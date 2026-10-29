import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { NativeFeed } from '../server/native-feed.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NativeAuthController } from '../server/native-auth.js';
import { handleAuthRequest } from '../server/auth-routes.js';
import { createNativeWorker } from './fixtures/native-worker.js';

const require = createRequire(import.meta.url);
const { authCodes } = require('../server/native/helpers.cjs');

/** 完成内存异步回调。参数：无；返回：事件循环Promise。 */
async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

/** 创建受控Promise。参数：无；返回：promise及完成函数。 */
function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeSession {
  resets = 0; pinned = false; listeners: (() => void)[] = [];
  create = async (): Promise<any> => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', expiresIn: 180 });
  poll = async (): Promise<any> => ({ state: 'waiting' });
  /** 模拟受限认证调用。参数：method方法；返回：响应Promise。 */
  async authCall(method: string) { return method === 'qr-create' ? this.create() : this.poll(); }
  /** 固定会话。参数：value保留标志；返回：无。 */
  pin(value: boolean) { this.pinned = value; }
  /** 销毁隔离身份。参数：无；返回：Promise<void>。 */
  async resetSession() { this.resets += 1; this.pinned = false; for (const listener of this.listeners) listener(); }
  /** 注册清理监听。参数：listener回调；返回：解除函数。 */
  onReset(listener: () => void) { this.listeners.push(listener); return () => {}; }
}

test('二维码创建只返回公开状态，轮询成功后保留共享会话', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const session = new FakeSession(); const auth = new NativeAuthController(session);
  session.poll = async () => ({ state: 'success' });
  const status = await auth.start();
  assert.equal(status.state, 'waiting'); assert.equal(session.pinned, true);
  assert.deepEqual(Object.keys(status).sort(), ['expiresAt', 'message', 'revision', 'state']);
  assert.ok(auth.getQr(status.revision!)); assert.equal(auth.getQr(status.revision! - 1), null);
  context.mock.timers.tick(1500); await flush();
  assert.equal(auth.getState().state, 'success'); assert.equal(auth.getQr(status.revision!), null);
  assert.equal(session.pinned, true); await auth.cancel(); assert.equal(auth.getState().state, 'success');
  const resets = session.resets; await assert.rejects(auth.start(), /已登录/); assert.equal(session.resets, resets);
  await auth.logout(); assert.equal(auth.getState().state, 'idle'); assert.equal(session.pinned, false);
});

test('取消未完成创建会销毁进程，迟到二维码不能复活状态', async () => {
  const session = new FakeSession(); const create = deferred(); session.create = () => create.promise;
  const auth = new NativeAuthController(session); const starting = auth.start(); await flush();
  const revision = auth.getState().revision!;
  await auth.cancel();
  create.resolve({ svg: '<svg></svg>', expiresIn: 180 }); await starting;
  assert.equal(auth.getState().state, 'idle'); assert.equal(auth.getQr(revision), null); assert.equal(session.pinned, false);
  assert.equal(session.resets, 2);
});

test('未知扫码状态继续等待，API异常为error且清理，不伪装expired', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const session = new FakeSession(); const auth = new NativeAuthController(session);
  await auth.start(); context.mock.timers.tick(1500); await flush();
  assert.equal(auth.getState().state, 'waiting');
  session.poll = async () => { throw new Error('401 upstream private response'); };
  context.mock.timers.tick(1500); await flush();
  assert.equal(auth.getState().state, 'error'); assert.equal(session.pinned, false);
  assert.equal(JSON.stringify(auth.getState()).includes('401 upstream'), false);
});

test('扫码到期及引擎故障清除身份，轮询结果不能覆盖取消', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const session = new FakeSession(); const auth = new NativeAuthController(session);
  const status = await auth.start();
  context.mock.timers.tick(180000); await flush();
  assert.equal(auth.getState().state, 'expired'); assert.equal(auth.getQr(status.revision!), null);
  const pending = deferred(); session.poll = () => pending.promise;
  await auth.start(); context.mock.timers.tick(1500); await flush();
  await auth.cancel(); pending.resolve({ state: 'success' }); await flush();
  assert.equal(auth.getState().state, 'idle');
  await auth.start(); for (const listener of session.listeners) listener();
  assert.equal(auth.getState().state, 'idle'); assert.equal(auth.getQr(auth.getState().revision!), null);
});

test('上游短二维码有效期不会延长且API错误不会当作过期', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const session = new FakeSession(); session.create = async () => ({ svg: '<svg></svg>', expiresIn: 2 });
  const auth = new NativeAuthController(session); const status = await auth.start();
  assert.equal(status.expiresAt! - Date.now(), 2000);
  context.mock.timers.tick(2000); await flush(); assert.equal(auth.getState().state, 'expired');
  const worker = createNativeWorker({ httpRequest: async () => ({ code: 401, data: {} }) }, () => {});
  worker.httpClient = {}; worker.auth.qrToken = 'fake-qr';
  await assert.rejects(worker.pollQr(), /服务返回错误/); worker.close();
});

test('登录pin在无行情订阅时保留进程，logout回放匿名目标并清身份', async () => {
  class Engine extends EventEmitter {
    calls: string[] = []; stops = 0;
    /** 模拟受限IPC。参数：method方法；返回：安全认证响应。 */
    async call(method: string) { this.calls.push(method); return method === 'qr-create' ? { svg: '<svg></svg>', expiresIn: 180 } : { state: 'success' }; }
    /** 模拟隔离进程退出。参数：无；返回：Promise<void>。 */
    async stop() { this.stops += 1; this.emit('reset'); this.emit('state'); }
  }
  const engine = new Engine(); const feed = new NativeFeed(engine); const auth = new NativeAuthController(feed);
  const cancel = feed.subscribe('QQQ.US', () => {}); await flush();
  await auth.start(); const stops = engine.stops; cancel(); await flush(); assert.equal(engine.stops, stops);
  await auth.logout(); assert.equal(auth.getState().state, 'idle'); assert.ok(engine.stops > stops);
  feed.pin(true); engine.emit('reset');
  await assert.rejects(feed.authCall('qr-poll'), /取消/);
  await feed.close();
});

test('worker凭据仅写隔离HTTP session，成功重连并保留行情目标', async () => {
  const writes: { key: string; value: string }[] = []; const connects: unknown[] = [];
  const native = {
    httpRequest: async () => ({ code: 0, data: { credentials: { token: 'fake-access', refresh_token: 'fake-refresh' } } }),
    httpSetSession: async (key: string, value: string) => { writes.push({ key, value }); },
    wsClose: () => {}, wsClient: (...args: unknown[]) => { connects.push(args); return {}; },
  };
  const worker = createNativeWorker(native, () => {}); worker.httpClient = {}; worker.auth.qrToken = 'fake-qr';
  worker.targets.set('QQQ.US', { symbol: 'QQQ.US', counter: null, pending: false, confirmed: false, latest: null });
  try {
    const result = await worker.pollQr();
    assert.deepEqual(result, { state: 'success' }); assert.equal(writes.length, 2);
    assert.equal(writes[0].key, 'token'); assert.equal(worker.targets.size, 1); assert.equal(connects.length, 1);
    assert.equal(JSON.stringify(result).includes('fake-'), false);
  } finally { worker.close(); }
});

test('worker部分写入凭据后失败，控制器销毁身份而不保留假登录', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let writes = 0; let closes = 0;
  const native = {
    httpRequest: async () => ({ code: 0, data: { credentials: { token: 'fake-token', refresh_token: 'fake-refresh' } } }),
    httpSetSession: async () => { writes += 1; if (writes === 2) throw new Error('private-response'); },
    wsClose: () => { closes += 1; },
  };
  const worker = createNativeWorker(native, () => {}); worker.httpClient = {}; worker.socket = {};
  const session = new FakeSession();
  const originalReset = session.resetSession.bind(session);
  session.resetSession = async () => { worker.close(); await originalReset(); };
  session.poll = () => worker.pollQr();
  const auth = new NativeAuthController(session); await auth.start(); worker.auth.qrToken = 'fake-qr';
  context.mock.timers.tick(1500); await flush();
  assert.equal(writes, 2); assert.equal(auth.getState().state, 'error'); assert.equal(session.pinned, false);
  assert.ok(session.resets >= 2); assert.ok(closes >= 1);
});

test('认证诊断仅保留数字HTTP/业务码，拒绝响应体与凭据', async () => {
  assert.deepEqual(authCodes({ status: 429, code: '1234', token: 'fake-private', message: 'secret' }), { httpStatus: 429, code: 1234 });
  assert.deepEqual(authCodes('upstream private body'), {});
  const logs: any[] = [];
  const worker = createNativeWorker({ httpRequest: async () => { throw JSON.stringify({ status: 429, code: 1234, token: 'fake-private' }); } }, (event: string, data: any) => logs.push({ event, data }));
  worker.httpClient = {};
  await assert.rejects(worker.auth.request('/v1/auth/request_scan_login'));
  assert.equal(JSON.stringify(logs).includes('fake-private'), false);
  assert.match(logs[0].data.message, /AUTH_CREATE_FAILED/);
  assert.match(logs[0].data.message, /429/); assert.match(logs[0].data.message, /1234/);
});

test('worker取消代数阻止迟到扫码凭据写入', async () => {
  const pending = deferred(); let writes = 0;
  const native = { httpRequest: () => pending.promise, httpSetSession: async () => { writes += 1; } };
  const worker = createNativeWorker(native, () => {}); worker.httpClient = {}; worker.auth.qrToken = 'fake-qr';
  const polling = worker.pollQr(); worker.close();
  pending.resolve({ code: 0, data: { credentials: { token: 'fake-late' } } });
  await assert.rejects(polling, /取消/); assert.equal(writes, 0);
});

/** 调用内存HTTP路由，不监听端口。参数：方法、路径、头、body；返回：状态和响应。 */
async function route(method: string, path: string, headers: Record<string, string> = {}, body = '') {
  const request = Readable.from(body ? [Buffer.from(body)] : []) as IncomingMessage;
  request.method = method; request.headers = headers;
  let status = 0; let responseBody = ''; let responseHeaders: unknown;
  const response = {
    writeHead(code: number, values: unknown) { status = code; responseHeaders = values; return this; },
    end(value: string) { responseBody = value; },
  } as unknown as ServerResponse;
  await handleAuthRequest(request, response, new URL(path, 'http://127.0.0.1'));
  return { status, responseBody, responseHeaders };
}

test('认证路由禁止GET变更，POST拒绝缺头和非空/超大JSON', async () => {
  assert.equal((await route('GET', '/api/auth/start')).status, 405);
  assert.equal((await route('POST', '/api/auth/start')).status, 400);
  const headers = { 'content-type': 'application/json', 'x-market-lens': '1' };
  assert.equal((await route('POST', '/api/auth/start', headers, '{"token":"injected"}')).status, 400);
  assert.equal((await route('POST', '/api/auth/start', headers, 'x'.repeat(9000))).status, 400);
  assert.equal((await route('GET', '/api/auth/qr?revision=1')).status, 404);
  const state = await route('GET', '/api/auth/state'); assert.equal(state.status, 200);
  assert.equal(JSON.parse(state.responseBody).state, 'idle');
});
