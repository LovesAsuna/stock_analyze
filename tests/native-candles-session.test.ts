import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NativeFeed, type NativeEngine } from '../server/native-feed.js';

type EngineMethod = Parameters<NativeEngine['call']>[0];
type EnginePayload = Parameters<NativeEngine['call']>[1];
const payload = { symbol: 'QQQ.US', period: 'day', count: 30, timestamp: '1700000000' };

/** 创建可控异步结果。参数：无；返回：Promise及成功、失败函数。 */
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** 等待内存异步队列完成。参数：无；返回：下一个事件循环Promise。 */
async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

/** 可控制K线和目标操作的假引擎，不加载原生模块或启动子进程。 */
class FakeEngine extends EventEmitter implements NativeEngine {
  calls: { method: EngineMethod; payload: EnginePayload }[] = [];
  candleJobs: ReturnType<typeof deferred>[] = [];
  gates = new Map<EngineMethod, ReturnType<typeof deferred>>();
  stops = 0;

  /** 记录共享引擎调用。参数：method受限操作、payload请求参数；返回：可控响应。 */
  async call(method: EngineMethod, request?: EnginePayload): Promise<any> {
    this.calls.push({ method, payload: request });
    if (method === 'candles') {
      const job = deferred(); this.candleJobs.push(job);
      return job.promise;
    }
    return this.gates.get(method)?.promise;
  }

  /** 记录进程回收并保留可控迟到响应。参数：无；返回：成功Promise。 */
  async stop(): Promise<void> { this.stops += 1; }
}

test('K线成功和失败均释放引用并回收无消费者的共享进程', async () => {
  for (const failure of [false, true]) {
    const engine = new FakeEngine(); const feed = new NativeFeed(engine);
    try {
      const request = feed.candleCall(payload);
      const failureCheck = failure ? assert.rejects(request, /synthetic candle failure/) : null;
      await flush();
      assert.deepEqual(engine.calls, [{ method: 'candles', payload }]);
      assert.equal(engine.stops, 0);
      if (failure) {
        engine.candleJobs[0].reject(new Error('synthetic candle failure'));
        await failureCheck;
      } else {
        const result = { candles: [{ close: 100 }] };
        engine.candleJobs[0].resolve(result);
        assert.equal(await request, result);
      }
      await flush(); assert.equal(engine.stops, 1);
    } finally { await feed.close(); }
  }
});

test('历史分页任务在页间持有会话，整段完成后才回收', async () => {
  const engine = new FakeEngine(); const feed = new NativeFeed(engine);
  const betweenPages = deferred();
  try {
    const history = feed.withCandleSession(async () => {
      const first = await feed.candleCall(payload);
      await betweenPages.promise;
      return [first, await feed.candleCall({ ...payload, timestamp: '1699999999' })];
    });
    await flush(); engine.candleJobs[0].resolve('first');
    await flush(); assert.equal(engine.stops, 0);
    betweenPages.resolve(undefined); await flush();
    engine.candleJobs[1].resolve('second'); assert.deepEqual(await history, ['first', 'second']);
    await flush(); assert.equal(engine.stops, 1);
  } finally { betweenPages.resolve(undefined); await feed.close(); }
});

test('上次正常回收结束事件不取消排队的新行情请求', async () => {
  const engine = new FakeEngine(); const feed = new NativeFeed(engine); const stopping = deferred();
  engine.stop = async () => {
    engine.stops++; engine.emit('reset', { reason: 'session-stopped' });
    await stopping.promise; engine.emit('state', { state: 'closed' });
  };
  try {
    const first = feed.candleCall(payload); await flush();
    engine.candleJobs[0].resolve('first'); await first; await flush();
    const second = feed.candleCall(payload);
    stopping.resolve(undefined); await flush();
    assert.equal(engine.candleJobs.length, 2);
    engine.candleJobs[1].resolve('second'); assert.equal(await second, 'second');
  } finally { stopping.resolve(undefined); await feed.close(); }
});

test('多个在途K线请求共享进程，最后一个完成才回收', async () => {
  const engine = new FakeEngine(); const feed = new NativeFeed(engine);
  try {
    const first = feed.candleCall(payload);
    const second = feed.candleCall({ symbol: '700.HK', period: 'week', count: 5 });
    const secondCheck = assert.rejects(second, /synthetic candle failure/);
    await flush(); assert.equal(engine.candleJobs.length, 2);
    engine.candleJobs[0].resolve('first'); assert.equal(await first, 'first');
    await flush(); assert.equal(engine.stops, 0);
    engine.candleJobs[1].reject(new Error('synthetic candle failure')); await secondCheck;
    await flush(); assert.equal(engine.stops, 1);
  } finally { await feed.close(); }
});

test('最后一个quote退订不打断在途K线，K线结束后回收', async () => {
  const engine = new FakeEngine(); const feed = new NativeFeed(engine);
  try {
    const cancel = feed.subscribe('QQQ.US', () => {}); await flush();
    const request = feed.candleCall(payload); await flush();
    cancel(); await flush();
    assert.equal(engine.calls.at(-1)?.method, 'unsubscribe');
    assert.equal(engine.stops, 0);
    engine.candleJobs[0].resolve('candles'); assert.equal(await request, 'candles');
    await flush(); assert.equal(engine.stops, 1);
  } finally { await feed.close(); }
});

test('K线等待已排队的quote退订时提前持有引用，避免进程被停止', async () => {
  const engine = new FakeEngine(); const feed = new NativeFeed(engine);
  try {
    const cancel = feed.subscribe('QQQ.US', () => {}); await flush();
    cancel(); const request = feed.candleCall(payload);
    await flush();
    assert.deepEqual(engine.calls.map((call) => call.method), ['subscribe', 'connect', 'unsubscribe', 'candles']);
    assert.equal(engine.stops, 0);
    engine.candleJobs[0].resolve('candles'); await request;
    await flush(); assert.equal(engine.stops, 1);
  } finally { await feed.close(); }
});

test('K线完成时已有quote或登录固定引用则保留共享进程', async () => {
  for (const consumer of ['quote', 'pin']) {
    const engine = new FakeEngine(); const feed = new NativeFeed(engine);
    try {
      if (consumer === 'quote') feed.subscribe('QQQ.US', () => {});
      else feed.pin(true);
      const request = feed.candleCall(payload); await flush();
      engine.candleJobs[0].resolve('candles'); await request;
      await flush(); assert.equal(engine.stops, 0);
    } finally { await feed.close(); }
  }
});

test('已排队的K线回收重新检查新增quote、登录固定和在途K线引用', async () => {
  for (const consumer of ['quote', 'pin', 'candle']) {
    const engine = new FakeEngine(); const feed = new NativeFeed(engine);
    const unsubscribe = deferred(); engine.gates.set('unsubscribe', unsubscribe);
    try {
      const cancel = feed.subscribe('QQQ.US', () => {}); await flush();
      const first = feed.candleCall(payload); await flush();
      cancel(); await flush();
      engine.candleJobs[0].resolve('first'); await first;
      // 退订仍阻塞队列，首个请求的回收任务已经排队但尚未执行。
      let next: Promise<any> | undefined;
      if (consumer === 'quote') feed.subscribe('700.HK', () => {});
      else if (consumer === 'pin') feed.pin(true);
      else next = feed.candleCall(payload);
      unsubscribe.resolve(undefined); await flush();
      assert.equal(engine.stops, 0);
      if (next) {
        engine.candleJobs[1].resolve('next'); await next;
        await flush(); assert.equal(engine.stops, 1);
      }
    } finally { unsubscribe.resolve(undefined); await feed.close(); }
  }
});

test('reset拒绝旧会话迟到K线，后续请求仍可使用新会话', async () => {
  const engine = new FakeEngine(); const feed = new NativeFeed(engine);
  try {
    const stale = feed.candleCall(payload);
    const staleCheck = assert.rejects(stale, /原生K线会话已取消/);
    await flush(); await feed.resetSession();
    const fresh = feed.candleCall(payload); await flush();
    engine.candleJobs[0].resolve('stale'); await staleCheck;
    await flush(); assert.equal(engine.stops, 1);
    engine.candleJobs[1].resolve('fresh'); assert.equal(await fresh, 'fresh');
    await flush(); assert.equal(engine.stops, 2);
  } finally { await feed.close(); }
});

test('等待目标队列期间reset也拒绝K线，不向新会话发送旧请求', async () => {
  const engine = new FakeEngine(); const feed = new NativeFeed(engine);
  const subscribe = deferred(); engine.gates.set('subscribe', subscribe);
  try {
    feed.subscribe('QQQ.US', () => {}); await flush();
    const request = feed.candleCall(payload);
    const rejection = assert.rejects(request, /原生K线会话已取消/);
    const reset = feed.resetSession();
    subscribe.resolve(undefined); await reset; await rejection;
    assert.equal(engine.candleJobs.length, 0);
  } finally { subscribe.resolve(undefined); await feed.close(); }
});

test('关闭拒绝后续K线调用且不会再次启动或停止引擎', async () => {
  const engine = new FakeEngine(); const feed = new NativeFeed(engine);
  await feed.close();
  await assert.rejects(feed.candleCall(payload), /原生K线会话已取消/);
  await flush();
  assert.deepEqual(engine.calls, []); assert.equal(engine.stops, 1);
});

test('关闭拒绝在途K线的迟到响应', async () => {
  const engine = new FakeEngine(); const feed = new NativeFeed(engine);
  const request = feed.candleCall(payload);
  const rejection = assert.rejects(request, /原生K线会话已取消/);
  await flush(); await feed.close();
  engine.candleJobs[0].resolve('late'); await rejection;
  await flush(); assert.equal(engine.stops, 1);
});
