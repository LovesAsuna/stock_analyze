import { useMemo, useState, type RefObject } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { Candle } from '../shared/types';
import { analyzeElliottWaves } from '../shared/elliott-wave';
import { resolveWaveWindow, type WaveWindow, type WaveWindowSelection } from './wave-window';

/** 管理波浪开关和按证券周期隔离的时间窗口。参数：真实柱、证券周期键、图表引用；返回：分析及窗口操作，不改变视野。 */
export function useWaveWindow(candles: Candle[], key: string, chartRef: RefObject<{ chart: IChartApi } | null>) {
  const [enabled, setEnabled] = useState(false);
  const [radius, setRadius] = useState(6);
  const [selection, setSelection] = useState<WaveWindowSelection | null>(null);
  const window = resolveWaveWindow(candles, key, selection);
  const selectedCandles = useMemo(() => candles.slice(window.from, window.to + 1), [candles, window.from, window.to]);
  const analysis = useMemo(() => enabled ? analyzeElliottWaves(selectedCandles, radius) : null, [selectedCandles, enabled, radius]);
  /** 保存绝对时间，追加数据不会移动用户已选的边界。参数：含两端索引窗口；返回：无。 */
  const select = (next: WaveWindow) => {
    const start = candles[next.from]; const end = candles[next.to];
    if (start && end) setSelection({ key, start: start.time, end: end.time });
  };
  /** 选取当前可见且实际存在的K线。参数：无；返回：无，不改变时间轴。 */
  const selectVisible = () => {
    const range = chartRef.current?.chart.timeScale().getVisibleLogicalRange();
    if (!range || !candles.length) return;
    const last = candles.length - 1;
    const from = Math.max(0, Math.min(last, Math.ceil(range.from)));
    select({ from, to: Math.max(from, Math.min(last, Math.floor(range.to))) });
  };
  /** 开启时从当前视野初始化，关闭只清除展示。参数：是否开启；返回：无。 */
  const toggle = (next: boolean) => { if (next) selectVisible(); setEnabled(next); };
  return { enabled, toggle, radius, setRadius, window, selectedCandles, analysis, select, selectVisible };
}
