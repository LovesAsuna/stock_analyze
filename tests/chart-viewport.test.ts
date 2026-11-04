import test from 'node:test';
import assert from 'node:assert/strict';
import { loadViewport, saveViewport, type ViewportRange } from '../src/chart-viewport';

const STORAGE_KEY = 'market-lens-chart-viewports-v1';
const KEY = 'native|TEST.US|day';
const candles = Array.from({ length: 100 }, (_, index) => ({ time: 1700000000 + index * 86400 }));
interface Fixture { data: Map<string, string>; warnings: unknown[][]; fail: string }

/**
 * 在独立的内存本机存储中运行同步断言，始终恢复 window 和日志方法。
 * @param run 接收存储、固定日志及可配置失败方式的测试回调。
 * @returns 无返回值；断言异常原样交给测试运行器。
 */
function withStorage(run: (fixture: Fixture) => void): void {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalWarn = console.warn;
  const fixture: Fixture = { data: new Map(), warnings: [], fail: '' };
  const storage = {
    getItem(key: string) {
      if (fixture.fail === 'read') throw new Error('secret-read-error');
      return fixture.data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (fixture.fail === 'write') throw new Error('secret-quota-error');
      fixture.data.set(key, value);
    },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    get localStorage() {
      if (fixture.fail === 'access') throw new Error('secret-access-error');
      return storage;
    },
  } });
  console.warn = (...args: unknown[]) => { fixture.warnings.push(args); };
  try { run(fixture); }
  finally {
    console.warn = originalWarn;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

/** 无记录返回 null；保存小数下标并隔离来源、证券及周期；无参数，返回断言结果。 */
test('视野保存小数逻辑范围，来源、证券和周期之间互不串用', () => withStorage(({ data }) => {
  assert.equal(loadViewport(KEY, candles), null);
  const range = { from: 10.25, to: 40.75 };
  assert.equal(saveViewport(KEY, candles, range), '');
  assert.deepEqual(loadViewport(KEY, candles), range);
  for (const key of ['other|TEST.US|day', 'native|OTHER.US|day', 'native|TEST.US|week']) {
    assert.equal(loadViewport(key, candles), null);
  }
  const stored = JSON.parse(data.get(STORAGE_KEY)!);
  assert.equal(stored.version, 1);
  assert.deepEqual(stored.entries[0], {
    key: KEY, anchor: candles[40].time, offset: 0.75, span: 30.5, latest: false,
  });
}));

/** 历史锚点保持同一 UTC 柱，补充或裁剪前缀不改变实际时间；无参数，返回断言结果。 */
test('历史视野通过固定时间锚点应对历史起点及末端变化', () => withStorage(() => {
  assert.equal(saveViewport(KEY, candles, { from: 10.25, to: 40.75 }), '');
  const prefix = [{ time: candles[0].time - 172800 }, { time: candles[0].time - 86400 }];
  assert.deepEqual(loadViewport(KEY, [...prefix, ...candles]), { from: 12.25, to: 42.75 });
  assert.deepEqual(loadViewport(KEY, candles.slice(10)), { from: 0.25, to: 30.75 });
  const appended = [...candles, { time: candles.at(-1)!.time + 86400 }];
  assert.deepEqual(loadViewport(KEY, appended), { from: 10.25, to: 40.75 });
  assert.equal(loadViewport(KEY, candles.filter((_, index) => index !== 40)), null);
}));

/** 最新位置保存末柱相对偏移，新增柱后保持跨度和右侧留白；无参数，返回断言结果。 */
test('最新视野跟随当前末柱，同时保留右侧留白', () => withStorage(({ data }) => {
  assert.equal(saveViewport(KEY, candles, { from: 75.5, to: 105.75 }), '');
  const entry = JSON.parse(data.get(STORAGE_KEY)!).entries[0];
  assert.equal(entry.anchor, candles[99].time);
  assert.equal(entry.latest, true);
  assert.equal(entry.offset, 6.75);
  assert.deepEqual(loadViewport(KEY, candles.slice(10, 90)), { from: 55.5, to: 85.75 });
  const appended = [...candles, { time: candles[99].time + 86400 }];
  assert.deepEqual(loadViewport(KEY, appended), { from: 76.5, to: 106.75 });
  assert.equal(saveViewport(KEY, candles, { from: 79, to: 99 }), '');
  assert.deepEqual(loadViewport(KEY, appended), { from: 80, to: 100 });
}));

/** 边界范围可覆盖少量柱或处于有限右侧空白；无参数，返回断言结果。 */
test('允许单柱、跨度边界、左侧留白和合理右侧空白', () => withStorage(() => {
  for (const range of [{ from: -2, to: 0 }, { from: -99901, to: 99 }, { from: 100, to: 102 }]) {
    assert.equal(saveViewport(KEY, candles, range), '');
    assert.deepEqual(loadViewport(KEY, candles), range);
  }
  const single = candles.slice(0, 1);
  assert.equal(saveViewport(KEY, single, { from: -1, to: 1 }), '');
  assert.deepEqual(loadViewport(KEY, single), { from: -1, to: 1 });
}));

/** 非法逻辑范围不能覆盖已有有效存储；无参数，返回断言结果。 */
test('拒绝非有限、倒置、超大、过窄和远离数据的范围', () => withStorage(({ data }) => {
  saveViewport(KEY, candles, { from: 10, to: 40 });
  const previous = data.get(STORAGE_KEY);
  const invalid = [
    { from: NaN, to: 40 }, { from: 0, to: Infinity }, { from: -Infinity, to: 0 },
    { from: 5, to: 4 }, { from: 0, to: 1.99 }, { from: 0, to: 100001 },
    { from: -10, to: -1 }, { from: 2000, to: 2010 }, { from: 1e30, to: 1e30 },
    null, { from: '1', to: 40 },
  ];
  for (const range of invalid) {
    assert.match(saveViewport(KEY, candles, range as ViewportRange), /无效/);
    assert.equal(data.get(STORAGE_KEY), previous);
  }
}));

/** 非法键和柱序列不能进入持久化边界；无参数，返回断言结果。 */
test('拒绝空键、超长键、控制字符、无效时间及乱序柱', () => withStorage(({ data }) => {
  const range = { from: 10, to: 40 };
  for (const key of ['', ' ', ' key', 'key ', 'a\nb', '__proto__', 'constructor', 'prototype', 'x'.repeat(257), 7, null]) {
    assert.match(saveViewport(key as string, candles, range), /无效/);
    assert.equal(loadViewport(key as string, candles), null);
  }
  const invalid = [[], [{ time: NaN }], [{ time: Infinity }], [{ time: 1.2 }],
    [{ time: 8640000000001 }], [{ time: 2 }, { time: 1 }], [{ time: 1 }, { time: 1 }],
    Array(2), [null], undefined];
  for (const value of invalid) {
    assert.match(saveViewport(KEY, value as typeof candles, range), /无效/);
    assert.equal(loadViewport(KEY, value as typeof candles), null);
  }
  assert.equal(data.size, 0);
}));

/** 保存时更新最近使用顺序，超出 64 项淘汰最久未保存项；无参数，返回断言结果。 */
test('最多保留最近保存的 64 个键，更新同键不产生重复记录', () => withStorage(({ data }) => {
  for (let index = 0; index < 64; index++) {
    assert.equal(saveViewport(`source|TEST${index}.US|day`, candles, { from: 10, to: 40 }), '');
  }
  saveViewport('source|TEST0.US|day', candles, { from: 20, to: 50 });
  saveViewport('source|NEW.US|day', candles, { from: 10, to: 40 });
  assert.equal(loadViewport('source|TEST1.US|day', candles), null);
  assert.deepEqual(loadViewport('source|TEST0.US|day', candles), { from: 20, to: 50 });
  const store = JSON.parse(data.get(STORAGE_KEY)!);
  assert.equal(store.entries.length, 64);
  assert.equal(new Set(store.entries.map((entry: { key: string }) => entry.key)).size, 64);
  assert.ok(data.get(STORAGE_KEY)!.length <= 65536);
}));

/** 解析边界整体拒绝坏记录，并允许下一次有效保存修复；无参数，返回断言结果。 */
test('损坏、超长、未知版本及错误结构不崩溃且不泄漏原始内容', () => withStorage(({ data, warnings }) => {
  saveViewport(KEY, candles, { from: 10, to: 40 });
  const valid = JSON.parse(data.get(STORAGE_KEY)!);
  const entry = valid.entries[0];
  const invalid = ['secret-raw-storage', 'x'.repeat(65537), 'null', '[]',
    JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, extra: true }),
    JSON.stringify({ version: 1, entries: {} }),
    JSON.stringify({ version: 1, entries: Array(65).fill(entry) }),
    JSON.stringify({ version: 1, entries: [entry, entry] }),
  ];
  for (const patch of [{ key: '__proto__' }, { anchor: null }, { offset: -1 }, { offset: 1 },
    { span: 1 }, { span: 100001 }, { span: '20' }, { latest: 'false' }, { extra: true },
    { latest: true, offset: 1000010 }]) {
    invalid.push(JSON.stringify({ version: 1, entries: [{ ...entry, ...patch }] }));
  }
  for (const raw of invalid) {
    data.set(STORAGE_KEY, raw);
    assert.equal(loadViewport(KEY, candles), null);
  }
  assert.ok(warnings.length >= invalid.length);
  assert.ok(warnings.every((args) => args.length === 1 && args[0] === '图表视野读取失败：本机内容损坏或版本无效，已忽略。'));
  assert.equal(saveViewport(KEY, candles, { from: 10, to: 40 }), '');
  assert.deepEqual(loadViewport(KEY, candles), { from: 10, to: 40 });
}));

/** 存储 getter、读取和配额错误只产生固定日志及安全提示；无参数，返回断言结果。 */
test('本机存储禁用、读取失败及配额不足均安全返回', () => withStorage((fixture) => {
  for (const failure of ['access', 'read', 'write']) {
    fixture.fail = failure;
    assert.equal(loadViewport(KEY, candles), null);
    const error = saveViewport(KEY, candles, { from: 10, to: 40 });
    assert.match(error, /无法保存到本机/);
    assert.doesNotMatch(error, /secret/);
  }
  assert.ok(fixture.warnings.every((args) => args.length === 1 && typeof args[0] === 'string' && !args[0].includes('secret')));
}));

/** 无浏览器时读取回退且保存提供安全错误；无参数，返回断言结果。 */
test('无 window 的运行环境不会因调用持久化函数崩溃', () => withStorage(() => {
  Reflect.deleteProperty(globalThis, 'window');
  assert.equal(loadViewport(KEY, candles), null);
  assert.match(saveViewport(KEY, candles, { from: 10, to: 40 }), /无法保存到本机/);
}));
