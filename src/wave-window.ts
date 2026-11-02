import type { Candle } from '../shared/types';

export interface WaveWindow { from: number; to: number }
export interface WaveWindowSelection { key: string; start: number; end: number }

/** 用时间保存窗口，实时追加柱不移动用户边界。参数：有序K线、证券周期键、已选时间；返回：包含两端的柱索引。 */
export function resolveWaveWindow(candles: Candle[], key: string, selection: WaveWindowSelection | null): WaveWindow {
  const last = Math.max(0, candles.length - 1);
  if (!selection || selection.key !== key) return { from: Math.max(0, last - 99), to: last };
  const start = candles.findIndex(candle => candle.time >= selection.start);
  const end = candles.findIndex(candle => candle.time > selection.end);
  const from = start < 0 ? last : start;
  return { from, to: Math.max(from, end < 0 ? last : Math.max(0, end - 1)) };
}

/** 将拖动或键盘输入限制到数据内，禁止边界交叉。参数：当前窗口、边界、目标索引、总柱数；返回：修正窗口。 */
export function moveWaveBoundary(window: WaveWindow, edge: 'from' | 'to', index: number, length: number): WaveWindow {
  if (!Number.isFinite(index) || length < 1) return window;
  const bounded = Math.max(0, Math.min(length - 1, Math.round(index)));
  return edge === 'from' ? { from: Math.min(bounded, window.to), to: window.to }
    : { from: window.from, to: Math.max(bounded, window.from) };
}
