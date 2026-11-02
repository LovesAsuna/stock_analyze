import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWaveWindow, moveWaveBoundary } from '../src/wave-window';
import type { Candle } from '../shared/types';

/** 生成窗口索引测试柱。参数：数量；返回：严格递增时间柱。 */
function candles(length: number): Candle[] {
  return Array.from({ length }, (_, index) => ({ time: 1700000000 + index * 86400, open: 10, close: 10, high: 11, low: 9, volume: 1, confirmed: true }));
}

test('窗口按时间保存，追加和前置数据不移动选中的柱，切换证券周期恢复默认', () => {
  const original = candles(150); const key = 'RKLB.US-day';
  const selection = { key, start: original[70].time, end: original[120].time };
  assert.deepEqual(resolveWaveWindow(original, key, null), { from: 50, to: 149 });
  assert.deepEqual(resolveWaveWindow(candles(160), key, selection), { from: 70, to: 120 });
  assert.deepEqual(resolveWaveWindow(original.slice(20), key, selection), { from: 50, to: 100 });
  assert.deepEqual(resolveWaveWindow(original, 'RKLB.US-week', selection), { from: 50, to: 149 });
  assert.deepEqual(resolveWaveWindow(original, 'AAPL.US-day', selection), { from: 50, to: 149 });
  assert.deepEqual(resolveWaveWindow([], key, null), { from: 0, to: 0 });
});

test('拖动吸附整柱、夹到数据范围且起止不能交叉，非法输入保持原值', () => {
  const selected = { from: 10, to: 60 };
  assert.deepEqual(moveWaveBoundary(selected, 'from', 20.6, 100), { from: 21, to: 60 });
  assert.deepEqual(moveWaveBoundary(selected, 'from', 99, 100), { from: 60, to: 60 });
  assert.deepEqual(moveWaveBoundary(selected, 'to', -10, 100), { from: 10, to: 10 });
  assert.deepEqual(moveWaveBoundary(selected, 'to', 999, 100), { from: 10, to: 99 });
  assert.deepEqual(moveWaveBoundary(selected, 'from', NaN, 100), selected);
});
