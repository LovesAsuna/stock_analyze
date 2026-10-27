import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readIntraday, intradayRows } = require('../server/native/intraday.cjs');

const day = Date.parse('2026-10-26T04:00:00Z') / 1000;

/** 构造桌面原生分组契约样本。参数：session桌面时段、extra分钟覆盖；返回：完整分组响应。 */
function sample(session = 0, extra: Record<string, unknown> = {}): any {
  const hours: Record<number, number> = { 0: 14, 2: 10, 3: 21, 4: 2 };
  return { base_price: '99', timeshares: [{ date: day, trade_session: session,
    minutes: [{ timestamp: Date.parse(`2026-10-26T${String(hours[session]).padStart(2, '0')}:00:00Z`) / 1000,
      price: '100', avg_price: '99.5', amount: '123', balance: '12300', ...extra }] }] };
}

/** 构造不访问账户的共享worker。参数：无；返回：worker及请求记录。 */
function fixture(): any {
  const calls: any[] = [];
  const worker: any = { generation: 1, subscriptionGeneration: 1, authenticated: true, socket: {}, httpClient: {}, targets: new Map(),
    connect() {}, send(_event: string, value: unknown) { calls.push({ log: value }); },
    native: {
      async searchSecurities(raw: string) { calls.push({ search: JSON.parse(raw) }); return { code: 0, data: [{ code: 'AAPL', market: 'US', counter_id: 'ST/US/AAPL' }] }; },
      async quoteMinute(this: unknown, raw: string) { calls.push({ ws: JSON.parse(raw), socket: this }); return { code: 0, data: sample() }; },
      async httpRequest(this: unknown, method: string, path: string, raw: string) { calls.push({ method, path, params: JSON.parse(raw), client: this }); return { code: 0, data: sample() }; },
    } };
  return { worker, calls };
}

test('实时分时返回真实传输来源，历史读取保持数组兼容', async () => {
  const { worker } = fixture();
  const ws = await readIntraday(worker, { symbol: 'AAPL.US', session: 'regular', withTransport: true });
  assert.equal(ws.transport, 'desktop-ws'); assert.equal(ws.rows.length, 1);
  worker.native.quoteMinute = async () => { throw new Error('synthetic WS failure'); };
  const http = await readIntraday(worker, { symbol: 'AAPL.US', session: 'regular', withTransport: true });
  assert.equal(http.transport, 'desktop-http'); assert.equal(http.rows.length, 1);
});

test('真实分组展开保留秒、均价与amount成交量，不使用balance或total_amount', () => {
  const rows = intradayRows(sample(4, { total_amount: '99999' }), { symbol: 'AAPL.US', session: 'overnight' }, 'ST/US/AAPL');
  assert.deepEqual(rows, [{ timestamp: Date.parse('2026-10-26T02:00:00Z') / 1000, price: 100, volume: 123, avg_price: 99.5, trade_session: 'overnight' }]);
  assert.equal(intradayRows(sample(0, { volume: '123' }), { symbol: 'AAPL.US', session: 'regular' }, 'ST/US/AAPL')[0].volume, 123);
  assert.deepEqual(intradayRows(sample(), { symbol: 'AAPL.US', session: 'pre' }, 'ST/US/AAPL'), []);
});

test('分钟字段、证券身份、交易日和未知时段严格拒绝', () => {
  const query = { symbol: 'AAPL.US', session: 'all' };
  for (const extra of [{ amount: undefined }, { amount: '' }, { amount: true }, { amount: -1 }, { amount: '  ' }, { volume: null }, { volume: '124' }, { price: 0 }, { timestamp: Date.now() }, { avg_price: 'oops' }]) {
    assert.throws(() => intradayRows(sample(0, extra), query, 'ST/US/AAPL'), /桌面分时/);
  }
  assert.throws(() => intradayRows({ ...sample(), counter_id: 'ST/US/MSFT' }, query, 'ST/US/AAPL'), /身份/);
  assert.throws(() => intradayRows(sample(), { ...query, date: '20261023' }, 'ST/US/AAPL'), /其他日期/);
  assert.throws(() => intradayRows(sample(9), query, 'ST/US/AAPL'), /时段/);
  assert.throws(() => intradayRows({ timeshares: [{ date: day, trade_session: 0 }] }, query), /结构/);
});

test('当前分时使用原生WS及真实枚举，历史固定100并按分组筛选', async () => {
  const { worker, calls } = fixture();
  worker.native.quoteMinute = async function(raw: string) { calls.push({ ws: JSON.parse(raw), socket: this }); return { code: 0, data: sample(4) }; };
  assert.equal((await readIntraday(worker, { symbol: 'AAPL.US', session: 'overnight' })).length, 1);
  assert.deepEqual(calls.find((call: any) => call.ws)?.ws, { counter_id: 'ST/US/AAPL', trade_session: 4, adjust_type: 0, avg_price: 1 });
  assert.equal(calls.find((call: any) => call.ws)?.socket, worker.socket);
  assert.deepEqual(await readIntraday(worker, { symbol: 'AAPL.US', session: 'overnight', date: '20261026' }), []);
  assert.equal(calls.find((call: any) => call.path)?.path, '/v1/quote/stock/history_timeshares');
  assert.equal(calls.find((call: any) => call.path)?.params.trade_session, 100);
  assert.equal(calls.find((call: any) => call.path)?.params.date, '20261026');
});

test('WS拒绝或结构无效回退同版HTTP，HTTP失败仍抛错', async () => {
  for (const response of [{ code: 403 }, { code: 0, data: {} }]) {
    const { worker, calls } = fixture();
    worker.native.quoteMinute = async () => response;
    const points = await readIntraday(worker, { symbol: 'AAPL.US', session: 'regular' });
    assert.equal(points.length, 1);
    const http = calls.find((call: any) => call.path);
    assert.equal(http.path, '/v5/quote/stock/timeshares');
    assert.equal(http.method, 'GET');
    assert.equal(http.client, worker.httpClient);
    worker.native.httpRequest = async () => ({ code: 403 });
    await assert.rejects(readIntraday(worker, { symbol: 'AAPL.US', session: 'regular' }), /拒绝/);
  }
});

test('WS返回及错误跨代后拒绝，不再调用HTTP，搜索和历史也拒旧', async () => {
  for (const field of ['generation', 'subscriptionGeneration', 'socket']) {
    const { worker, calls } = fixture();
    worker.native.quoteMinute = async () => { worker[field] = field === 'socket' ? {} : 2; return { code: 0, data: sample() }; };
    await assert.rejects(readIntraday(worker, { symbol: 'AAPL.US', session: 'all' }), /切换/);
    assert.equal(calls.filter((call: any) => call.path).length, 0);
  }
  const { worker } = fixture();
  worker.native.httpRequest = async () => { worker.authenticated = false; return { code: 0, data: sample() }; };
  await assert.rejects(readIntraday(worker, { symbol: 'AAPL.US', session: 'all', date: '20261026' }), /切换/);
});

test('边界输入无效时不触碰引擎，港股特殊时段返回空', async () => {
  const { worker, calls } = fixture();
  for (const payload of [{ symbol: 'AAPL.US;whoami', session: 'all' }, { symbol: 'AAPL.US', session: 'night' },
    { symbol: 'AAPL.US', session: 'all', date: '20260230' }, { symbol: 'AAPL.US', session: 'all', date: 20261026 }]) {
    await assert.rejects(readIntraday(worker, payload));
  }
  assert.deepEqual(await readIntraday(worker, { symbol: '700.HK', session: 'overnight' }), []);
  assert.equal(calls.length, 0);
});
