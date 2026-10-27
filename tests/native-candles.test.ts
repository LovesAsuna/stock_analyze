import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { optionIdentity, findCounter, desktopGet, readCandles, candleRows } = require('../server/native/candles.cjs');
const symbol = 'AAPL261218C00200000.US';
const counter = 'OP/US/AAPL261218C00200000';
const request = { symbol, period: 'day', count: 3 };
const rawRow = { timestamp: '1800000000', open: '1.5', high: '2', low: '1', close: '1.8', amount: '25' };
const normalizedRow = { timestamp: 1800000000, open: 1.5, high: 2, low: 1, close: 1.8, volume: 25 };
const datePath = '/v4/gemini/optionchain-date-list';
const chainPath = '/v4/gemini/option-list';
const klinePath = '/v3/quote/kline';

/** 创建可控内存任务。参数：无；返回：Promise及完成函数。 */
function deferred() {
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<any>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** 排空异步任务队列。参数：无；返回：下一事件循环Promise。 */
async function flush(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }

/** 构造纯内存桌面会话。参数：无；返回：假worker、请求记录及可替换响应，不加载原生引擎。 */
function fixture() {
  const httpCalls: { method: string; path: string; params: any; headers: string; context: unknown }[] = [];
  const wsCalls: { params: any; context: unknown }[] = [];
  const searchCalls: any[] = [];
  const logs: any[] = [];
  const replies = new Map<string, any>([
    [datePath, { expire_date_list: [{ expire_date: '20261218', standard_attr: 'S' }] }],
    [chainPath, { strike_price: [{ price: '200', call_counter_id: counter, put_counter_id: 'OP/US/AAPL261218P00200000' }] }],
    [klinePath, { counter_id: counter, klines: [rawRow] }],
  ]);
  const worker = {
    authenticated: true, generation: 1, subscriptionGeneration: 1,
    socket: {}, httpClient: {}, targets: new Map<string, { counter: string }>(), connections: 0,
    /** 记录连接调用。参数：无；返回：无。 */
    connect() { this.connections += 1; },
    /** 记录安全日志。参数：event事件、data日志；返回：无。 */
    send(event: string, data: unknown) { logs.push({ event, data }); },
    native: {
      /** 记录精确搜索。参数：raw搜索JSON；返回：只含标的的搜索结果。 */
      async searchSecurities(raw: string): Promise<any> {
        searchCalls.push(JSON.parse(raw));
        return { code: 0, data: [{ code: 'AAPL', market: 'US', counter_id: 'ST/US/AAPL' }] };
      },
      /** 记录WS请求及绑定。参数：raw参数JSON；返回：模拟柱。 */
      async quoteKline(this: unknown, raw: string): Promise<any> {
        wsCalls.push({ params: JSON.parse(raw), context: this });
        return { code: 0, data: { counter_id: counter, klines: [rawRow] } };
      },
      /** 记录HTTP请求及绑定。参数：method、path、raw、headers；返回：模拟信封。 */
      async httpRequest(this: unknown, method: string, path: string, raw: string, headers: string): Promise<any> {
        httpCalls.push({ method, path, params: JSON.parse(raw), headers, context: this });
        return { status: 200, body: JSON.stringify({ code: 0, data: replies.get(path) }) };
      },
    },
  };
  return { worker, httpCalls, wsCalls, searchCalls, logs, replies };
}

test('实时读取返回实际WS或HTTP来源，普通历史页仍返回原数组', async () => {
  const { worker } = fixture();
  assert.deepEqual(await readCandles(worker, { ...request, withTransport: true }), { rows: [normalizedRow], transport: 'desktop-ws' });
  worker.native.quoteKline = async () => { throw new Error('synthetic WS failure'); };
  assert.deepEqual(await readCandles(worker, { ...request, withTransport: true }), { rows: [normalizedRow], transport: 'desktop-http' });
  assert.deepEqual(await readCandles(worker, request), [normalizedRow]);
});

test('期权身份保留根代码、方向和千分行权价，验证真实日历及安全整数', () => {
  assert.deepEqual(optionIdentity(symbol), { root: 'AAPL', date: '20261218', direction: 'C', strike: 200000 });
  assert.deepEqual(optionIdentity('BRK.B280229P00000500.US'), { root: 'BRK.B', date: '20280229', direction: 'P', strike: 500 });
  assert.equal(optionIdentity('AAPL.US'), null);
  assert.equal(optionIdentity(null), null);
  assert.equal(optionIdentity({ toString: () => symbol }), null);
  for (const invalid of ['AAPL260229C00200000.US', 'AAPL261332C00200000.US', 'AAPL261218C00000000.US', 'A261218C9007199254740993.US']) {
    assert.throws(() => optionIdentity(invalid), /到期日或行权价无效/, invalid);
  }
});

test('通过真实链的日期和standard_attr查找精确合约，不猜测counter前缀', async () => {
  const { worker, httpCalls, searchCalls, replies } = fixture();
  replies.set(datePath, { expire_date_list: [
    null, { expire_date: '20261211', standard_attr: 'W' },
    { expire_date: '20261218', standard_attr: 'S' }, { expire_date: '20261218', standard_attr: 'S' },
    { expire_date: '20261218', standard_attr: 'NS_1' }, { expire_date: '20261218', standard_attr: '../' },
  ] });
  assert.equal(await findCounter(worker, ' aapl261218c00200000.us '), counter);
  assert.deepEqual(searchCalls, [{ term: 'AAPL', markets: ['US'], products: [], is_code_exact_match: true, limit: 100 }]);
  assert.deepEqual(httpCalls.map(call => [call.path, call.params]), [
    [datePath, { underlying_counter_id: 'ST/US/AAPL' }],
    [chainPath, { underlying_counter_id: 'ST/US/AAPL', expire_date: '20261218', standard_attr: 'S' }],
    [chainPath, { underlying_counter_id: 'ST/US/AAPL', expire_date: '20261218', standard_attr: 'NS_1' }],
  ]);
  assert.ok(httpCalls.every(call => call.method === 'GET' && call.context === worker.httpClient && call.headers === '{}'));
});

test('put从put列匹配，普通证券沿用严格搜索且不读取期权链', async () => {
  const { worker, httpCalls } = fixture();
  assert.equal(await findCounter(worker, symbol.replace('C002', 'P002')), 'OP/US/AAPL261218P00200000');
  httpCalls.length = 0;
  assert.equal(await findCounter(worker, 'AAPL.US'), 'ST/US/AAPL');
  assert.deepEqual(httpCalls, []);
});

test('拒绝标的搜索的市场、代码、counter冲突', async () => {
  const badRows = [
    [{ code: 'AAPL', market: 'HK', counter_id: 'ST/HK/AAPL' }],
    [{ code: 'AAP', market: 'US', counter_id: 'ST/US/AAP' }],
    [{ code: 'AAPL', market: 'US', counter_id: 'ST/US/MSFT' }],
    [{ code: 'AAPL', market: 'US', counter_id: 'ST/US/AAPL' }, { code: 'AAPL', market: 'US', counter_id: 'ETF/US/AAPL' }],
  ];
  for (const data of badRows) {
    const { worker, httpCalls } = fixture();
    worker.native.searchSecurities = async () => ({ data });
    await assert.rejects(findCounter(worker, symbol), /未找到|多个/);
    assert.deepEqual(httpCalls, []);
  }
});

test('拒绝缺失、畸形、不匹配日期及过多standard_attr', async () => {
  for (const dates of [
    {}, { expire_date_list: {} }, { expire_date_list: [] },
    { expire_date_list: [{ expire_date: '2026-12-18', standard_attr: 'S' }] },
    { expire_date_list: [{ expire_date: '20261218', standard_attr: 1 }] },
    { expire_date_list: [{ expire_date: '20261218', standard_attr: 'bad/path' }] },
    { expire_date_list: ['S', 'W', 'A', 'B', 'C'].map(standard_attr => ({ expire_date: '20261218', standard_attr })) },
  ]) {
    const { worker, replies, httpCalls } = fixture(); replies.set(datePath, dates);
    await assert.rejects(findCounter(worker, symbol), /到期日/);
    assert.equal(httpCalls.length, 1);
  }
});

test('期权链必须完整精确匹配根、日期、方向、行权价、前缀及原始代码', async () => {
  const wrongCounters = [
    'ST/US/AAPL261218C00200000', 'OP/HK/AAPL261218C00200000',
    'OP/US/MSFT261218C00200000', 'OP/US/AAPL261211C00200000',
    'OP/US/AAPL261218P00200000', 'OP/US/AAPL261218C00210000',
    'OP/US/AAPL261218C200000', 'OP/US/AAPL1261218C00200000',
  ];
  for (const call_counter_id of wrongCounters) {
    const { worker, replies } = fixture();
    replies.set(chainPath, { strike_price: [{ price: 200, call_counter_id }] });
    await assert.rejects(findCounter(worker, symbol), /唯一精确合约/, call_counter_id);
  }
  for (const price of [201, '', null, true, {}, Infinity]) {
    const { worker, replies } = fixture();
    replies.set(chainPath, { strike_price: [{ price, call_counter_id: counter }] });
    await assert.rejects(findCounter(worker, symbol), /唯一精确合约/);
  }
});

test('空期权链和畸形行均不伪造合约，重复精确行只返回一个counter', async () => {
  for (const chain of [{}, { strike_price: {} }, { strike_price: [] }, { strike_price: [null, {}, { call_counter_id: 42 }] }]) {
    const { worker, replies } = fixture(); replies.set(chainPath, chain);
    await assert.rejects(findCounter(worker, symbol), /结构无效|唯一精确合约/);
  }
  const { worker, replies } = fixture();
  replies.set(chainPath, { strike_price: [1, 2].map(() => ({ price: 200, call_counter_id: counter })) });
  assert.equal(await findCounter(worker, symbol), counter);
});

test('HTTP仅允许固定只读路径，拒绝未初始化客户端及失败信封', async () => {
  const { worker, httpCalls } = fixture();
  await assert.rejects(desktopGet(worker, '/v1/account', {}), /不支持/);
  assert.deepEqual(httpCalls, []);
  for (const result of [
    { status: 403, body: '{"code":0,"data":{"klines":[]}}' },
    { status_code: 500, body: '{"code":0}' },
    { code: 7, body: '{"code":0}' }, { body: '{"code":"7"}' },
    { body: 'invalid json' }, { body: '{"code":0,"data":null}' },
  ]) {
    worker.native.httpRequest = async () => result;
    await assert.rejects(desktopGet(worker, klinePath, {}));
  }
  worker.httpClient = null as any;
  await assert.rejects(desktopGet(worker, klinePath, {}), /未初始化/);
});

test('HTTP兼容直接和嵌套JSON信封，但不编造空数据', async () => {
  const { worker } = fixture();
  for (const result of [{ code: '0', data: { klines: [] } }, JSON.stringify({ body: JSON.stringify({ code: 0, data: { klines: [] } }) })]) {
    worker.native.httpRequest = async () => result;
    assert.deepEqual(await desktopGet(worker, klinePath, {}), { klines: [] });
  }
});

test('amount映射volume、volume零值优先，保留原始OHLCV而不使用turnover', () => {
  assert.deepEqual(candleRows({ klines: [rawRow] }, 3), [normalizedRow]);
  assert.deepEqual(candleRows({ klines: [{ ...rawRow, volume: '0', amount: '99', turnover: '500' }] }, 1), [{ ...normalizedRow, volume: 0 }]);
  assert.throws(() => candleRows({ klines: [{ ...rawRow, amount: undefined, turnover: 99 }] }, 1), /volume/);
  assert.deepEqual(candleRows({ klines: [{ ...rawRow, volume: null }] }, 1), [normalizedRow]);
  assert.throws(() => candleRows({ klines: [{ ...rawRow, volume: null, amount: null }] }, 1), /volume/);
  assert.deepEqual(candleRows({ klines: [] }, 3), []);
});

test('每个OHLCV字段拒绝缺失、空值、布尔、对象、非有限值及非十进制字符串', () => {
  for (const key of ['timestamp', 'open', 'high', 'low', 'close', 'amount']) {
    for (const value of [undefined, null, '', ' ', true, {}, [], NaN, Infinity, 'Infinity', 'NaN', '0x10']) {
      assert.throws(() => candleRows({ klines: [{ ...rawRow, [key]: value }] }, 1), /字段无效|价格或时间无效/, `${key}: ${String(value)}`);
    }
  }
});

test('拒绝非法OHLC关系、负量、时间和数量及空洞行', () => {
  for (const patch of [
    { timestamp: 0 }, { timestamp: -1 }, { timestamp: 1.5 }, { timestamp: Number.MAX_SAFE_INTEGER + 1 },
    { open: 0 }, { close: -1 }, { low: 0 }, { high: 1.4 }, { low: 1.6 }, { amount: -1 },
  ]) assert.throws(() => candleRows({ klines: [{ ...rawRow, ...patch }] }, 1), /价格或时间无效/);
  for (const klines of [null, {}, [null], [[]], new Array(1)]) assert.throws(() => candleRows({ klines }, 1));
  for (const count of [0, -1, 1001, 1.5, '1']) assert.throws(() => candleRows({ klines: [] }, count), /数量无效/);
  assert.throws(() => candleRows({ klines: [rawRow, rawRow] }, 1), /数量无效/);
  assert.throws(() => candleRows({ counter_id: 'OP/US/OTHER', klines: [] }, 1, counter), /身份不匹配/);
});

test('成功WS请求绑定socket并使用完整固定参数，精确缓存无需重查链', async () => {
  const { worker, wsCalls, httpCalls, searchCalls, logs } = fixture();
  worker.targets.set(symbol, { counter });
  assert.deepEqual(await readCandles(worker, { ...request, timestamp: '1799999999' }), [normalizedRow]);
  assert.deepEqual(wsCalls, [{ context: worker.socket, params: {
    counter_id: counter, line_type: 1000, line_num: 3, adjust_type: 0, kline_session: 0,
    timestamp: '1799999999', direction: 0, include_turnover_rate: true,
  } }]);
  assert.deepEqual(httpCalls, []); assert.deepEqual(searchCalls, []); assert.deepEqual(logs, []);
});

test('正股ETF与港股复用桌面K线，不查询期权链或CLI', async () => {
  for (const [security, nativeCounter] of [['AAPL.US', 'ST/US/AAPL'], ['QQQ.US', 'ETF/US/QQQ'], ['700.HK', 'ST/HK/00700']]) {
    const { worker, wsCalls, httpCalls, searchCalls } = fixture();
    worker.native.searchSecurities = async raw => {
      searchCalls.push(JSON.parse(raw));
      return { data: [{ code: nativeCounter.split('/')[2], market: security.slice(-2), counter_id: nativeCounter }] };
    };
    worker.native.quoteKline = async raw => { wsCalls.push({ context: worker.socket, params: JSON.parse(raw) }); return { data: { counter_id: nativeCounter, klines: [rawRow] } }; };
    assert.deepEqual(await readCandles(worker, { symbol: security, period: '15m', count: 3 }), [normalizedRow]);
    assert.equal(wsCalls[0].params.counter_id, nativeCounter); assert.equal(httpCalls.length, 0);
    worker.targets.set(security, { counter: nativeCounter });
    await readCandles(worker, { symbol: security, period: 'day', count: 3 });
    assert.equal(searchCalls.length, 1);
  }
});

test('错误缓存counter不能发往WS，必须重新从期权链验证', async () => {
  for (const cached of ['ST/US/AAPL', 'OP/US/AAPL261218P00200000', 'OP/US/AAPL261218C200000']) {
    const { worker, wsCalls, searchCalls } = fixture(); worker.targets.set(symbol, { counter: cached });
    assert.deepEqual(await readCandles(worker, request), [normalizedRow]);
    assert.equal(searchCalls.length, 1); assert.equal(wsCalls[0].params.counter_id, counter);
  }
});

test('WS异常、错误码、格式错误、错误身份和非法柱均回退HTTP且保留相同参数', async () => {
  const failures: (() => any)[] = [
    () => { throw new Error('synthetic private response'); },
    () => Promise.reject(new Error('synthetic rejection')),
    () => '{broken', () => null, () => ({ code: 7 }),
    () => ({ code: 0, data: null }), () => ({ code: 0, data: {} }),
    () => ({ data: { klines: [{ ...rawRow, high: 0 }] } }),
    () => ({ data: { counter_id: 'OP/US/OTHER', klines: [rawRow] } }),
  ];
  for (const fail of failures) {
    const { worker, httpCalls, logs } = fixture(); worker.targets.set(symbol, { counter });
    const calls: any[] = [];
    worker.native.quoteKline = async raw => { calls.push(JSON.parse(raw)); return fail(); };
    assert.deepEqual(await readCandles(worker, request), [normalizedRow]);
    assert.equal(httpCalls.length, 1); assert.equal(httpCalls[0].path, klinePath);
    assert.deepEqual(httpCalls[0].params, { ...calls[0], new_version_kline: true });
    assert.deepEqual(logs, [{ event: 'log', data: { kind: 'info', message: 'K线WS请求失败，使用桌面HTTP回退' } }]);
  }
});

test('WS超时后执行HTTP回退，迟到WS不能覆盖结果', { timeout: 10000 }, async () => {
  const { worker, httpCalls } = fixture(); worker.targets.set(symbol, { counter }); const job = deferred();
  worker.native.quoteKline = async () => job.promise;
  // withTimeout使用unref，测试单独运行时用有界计时器保留事件循环。
  const keepAlive = setTimeout(() => {}, 7000);
  try {
    assert.deepEqual(await readCandles(worker, request), [normalizedRow]);
    assert.equal(httpCalls.length, 1); assert.equal(httpCalls[0].path, klinePath);
    job.resolve({ data: { klines: [{ ...rawRow, close: '999' }] } });
    await flush(); assert.equal(httpCalls.length, 1);
  } finally { clearTimeout(keepAlive); }
});

test('WS空数组保持为空且不触发HTTP，HTTP空数组也不伪造蜡烛', async () => {
  const { worker, httpCalls, replies } = fixture(); worker.targets.set(symbol, { counter });
  worker.native.quoteKline = async () => ({ data: { klines: [] } });
  assert.deepEqual(await readCandles(worker, request), []); assert.deepEqual(httpCalls, []);
  worker.native.quoteKline = async () => { throw new Error('synthetic'); };
  replies.set(klinePath, { klines: [] });
  assert.deepEqual(await readCandles(worker, request), []); assert.equal(httpCalls.length, 1);
});

test('HTTP回退错误和非法柱向上传播，不返回部分数据', async () => {
  for (const reply of [{}, { klines: [rawRow, { ...rawRow, close: 9 }] }, { counter_id: 'OP/US/OTHER', klines: [] }]) {
    const { worker, replies } = fixture(); worker.targets.set(symbol, { counter });
    worker.native.quoteKline = async () => { throw new Error('synthetic'); }; replies.set(klinePath, reply);
    await assert.rejects(readCandles(worker, request), /数量无效|价格或时间无效|身份不匹配/);
  }
  const { worker } = fixture(); worker.targets.set(symbol, { counter });
  worker.native.quoteKline = async () => { throw new Error('synthetic WS failure'); };
  worker.native.httpRequest = async () => { throw new Error('synthetic HTTP failure'); };
  await assert.rejects(readCandles(worker, request), /synthetic HTTP failure/);
});

test('参数边界在连接前拒绝：symbol、period、count、timestamp均需明确类型', async () => {
  const invalid: any[] = [null, {}, { ...request, symbol: 'AAPL.SH' }, { ...request, symbol: 'AAPL261332C00200000.US' }];
  for (const period of ['quarter', 'toString', '__proto__', '', ['day'], { toString: () => 'day' }, null]) invalid.push({ ...request, period });
  for (const count of [0, -1, 1001, 1.5, '3', NaN, Infinity, null]) invalid.push({ ...request, count });
  for (const timestamp of ['', '-1', '1.5', '1234567890123', ' 123', 123, null, {}, ['123']]) invalid.push({ ...request, timestamp });
  const { worker, wsCalls, httpCalls, searchCalls } = fixture();
  for (const payload of invalid) await assert.rejects(readCandles(worker, payload));
  assert.equal(worker.connections, 0); assert.deepEqual(wsCalls, []); assert.deepEqual(httpCalls, []); assert.deepEqual(searchCalls, []);
});

test('支持的周期和边界count、timestamp准确映射到协议', async () => {
  const periods = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, day: 1000, week: 2000, month: 3000, year: 4000 };
  const { worker, wsCalls } = fixture(); worker.targets.set(symbol, { counter });
  for (const [period, lineType] of Object.entries(periods)) {
    await readCandles(worker, { ...request, period, count: 1, timestamp: '0' });
    assert.equal(wsCalls.at(-1)?.params.line_type, lineType);
  }
  await readCandles(worker, { ...request, count: 1000, timestamp: '999999999999' });
  assert.equal(wsCalls.at(-1)?.params.line_num, 1000);
  assert.equal(wsCalls.at(-1)?.params.timestamp, '999999999999');
});

test('搜索、日期或链响应期间连接代和订阅代变化后，不再请求后续阶段', async () => {
  for (const stage of ['search', datePath, chainPath]) {
    for (const changed of ['generation', 'subscriptionGeneration'] as const) {
      const { worker, wsCalls, httpCalls } = fixture(); const job = deferred();
      if (stage === 'search') worker.native.searchSecurities = async () => job.promise;
      else {
        const httpRequest = worker.native.httpRequest;
        worker.native.httpRequest = async function (...args) {
          const result = await httpRequest.apply(worker.httpClient, args);
          if (args[1] !== stage) return result;
          await job.promise; return result;
        };
      }
      const pending = readCandles(worker, request); const rejection = assert.rejects(pending, /会话已切换/);
      await flush(); worker[changed] += 1;
      job.resolve({ data: [{ code: 'AAPL', market: 'US', counter_id: 'ST/US/AAPL' }] });
      await rejection; assert.deepEqual(wsCalls, []);
      assert.equal(httpCalls.length, stage === 'search' ? 0 : stage === datePath ? 1 : 2);
    }
  }
});

test('WS迟到成功或失败均拒绝过期会话，且不发起HTTP回退', async () => {
  for (const change of ['generation', 'subscriptionGeneration', 'authenticated', 'socket']) {
    for (const failure of [false, true]) {
      const { worker, httpCalls, logs } = fixture(); worker.targets.set(symbol, { counter }); const job = deferred();
      worker.native.quoteKline = async () => job.promise;
      const pending = readCandles(worker, request); const rejection = assert.rejects(pending, /会话已切换/);
      await flush();
      if (change === 'generation') worker.generation += 1;
      else if (change === 'subscriptionGeneration') worker.subscriptionGeneration += 1;
      else if (change === 'authenticated') worker.authenticated = false;
      else worker.socket = {};
      if (failure) job.reject(new Error('synthetic'));
      else job.resolve({ data: { klines: [rawRow] } });
      await rejection; assert.deepEqual(httpCalls, []); assert.deepEqual(logs, []);
    }
  }
});

test('HTTP回退中的代际变化也拒绝迟到结果', async () => {
  for (const changed of ['generation', 'subscriptionGeneration'] as const) {
    const { worker } = fixture(); worker.targets.set(symbol, { counter }); const job = deferred();
    worker.native.quoteKline = async () => { throw new Error('synthetic'); };
    worker.native.httpRequest = async () => job.promise;
    const pending = readCandles(worker, request); const rejection = assert.rejects(pending, /会话已切换/);
    await flush(); worker[changed] += 1; job.resolve({ data: { klines: [rawRow] } });
    await rejection;
  }
});

test('等待协议认证后才能读取，等待期间订阅代变化必须拒绝', async () => {
  const { worker, wsCalls } = fixture(); worker.targets.set(symbol, { counter }); worker.authenticated = false;
  const pending = readCandles(worker, request); assert.deepEqual(wsCalls, []);
  worker.authenticated = true; assert.deepEqual(await pending, [normalizedRow]);
  worker.authenticated = false;
  const stale = readCandles(worker, request); const rejection = assert.rejects(stale, /连接已切换/);
  worker.subscriptionGeneration += 1; worker.authenticated = true;
  await rejection; assert.equal(wsCalls.length, 1);
});
