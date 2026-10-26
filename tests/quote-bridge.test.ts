import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LongbridgeRpc, QuoteBridge, type QuoteMethod } from '../server/quote-bridge.js';
import { MarketStreamHub } from '../server/market-stream.js';
import { normalizeRealtimeQuote, normalizeTradeSession } from '../server/realtime-normalize.js';
import { parseStreamEvent, type MarketStreamEvent } from '../shared/realtime.js';
import type { Period } from '../shared/types.js';

interface Request { id: number; method: QuoteMethod; params: Record<string, unknown> }
const SYMBOL = 'DRAM.US';
const TIME = '2026-10-19T14:30:00Z';
const candle = { timestamp: TIME, open: '10', high: '12', low: '9', close: '11', volume: '123' };

/** 无真实凭证的 JSONL 子进程，可手动控制响应、通知与退出顺序。 */
class FakeProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: Request[] = [];
  readonly stdin = new Writable({ write: (chunk, _encoding, done) => {
    const request = JSON.parse(String(chunk)) as Request;
    this.requests.push(request);
    this.handler?.(request);
    done();
  } });
  killed = false;
  handler?: (request: Request) => void;

  /** @returns 类型兼容的 fake，仅测试使用。 */
  asProcess(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams; }
  /** @returns 终止成功标记，不启动真实进程。 */
  kill(): boolean { this.killed = true; return true; }
  /** @param request 待响应请求。 @param result 响应体。 @returns 无返回值。 */
  reply(request: Request, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  }
  /** @param request 待拒绝请求。 @returns 无返回值；错误原文故意含模拟敏感信息。 */
  reject(request: Request): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { message: 'secret-token-never-print' } })}\n`);
  }
  /** @param params 报价通知体。 @returns 无返回值。 */
  notify(params: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'quote.updated', params })}\n`);
  }
}

/** @returns 无返回值；推进 Promise 与 I/O 回调，不等待实际市场接口。 */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** @param process fake 进程。 @returns 无返回值；安装固定订阅快照与 K 线应答。 */
function autoReply(process: FakeProcess): void {
  process.handler = (request) => {
    if (request.method === 'initialize') process.reply(request, { serverInfo: { version: '0.30' } });
    else if (request.method === 'quote.subscribe') process.reply(request, {
      subscribed: request.params.symbols,
      quotes: [{ symbol: (request.params.symbols as string[])[0], last_done: '10', prev_close: '9', timestamp: TIME }],
    });
    else if (request.method === 'quote.candlesticks') process.reply(request, [candle]);
    else process.reply(request, {});
  };
}

/** @param process fake 进程。 @param method RPC 方法。 @returns 匹配请求。 */
function requests(process: FakeProcess, method: QuoteMethod): Request[] {
  return process.requests.filter((request) => request.method === method);
}

/** @param events 已收到事件。 @returns 提取出的报价事件。 */
function quotes(events: MarketStreamEvent[]) {
  return events.filter((event) => event.type === 'quote').map((event) => event.quote);
}

test('JSONL 任意分片、多行与乱序 id 正确关联，只读白名单和错误脱敏', async () => {
  const process = new FakeProcess();
  const notices: unknown[] = [];
  const rpc = new LongbridgeRpc(() => process.asProcess(), (method, params) => notices.push({ method, params }));
  try {
    const first = rpc.request('initialize');
    const second = rpc.request('quote.quote', { symbols: [SYMBOL] });
    const response = `${JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'second' })}\n` +
      `${JSON.stringify({ jsonrpc: '2.0', method: 'quote.updated', params: { name: '测试' } })}\n` +
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'first' })}\r\n`;
    const bytes = Buffer.from(response);
    for (const byte of bytes) process.stdout.write(Buffer.from([byte]));
    assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
    assert.deepEqual(notices, [{ method: 'quote.updated', params: { name: '测试' } }]);
    const count = process.requests.length;
    await assert.rejects(rpc.request('trade.submit_order' as QuoteMethod), /不允许/);
    assert.equal(process.requests.length, count);
    const rejected = rpc.request('quote.quote');
    process.reject(process.requests.at(-1)!);
    await assert.rejects(rejected, (error: Error) => !error.message.includes('secret-token') && /RPC/.test(error.message));
  } finally { rpc.close(); }
});

test('EOF、exit、进程错误与主动关闭均拒绝 pending 并释放所有监听', async () => {
  for (const reason of ['end', 'exit', 'error', 'close'] as const) {
    const process = new FakeProcess();
    let disconnects = 0;
    const rpc = new LongbridgeRpc(() => process.asProcess(), undefined, () => { disconnects += 1; });
    const pending = rpc.request('initialize');
    const rejected = assert.rejects(pending, /Longbridge/);
    if (reason === 'end') process.stdout.emit('end');
    else if (reason === 'close') rpc.close();
    else if (reason === 'error') process.emit('error', new Error('secret-token-never-print'));
    else process.emit('exit', 1, null);
    await rejected;
    assert.equal(disconnects, reason === 'close' ? 0 : 1);
    assert.equal(process.killed, true);
    assert.equal(process.listenerCount('exit'), 0);
    assert.equal(process.listenerCount('error'), 0);
    assert.equal(process.stdout.listenerCount('data'), 0);
    assert.equal(process.stdout.listenerCount('end'), 0);
    assert.equal(process.stdin.listenerCount('error'), 0);
    assert.equal(process.stderr.listenerCount('data'), 0);
    await assert.rejects(rpc.request('initialize'), /关闭/);
    rpc.close();
  }
});

test('RPC 超时和畸形 JSON 有界失败，不包含远端原文', async () => {
  const process = new FakeProcess();
  const rpc = new LongbridgeRpc(() => process.asProcess(), undefined, undefined, 10);
  try {
    await assert.rejects(rpc.request('initialize'), /超时/);
    const pending = rpc.request('quote.quote');
    process.stdout.write('secret-token-not-json\n');
    await assert.rejects(pending, (error: Error) => /解析失败/.test(error.message) && !error.message.includes('secret-token'));
  } finally { rpc.close(); }
});

test('共享 symbol/period 订阅去重，重复回调有独立引用，最后关闭释放进程', async () => {
  const process = new FakeProcess();
  autoReply(process);
  let spawned = 0;
  const bridge = new QuoteBridge({ processFactory: () => { spawned += 1; return process.asProcess(); } });
  const events: MarketStreamEvent[] = [];
  const listener = (event: MarketStreamEvent): void => { parseStreamEvent(event); events.push(event); };
  const releaseFirst = bridge.subscribe(SYMBOL, 'day', listener);
  const releaseSecond = bridge.subscribe(SYMBOL, 'day', listener);
  const releaseOther = bridge.subscribe('NVDA.US', '1h', () => undefined);
  try {
    await flush();
    assert.equal(spawned, 1);
    assert.equal(requests(process, 'quote.subscribe').filter((request) => (request.params.symbols as string[])[0] === SYMBOL).length, 1);
    assert.equal(requests(process, 'quote.candlesticks').filter((request) => request.params.symbol === SYMBOL).length, 1);
    assert.deepEqual(requests(process, 'quote.candlesticks')[0].params, {
      symbol: SYMBOL, period: 'day', count: 1000, adjust_type: 'no_adjust', trade_sessions: 'intraday',
    });
    assert.equal((events[0] as { state: string }).state, 'connecting');
    assert.ok(events.some((event) => event.type === 'status' && event.state === 'connected'));
    releaseFirst();
    releaseFirst();
    const before = quotes(events).length;
    process.notify({ symbol: SYMBOL, timestamp: '2026-10-19T14:31:00Z', last_done: '11', trade_session: 0 });
    assert.equal(quotes(events).length, before + 1);
    releaseSecond();
    await flush();
    assert.equal(requests(process, 'quote.unsubscribe').length, 1);
    assert.equal(process.killed, false);
    releaseOther();
    assert.equal(process.killed, true);
    assert.equal(process.stdout.listenerCount('data'), 0);
  } finally { bridge.close(); }
});

test('全部实时周期映射为原生 RPC，季度使用月线且增量请求12根', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse(TIME) });
  const process = new FakeProcess();
  autoReply(process);
  const bridge = new QuoteBridge({ processFactory: () => process.asProcess() });
  const periods: Period[] = ['1m', '5m', '15m', '30m', '1h', 'day', 'week', 'month', 'quarter', 'year'];
  const events = new Map<Period, MarketStreamEvent[]>();
  try {
    for (const period of periods) {
      const received: MarketStreamEvent[] = [];
      events.set(period, received);
      bridge.subscribe(SYMBOL, period, (event) => { parseStreamEvent(event); received.push(event); });
    }
    await flush();
    assert.equal(requests(process, 'quote.subscribe').length, 1);
    const initial = requests(process, 'quote.candlesticks');
    assert.equal(initial.length, periods.length);
    for (const [index, period] of periods.entries()) {
      assert.deepEqual(initial[index].params, {
        symbol: SYMBOL, period: period === 'quarter' ? 'month' : period, count: 1000,
        adjust_type: 'no_adjust', trade_sessions: 'intraday',
      });
      assert.ok(events.get(period)!.some((event) => event.type === 'candles' && event.period === period));
    }
    context.mock.timers.tick(5000);
    await flush();
    const incremental = requests(process, 'quote.candlesticks').slice(periods.length);
    assert.equal(incremental.length, periods.length);
    for (const [index, period] of periods.entries()) {
      assert.equal(incremental[index].params.period, period === 'quarter' ? 'month' : period);
      assert.equal(incremental[index].params.count, period === 'quarter' ? 12 : 5);
    }
  } finally { bridge.close(); context.mock.timers.reset(); }
});

test('非法实时周期在启动进程前拒绝', () => {
  let spawned = false;
  const bridge = new QuoteBridge({ processFactory: () => { spawned = true; return new FakeProcess().asProcess(); } });
  try {
    for (const period of ['2m', '', 'Quarter', null, 15, { toString: () => 'day' }]) {
      assert.throws(() => bridge.subscribe(SYMBOL, period as Period, () => undefined), /周期/);
    }
    assert.equal(spawned, false);
  } finally { bridge.close(); }
});

test('季度月线增量保留完整旧季度，更新当前季度全部月份并向新客户端补齐', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-02-20T14:30:00Z') });
  const process = new FakeProcess();
  autoReply(process);
  const original = process.handler!;
  const monthly = Array.from({ length: 14 }, (_entry, index) => ({
    timestamp: new Date(Date.UTC(2025, index, 1)).toISOString(),
    open: '10', high: '20', low: '5', close: '15', volume: String(index + 1),
  }));
  const incremental = monthly.slice(-12).map((entry, index) => index === 11
    ? { ...entry, high: '40', low: '4', close: '35', volume: '140' } : entry);
  process.handler = (request) => {
    if (request.method === 'quote.candlesticks') process.reply(request, request.params.count === 1000 ? monthly : incremental);
    else original(request);
  };
  const bridge = new QuoteBridge({ processFactory: () => process.asProcess() });
  const events: MarketStreamEvent[] = [];
  try {
    bridge.subscribe(SYMBOL, 'quarter', (event) => events.push(event));
    await flush();
    const initial = events.filter((event) => event.type === 'candles').at(-1)!;
    assert.equal(initial.candles.length, 5);
    assert.equal(initial.candles[0].volume, 6);
    assert.equal(initial.candles.at(-1)?.volume, 27);
    context.mock.timers.tick(5000);
    await flush();
    const update = events.filter((event) => event.type === 'candles').at(-1)!;
    assert.equal(update.period, 'quarter');
    // 12个月从3月开始，首个缺少1、2月的季度不能覆盖缓存里完整的一季度。
    assert.equal(update.candles[0].time, Date.parse('2025-04-01T00:00:00Z') / 1000);
    assert.deepEqual(update.candles.at(-1), {
      time: Date.parse('2026-01-01T00:00:00Z') / 1000,
      open: 10, high: 40, low: 4, close: 35, volume: 153, confirmed: false,
    });
    const newcomer: MarketStreamEvent[] = [];
    bridge.subscribe(SYMBOL, 'quarter', (event) => newcomer.push(event));
    const cached = newcomer.filter((event) => event.type === 'candles').at(-1)!;
    assert.equal(cached.candles.length, 5);
    assert.deepEqual(cached.candles[0], initial.candles[0]);
    assert.deepEqual(cached.candles.at(-1), update.candles.at(-1));
    assert.equal(requests(process, 'quote.candlesticks').length, 2);
  } finally { bridge.close(); context.mock.timers.reset(); }
});

test('订阅完成前保持 connecting；通知先于旧快照时价格不回退且补全昨收', async () => {
  const process = new FakeProcess();
  const bridge = new QuoteBridge({ processFactory: () => process.asProcess() });
  const events: MarketStreamEvent[] = [];
  const release = bridge.subscribe(SYMBOL, 'day', (event) => events.push(event));
  try {
    assert.ok(events.every((event) => event.type !== 'status' || event.state !== 'connected'));
    process.reply(requests(process, 'initialize')[0], {});
    await flush();
    assert.ok(events.every((event) => event.type !== 'status' || event.state !== 'connected'));
    process.notify({ symbol: SYMBOL, timestamp: '2026-10-19T14:31:00Z', last_done: '12', trade_session: 'Intraday' });
    process.reply(requests(process, 'quote.subscribe')[0], {
      quotes: [{ symbol: SYMBOL, timestamp: TIME, last_done: '10', prev_close: '9' }],
    });
    await flush();
    assert.equal(quotes(events).at(-1)?.price, 12);
    assert.equal(quotes(events).at(-1)?.previousClose, 9);
    assert.equal(quotes(events).at(-1)?.timestamp, Date.parse('2026-10-19T14:31:00Z') / 1000);
    const before = quotes(events).length;
    process.notify({ symbol: SYMBOL, timestamp: TIME, last_done: '1', trade_session: 0 });
    assert.equal(quotes(events).length, before);
  } finally { release(); }
});

test('同 symbol 多周期只订阅一次，K线独立，报价不修改原生柱', async () => {
  const process = new FakeProcess();
  autoReply(process);
  const bridge = new QuoteBridge({ processFactory: () => process.asProcess() });
  const events: MarketStreamEvent[] = [];
  const day = bridge.subscribe(SYMBOL, 'day', (event) => events.push(event));
  const hourly = bridge.subscribe(SYMBOL, '1h', (event) => events.push(event));
  try {
    await flush();
    assert.equal(requests(process, 'quote.subscribe').length, 1);
    assert.equal(requests(process, 'quote.candlesticks').length, 2);
    const before = events.filter((event) => event.type === 'candles').length;
    process.notify({ symbol: SYMBOL, timestamp: '2026-10-19T20:30:00Z', last_done: '99', trade_session: 'Post' });
    assert.equal(quotes(events).at(-1)?.session, 'post');
    assert.equal(events.filter((event) => event.type === 'candles').length, before);
    assert.ok(events.filter((event) => event.type === 'candles').every((event) => event.candles[0].close === 11));
  } finally { day(); hourly(); }
});

test('报价会验证价格与时间，识别交易时段，未知时段不冒充 regular', () => {
  const snapshot = normalizeRealtimeQuote({ symbol: SYMBOL, last_done: '10', prev_close: '9', timestamp: TIME }, SYMBOL, null, true)!;
  assert.equal(snapshot.session, 'regular');
  for (const [input, expected] of [[0, 'regular'], [1, 'pre'], [2, 'post'], [3, 'overnight'],
    ['Intraday', 'regular'], ['Pre', 'pre'], ['Post', 'post'], ['Overnight', 'overnight'], ['alien', 'unknown']] as const) {
    assert.equal(normalizeTradeSession(input), expected);
  }
  const extended = normalizeRealtimeQuote({ symbol: SYMBOL, last_done: '10', prev_close: '9', timestamp: TIME,
    pre_market_quote: { last_done: '8', timestamp: '2026-10-19T12:00:00Z' },
    post_market_quote: { last_done: '12', timestamp: '2026-10-19T21:00:00Z' },
  }, SYMBOL, null, true)!;
  assert.equal(extended.session, 'post');
  assert.equal(extended.price, 12);
  const partial = normalizeRealtimeQuote({ symbol: SYMBOL, timestamp: '2026-10-19T14:31:00Z', trade_session: 0 }, SYMBOL, snapshot)!;
  assert.equal(partial.price, 10);
  assert.equal(partial.previousClose, 9);
  assert.equal(normalizeRealtimeQuote({ symbol: SYMBOL, last_done: '11' }, SYMBOL, snapshot), null);
  assert.equal(normalizeRealtimeQuote({ symbol: SYMBOL, timestamp: '2026-10-19T14:31:00Z', trade_session: 1 }, SYMBOL, snapshot), null);
  for (const invalid of ['', ' ', 'NaN', true, -1, 0]) {
    assert.throws(() => normalizeRealtimeQuote({ symbol: SYMBOL, last_done: invalid, timestamp: TIME }, SYMBOL, null, true), /价格/);
  }
  assert.throws(() => normalizeRealtimeQuote({ symbol: SYMBOL, last_done: '1', timestamp: 'no-timezone' }, SYMBOL, null, true));
  assert.equal(normalizeRealtimeQuote({ symbol: SYMBOL, last_done: '1', timestamp: TIME }, SYMBOL)?.session, 'unknown');
});

test('K线轮询在途不重叠，后续 count5，单次失败警告后自动恢复', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse(TIME) });
  const process = new FakeProcess();
  autoReply(process);
  const original = process.handler!;
  let holdCandles = true;
  process.handler = (request) => { if (request.method !== 'quote.candlesticks' || !holdCandles) original(request); };
  const bridge = new QuoteBridge({ processFactory: () => process.asProcess(), requestTimeoutMs: 60_000 });
  const events: MarketStreamEvent[] = [];
  const release = bridge.subscribe(SYMBOL, 'day', (event) => events.push(event));
  try {
    await flush();
    context.mock.timers.tick(5_000);
    await flush();
    assert.equal(requests(process, 'quote.candlesticks').length, 1);
    holdCandles = false;
    process.reply(requests(process, 'quote.candlesticks')[0], [candle]);
    await flush();
    context.mock.timers.tick(5_000);
    await flush();
    assert.equal(requests(process, 'quote.candlesticks')[1].params.count, 5);
    holdCandles = true;
    context.mock.timers.tick(5_000);
    await flush();
    process.reject(requests(process, 'quote.candlesticks').at(-1)!);
    await flush();
    assert.ok(events.some((event) => event.type === 'status' && event.state === 'error' && /K 线/.test(event.message)));
    holdCandles = false;
    context.mock.timers.tick(5_000);
    await flush();
    assert.equal((events.at(-1) as { state: string }).state, 'connected');
    assert.equal(requests(process, 'quote.candlesticks').at(-1)?.params.count, 1000);
    release();
    const count = process.requests.length;
    context.mock.timers.tick(60_000);
    await flush();
    assert.equal(process.requests.length, count);
  } finally { bridge.close(); context.mock.timers.reset(); }
});

test('断线指数重连恢复订阅和 count1000 补缺，最后离开取消重连', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse(TIME) });
  const processes: FakeProcess[] = [];
  const bridge = new QuoteBridge({ processFactory: () => {
    const process = new FakeProcess(); autoReply(process); processes.push(process); return process.asProcess();
  } });
  const events: MarketStreamEvent[] = [];
  const release = bridge.subscribe(SYMBOL, 'day', (event) => events.push(event));
  try {
    await flush();
    processes[0].emit('exit', 1, null);
    assert.ok(events.some((event) => event.type === 'status' && event.state === 'reconnecting'));
    context.mock.timers.tick(999);
    assert.equal(processes.length, 1);
    context.mock.timers.tick(1);
    await flush();
    assert.equal(processes.length, 2);
    assert.equal(requests(processes[1], 'quote.subscribe').length, 1);
    assert.equal(requests(processes[1], 'quote.candlesticks')[0].params.count, 1000);
    processes[1].emit('exit', 1, null);
    release();
    context.mock.timers.tick(60_000);
    await flush();
    assert.equal(processes.length, 2);
  } finally { bridge.close(); context.mock.timers.reset(); }
});

test('连续 initialize 失败指数退避最多30秒，关闭后不再创建进程', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse(TIME) });
  const processes: FakeProcess[] = [];
  const bridge = new QuoteBridge({ processFactory: () => {
    const process = new FakeProcess(); processes.push(process); return process.asProcess();
  } });
  const release = bridge.subscribe(SYMBOL, 'day', () => undefined);
  try {
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      processes.at(-1)!.emit('exit', 1, null);
      const before = processes.length;
      context.mock.timers.tick(delay - 1);
      await flush();
      assert.equal(processes.length, before);
      context.mock.timers.tick(1);
      await flush();
      assert.equal(processes.length, before + 1);
    }
    release();
    const count = processes.length;
    context.mock.timers.tick(120_000);
    await flush();
    assert.equal(processes.length, count);
  } finally { bridge.close(); context.mock.timers.reset(); }
});

test('五根增量后新客户端仍能收到先前完整历史', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse(TIME) });
  const process = new FakeProcess();
  autoReply(process);
  const original = process.handler!;
  const fullHistory = Array.from({ length: 10 }, (_entry, index) => ({ ...candle, timestamp: Date.parse(TIME) / 1000 + index * 86400 }));
  process.handler = (request) => {
    if (request.method === 'quote.candlesticks') process.reply(request, request.params.count === 1000 ? fullHistory : fullHistory.slice(-5));
    else original(request);
  };
  const bridge = new QuoteBridge({ processFactory: () => process.asProcess() });
  const events: MarketStreamEvent[] = [];
  const first = bridge.subscribe(SYMBOL, 'day', (event) => events.push(event));
  let second: (() => void) | undefined;
  try {
    await flush();
    context.mock.timers.tick(5000);
    await flush();
    assert.equal(events.filter((event) => event.type === 'candles').at(-1)?.candles.length, 5);
    const newcomer: MarketStreamEvent[] = [];
    second = bridge.subscribe(SYMBOL, 'day', (event) => newcomer.push(event));
    assert.equal(newcomer.filter((event) => event.type === 'candles').at(-1)?.candles.length, 10);
    assert.equal(requests(process, 'quote.candlesticks').length, 2);
  } finally { first(); second?.(); bridge.close(); context.mock.timers.reset(); }
});

/** 可控制背压并收集 SSE 输出的 HTTP 响应替身。 */
class FakeResponse extends EventEmitter {
  status = 0;
  chunks: string[] = [];
  writableLength = 0;
  writableEnded = false;
  destroyed = false;
  backpressure = false;
  headers: Record<string, string> = {};
  /** @param status HTTP 状态。 @param headers HTTP 响应头。 @returns 当前响应。 */
  writeHead(status: number, headers: Record<string, string>): this { this.status = status; this.headers = headers; return this; }
  /** @returns 无返回值；fake 不需要真实刷新响应头。 */
  flushHeaders(): void {}
  /** @param text SSE 内容。 @returns 是否还有缓冲空间。 */
  write(text: string): boolean { this.chunks.push(text); return !this.backpressure; }
  /** @param text 可选响应尾部。 @returns 当前响应。 */
  end(text?: string): this { if (text) this.chunks.push(text); this.writableEnded = true; this.emit('finish'); return this; }
  /** @returns 当前响应；模拟套接字关闭。 */
  destroy(): this { this.destroyed = true; this.emit('close'); return this; }
  /** @returns 类型兼容的 HTTP 响应替身。 */
  asResponse(): ServerResponse { return this as unknown as ServerResponse; }
}

/** @returns 合法 GET 请求替身，不会真实建立网络连接。 */
function fakeRequest(): IncomingMessage {
  return Object.assign(new EventEmitter(), { method: 'GET', aborted: false }) as IncomingMessage;
}

/** @param response SSE 响应替身。 @returns 解码后的全部统一事件。 */
function streamEvents(response: FakeResponse): MarketStreamEvent[] {
  return response.chunks.filter((chunk) => chunk.startsWith('data: ')).map((chunk) => parseStreamEvent(JSON.parse(chunk.slice(6).trim())));
}

test('SSE 忽略普通 request.close，heartbeat15s，断开释放监听，最多12个客户端', (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  let released = 0;
  let subscribed = 0;
  const hub = new MarketStreamHub({ bridge: {
    subscribe: () => { subscribed += 1; return () => { released += 1; }; }, close: () => undefined,
  } });
  const request = fakeRequest();
  const response = new FakeResponse();
  try {
    hub.open(request, response.asResponse(), SYMBOL, 'day');
    request.emit('close');
    assert.equal(released, 0);
    assert.equal(response.destroyed, false);
    context.mock.timers.tick(15_000);
    assert.ok(response.chunks.includes(': heartbeat\n\n'));
    for (let index = 1; index < 12; index += 1) hub.open(fakeRequest(), new FakeResponse().asResponse(), SYMBOL, 'day');
    const rejected = new FakeResponse();
    hub.open(fakeRequest(), rejected.asResponse(), SYMBOL, 'day');
    assert.equal(rejected.status, 429);
    assert.equal(subscribed, 12);
    response.emit('close');
    assert.equal(released, 1);
    assert.equal(request.listenerCount('aborted'), 0);
    assert.equal(response.listenerCount('error'), 0);
    assert.equal(response.listenerCount('finish'), 0);
    hub.close();
    assert.equal(released, 12);
    const count = response.chunks.length;
    context.mock.timers.tick(60_000);
    assert.equal(response.chunks.length, count);
  } finally { hub.close(); context.mock.timers.reset(); }
});

test('SSE write 背压已接受正常大帧，缓冲超限时释放订阅', () => {
  let released = 0;
  let emit: ((event: MarketStreamEvent) => void) | undefined;
  const hub = new MarketStreamHub({ bridge: {
    subscribe: (_symbol, _period, callback) => {
      emit = callback;
      callback({ type: 'status', symbol: SYMBOL, state: 'connecting', message: '正在连接' });
      return () => { released += 1; };
    }, close: () => undefined,
  } });
  try {
    const response = new FakeResponse();
    hub.open(fakeRequest(), response.asResponse(), SYMBOL, 'day');
    response.backpressure = true;
    const thousandCandles = Array.from({ length: 1000 }, (_entry, index) => ({
      time: Date.parse(TIME) / 1000 + index * 60, open: 10, high: 12, low: 9, close: 11, volume: 123, confirmed: true,
    }));
    emit!({ type: 'candles', symbol: SYMBOL, period: 'day', candles: thousandCandles, receivedAt: TIME });
    assert.ok(Buffer.byteLength(response.chunks.at(-1)!) > 16 * 1024);
    assert.equal(streamEvents(response).at(-1)?.type, 'candles');
    assert.equal(response.destroyed, false);
    assert.equal(released, 0);
    response.writableLength = 256 * 1024;
    emit!({ type: 'status', symbol: SYMBOL, state: 'connected', message: '缓冲已满' });
    assert.equal(response.destroyed, true);
    assert.equal(released, 1);
    const overLimit = new FakeResponse();
    hub.open(fakeRequest(), overLimit.asResponse(), SYMBOL, 'day');
    overLimit.writableLength = 256 * 1024;
    emit!({ type: 'status', symbol: SYMBOL, state: 'connected', message: '已连接' });
    assert.equal(overLimit.destroyed, true);
    assert.equal(released, 2);
  } finally { hub.close(); }
});

test('SSE 同步订阅回调内断开仍清理刚返回的取消函数', () => {
  let released = 0;
  const response = new FakeResponse();
  const hub = new MarketStreamHub({ bridge: {
    subscribe: (_symbol, _period, callback) => {
      response.writableLength = 256 * 1024;
      callback({ type: 'status', symbol: SYMBOL, state: 'connecting', message: '连接中' });
      return () => { released += 1; };
    }, close: () => undefined,
  } });
  try {
    const request = fakeRequest();
    hub.open(request, response.asResponse(), SYMBOL, 'day');
    assert.equal(response.destroyed, true);
    assert.equal(released, 1);
    assert.equal(request.listenerCount('aborted'), 0);
    assert.equal(response.listenerCount('close'), 0);
  } finally { hub.close(); }
});

test('SSE native connected 优先报价，失败切换 CLI，报价时间跨通道不回退', () => {
  let native: (event: MarketStreamEvent) => void = () => undefined;
  let cli: (event: MarketStreamEvent) => void = () => undefined;
  let released = 0;
  const hub = new MarketStreamHub({ bridge: {
    subscribe: (_symbol, _period, callback) => { cli = callback; return () => { released += 1; }; }, close: () => undefined,
  }, nativeQuoteProvider: (_symbol, callback) => { native = callback; return () => { released += 1; }; } });
  const response = new FakeResponse();
  try {
    hub.open(fakeRequest(), response.asResponse(), SYMBOL, 'day');
    cli({ type: 'status', symbol: SYMBOL, state: 'connected', message: 'CLI订阅已完成' });
    native({ type: 'status', symbol: SYMBOL, state: 'connecting', message: '正在启动' });
    const fallbackStatus = streamEvents(response).at(-1)!;
    assert.equal(fallbackStatus.type === 'status' ? fallbackStatus.state : null, 'connected');
    native({ type: 'status', symbol: SYMBOL, state: 'connected', message: '已连接' });
    const quote = { symbol: SYMBOL, timestamp: Date.parse(TIME) / 1000, price: 10, previousClose: 9, session: 'regular' as const };
    cli({ type: 'quote', quote });
    native({ type: 'quote', quote: { ...quote, timestamp: quote.timestamp + 10, price: 11 } });
    assert.equal(quotes(streamEvents(response)).length, 1);
    native({ type: 'status', symbol: SYMBOL, state: 'error', message: '已断开' });
    cli({ type: 'quote', quote });
    assert.equal(quotes(streamEvents(response)).length, 1);
    cli({ type: 'quote', quote: { ...quote, timestamp: quote.timestamp + 20, price: 12 } });
    assert.equal(quotes(streamEvents(response)).at(-1)?.price, 12);
    hub.close();
    assert.equal(released, 2);
  } finally { hub.close(); }
});
