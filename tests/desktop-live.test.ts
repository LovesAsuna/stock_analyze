import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeSession } from '../server/native-feed.js';
import { subscribeLiveDesktopCandles } from '../server/desktop-live-candles.js';
import { mergeIntradayUpdate, parseIntradayUpdate } from '../shared/intraday-updates.js';
import type { MarketStreamEvent } from '../shared/realtime.js';
import type { IntradayPoint } from '../shared/intraday.js';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openIntradayStream, closeIntradayStreams } from '../server/intraday-stream.js';

/** 创建可控读取，验证在途推送追赶。参数：无；返回：Promise及完成方法。 */
function deferred() {
  let resolve!: (result: unknown) => void;
  const promise = new Promise(resolveResult => { resolve = resolveResult; });
  return { promise, resolve };
}
/** 排空内存异步队列。参数：无；返回：下一事件循环。 */
async function flush(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }
const raw = { timestamp: 1793050200, open: 10, high: 12, low: 9, close: 11, volume: 100 };

test('桌面柱收到推送立即读取、在途合并追赶，同证券周期共享，取消拒绝迟到结果', async context => {
  let notify!: (event: MarketStreamEvent) => void; let released = 0;
  const jobs: ReturnType<typeof deferred>[] = []; const counts: number[] = [];
  context.mock.method(nativeSession, 'subscribe', (_symbol: string, callback: typeof notify) => { notify = callback; return () => { released++; }; });
  context.mock.method(nativeSession, 'candleCall', (payload: { count: number }) => { counts.push(payload.count); const job = deferred(); jobs.push(job); return job.promise; });
  const firstEvents: MarketStreamEvent[] = []; const secondEvents: MarketStreamEvent[] = [];
  const first = subscribeLiveDesktopCandles('AAPL.US', '1m', event => firstEvents.push(event));
  const second = subscribeLiveDesktopCandles('AAPL.US', '1m', event => secondEvents.push(event));
  try {
    await flush(); assert.equal(jobs.length, 1);
    const quote: MarketStreamEvent = { type: 'quote', quote: { symbol: 'AAPL.US', price: 11, previousClose: 10, timestamp: raw.timestamp, session: 'regular' } };
    notify(quote); notify(quote); assert.equal(jobs.length, 1);
    jobs[0].resolve({ rows: [raw], transport: 'desktop-ws' }); await flush();
    assert.equal(jobs.length, 2); assert.deepEqual(counts, [1000, 3]);
    jobs[1].resolve({ rows: [{ ...raw, close: 12 }], transport: 'desktop-http' }); await flush();
    assert.equal(firstEvents.filter(event => event.type === 'candles').length, 2);
    assert.deepEqual(firstEvents, secondEvents);
    assert.ok(firstEvents.some(event => event.type === 'sync' && event.mode === 'event' && event.transport === 'desktop-http'));
    notify(quote); assert.equal(jobs.length, 3); // 没有5秒timer，通知同一轮直接读取。
    first(); second(); jobs[2].resolve({ rows: [raw], transport: 'desktop-ws' }); await flush();
    assert.equal(firstEvents.filter(event => event.type === 'candles').length, 2); assert.equal(released, 1);
    notify(quote); assert.equal(jobs.length, 3);
  } finally { first(); second(); }
});

test('分时SSE推送触发读取、在途追赶，关闭后不发送迟到数据且释放引用', async context => {
  let notify!: (event: MarketStreamEvent) => void; let released = 0;
  const jobs: ReturnType<typeof deferred>[] = []; const frames: string[] = [];
  context.mock.method(nativeSession, 'subscribe', (_symbol: string, callback: typeof notify) => { notify = callback; return () => { released++; }; });
  context.mock.method(nativeSession, 'intradayCall', () => { const job = deferred(); jobs.push(job); return job.promise; });
  const request = new EventEmitter(); const response = Object.assign(new EventEmitter(), {
    writableLength: 0, writeHead() {}, flushHeaders() {}, write(frame: string) { frames.push(frame); }, end() {},
  });
  const points = [{ timestamp: raw.timestamp, price: 11, volume: 100, avg_price: 10, trade_session: 'regular' }];
  try {
    openIntradayStream(request as IncomingMessage, response as unknown as ServerResponse, 'AAPL.US', 'regular');
    assert.equal(jobs.length, 1);
    const quote: MarketStreamEvent = { type: 'quote', quote: { symbol: 'AAPL.US', price: 11, previousClose: 10, timestamp: raw.timestamp, session: 'regular' } };
    notify(quote); notify(quote); assert.equal(jobs.length, 1);
    jobs[0].resolve({ rows: points, transport: 'desktop-ws' }); await flush(); assert.equal(jobs.length, 2);
    const events = frames.filter(frame => frame.startsWith('data:')).map(frame => JSON.parse(frame.slice(6)));
    assert.ok(events.some(event => event.type === 'points' && event.points[0].volume === 100));
    assert.ok(events.some(event => event.type === 'sync' && event.mode === 'event'));
    response.emit('close'); const frameCount = frames.length;
    jobs[1].resolve({ rows: points, transport: 'desktop-http' }); await flush();
    assert.equal(frames.length, frameCount); assert.equal(released, 1);
    notify(quote); assert.equal(jobs.length, 2);
  } finally { closeIntradayStreams(); }
});

test('分时校正替换分钟成交量、保留五日历史并以夜盘交易日裁剪', () => {
  const point = (iso: string, price = 10, session: IntradayPoint['session'] = 'regular'): IntradayPoint => ({ time: Date.parse(iso) / 1000, price, volume: 100, averagePrice: 10, session });
  const history = [point('2026-10-26T14:00:00Z'), point('2026-10-27T14:00:00Z')];
  const update = [{ ...history[1], price: 12, volume: 120 }];
  const result = mergeIntradayUpdate(history, update, 'AAPL.US', 5);
  assert.equal(result.length, 2); assert.equal(result[1].volume, 120); assert.equal(history[1].volume, 100);
  assert.equal(mergeIntradayUpdate(history, update, 'AAPL.US', 1).length, 1);
  const night = [point('2026-10-27T00:00:00Z', 10, 'overnight'), point('2026-10-27T06:00:00Z', 11, 'overnight')];
  assert.equal(mergeIntradayUpdate([], night, 'AAPL.US', 1).length, 2);
  const event = { type: 'points', symbol: 'AAPL.US', session: 'regular', points: update, receivedAt: '2026-10-27T14:00:01Z' };
  assert.equal(parseIntradayUpdate(event, 'AAPL.US', 'regular').points.length, 1);
  assert.throws(() => parseIntradayUpdate(event, 'QQQ.US', 'regular'), /上下文/);
  assert.throws(() => parseIntradayUpdate({ ...event, points: [{ ...update[0], volume: -1 }] }, 'AAPL.US', 'regular'), /点无效/);
});
