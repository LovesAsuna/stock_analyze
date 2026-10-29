import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDesktopEndpoints } from './fixtures/native-worker.js';
const require = createRequire(import.meta.url);
const { parseDesktopEndpoints, discoverDesktopEndpoints, validateDesktopEndpoint, selectDesktopEndpoints, probeDesktopEndpoint, detectDesktopRegion } = require('../server/native/desktop-endpoints.cjs');
const { NativeQuoteWorker } = require('../server/native/worker.cjs');
const { readDesktopMain } = require('../server/native/desktop-resources.cjs');

const production = '{version:"v6",api:{hk:"https://api-gl.lbkrs.com",bj:"https://api.lbctrl.com"},bAPI:"https://b-api.lbkrs.com",ws:{quoteGateway:{hk:"wss://quote-gl.lbkrs.com",bj:"wss://quote.lbctrl.com"},lbGatewayWS:{hk:"wss://ws-gl.lbkrs.com/v1",bj:"wss://ws.lbctrl.com/v1"}},geoTest:"https://geotest.lbctrl.com"}';
const preproduction = '{version:"v4",api:"https://pre-api.lbkrs.com",ws:{quoteGateway:"wss://quote-pre.longbridge.global",lbGatewayWS:"wss://pre-ws.lbkrs.com"}}';
const source = `var staging=${preproduction},regional=${production},us=${production.replace('v6', 'v6-lbus')};`;

/** 在自有临时目录写入只读ASAR样本，测试后清理。参数：文本、回调；返回：无。 */
function fixture(text: string, run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'market-lens-endpoints-test-'));
  try {
    const body = Buffer.from(text);
    const header = Buffer.from(JSON.stringify({ files: { dist: { files: { main: { files: { 'index.js': { offset: '0', size: body.length } } } } } } }));
    const prefix = Buffer.alloc(16); prefix.writeUInt32LE(header.length + 8, 4); prefix.writeUInt32LE(header.length, 12);
    const path = join(directory, 'app.asar'); writeFileSync(path, Buffer.concat([prefix, header, body])); run(path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** 创建可控TLS替身，关闭时只记录事件。参数：是否授权；返回：socket替身。 */
function fakeSocket(authorized = true) {
  const socket = new EventEmitter();
  return Object.assign(socket, { authorized, destroyed: false,
    /** 模拟关闭。参数：无；返回：无。 */
    destroy() { this.destroyed = true; socket.emit('close'); },
  });
}

/** 创建内存HTTPS返回，不监听端口。参数：响应正文、状态；返回：GET替身及请求记录。 */
function fakeRequest(body: string, statusCode = 200) {
  const transport = fakeSocket(); const response = Object.assign(fakeSocket(), { statusCode });
  return { transport,
    /** 排队返回模拟响应。参数：地址、消费者；返回：请求替身。 */
    request(_url: string, listener: (response: any) => void) {
      queueMicrotask(() => { listener(response); response.emit('data', Buffer.from(body)); response.emit('end'); }); return transport;
    },
  };
}

test('只读同版ASAR解析配套生产HTTP/WS，排除预发及美区配置', () => {
  fixture(source, path => {
    const candidates = discoverDesktopEndpoints(path);
    assert.equal(readDesktopMain(path), source);
    assert.deepEqual(candidates.map((candidate: any) => candidate.region), ['hk', 'bj']);
    assert.deepEqual(candidates[1], testDesktopEndpoints);
    assert.equal(candidates[0].api, 'https://api-gl.lbkrs.com/');
  });
});

test('配置支持静态引号和空白及新的数字版本，不依赖压缩变量名', () => {
  const quoted = production.replace('v6', 'v12').replace(/version:/g, '"version" : ').replace(/hk:/g, "'hk' : ").replace(/bj:/g, '"bj" : ');
  assert.deepEqual(parseDesktopEndpoints(`const longbridgeProduction = ${quoted};`), parseDesktopEndpoints(production));
});

test('配置缺失、歧义、区域缺项、危险属性和动态表达式明确拒绝且不执行', () => {
  for (const invalid of ['', preproduction, `${production};${production}`, production.replace('bj:"wss://ws.lbctrl.com/v1"', 'bj:""'),
    production.replace('geoTest:', '__proto__:"private",geoTest:'), production.replace('geoTest:', 'version:"duplicate",geoTest:'),
    production.replace('"https://geotest.lbctrl.com"', '(() => { throw new Error("must not run"); })()'),
    production.replace('api:{hk:', 'api:{other:'), production.replace('geoTest:"https:', 'geoTest:"http:')]) assert.throws(() => parseDesktopEndpoints(invalid));
});

test('端点校验拒绝外部地址、内嵌凭证、非标准端口、查询和协议降级', () => {
  for (const value of ['https://example.com', 'https://api.lbctrl.com.evil.example', 'https://api.lbctrl.com@evil.example', 'https://secret@api.lbctrl.com',
    'https://api.lbctrl.com:8443', 'http://api.lbctrl.com', 'https://api.lbctrl.com/?token=private', 'https://api.lbctrl.com/#private', null]) assert.throws(() => validateDesktopEndpoint(value, 'https:'));
});

test('ASAR截断或无效成员被拒绝，不读取用户目录或执行包源码', () => {
  fixture(source, path => {
    writeFileSync(path, Buffer.alloc(15)); assert.throws(() => discoverDesktopEndpoints(path), /头部不完整/);
  });
});

test('大陆地域优先bj，海外优先hk，所有通道使用同组端点', async () => {
  const candidates = parseDesktopEndpoints(source);
  for (const region of ['bj', 'hk']) {
    const calls: string[] = [];
    const selected = await selectDesktopEndpoints(candidates, { detectRegion: async () => region, probe: async (url: string) => { calls.push(url); return true; } });
    assert.equal(selected.region, region); assert.equal(calls.length, 6);
    assert.deepEqual(selected, candidates.find((candidate: any) => candidate.region === region));
  }
});

test('首选区域任一通道不可用时换整组，地域检测失败也能自动选择可用组', async () => {
  const candidates = parseDesktopEndpoints(source);
  for (const failed of ['api', 'quoteGateway', 'lbGatewayWS']) {
    const selected = await selectDesktopEndpoints(candidates, { detectRegion: async () => 'hk', probe: async (url: string) => url !== candidates[0][failed] });
    assert.deepEqual(selected, candidates[1]);
  }
  const fallback = await selectDesktopEndpoints(candidates, { detectRegion: async () => { throw new Error('private'); },
    probe: async (url: string) => { if (url.includes('-gl.')) throw new Error('private'); return true; } });
  assert.deepEqual(fallback, candidates[1]);
});

test('全部不可连接返回固定诊断，不泄漏错误原文且不猜测域名', async () => {
  await assert.rejects(selectDesktopEndpoints(parseDesktopEndpoints(source), { detectRegion: async () => null, probe: async () => false }),
    (error: any) => error.code === 'ENDPOINT_UNAVAILABLE' && !error.message.includes('private'));
  for (const candidates of [[], [testDesktopEndpoints, testDesktopEndpoints], [{ ...testDesktopEndpoints, api: 'https://external.example' }]]) {
    await assert.rejects(selectDesktopEndpoints(candidates));
  }
});

test('TLS探测保留证书验证，成功或错误均关闭socket', async () => {
  for (const [authorized, event] of [[true, 'secureConnect'], [false, 'secureConnect'], [true, 'error']] as const) {
    const socket = fakeSocket(authorized); let options: any;
    const pending = probeDesktopEndpoint(testDesktopEndpoints.quoteGateway, 5000, (value: unknown) => { options = value; return socket; });
    socket.emit(event, new Error('private'));
    assert.equal(await pending, event === 'secureConnect' && authorized);
    assert.equal(socket.destroyed, true); assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.servername, 'quote.lbctrl.com'); assert.equal(options.port, 443);
  }
});

test('TLS和地域请求超时有界，回收未完成连接', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const socket = fakeSocket(); const request = fakeSocket();
    const pending = probeDesktopEndpoint(testDesktopEndpoints.quoteGateway, 5000, () => socket);
    const region = detectDesktopRegion(testDesktopEndpoints.geoTest, 5000, () => request);
    context.mock.timers.tick(5000);
    assert.equal(await pending, false); assert.equal(await region, null);
    assert.equal(socket.destroyed, true); assert.equal(request.destroyed, true);
  } finally { context.mock.timers.reset(); }
});

test('地域检测复用桌面code/status规则，拒绝HTTP失败、畸形及过大正文', async () => {
  for (const [body, status, expected] of [['{"code":0}', 200, 'bj'], ['{"status":200}', 200, 'bj'], ['{"code":1}', 200, 'hk'],
    ['null', 200, null], ['[]', 200, null], ['private', 200, null], ['{"code":0}', 403, null], ['x'.repeat(4097), 200, null]] as const) {
    const mock = fakeRequest(body, status);
    assert.equal(await detectDesktopRegion(testDesktopEndpoints.geoTest, 5000, mock.request), expected);
    assert.equal(mock.transport.destroyed, true);
  }
});

test('worker只使用注入的自动识别端点，重连仍保持同组且缺配置拒绝连接', () => {
  const calls: unknown[][] = [];
  const native = { wsClient: (...args: unknown[]) => { calls.push(args); return {}; }, wsClose: () => {} };
  const missing = new NativeQuoteWorker(native, () => {});
  assert.throws(() => missing.connect(), /尚未自动识别/); assert.equal(calls.length, 0); missing.close();
  const worker = new NativeQuoteWorker(native, () => {}, testDesktopEndpoints);
  try {
    worker.connect(); worker.connect(); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 2), [testDesktopEndpoints.quoteGateway, testDesktopEndpoints.lbGatewayWS]);
    worker.close(); worker.connect(); assert.deepEqual(calls[1].slice(0, 2), calls[0].slice(0, 2));
  } finally { worker.close(); }
});
