import { useMemo, type RefObject } from 'react';
import { isRecord, useLocalSetting } from './local-settings';
import type { IChartApi } from 'lightweight-charts';
import type { Candle } from '../shared/types';
import { analyzeElliottWaves } from '../shared/elliott-wave';
import { resolveWaveWindow, type WaveWindow, type WaveWindowSelection } from './wave-window';

interface WavePreferences { enabled: boolean; radius: number; windows: WaveWindowSelection[] }
const DEFAULT_WAVE_PREFERENCES: WavePreferences = { enabled: false, radius: 6, windows: [] };

/** 校验波浪设置及最多64个隔离时间窗口。参数：未知存储值；返回：完整有效配置类型。 */
export function isWavePreferences(value: unknown): value is WavePreferences {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || ![3, 6, 12].includes(value.radius as number) || !Array.isArray(value.windows) || value.windows.length > 64) return false;
  return value.windows.every(window => isRecord(window) && typeof window.key === 'string' && window.key.length <= 160 &&
    typeof window.start === 'number' && typeof window.end === 'number' && Number.isSafeInteger(window.start) && Number.isSafeInteger(window.end) &&
    window.start > 0 && window.end >= window.start && window.end <= 8640000000000) &&
    new Set(value.windows.map(window => window.key)).size === value.windows.length;
}

/** 管理波浪开关和按来源证券周期隔离的时间窗口。参数：真实柱、上下文键、图表引用；返回：分析及持久窗口操作。 */
export function useWaveWindow(candles: Candle[], key: string, chartRef: RefObject<{ chart: IChartApi } | null>) {
  const [preferences, setPreferences, error] = useLocalSetting('market-lens-waves-v1', DEFAULT_WAVE_PREFERENCES, isWavePreferences);
  const { enabled, radius } = preferences;
  const selection = preferences.windows.find(window => window.key === key) ?? null;
  const window = resolveWaveWindow(candles, key, selection);
  const selectedCandles = useMemo(() => candles.slice(window.from, window.to + 1), [candles, window.from, window.to]);
  const analysis = useMemo(() => enabled ? analyzeElliottWaves(selectedCandles, radius) : null, [selectedCandles, enabled, radius]);
  /** 保存绝对时间，追加数据不会移动用户已选的边界。参数：含两端索引窗口；返回：无。 */
  const select = (next: WaveWindow) => {
    const start = candles[next.from]; const end = candles[next.to];
    if (start && end) setPreferences(previous => ({ ...previous,
      windows: [...previous.windows.filter(window => window.key !== key), { key, start: start.time, end: end.time }].slice(-64) }));
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
  const toggle = (next: boolean) => { if (next && !selection) selectVisible(); setPreferences(previous => ({ ...previous, enabled: next })); };
  /** 更新确认灵敏度。参数：支持的确认柱数；返回：无，无效输入由统一边界拒绝。 */
  const setRadius = (next: number) => setPreferences(previous => ({ ...previous, radius: next }));
  return { enabled, toggle, radius, setRadius, window, selectedCandles, analysis, select, selectVisible, error };
}
