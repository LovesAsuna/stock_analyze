import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { resolveDesktopInstallation } = require('../server/native/desktop-installation.cjs');
const { installDesktopTimestamp } = require('../server/native/native-compat-timestamp.cjs');

/** 创建无原生执行的安装布局样本。参数：应用根目录、平台、架构；返回：资源路径。 */
function installation(root: string, platform: string, arch: string) {
  const resources = platform === 'darwin' ? join(root, 'Contents', 'Resources') : join(root, 'resources');
  const addonPath = join(resources, 'app.asar.unpacked', 'node_modules', '@lb-public', 'engine-neon', 'addons', platform === 'darwin' ? 'mac' : 'win', arch, 'engine_neon.node');
  mkdirSync(join(addonPath, '..'), { recursive: true });
  writeFileSync(addonPath, 'fixture, never executed');
  const asarPath = join(resources, 'app.asar'); writeFileSync(asarPath, 'fixture');
  return { resources, asarPath, addonPath };
}

/** 在自有临时目录中运行并清理样本。参数：测试回调；返回：无。 */
function temporary(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'market-lens-install-test-'));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('扫描Applications下不同名称的长桥应用，分别选择Apple Silicon和Intel模块', () => {
  for (const [name, arch] of [['Longbridge Pro.app', 'arm64'], ['LongPort.app', 'x64'], ['长桥.app', 'arm64'], ['長橋 Pro.app', 'x64']]) {
    temporary(applicationsDir => {
      const expected = installation(join(applicationsDir, name), 'darwin', arch);
      installation(join(applicationsDir, 'Other.app'), 'darwin', arch);
      assert.deepEqual(resolveDesktopInstallation({ platform: 'darwin', arch, installRoot: undefined, applicationsDir }), expected);
    });
  }
});

test('缺少对应架构、ASAR或安装时明确失败，不回退加载另一架构', () => {
  temporary(applicationsDir => {
    assert.throws(() => resolveDesktopInstallation({ platform: 'darwin', arch: 'arm64', installRoot: undefined, applicationsDir }), /未在\/Applications找到/);
    const expected = installation(join(applicationsDir, 'Longbridge.app'), 'darwin', 'x64');
    assert.throws(() => resolveDesktopInstallation({ platform: 'darwin', arch: 'arm64', installRoot: undefined, applicationsDir }), /mac\/arm64/);
    rmSync(expected.asarPath);
    assert.throws(() => resolveDesktopInstallation({ platform: 'darwin', arch: 'x64', installRoot: undefined, applicationsDir }), /app.asar/);
  });
});

test('多个安装要求显式指定，手动app或Resources路径优先且Windows路径兼容', () => {
  temporary(applicationsDir => {
    const root = join(applicationsDir, 'Longbridge.app');
    const expected = installation(root, 'darwin', 'arm64');
    installation(join(applicationsDir, 'LongPort.app'), 'darwin', 'arm64');
    assert.throws(() => resolveDesktopInstallation({ platform: 'darwin', arch: 'arm64', installRoot: undefined, applicationsDir }), /多个可用/);
    for (const installRoot of [root, expected.resources]) assert.deepEqual(resolveDesktopInstallation({ platform: 'darwin', arch: 'arm64', installRoot, applicationsDir }), expected);
    const windows = join(applicationsDir, 'windows'); const win = installation(windows, 'win32', 'x64');
    assert.deepEqual(resolveDesktopInstallation({ platform: 'win32', arch: 'x64', installRoot: windows }), win);
    assert.throws(() => resolveDesktopInstallation({ platform: 'darwin', arch: 'arm64', installRoot: windows }), /指定的长桥安装目录/);
    assert.throws(() => resolveDesktopInstallation({ platform: 'darwin', arch: 'arm64', installRoot: '' }), /非空/);
    assert.throws(() => resolveDesktopInstallation({ platform: 'linux', arch: 'x64' }), /暂不支持/);
  });
});

test('时间戳兼容层读取调用方传入的同版ASAR，不重新套用Windows路径', () => {
  temporary(directory => {
    const prefixValue = '1'.repeat(32);
    const source = Buffer.from(`var W="${prefixValue}",Z=function(A,e){var g=[W,A,e].join("|");return n.qn.sha256(g)};console.timeStamp=Z;`);
    const header = Buffer.from(JSON.stringify({ files: { dist: { files: { main: { files: { 'index.js': { offset: '0', size: source.length } } } } } } }));
    const prefix = Buffer.alloc(16); prefix.writeUInt32LE(header.length + 8, 4); prefix.writeUInt32LE(header.length, 12);
    const asarPath = join(directory, 'mac-app.asar'); writeFileSync(asarPath, Buffer.concat([prefix, header, source]));
    const native = { sha256: (value: string) => createHash('sha256').update(value).digest('hex') };
    const previous = console.timeStamp; const restore = installDesktopTimestamp(native, asarPath);
    try { assert.equal((console.timeStamp as unknown as (value: string, context: string) => string)('sample', 'context'), native.sha256(`${prefixValue}|sample|context`)); }
    finally { restore(); }
    assert.equal(console.timeStamp, previous);
  });
});
