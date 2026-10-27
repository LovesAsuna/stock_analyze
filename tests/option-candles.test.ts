import test from 'node:test';
import assert from 'node:assert/strict';
import { isOptionSymbol, desktopCandles, desktopHistory, subscribeDesktopCandles, type ReadPage } from '../server/desktop-candles.js';
import type { MarketStreamEvent } from '../shared/realtime.js';

type RawCandle = Awaited<ReturnType<ReadPage>>[number];
const SYMBOL = 'AAPL261218C200000.US';
const FIRST = Date.parse('2026-01-01T00:00:00Z') / 1000;

/** 创建有效原生柱。参数：Unix秒时间和可选收盘价；返回：原始OHLCV。 */
function candle(timestamp: number, close = 10): RawCandle {
  return { timestamp, open: 10, high: 12, low: 8, close, volume: 100 };
}

/** 创建可逆序的完整历史页。参数：最早Unix秒、数量；返回：连续秒原始柱数组。 */
function page(earliest: number, count = 1000): RawCandle[] {
  return Array.from({ length: count }, (_, index) => candle(earliest + index));
}

/** 创建可控异步读取。参数：无；返回：页Promise及完成和失败函数。 */
function deferred() {
  let resolve!: (rows: RawCandle[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<RawCandle[]>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** 清空异步轮询微任务。参数：无；返回：下一事件循环的Promise。 */
async function flush(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }

test('识别美股期权而不匹配普通股票', () => {
  assert.equal(isOptionSymbol(SYMBOL), true);
  assert.equal(isOptionSymbol('BRK.B261218P200000.US'), true);
  for (const symbol of ['AAPL.US', '700.HK', 'AAPL261218C200000.HK', 'AAPL261218X200000.US']) {
    assert.equal(isOptionSymbol(symbol), false);
  }
});

test('历史严格校验真实YYYY-MM-DD日期，拒绝前不读取', async () => {
  let reads = 0;
  const read: ReadPage = async () => { reads += 1; return []; };
  for (const start of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-01', '2026-01-00', '2026-1-01', '2026-01-1', '2026-01-01 ', '2026-01-01T00:00:00Z', 'invalid', '']) {
    await assert.rejects(desktopHistory(SYMBOL, 'day', start, read), /起始日期无效/);
  }
  assert.equal(reads, 0);
  assert.deepEqual(await desktopHistory(SYMBOL, 'day', '2024-02-29', async () => [candle(FIRST)]), [candle(FIRST)]);
});

test('历史按原始秒去重排序、过滤起始日前记录，游标取最早时间减一', async () => {
  const calls: Parameters<ReadPage>[0][] = [];
  const newest = { ...candle(FIRST + 2999, 11), timestamp: String(FIRST + 2999) };
  const pages = [
    [...page(FIRST + 2000, 999), newest].reverse(),
    [candle(FIRST + 2999, 9), ...page(FIRST + 1001, 999)],
    [candle(FIRST - 1), candle(FIRST), candle(FIRST + 1001)],
  ];
  const read: ReadPage = async payload => { calls.push(payload); return pages[calls.length - 1]; };
  const result = await desktopHistory(SYMBOL, '1m', '2026-01-01', read);
  assert.deepEqual(calls, [
    { symbol: SYMBOL, period: '1m', count: 1000 },
    { symbol: SYMBOL, period: '1m', count: 1000, timestamp: String(FIRST + 1999) },
    { symbol: SYMBOL, period: '1m', count: 1000, timestamp: String(FIRST + 1000) },
  ]);
  assert.equal(result.length, 2000);
  assert.equal(result[0].timestamp, FIRST);
  assert.equal(result.at(-1), newest);
  assert.equal(new Set(result.map(row => Number(row.timestamp))).size, result.length);
  assert.ok(result.every((row, index) => !index || Number(result[index - 1].timestamp) < Number(row.timestamp)));
});

test('后页最早时间不前进时即使是短页也失败', async () => {
  for (const offset of [0, 1, 1000]) {
    let reads = 0;
    const read: ReadPage = async () => ++reads === 1 ? page(FIRST + 2000) : [candle(FIRST + 2000 + offset)];
    await assert.rejects(desktopHistory(SYMBOL, '1m', '2026-01-01', read), /游标未前进/);
    assert.equal(reads, 2);
  }
});

test('后页最早时间恰好等于秒游标时允许前进', async () => {
  let reads = 0;
  const read: ReadPage = async () => ++reads === 1 ? page(FIRST + 2000) : [candle(FIRST + 1999)];
  const result = await desktopHistory(SYMBOL, '1m', '2026-01-01', read);
  assert.equal(reads, 2);
  assert.equal(result.length, 1001);
  assert.equal(result[0].timestamp, FIRST + 1999);
});

test('满页到达起始日停止，不再请求下一页', async () => {
  let reads = 0;
  const read: ReadPage = async () => { reads += 1; return page(FIRST - 1); };
  const result = await desktopHistory(SYMBOL, '1m', '2026-01-01', read);
  assert.equal(reads, 1);
  assert.equal(result.length, 999);
  assert.equal(result[0].timestamp, FIRST);
});

test('空首页与近期空页均明确失败，不伪造K线；后续空页终止', async () => {
  const empty: ReadPage = async () => [];
  await assert.rejects(desktopHistory(SYMBOL, 'day', '2026-01-01', empty), /未返回该期权K线/);
  await assert.rejects(desktopCandles(SYMBOL, 'day', 1000, empty), /未返回该期权K线/);
  let reads = 0;
  const read: ReadPage = async () => ++reads === 1 ? page(FIRST + 1000) : [];
  assert.equal((await desktopHistory(SYMBOL, '1m', '2026-01-01', read)).length, 1000);
  assert.equal(reads, 2);
});

test('历史限制48页，未完成窗口明确失败且不发出第49次读取', async () => {
  let reads = 0;
  const read: ReadPage = async () => { reads += 1; return page(FIRST + 100000 - reads * 1000); };
  await assert.rejects(desktopHistory(SYMBOL, '1m', '2026-01-01', read), /超过48页/);
  assert.equal(reads, 48);
});

test('第48页短页完成时正常返回', async () => {
  let reads = 0;
  const read: ReadPage = async () => { reads += 1; return page(FIRST + 100000 - reads * 1000, reads === 48 ? 1 : 1000); };
  assert.equal((await desktopHistory(SYMBOL, '1m', '2026-01-01', read)).length, 47001);
  assert.equal(reads, 48);
});

test('第48页满页恰好触及起始日时成功，不误报上限', async () => {
  let reads = 0;
  const read: ReadPage = async () => { reads += 1; return page(FIRST + (48 - reads) * 1000); };
  const result = await desktopHistory(SYMBOL, '1m', '2026-01-01', read);
  assert.equal(reads, 48);
  assert.equal(result.length, 48000);
  assert.equal(result[0].timestamp, FIRST);
});

test('季度近期和历史均请求月线，近期以真实月线聚合', async () => {
  const months = [1, 2, 3].map(month => candle(Date.parse(`2025-0${month}-02T15:00:00Z`) / 1000, month + 8));
  const calls: Parameters<ReadPage>[0][] = [];
  const read: ReadPage = async payload => { calls.push(payload); return months; };
  const result = await desktopCandles(SYMBOL, 'quarter', 12, read);
  assert.equal(result.length, 1);
  assert.equal(result[0].open, 10);
  assert.equal(result[0].close, 11);
  assert.equal(result[0].volume, 300);
  assert.equal(result[0].confirmed, true);
  assert.deepEqual(await desktopHistory(SYMBOL, 'quarter', '2025-01-01', read), months);
  assert.deepEqual(calls.map(payload => [payload.period, payload.count]), [['month', 12], ['month', 1000]]);
});

test('无效原始柱、非整数秒和超大历史页失败，不继续分页', async () => {
  const invalid = [
    [{ ...candle(FIRST), high: 1 }],
    [{ ...candle(FIRST), timestamp: 'not-a-time' }],
    [candle(FIRST + 0.5)],
    [{ ...candle(FIRST), timestamp: true }],
    page(FIRST, 1001),
  ];
  for (const rows of invalid) {
    let reads = 0;
    await assert.rejects(desktopHistory(SYMBOL, 'day', '2026-01-01', async () => { reads += 1; return rows; }));
    assert.equal(reads, 1);
  }
  await assert.rejects(desktopHistory(SYMBOL, 'day', '2026-01-01', async () => { throw new Error('synthetic read failure'); }), /synthetic read failure/);
});

test('相同读取器证券周期共享轮询，完成后等待5秒且请求不重叠', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const jobs: ReturnType<typeof deferred>[] = [];
  const calls: Parameters<ReadPage>[0][] = [];
  const read: ReadPage = payload => { calls.push(payload); const job = deferred(); jobs.push(job); return job.promise; };
  const firstEvents: MarketStreamEvent[] = [];
  const secondEvents: MarketStreamEvent[] = [];
  const first = subscribeDesktopCandles(SYMBOL, 'day', event => firstEvents.push(event), read);
  const second = subscribeDesktopCandles(SYMBOL, 'day', event => secondEvents.push(event), read);
  try {
    await flush(); assert.equal(jobs.length, 1);
    context.mock.timers.tick(15000); await flush(); assert.equal(jobs.length, 1);
    jobs[0].resolve([candle(FIRST)]); await flush();
    assert.equal(firstEvents.length, 1); assert.equal(secondEvents.length, 1);
    assert.equal(firstEvents[0].type, 'candles');
    context.mock.timers.tick(4999); await flush(); assert.equal(jobs.length, 1);
    context.mock.timers.tick(1); await flush(); assert.equal(jobs.length, 2);
    first(); first();
    jobs[1].resolve([candle(FIRST + 60)]); await flush();
    assert.equal(firstEvents.length, 1); assert.equal(secondEvents.length, 2);
    assert.deepEqual(calls, Array(2).fill({ symbol: SYMBOL, period: 'day', count: 1000 }));
    second(); context.mock.timers.tick(60000); await flush(); assert.equal(jobs.length, 2);
  } finally { first(); second(); context.mock.timers.reset(); }
});

test('不同读取器、证券和周期使用独立轮询组', async () => {
  const calls: Parameters<ReadPage>[0][] = [];
  const first: ReadPage = async payload => { calls.push(payload); return [candle(FIRST)]; };
  const second: ReadPage = async payload => { calls.push(payload); return [candle(FIRST)]; };
  const events: MarketStreamEvent[] = [];
  const listener = (event: MarketStreamEvent): void => { events.push(event); };
  const releases = [
    subscribeDesktopCandles(SYMBOL, 'day', listener, first),
    subscribeDesktopCandles(SYMBOL, 'day', listener, second),
    subscribeDesktopCandles(SYMBOL, 'week', listener, first),
    subscribeDesktopCandles('AAPL261218P200000.US', 'day', listener, first),
  ];
  try { await flush(); assert.equal(calls.length, 4); assert.equal(events.length, 4); }
  finally { releases.forEach(release => release()); }
});

test('首轮微任务前取消不读取，重复取消不影响新组', async () => {
  let reads = 0;
  const read: ReadPage = async () => { reads += 1; return [candle(FIRST)]; };
  let cancelledEvents = 0;
  const first = subscribeDesktopCandles(SYMBOL, 'day', () => { cancelledEvents += 1; }, read);
  first(); first(); await flush(); assert.equal(reads, 0); assert.equal(cancelledEvents, 0);
  const events: MarketStreamEvent[] = [];
  const second = subscribeDesktopCandles(SYMBOL, 'day', event => events.push(event), read);
  try { first(); await flush(); assert.equal(reads, 1); assert.equal(events.length, 1); }
  finally { second(); }
});

test('在途读取期间部分退订仅移除该消费者', async () => {
  const job = deferred();
  let reads = 0;
  const read: ReadPage = () => { reads += 1; return job.promise; };
  let cancelledEvents = 0;
  const first = subscribeDesktopCandles(SYMBOL, 'day', () => { cancelledEvents += 1; }, read);
  const events: MarketStreamEvent[] = [];
  const second = subscribeDesktopCandles(SYMBOL, 'day', event => events.push(event), read);
  try {
    await flush(); first(); job.resolve([candle(FIRST)]); await flush();
    assert.equal(reads, 1); assert.equal(events.length, 1); assert.equal(cancelledEvents, 0);
  } finally { first(); second(); }
});

test('通知期间退订后续消费者不会继续向其发送结果', async () => {
  const read: ReadPage = async () => [candle(FIRST)];
  let second = (): void => {};
  let cancelledEvents = 0;
  const first = subscribeDesktopCandles(SYMBOL, 'day', () => second(), read);
  second = subscribeDesktopCandles(SYMBOL, 'day', () => { cancelledEvents += 1; }, read);
  try { await flush(); assert.equal(cancelledEvents, 0); }
  finally { first(); second(); }
});

test('最后退订后拒绝迟到成功和失败，新组不受旧组影响', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const warnings: unknown[][] = [];
  context.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const releases: (() => void)[] = [];
  try {
    for (const failure of [false, true]) {
      const jobs: ReturnType<typeof deferred>[] = [];
      const read: ReadPage = () => { const job = deferred(); jobs.push(job); return job.promise; };
      let oldEvents = 0;
      const old = subscribeDesktopCandles(SYMBOL, 'day', () => { oldEvents += 1; }, read);
      releases.push(old); await flush(); old();
      const events: MarketStreamEvent[] = [];
      const fresh = subscribeDesktopCandles(SYMBOL, 'day', event => events.push(event), read);
      releases.push(fresh); await flush();
      if (failure) jobs[0].reject(new Error('sensitive synthetic failure'));
      else jobs[0].resolve([candle(FIRST)]);
      await flush(); assert.equal(events.length, 0); assert.equal(oldEvents, 0); assert.equal(warnings.length, 0);
      jobs[1].resolve([candle(FIRST)]); await flush(); assert.equal(events.length, 1);
      fresh(); context.mock.timers.tick(60000); await flush(); assert.equal(jobs.length, 2);
    }
  } finally { releases.forEach(release => release()); context.mock.timers.reset(); }
});

test('消费者抛错不阻断同组消费者且下轮仍可推送', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const warnings: unknown[][] = [];
  context.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  let reads = 0;
  const read: ReadPage = async () => { reads += 1; return [candle(FIRST)]; };
  const events: MarketStreamEvent[] = [];
  const throwing = subscribeDesktopCandles(SYMBOL, 'day', () => { throw new Error('sensitive consumer failure'); }, read);
  const healthy = subscribeDesktopCandles(SYMBOL, 'day', event => events.push(event), read);
  try {
    await flush(); assert.equal(events.length, 1);
    context.mock.timers.tick(5000); await flush();
    assert.equal(reads, 2); assert.equal(events.length, 2); assert.equal(warnings.length, 2);
    assert.ok(events.every(event => event.type === 'candles'));
    assert.ok(warnings.every(args => !JSON.stringify(args).includes('sensitive')));
  } finally { throwing(); healthy(); context.mock.timers.reset(); }
});

test('读取失败和空页仅安全记录日志，5秒后恢复且不发送status', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const warnings: unknown[][] = [];
  context.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  let reads = 0;
  const read: ReadPage = async () => {
    reads += 1;
    if (reads === 1) throw new Error('sensitive provider detail');
    return reads === 2 ? [] : [candle(FIRST)];
  };
  const events: MarketStreamEvent[] = [];
  const release = subscribeDesktopCandles(SYMBOL, 'day', event => events.push(event), read);
  try {
    await flush(); assert.equal(events.length, 0); assert.equal(warnings.length, 1);
    context.mock.timers.tick(4999); await flush(); assert.equal(reads, 1);
    context.mock.timers.tick(1); await flush(); assert.equal(events.length, 0); assert.equal(warnings.length, 2);
    context.mock.timers.tick(5000); await flush(); assert.equal(reads, 3);
    assert.equal(events.length, 1); assert.ok(events.every(event => event.type === 'candles'));
    assert.ok(warnings.every(args => !JSON.stringify(args).includes('sensitive')));
  } finally { release(); context.mock.timers.reset(); }
});
