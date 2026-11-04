import test from 'node:test';
import assert from 'node:assert/strict';
import { isBoolean, readLocalSetting, writeLocalSetting } from '../src/local-settings';
import { DEFAULT_WORKSPACE_SETTINGS, isWorkspaceSettings, restoreWorkspaceSettings } from '../src/workspace-settings';
import { isWavePreferences } from '../src/useWaveWindow';

/** 注入独立应用存储。参数：断言函数；返回：无，总会恢复全局窗口。 */
function withStorage(run: (values: Map<string, string>, storage: Storage) => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window'); const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } } as Storage;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  try { run(values, storage); } finally {
    if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window');
  }
}

/** 版本和内容必须有效，损坏存储不能被读取动作覆盖。 */
test('设置读取拒绝损坏和未知版本，写入失败保留原值', () => withStorage((values, storage) => {
  assert.deepEqual(readLocalSetting('setting', true, isBoolean), { value: true, error: '' });
  assert.equal(writeLocalSetting('setting', false, isBoolean), '');
  assert.equal(readLocalSetting('setting', true, isBoolean).value, false);
  for (const raw of ['{broken', '{"version":2,"value":false}', '{"version":1,"value":"false"}', 'x'.repeat(131073)]) {
    values.set('setting', raw);
    const result = readLocalSetting('setting', true, isBoolean);
    assert.equal(result.value, true); assert.ok(result.error); assert.equal(values.get('setting'), raw);
  }
  values.set('setting', '{"version":1,"value":false}');
  storage.setItem = () => { throw new Error('quota'); };
  assert.ok(writeLocalSetting('setting', true, isBoolean));
  assert.equal(readLocalSetting('setting', true, isBoolean).value, false);
  storage.getItem = () => { throw new Error('disabled'); };
  assert.ok(readLocalSetting('setting', true, isBoolean).error);
}));

/** 恢复边界不能接受错误来源、市场、周期、布尔值或溢出日期。 */
test('工作台设置校验证券身份、周期和复盘日期', () => {
  assert.ok(isWorkspaceSettings(DEFAULT_WORKSPACE_SETTINGS));
  const invalid = [
    { source: 'other' }, { period: '2m' }, { view: 'bad' }, { session: 'bad' }, { preset: 'bad' }, { oscillator: 'bad' },
    { view: ['candles'] }, { session: ['regular'] }, { preset: ['week'] }, { oscillator: ['macd'] },
    { security: { symbol: 'NVDA.US;command', name: 'NVDA', market: 'US', currency: 'USD' } },
    { security: { symbol: '700.HK', name: '腾讯', market: 'US', currency: 'USD' } },
    { layers: { ...DEFAULT_WORKSPACE_SETTINGS.layers, ma: 'true' } },
    { range: { start: '2026-02-30', end: '2026-03-02' } },
    { range: { start: '2026-10-01', end: '2026-10-01' } },
    { range: { start: '2026-01-01', end: '2026-10-01' } },
  ];
  for (const patch of invalid) assert.equal(isWorkspaceSettings({ ...DEFAULT_WORKSPACE_SETTINGS, ...patch }), false);
});

/** 相对范围跨周重算，自定义范围不漂移，演示日期保持固定。 */
test('本周和近30天在重开时依据当前中国日期恢复', () => {
  const saved = { ...DEFAULT_WORKSPACE_SETTINGS, source: 'longbridge' as const };
  const now = new Date('2026-11-04T04:00:00Z');
  assert.deepEqual(restoreWorkspaceSettings(saved, now).range, { start: '2026-11-02', end: '2026-11-07' });
  assert.deepEqual(restoreWorkspaceSettings({ ...saved, preset: 'month' }, now).range, { start: '2026-10-08', end: '2026-11-07' });
  const custom = { ...saved, preset: 'custom' as const, range: { start: '2026-09-01', end: '2026-09-09' } };
  assert.deepEqual(restoreWorkspaceSettings(custom, now), custom);
  assert.deepEqual(restoreWorkspaceSettings(DEFAULT_WORKSPACE_SETTINGS, now).range, DEFAULT_WORKSPACE_SETTINGS.range);
});

/** 波浪边界的绝对时间与上下文不能重复或越界。 */
test('波浪设置校验窗口和灵敏度', () => {
  const window = { key: 'demo:NVDA.US:day', start: 1770000000, end: 1780000000 };
  const valid = { enabled: true, radius: 6, windows: [window] };
  assert.ok(isWavePreferences(valid));
  assert.equal(isWavePreferences({ ...valid, radius: 4 }), false);
  assert.equal(isWavePreferences({ ...valid, windows: [window, window] }), false);
  assert.equal(isWavePreferences({ ...valid, windows: [{ ...window, end: 1 }] }), false);
  assert.equal(isWavePreferences({ ...valid, windows: Array.from({ length: 65 }, (_, index) => ({ ...window, key: String(index) })) }), false);
});
