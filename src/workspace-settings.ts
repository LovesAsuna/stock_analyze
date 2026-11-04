import type { ChartLayers, Oscillator } from './Chart';
import type { ChartView } from './MarketTimeframes';
import type { IntradaySession } from '../shared/intraday';
import type { Period, Security, SourceMode } from '../shared/types';
import { isPeriod } from '../shared/periods';
import { getChinaWeekRange } from '../shared/review';
import { isRecord } from './local-settings';

export interface WorkspaceSettings {
  source: SourceMode; security: Security; period: Period; view: ChartView; session: IntradaySession;
  range: { start: string; end: string }; preset: 'week' | 'month' | 'custom';
  layers: ChartLayers; oscillator: Oscillator;
}

/** 计算相对复盘区间。参数：来源、预设、可选当前时间；返回：结束日不含的日期范围。 */
export function presetRange(source: SourceMode, preset: 'week' | 'month', now = new Date()) {
  const week = getChinaWeekRange(source === 'demo' ? new Date('2026-10-16T08:00:00Z') : now);
  const end = week.end.slice(0, 10);
  return { start: preset === 'week' ? week.start.slice(0, 10) : new Date(Date.parse(end) - 30 * 86400000).toISOString().slice(0, 10), end };
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  source: 'demo', security: { symbol: 'NVDA.US', name: '英伟达', market: 'US', currency: 'USD' },
  period: 'day', view: 'candles', session: 'regular', range: presetRange('demo', 'week'), preset: 'week',
  layers: { ma: false, sar: false, boll: false, signals: true, fills: true }, oscillator: 'macd',
};

/** 校验自然日，拒绝自动溢出的日期。参数：未知值；返回：是否为完整有效日期字符串。 */
function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** 校验证券身份，防止错误市场和任意输入进入接口。参数：未知证券；返回：有效证券类型。 */
export function isSecurity(value: unknown): value is Security {
  if (!isRecord(value) || typeof value.symbol !== 'string' || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 160) return false;
  return value.market === 'HK' ? /^\d{1,5}\.HK$/.test(value.symbol) && value.currency === 'HKD'
    : value.market === 'US' && /^[A-Z][A-Z0-9.-]{0,35}\.US$/.test(value.symbol) && value.currency === 'USD';
}

/** 校验工作台完整设置。参数：浏览器边界输入；返回：有效设置类型，未知枚举和日期均拒绝。 */
export function isWorkspaceSettings(value: unknown): value is WorkspaceSettings {
  if (!isRecord(value) || !isSecurity(value.security) || !isPeriod(value.period) || !isRecord(value.range) || !isRecord(value.layers)) return false;
  if (!isDate(value.range.start) || !isDate(value.range.end)) return false;
  const days = (Date.parse(value.range.end) - Date.parse(value.range.start)) / 86400000;
  return (value.source === 'demo' || value.source === 'longbridge') &&
    typeof value.view === 'string' && ['candles', 'intraday', 'five-day'].includes(value.view) &&
    typeof value.session === 'string' && ['overnight', 'pre', 'regular', 'post', 'all'].includes(value.session) &&
    typeof value.preset === 'string' && ['week', 'month', 'custom'].includes(value.preset) && days >= 1 && days <= 93 &&
    ['ma', 'sar', 'boll', 'signals', 'fills'].every(key => typeof (value.layers as Record<string, unknown>)[key] === 'boolean') &&
    typeof value.oscillator === 'string' && ['macd', 'rsi', 'dmi'].includes(value.oscillator);
}

/** 恢复时更新相对日期，自定义日期保持原样。参数：已校验设置、可选当前时间；返回：当前日期适用设置。 */
export function restoreWorkspaceSettings(value: WorkspaceSettings, now = new Date()): WorkspaceSettings {
  return value.preset === 'custom' ? value : { ...value, range: presetRange(value.source, value.preset, now) };
}

/** 校验分时窗格开关。参数：未知值；返回：两个严格布尔值组成的有效配置。 */
export function isIntradayStudies(value: unknown): value is { rsi: boolean; macd: boolean } {
  return isRecord(value) && typeof value.rsi === 'boolean' && typeof value.macd === 'boolean';
}
export const DEFAULT_INTRADAY_STUDIES = { rsi: true, macd: true };

/** 校验自选市场过滤。参数：未知值；返回：是否为受支持市场。 */
export function isWatchlistMarket(value: unknown): value is 'all' | 'HK' | 'US' {
  return value === 'all' || value === 'HK' || value === 'US';
}
