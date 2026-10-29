import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createNativeWorker } from './fixtures/native-worker.js';
const require = createRequire(import.meta.url);
const { dispatchRequest, handleRequest } = require('../server/native/worker.cjs');
const { assertIsolation, assertAnonymousSession } = require('../server/native/bootstrap.cjs');
const { desktopTimestampPrefix, installDesktopTimestampFromSource } = require('../server/native/native-compat-timestamp.cjs');
const { normalizeNativeQuote, mergeNativeQuoteSnapshot, numeric } = require('../server/native/quote.cjs');
const { searchNativeSecurities, sameSessionGeneration } = require('../server/native/helpers.cjs');

/** 创建仅含已验证公式的源字符串。参数：prefix短前缀；返回：不可执行的测试源码。 */
function timestampSource(prefix: string): string {
  return `var W="${prefix}",Z=function(A,e){var g=[W,A,e].join("|");return n.qn.sha256(g)};console.timeStamp=Z;`;
}

/** 创建归一化快照字段。参数：timestamp秒、price价格；返回：原生报价样本。 */
function rawQuote(timestamp: number, price: string): any {
  return { timestamp, last_done: price, trade_status: 202 };
}

test('时间戳源码入口保持公式校验及安装恢复，不需要再次读取ASAR', () => {
  const prefix = '1'.repeat(32); const source = timestampSource(prefix);
  const native = { sha256: (value: string) => createHash('sha256').update(value).digest('hex') };
  assert.equal(desktopTimestampPrefix('x'.repeat(1000000) + source), prefix);
  assert.throws(() => desktopTimestampPrefix(source + source), /格式发生变化/);
  assert.throws(() => desktopTimestampPrefix('globalThis.notExecuted = true'), /格式发生变化/);
  const previous = console.timeStamp;
  const restore = installDesktopTimestampFromSource(native, source);
  try { assert.equal((console.timeStamp as unknown as (value: string, context: string) => string)('sample', 'context'), native.sha256(`${prefix}|sample|context`)); }
  finally { restore(); }
  assert.equal(console.timeStamp, previous);
});

test('共用搜索协议保留规范代码、products字段和原生返回内容', async () => {
  const calls: any[] = []; const response = { data: [{ code: '00700', market: 'HK', counter_id: 'ST/HK/00700' }] };
  const native = { searchSecurities: async (raw: string) => { calls.push(JSON.parse(raw)); return response; } };
  assert.equal(await searchNativeSecurities(native, '00700.hk', 5000), response);
  assert.deepEqual(calls, [{ term: '700', markets: ['HK'], is_code_exact_match: true, products: [], limit: 100 }]);
  assert.equal(sameSessionGeneration({ generation: 1, subscriptionGeneration: 2 }, 1, 2), true);
  assert.equal(sameSessionGeneration({ generation: 1, subscriptionGeneration: 3 }, 1, 2), false);
});

test('共享代数比较不把未认证视为旧代，认证和socket策略由调用方处理', () => {
  assert.equal(sameSessionGeneration({ generation: 1, subscriptionGeneration: 2, authenticated: false, socket: null }, 1, 2), true);
});

test('快照合并保留期间收到的推送及对象身份，只补缺失昨收', () => {
  const previous = normalizeNativeQuote(rawQuote(110, '110'), 'QQQ.US');
  const merged = mergeNativeQuoteSnapshot({ ...rawQuote(120, '100'), prev_close: '90' }, 'QQQ.US', previous, true);
  assert.equal(merged, previous); assert.equal(merged.quote.price, 110); assert.equal(merged.quote.timestamp, 110);
  assert.equal(merged.quote.previousClose, 90); assert.equal(merged.fields.prev_close, 90);
});

test('快照合并拒绝无法独立确认的快照，旧快照不覆盖新价，新快照沿用有效增量字段', () => {
  const previous = normalizeNativeQuote({ ...rawQuote(110, '110'), prev_close: '90' }, 'QQQ.US');
  assert.equal(mergeNativeQuoteSnapshot(rawQuote(100, '100'), 'QQQ.US', previous), previous);
  const next = mergeNativeQuoteSnapshot(rawQuote(120, '120'), 'QQQ.US', previous);
  assert.equal(next.quote.price, 120); assert.equal(next.quote.previousClose, 90);
  assert.throws(() => mergeNativeQuoteSnapshot({ timestamp: 130 }, 'QQQ.US', previous), /无法确认/);
  // 报价数字文法仍比K线严格，不因共享设施重构而扩大接受范围。
  for (const invalid of ['1e2', '.5', '1.', '+1', ' 1 ']) assert.equal(numeric(invalid), null);
});

test('启动隔离检查独立拒绝继承HOME或错配APPDATA', () => {
  const directory = join(process.cwd(), 'isolated-fixture');
  const environment = { LB_ENGINE_ISOLATION: directory, APPDATA: join(directory, 'AppData', 'Roaming'), HOME: directory };
  assert.doesNotThrow(() => assertIsolation(environment));
  assert.throws(() => assertIsolation({ ...environment, HOME: process.cwd() }), /必须使用隔离目录/);
  assert.throws(() => assertIsolation({ ...environment, APPDATA: process.cwd() }), /必须使用隔离目录/);
});

test('新会话检查绑定正确HTTP客户端并拒绝凭据或无法检查的会话', async () => {
  const client = {};
  await assertAnonymousSession({ httpGetSession: async function(this: unknown, key: string) { assert.equal(this, client); assert.equal(key, 'token'); throw 'not found'; } }, client);
  await assert.rejects(assertAnonymousSession({ httpGetSession: async () => 'fake-token' }, client), /含有登录态/);
  await assert.rejects(assertAnonymousSession({ httpGetSession: async () => { throw new Error('private'); } }, client), /无法检查/);
});

test('IPC派发保持五个控制方法和精确payload，不接受任意属性名', async () => {
  const calls: unknown[] = [];
  const worker = { connect: () => 'connected', subscribe: (symbol: string) => { calls.push(symbol); return 'subscribed'; },
    unsubscribe: (symbol: string) => { calls.push(symbol); return 'unsubscribed'; }, createQr: async () => 'qr', pollQr: async () => 'polled' };
  for (const [method, expected] of [['connect', 'connected'], ['subscribe', 'subscribed'], ['unsubscribe', 'unsubscribed'], ['qr-create', 'qr'], ['qr-poll', 'polled']]) {
    assert.equal(await dispatchRequest(worker, method, { symbol: 'QQQ.US' }), expected);
  }
  assert.deepEqual(calls, ['QQQ.US', 'QQQ.US']);
  for (const method of ['constructor', '__proto__', 'close', 'trade', null]) assert.throws(() => dispatchRequest(worker, method, {}), /不支持/);
  await assert.rejects(dispatchRequest({}, 'candles', { symbol: 'QQQ.US', period: 'invalid', count: 3 }), /K线参数/);
  await assert.rejects(dispatchRequest({}, 'intraday', { symbol: 'QQQ.US', session: 'invalid' }), /分时时段/);
});

test('IPC信封拒绝无效id，成功回传结果，错误只回传固定诊断', async () => {
  const replies: any[] = []; const reply = (value: unknown) => { replies.push(value); };
  for (const message of [null, {}, { id: '1' }, { id: 1.5 }]) await handleRequest({}, message, reply);
  assert.equal(replies.length, 0);
  await handleRequest({ connect: () => ({ authenticated: false }) }, { id: 1, method: 'connect' }, reply);
  await handleRequest({ connect: () => { throw new Error('fake-private-token'); } }, { id: 2, method: 'connect' }, reply);
  assert.deepEqual(replies[0], { id: 1, result: { authenticated: false } });
  assert.equal(replies[1].id, 2); assert.equal(typeof replies[1].error.message, 'string');
  assert.equal(JSON.stringify(replies).includes('fake-private-token'), false);
});

test('扫码模块写入后的取消不能复活登录或重连行情', async () => {
  const worker = createNativeWorker({ httpRequest: async () => ({ code: 0, data: { credentials: { token: 'fake-token' } } }) }, () => {});
  worker.httpClient = {}; worker.auth.qrToken = 'fake-qr';
  worker.auth.writeCredentials = async () => { worker.close(); };
  await assert.rejects(worker.pollQr(), /已取消/);
  assert.equal(worker.loggedIn, false); assert.equal(worker.socket, null);
});

test('认证结果返回到worker前失效时不能改变报价身份', async () => {
  const worker = createNativeWorker({}, () => {});
  worker.auth.pollQr = async () => { worker.close(); return { state: 'success' }; };
  await assert.rejects(worker.pollQr(), /已取消/);
  assert.equal(worker.loggedIn, false); assert.equal(worker.socket, null);
});
