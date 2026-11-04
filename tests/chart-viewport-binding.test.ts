import test from 'node:test';
import assert from 'node:assert/strict';
import type { IChartApi } from 'lightweight-charts';
import { bindViewportPersistence } from '../src/chart-viewport-binding';
import { loadViewport, type ViewportRange } from '../src/chart-viewport';
import type { Candle } from '../shared/types';

/** 真实交互标记之外的图表范围通知不得触发持久化；切换上下文必须先提交旧键。 */
test('视野绑定忽略行情更新，操作合并保存且正确隔离来源周期', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const values = new Map<string, string>(); let writes = 0;
  const windowTarget = Object.assign(new EventTarget(), { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { writes++; values.set(key, value); },
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: windowTarget });
  const container = new EventTarget(); const errors: string[] = [];
  let range: ViewportRange = { from: 0, to: 100 }; let listener: (() => void) | null = null;
  const scale = {
    getVisibleLogicalRange: () => range,
    setVisibleLogicalRange: (next: ViewportRange) => { range = next; listener?.(); },
    subscribeVisibleLogicalRangeChange: (next: () => void) => { listener = next; },
    unsubscribeVisibleLogicalRangeChange: () => { listener = null; },
  };
  const chart = { timeScale: () => scale } as unknown as IChartApi;
  const candles = Array.from({ length: 120 }, (_, index) => ({ time: 1700000000 + index * 86400 })) as Candle[];
  const binding = bindViewportPersistence(chart, container as HTMLElement, error => errors.push(error));
  try {
    binding.beforeUpdate('demo:NVDA.US:day', candles); binding.afterUpdate('day');
    assert.deepEqual(range, { from: 100, to: 121 });
    for (let index = 0; index < 10; index++) {
      binding.beforeUpdate('demo:NVDA.US:day', candles); scale.setVisibleLogicalRange({ from: 101, to: 122 }); binding.afterUpdate('day');
    }
    windowTarget.dispatchEvent(new Event('pagehide')); assert.equal(writes, 0);
    container.dispatchEvent(new Event('pointerdown'));
    scale.setVisibleLogicalRange({ from: 50, to: 80 }); scale.setVisibleLogicalRange({ from: 40, to: 70 });
    windowTarget.dispatchEvent(new Event('pointerup')); assert.equal(writes, 0);
    binding.beforeUpdate('longbridge:NVDA.US:day', candles); binding.afterUpdate('day');
    assert.equal(writes, 1); assert.deepEqual(range, { from: 100, to: 121 });
    assert.deepEqual(loadViewport('demo:NVDA.US:day', candles), { from: 40, to: 70 });
    // 工具动作下一帧才更新范围，交互标记必须保留到异步范围通知。
    binding.capture(); scale.setVisibleLogicalRange({ from: 90, to: 120 });
    windowTarget.dispatchEvent(new Event('pagehide')); assert.equal(writes, 2);
    binding.beforeUpdate('demo:NVDA.US:day', candles); binding.afterUpdate('day');
    assert.deepEqual(range, { from: 40, to: 70 });
    assert.equal(loadViewport('demo:NVDA.US:week', candles), null);
    assert.ok(errors.every(error => error === ''));
  } finally {
    binding.destroy(); assert.equal(listener, null);
    if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window');
  }
});
