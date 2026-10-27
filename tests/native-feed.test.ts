import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createNativeFeed, NativeFeed } from '../server/native-feed.js';
import type { MarketStreamEvent } from '../shared/realtime.js';

const require = createRequire(import.meta.url);
const { normalizeNativeSymbol, resolveCounter } = require('../server/native/helpers.cjs');
const { normalizeNativeQuote } = require('../server/native/quote.cjs');
const { NativeQuoteWorker } = require('../server/native/worker.cjs');

/** 等待纯内存异步任务完成。参数：无；返回：下一个事件循环Promise。 */
async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

/** 创建可控Promise。参数：无；返回：Promise与完成函数。 */
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** 创建不加载原生模块的行情假引擎。参数：无；返回：原生方法替身及记录。 */
function mockNative() {
  const callbacks: ((event: string, data: unknown) => void)[] = [];
  const subscriptions: unknown[] = []; const unsubscriptions: unknown[] = []; const searchParameters: any[] = [];
  const searchJobs: ReturnType<typeof deferred>[] = []; const snapshotJobs: ReturnType<typeof deferred>[] = [];
  return {
    callbacks, subscriptions, unsubscriptions, searchJobs, snapshotJobs, searchParameters,
    wsClient: (_binary: string, _text: string, callback: (event: string, data: unknown) => void) => { callbacks.push(callback); return {}; },
    wsClose: () => {},
    searchSecurities: (raw: string) => { searchParameters.push(JSON.parse(raw)); const job = deferred(); searchJobs.push(job); return job.promise; },
    wsSubscribeV2: (raw: string) => subscriptions.push(JSON.parse(raw)),
    wsUnsubscribeV2: (raw: string) => unsubscriptions.push(JSON.parse(raw)),
    quoteDetail: () => { const job = deferred(); snapshotJobs.push(job); return job.promise; },
  };
}

/** 返回精确证券结果。参数：代码、市场、前缀；返回：原生搜索响应。 */
function security(code = 'QQQ', market = 'US', prefix = 'ETF') {
  return { data: [{ code, market, counter_id: `${prefix}/${market}/${code}` }] };
}

/** 返回确定时间的原生报价。参数：timestamp秒、price价格；返回：原生data。 */
function rawQuote(timestamp = 100, price = '100') {
  return { counter_id: 'ETF/US/QQQ', timestamp: String(timestamp), last_done: price, prev_close: '90', trade_status: 202 };
}

test('证券边界支持US/HK及期权，搜索必须验证code、market及counter_id', () => {
  assert.equal(normalizeNativeSymbol('00700.hk'), '700.HK');
  assert.equal(normalizeNativeSymbol('AAPL261218C00200000.US'), 'AAPL261218C00200000.US');
  assert.throws(() => normalizeNativeSymbol('A'.repeat(33) + '.US'), /35/);
  for (const symbol of ['0.HK', 'AAPL.SH', 'QQQ.US;exit', '../QQQ.US']) assert.throws(() => normalizeNativeSymbol(symbol));
  assert.equal(resolveCounter(security(), 'QQQ.US'), 'ETF/US/QQQ');
  assert.equal(resolveCounter(security('00700', 'HK', 'ST'), '700.HK'), 'ST/HK/00700');
  assert.throws(() => resolveCounter(security('SQQQ'), 'QQQ.US'), /未找到/);
  assert.throws(() => resolveCounter({ data: [{ code: 'QQQ', market: 'US', counter_id: 'ETF/HK/QQQ' }] }, 'QQQ.US'), /未找到/);
  assert.throws(() => resolveCounter({ data: [...security().data, ...security('QQQ', 'US', 'ST').data] }, 'QQQ.US'), /多个/);
});

test('原生增量拒旧时间，保留昨收并按已确认交易状态选择价格', () => {
  const initial = normalizeNativeQuote(rawQuote(), 'QQQ.US');
  assert.equal(initial.quote.session, 'regular');
  const next = normalizeNativeQuote({ timestamp: '101', last_done: '102' }, 'QQQ.US', initial);
  assert.equal(next.quote.previousClose, 90);
  assert.equal(normalizeNativeQuote({ ...rawQuote(99), prev_close: '1' }, 'QQQ.US', next), null);
  const pre = normalizeNativeQuote({ timestamp: '102', sequence: '1', market_price: '103', trade_status: '206' }, 'QQQ.US', next);
  assert.equal(pre.quote.price, 103); assert.equal(pre.quote.session, 'pre');
  const post = normalizeNativeQuote({ timestamp: '103', sequence: '2', market_price: '104', trade_status: 207 }, 'QQQ.US', pre);
  assert.equal(post.quote.session, 'post');
  assert.equal(normalizeNativeQuote({ ...rawQuote(104), trade_status: 999 }, 'QQQ.US', post).quote.session, 'unknown');
  assert.equal(normalizeNativeQuote({ ...rawQuote(105), timestamp: true }, 'QQQ.US', post), null);
  assert.equal(normalizeNativeQuote({ timestamp: '106', trade_status: 206, last_done: '1' }, 'QQQ.US'), null);
});

test('原生重连恢复所有目标，过期搜索及快照不能覆盖新一代订阅', async () => {
  const native = mockNative(); const events: { event: string; data: any }[] = [];
  const worker = new NativeQuoteWorker(native, (event: string, data: unknown) => events.push({ event, data }));
  try {
    worker.subscribe('QQQ.US'); worker.subscribe('700.HK'); worker.connect();
    const callback = native.callbacks[0];
    callback('message', { type: 'authenticated' });
    assert.equal(native.searchJobs.length, 2);
    assert.deepEqual(native.searchParameters[0], { term: 'QQQ', markets: ['US'], is_code_exact_match: true, products: [], limit: 100 });
    assert.deepEqual(native.searchParameters[1].markets, ['HK']);
    callback('reconnecting', {}); callback('message', { type: 'authenticated' });
    native.searchJobs[0].resolve(security()); native.searchJobs[1].resolve(security('700', 'HK', 'ST'));
    await flush(); assert.equal(native.subscriptions.length, 0);
    native.searchJobs[2].resolve(security()); native.searchJobs[3].resolve(security('700', 'HK', 'ST'));
    await flush(); assert.equal(native.subscriptions.length, 2);
    assert.equal(events.some((item) => item.event === 'status' && item.data.state === 'connected'), false);
    callback('message', { type: 'quote/detail', counter_id: 'ETF/US/QQQ', data: { ...rawQuote(110, '110'), prev_close: undefined } });
    native.snapshotJobs[0].resolve({ code: 0, data: rawQuote(100, '100') });
    native.snapshotJobs[1].resolve({ code: 0, data: { ...rawQuote(), counter_id: 'ST/HK/700' } });
    await flush();
    const qqq = events.filter((item) => item.event === 'quote' && item.data.symbol === 'QQQ.US');
    assert.equal(qqq.at(-1)?.data.price, 110); assert.equal(qqq.at(-1)?.data.previousClose, 90);
    assert.equal(events.filter((item) => item.event === 'status' && item.data.state === 'connected').length, 2);
    worker.unsubscribe('QQQ.US');
    callback('message', { type: 'quote/detail', counter_id: 'ETF/US/QQQ', data: rawQuote(120) });
    assert.equal(events.filter((item) => item.event === 'quote' && item.data.symbol === 'QQQ.US').length, qqq.length);
  } finally { worker.close(); }
});

test('精确匹配失败以错误事件报告，不猜测counter前缀', async () => {
  const native = mockNative(); const events: any[] = [];
  const worker = new NativeQuoteWorker(native, (_event: string, data: unknown) => events.push(data));
  try {
    worker.subscribe('QQQ.US'); worker.connect(); native.callbacks[0]('message', { type: 'authenticated' });
    native.searchJobs[0].resolve(security('SQQQ')); await flush();
    assert.equal(native.subscriptions.length, 0);
    assert.match(events.at(-1).message, /未找到/); assert.equal(events.at(-1).state, 'error');
  } finally { worker.close(); }
});

test('证券搜索超时发出明确错误，迟到搜索不能创建订阅', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const native = mockNative(); const events: any[] = [];
  const worker = new NativeQuoteWorker(native, (_event: string, data: unknown) => events.push(data));
  try {
    worker.subscribe('QQQ.US'); worker.connect(); native.callbacks[0]('message', { type: 'authenticated' });
    context.mock.timers.tick(12000); await flush();
    assert.equal(events.at(-1).state, 'error'); assert.match(events.at(-1).message, /超时/);
    native.searchJobs[0].resolve(security()); await flush(); assert.equal(native.subscriptions.length, 0);
  } finally { worker.close(); context.mock.timers.reset(); }
});

test('取消目标和重连后，旧快照不能确认新目标或覆盖价格', async () => {
  const native = mockNative(); const events: any[] = [];
  const worker = new NativeQuoteWorker(native, (event: string, data: unknown) => events.push({ event, data }));
  try {
    worker.subscribe('QQQ.US'); worker.connect(); native.callbacks[0]('message', { type: 'authenticated' });
    native.searchJobs[0].resolve(security()); await flush();
    worker.unsubscribe('QQQ.US'); worker.subscribe('QQQ.US');
    native.snapshotJobs[0].resolve({ code: 0, data: rawQuote(500, '500') });
    native.searchJobs[1].resolve(security()); await flush();
    assert.equal(events.some((item) => item.event === 'quote'), false);
    native.callbacks[0]('reconnecting', {}); native.callbacks[0]('message', { type: 'authenticated' });
    native.snapshotJobs[1].resolve({ code: 0, data: rawQuote(600, '600') });
    native.searchJobs[2].resolve(security()); await flush();
    assert.equal(events.some((item) => item.event === 'quote'), false);
    native.snapshotJobs[2].resolve({ code: 0, data: rawQuote(100, '100') }); await flush();
    assert.equal(events.filter((item) => item.event === 'quote').at(-1).data.price, 100);
  } finally { worker.close(); }
});

test('有效期权推送后快照失败或超时不降级连接并持续传递报价', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const failure of ['reject', 'timeout', 'response']) {
    const native = mockNative(); const events: MarketStreamEvent[] = []; let stops = 0;
    const engine = new EventEmitter() as EventEmitter & { call: (method: string, payload?: { symbol: string }) => Promise<any>; stop: () => Promise<void> };
    const worker = new NativeQuoteWorker(native, (event: string, data: unknown) => engine.emit(event, data));
    engine.call = async (method, payload) => method === 'connect' ? worker.connect() : worker[method](payload?.symbol);
    engine.stop = async () => { stops++; worker.close(); };
    const feed = new NativeFeed(engine); const symbol = 'RKLB261218C00100000.US'; const counter = 'OPTION/US/RKLB261218C00100000';
    try {
      feed.subscribe(symbol, (event) => events.push(event)); await flush();
      native.callbacks[0]('message', { type: 'authenticated' });
      native.searchJobs[0].resolve(security(symbol.slice(0, -3), 'US', 'OPTION')); await flush();
      native.callbacks[0]('message', { type: 'quote/detail', counter_id: counter, data: rawQuote(100) });
      if (failure === 'reject') native.snapshotJobs[0].reject(new Error('synthetic snapshot failure'));
      else if (failure === 'timeout') context.mock.timers.tick(12000);
      else native.snapshotJobs[0].resolve({ code: 403 });
      await flush();
      native.callbacks[0]('message', { type: 'quote/detail', counter_id: counter, data: rawQuote(101) });
      context.mock.timers.tick(4000); await flush();
      assert.deepEqual(events.filter((event) => event.type === 'quote').map((event) => event.quote.timestamp), [100, 101]);
      assert.equal(events.some((event) => event.type === 'status' && event.state === 'error'), false);
      assert.equal(stops, 0); assert.equal(native.searchJobs.length, 1);
    } finally { await feed.close(); }
  }
  context.mock.timers.reset();
});

test('期权WS快照失败使用桌面HTTP且拒绝旧会话继续回退', async () => {
  const native = mockNative(); const worker = new NativeQuoteWorker(native, () => {});
  let requests = 0; const symbol = 'DRAM270115C70000.US'; const counter = 'OP/US/DRAM270115C70000';
  Object.assign(native, { httpRequest: async (_method: string, path: string, raw: string) => {
    requests++; assert.equal(path, '/v2/quote/option/detail'); assert.equal(JSON.parse(raw).counter_id, counter);
    return { data: { ...rawQuote(), counter_id: counter } };
  } });
  worker.httpClient = {};
  try {
    worker.subscribe(symbol); worker.connect(); native.callbacks[0]('message', { type: 'authenticated' });
    native.searchJobs[0].resolve(security(symbol.slice(0, -3), 'US', 'OP')); await flush();
    native.snapshotJobs[0].resolve({ code: 403 }); await flush();
    assert.equal(requests, 1); assert.equal(worker.targets.get(symbol).confirmed, true);
    native.callbacks[0]('reconnecting', {}); native.callbacks[0]('message', { type: 'authenticated' });
    native.searchJobs[1].resolve(security(symbol.slice(0, -3), 'US', 'OP')); await flush();
    worker.unsubscribe(symbol); native.snapshotJobs[1].reject(new Error('late failure')); await flush();
    assert.equal(requests, 1);
  } finally { worker.close(); }
});

test('重连的当前代旧快照可确认连接且保留更新价格与时间', async () => {
  const native = mockNative(); const events: any[] = [];
  const worker = new NativeQuoteWorker(native, (event: string, data: any) => events.push({ event, data }));
  try {
    worker.subscribe('QQQ.US'); worker.connect(); const callback = native.callbacks[0];
    callback('message', { type: 'authenticated' }); native.searchJobs[0].resolve(security()); await flush();
    native.snapshotJobs[0].resolve({ code: 0, data: rawQuote(110, '110') }); await flush();
    callback('reconnecting', {}); callback('message', { type: 'authenticated' });
    native.searchJobs[1].resolve(security()); await flush();
    native.snapshotJobs[1].resolve({ code: 0, data: rawQuote(100, '100') }); await flush();
    assert.equal(events.filter((item) => item.event === 'status').at(-1).data.state, 'connected');
    assert.equal(events.filter((item) => item.event === 'quote').at(-1).data.timestamp, 110);
    assert.equal(events.filter((item) => item.event === 'quote').at(-1).data.price, 110);
  } finally { worker.close(); }
});

test('rejected清除已确认和搜索中标记，旧搜索不能污染重新认证', async () => {
  const native = mockNative(); const events: any[] = [];
  const worker = new NativeQuoteWorker(native, (event: string, data: any) => events.push({ event, data }));
  try {
    worker.subscribe('QQQ.US'); worker.subscribe('700.HK'); worker.connect(); const callback = native.callbacks[0];
    callback('message', { type: 'authenticated' }); native.searchJobs[0].resolve(security()); await flush();
    native.snapshotJobs[0].resolve({ code: 0, data: rawQuote() }); await flush();
    callback('message', { type: 'rejected' }); callback('message', { type: 'authenticated' });
    assert.equal(native.searchJobs.length, 4);
    native.searchJobs[1].resolve(security('700', 'HK', 'ST')); await flush();
    assert.equal(native.subscriptions.length, 1);
    native.searchJobs[2].resolve(security()); native.searchJobs[3].resolve(security('700', 'HK', 'ST')); await flush();
    native.snapshotJobs[1].resolve({ code: 0, data: rawQuote(101) });
    native.snapshotJobs[2].resolve({ code: 0, data: { ...rawQuote(), counter_id: 'ST/HK/700' } }); await flush();
    for (const symbol of ['QQQ.US', '700.HK']) {
      assert.equal(events.filter((item) => item.event === 'status' && item.data.symbol === symbol).at(-1).data.state, 'connected');
    }
  } finally { worker.close(); }
});

test('单个期权失败仅重试该目标，正常行情和共享进程持续可用', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const native = mockNative(); const events: MarketStreamEvent[] = []; let stops = 0;
  const engine = new EventEmitter() as EventEmitter & { call: (method: string, payload?: { symbol: string }) => Promise<any>; stop: () => Promise<void> };
  const worker = new NativeQuoteWorker(native, (event: string, data: unknown) => engine.emit(event, data));
  engine.call = async (method, payload) => method === 'connect' ? worker.connect() : worker[method](payload?.symbol);
  engine.stop = async () => { stops++; worker.close(); };
  const feed = new NativeFeed(engine); const option = 'DRAM261218C00100000.US';
  try {
    feed.subscribe('QQQ.US', (event) => events.push(event));
    const cancelOption = feed.subscribe(option, (event) => events.push(event)); await flush();
    native.callbacks[0]('message', { type: 'authenticated' });
    native.searchJobs[0].resolve(security()); native.searchJobs[1].resolve({ data: [] }); await flush();
    native.snapshotJobs[0].resolve({ code: 0, data: rawQuote() }); await flush();
    assert.equal(native.searchParameters[2].term, 'DRAM');
    native.searchJobs[2].resolve({ data: [] }); await flush();
    context.mock.timers.tick(4000); await flush();
    assert.equal(native.searchJobs.length, 4); assert.equal(native.searchParameters[3].term, option.slice(0, -3));
    native.searchJobs[3].resolve(security(option.slice(0, -3), 'US', 'OPTION')); await flush();
    native.snapshotJobs[1].resolve({ code: 403 }); await flush();
    native.callbacks[0]('message', { type: 'quote/detail', counter_id: 'ETF/US/QQQ', data: rawQuote(101) });
    assert.equal(events.filter((event) => event.type === 'quote').at(-1)?.quote.timestamp, 101);
    assert.equal(stops, 0); assert.equal(native.callbacks.length, 1);
    cancelOption(); await flush(); context.mock.timers.tick(100000); await flush();
    assert.equal(native.searchJobs.length, 4); assert.equal(stops, 0);
    assert.equal(events.some((event) => event.type === 'status' && event.symbol === 'QQQ.US' && event.state === 'reconnecting'), false);
  } finally { await feed.close(); context.mock.timers.reset(); }
});

test('协议重新认证后证券失败不延续旧连接重启，后续断线仍恢复', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const native = mockNative(); let stops = 0;
  const engine = new EventEmitter() as EventEmitter & { call: (method: string, payload?: { symbol: string }) => Promise<any>; stop: () => Promise<void> };
  const worker = new NativeQuoteWorker(native, (event: string, data: unknown) => engine.emit(event, data));
  engine.call = async (method, payload) => method === 'connect' ? worker.connect() : worker[method](payload?.symbol);
  engine.stop = async () => { stops++; worker.close(); };
  const feed = new NativeFeed(engine);
  try {
    feed.subscribe('QQQ.US', () => {}); await flush(); const callback = native.callbacks[0];
    callback('message', { type: 'authenticated' }); callback('reconnecting', {});
    callback('message', { type: 'authenticated' }); native.searchJobs[1].resolve({ data: [] }); await flush();
    context.mock.timers.tick(4000); await flush(); assert.equal(stops, 0); assert.equal(native.searchJobs.length, 3);
    callback('error', {}); context.mock.timers.tick(4000); await flush(); assert.equal(stops, 1);
  } finally { await feed.close(); context.mock.timers.reset(); }
});

test('目标重试有界退避，成功确认取消待执行重试', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const native = mockNative(); const worker = new NativeQuoteWorker(native, () => {});
  try {
    worker.subscribe('QQQ.US'); worker.connect(); native.callbacks[0]('message', { type: 'authenticated' });
    for (const [index, delay] of [4000, 8000, 16000].entries()) {
      native.searchJobs[index].resolve({ data: [] }); await flush();
      context.mock.timers.tick(delay); await flush();
    }
    native.searchJobs[3].resolve({ data: [] }); await flush(); context.mock.timers.tick(100000); await flush();
    assert.equal(native.searchJobs.length, 4);
    worker.unsubscribe('QQQ.US'); worker.subscribe('QQQ.US');
    native.searchJobs[4].resolve(security()); await flush(); native.snapshotJobs[0].resolve({ code: 403 }); await flush();
    native.callbacks[0]('message', { type: 'quote/detail', counter_id: 'ETF/US/QQQ', data: rawQuote() });
    context.mock.timers.tick(100000); await flush(); assert.equal(native.searchJobs.length, 5);
  } finally { worker.close(); context.mock.timers.reset(); }
});

test('短暂connected不清零进程恢复预算，稳定连接后允许重新恢复', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  class Engine extends EventEmitter {
    stops = 0;
    /** 提交内存操作。参数：无；返回：成功Promise。 */
    async call() {}
    /** 记录共享进程停止。参数：无；返回：成功Promise。 */
    async stop() { this.stops++; }
  }
  const engine = new Engine(); const feed = new NativeFeed(engine);
  try {
    feed.subscribe('QQQ.US', () => {}); await flush();
    for (const delay of [4000, 8000, 16000, 32000]) {
      engine.emit('status', { symbol: 'QQQ.US', state: 'connected', message: 'synthetic confirmation' });
      engine.emit('status', { symbol: 'QQQ.US', state: 'error', scope: 'connection', message: 'synthetic connection failure' });
      context.mock.timers.tick(delay); await flush();
    }
    assert.equal(engine.stops, 3);
    engine.emit('status', { symbol: 'QQQ.US', state: 'connected', message: 'synthetic stable connection' });
    context.mock.timers.tick(30000); await flush();
    engine.emit('state', {}); context.mock.timers.tick(4000); await flush(); assert.equal(engine.stops, 4);
  } finally { await feed.close(); context.mock.timers.reset(); }
});

test('同步取消尚未启动的订阅不会为了unsubscribe启动原生进程', async () => {
  class FakeEngine extends EventEmitter {
    calls: string[] = [];
    /** 记录操作。参数：method方法；返回：Promise<void>。 */
    async call(method: string) { this.calls.push(method); }
    /** 无进程清理。参数：无；返回：Promise<void>。 */
    async stop() {}
  }
  const engine = new FakeEngine(); const cancel = createNativeFeed(engine)('QQQ.US', () => {});
  cancel(); await flush(); assert.deepEqual(engine.calls, []);
});

test('快速取消再订阅同证券仍按队列重建目标并恢复确认事件', async () => {
  class FakeEngine extends EventEmitter {
    calls: string[] = [];
    /** 记录变更并模拟确认。参数：method操作、payload代码；返回：Promise<void>。 */
    async call(method: string, payload?: { symbol: string }) {
      this.calls.push(`${method}:${payload?.symbol ?? ''}`);
      if (method === 'subscribe') this.emit('status', { symbol: payload?.symbol, state: 'connected', message: '桌面原生WS匿名' });
    }
    /** 停止假进程。参数：无；返回：Promise<void>。 */
    async stop() {}
  }
  const engine = new FakeEngine(); const subscribe = createNativeFeed(engine);
  const first = subscribe('QQQ.US', () => {}); await flush();
  first(); const events: MarketStreamEvent[] = [];
  const second = subscribe('QQQ.US', (event) => events.push(event)); await flush();
  assert.deepEqual(engine.calls, ['subscribe:QQQ.US', 'connect:', 'unsubscribe:QQQ.US', 'subscribe:QQQ.US', 'connect:']);
  assert.equal(events.some((event) => event.type === 'status' && event.state === 'connected'), true);
  second(); await flush();
});

test('进程失败按有界退避重放目标，取消后不再恢复', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  class FakeEngine extends EventEmitter {
    calls: string[] = []; stops = 0;
    /** 记录IPC。参数：method操作；返回：Promise<void>。 */
    async call(method: string) { this.calls.push(method); }
    /** 记录回收。参数：无；返回：Promise<void>。 */
    async stop() { this.stops += 1; }
  }
  const engine = new FakeEngine(); const cancel = createNativeFeed(engine)('QQQ.US', () => {}); await flush();
  for (const delay of [4000, 8000, 16000]) {
    engine.emit('state', {}); context.mock.timers.tick(delay); await flush();
  }
  assert.equal(engine.stops, 3);
  engine.emit('state', {}); context.mock.timers.tick(32000); await flush(); assert.equal(engine.stops, 3);
  cancel(); await flush();
  context.mock.timers.tick(100000); await flush(); assert.equal(engine.stops, 4);
  context.mock.timers.reset();
});

test('多个消费者共享一次订阅，相同回调也有独立引用，最后取消销毁进程', async () => {
  class FakeEngine extends EventEmitter {
    calls: string[] = []; stops = 0;
    /** 记录IPC。参数：method操作、payload参数；返回：成功Promise。 */
    async call(method: string, payload?: { symbol: string }) { this.calls.push(`${method}:${payload?.symbol ?? ''}`); }
    /** 记录停止。参数：无；返回：成功Promise。 */
    async stop() { this.stops += 1; }
  }
  const engine = new FakeEngine(); const subscribe = createNativeFeed(engine); const events: MarketStreamEvent[] = [];
  const callback = (event: MarketStreamEvent) => events.push(event);
  const first = subscribe('QQQ.US', callback); const second = subscribe('QQQ.US', callback);
  await flush(); assert.deepEqual(engine.calls, ['subscribe:QQQ.US', 'connect:']);
  engine.emit('status', { symbol: 'QQQ.US', state: 'connected', message: '桌面原生WS匿名' });
  engine.emit('quote', { symbol: 'QQQ.US', timestamp: 100, price: 100, previousClose: 90, session: 'regular' });
  engine.emit('quote', { symbol: 'QQQ.US', timestamp: 99, price: 1, previousClose: 1, session: 'regular' });
  assert.equal(events.filter((event) => event.type === 'quote').length, 2);
  first(); first(); await flush(); assert.equal(engine.stops, 0);
  second(); await flush(); assert.equal(engine.calls.at(-1), 'unsubscribe:QQQ.US'); assert.equal(engine.stops, 1);
});
