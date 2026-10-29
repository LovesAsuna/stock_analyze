import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeFeed } from '../server/native-feed.js';
import type { MarketStreamEvent } from '../shared/realtime.js';

const require = createRequire(import.meta.url);
const { startupFailure, readStartupFailure } = require('../server/native/startup-errors.cjs');
const { EngineClient } = require('../server/native/engine-client.cjs');

/** 等待内存队列执行。参数：无；返回：下一事件循环Promise。 */
async function flush(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }

test('启动诊断区分安装、架构、依赖、签名和时间戳兼容，不传递异常原文', () => {
  const cases = [
    ['INSTALL_MISSING', '发现多个可用长桥应用', 'INSTALL_MULTIPLE'],
    ['INSTALL_MISSING', '无法扫描macOS应用目录', 'INSTALL_SCAN'],
    ['INSTALL_MISSING', '暂不支持 linux/x64', 'PLATFORM'],
    ['NATIVE_LOAD', 'mach-o file, but is an incompatible architecture', 'NATIVE_ARCH'],
    ['NATIVE_LOAD', 'Library not loaded: /private/secret.dylib', 'NATIVE_DEPENDENCY'],
    ['NATIVE_LOAD', 'code signature invalid /private/user', 'NATIVE_SIGNATURE'],
    ['TIMESTAMP_COMPAT', 'private-package-value', 'TIMESTAMP_COMPAT'],
    ['HTTP_INIT', 'private-client-value', 'HTTP_INIT'],
    ['ENDPOINT_CONFIG', 'private-package-value', 'ENDPOINT_CONFIG'],
    ['ENDPOINT_UNAVAILABLE', 'private-network-value', 'ENDPOINT_UNAVAILABLE'],
  ];
  for (const [stage, text, code] of cases) {
    const error = startupFailure(stage, new Error(text));
    assert.equal(error.code, code);
    assert.equal(/\/private|private-package-value/.test(error.message), false);
  }
  assert.equal(readStartupFailure({ code: 'toString', message: 'secret' }).code, 'STARTUP_UNKNOWN');
});

test('父进程就绪失败保留固定诊断，退出不会再覆盖为通用状态', async () => {
  const engine = new EngineClient(); const child = new EventEmitter();
  const run = { child, cancelled: false, exited: false };
  engine.run = run;
  const states: unknown[] = []; engine.on('state', (value: unknown) => states.push(value));
  const pending = engine.waitReady(run);
  child.emit('message', { event: 'fatal', data: { code: 'TIMESTAMP_COMPAT', message: 'secret' } });
  await assert.rejects(pending, (error: any) => error.code === 'TIMESTAMP_COMPAT' && !error.message.includes('secret'));
  child.emit('exit', 1);
  await flush();
  assert.deepEqual(states, []);
});

test('行情队列失败保留初始化阶段，拒绝外来错误原文', async () => {
  class Engine extends EventEmitter {
    /** 模拟阶段失败。参数：无；返回：拒绝的Promise。 */
    async call() { throw Object.assign(new Error('secret'), { code: 'TIMESTAMP_COMPAT' }); }
    /** 模拟回收。参数：无；返回：Promise<void>。 */
    async stop() {}
  }
  const engine = new Engine(); const feed = new NativeFeed(engine); const events: MarketStreamEvent[] = [];
  try {
    feed.subscribe('AAPL.US', event => events.push(event)); await flush();
    engine.emit('fatal', { code: 'NATIVE_ARCH', message: 'secret' });
    const errors = events.filter(event => event.type === 'status' && event.state === 'error');
    assert.ok(errors.some(event => event.type === 'status' && event.message.includes('[TIMESTAMP_COMPAT]')));
    assert.ok(errors.some(event => event.type === 'status' && event.message.includes('[NATIVE_ARCH]')));
    assert.equal(JSON.stringify(errors).includes('secret'), false);
  } finally { await feed.close(); }
});

test('真实子进程覆盖继承的HOME，并将安装缺失诊断经IPC传回父进程', async () => {
  const previous = process.env.LONGBRIDGE_INSTALL_DIR;
  const previousHome = process.env.HOME;
  const inheritedHome = join(tmpdir(), `market-lens-inherited-home-${crypto.randomUUID()}`);
  process.env.HOME = inheritedHome;
  process.env.LONGBRIDGE_INSTALL_DIR = join(tmpdir(), `market-lens-missing-${crypto.randomUUID()}`);
  const engine = new EngineClient(); const diagnostics: any[] = [];
  engine.on('fatal', (value: unknown) => diagnostics.push(value));
  try {
    await assert.rejects(engine.call('connect'), (error: any) => error.code === 'INSTALL_MISSING' && error.message.includes('[INSTALL_MISSING]'));
    // worker先校验HOME等于隔离目录；能到安装阶段说明已覆盖继承值。
    assert.deepEqual(diagnostics, [{ code: 'INSTALL_MISSING' }]);
    assert.equal(process.env.HOME, inheritedHome);
  } finally {
    if (previous === undefined) delete process.env.LONGBRIDGE_INSTALL_DIR;
    else process.env.LONGBRIDGE_INSTALL_DIR = previous;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await engine.stop();
  }
});
