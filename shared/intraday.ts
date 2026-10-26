import type { SourceMode } from './types.js';

/** 分时查询时段；all 合并数据源实际提供的所有时段。 */
export type IntradaySession = 'overnight' | 'pre' | 'regular' | 'post' | 'all';

/** 独立分时点，不使用 K 线或策略信号的数据结构。 */
export interface IntradayPoint {
  /** 原始 UTC Unix 秒，不人为平移时区。 */
  time: number;
  price: number;
  volume: number;
  /** 数据源未提供有效均价时为 null，不通过 K 线伪造。 */
  averagePrice: number | null;
  session: Exclude<IntradaySession, 'all'>;
}

/** 交易所本地日历，hour/minute 用于明确交易时段。 */
export interface ExchangeParts { year: number; month: number; day: number; hour: number; minute: number }

const exchangeFormatters = new Map<string, Intl.DateTimeFormat>();

/** 根据代码选择时区，参数为港美证券代码，返回 IANA 时区。 */
export function exchangeZone(symbol: string): string {
  return symbol.endsWith('.HK') ? 'Asia/Hong_Kong' : 'America/New_York';
}

/** 将 UTC Unix 秒转换为交易所日历，参数为时间和代码，返回本地年月日时分。 */
export function exchangeParts(time: number, symbol: string): ExchangeParts {
  if (!Number.isFinite(time) || !Number.isFinite(new Date(time * 1000).getTime())) throw new Error('交易所时间无效。');
  const zone = exchangeZone(symbol);
  let formatter = exchangeFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    exchangeFormatters.set(zone, formatter);
  }
  return Object.fromEntries(formatter.formatToParts(new Date(time * 1000))
    .filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)])) as unknown as ExchangeParts;
}

/** 将交易所本地日历转换为 UTC 秒，参数为日历和代码，返回支持夏令时的绝对时间。 */
export function exchangeTimestamp(parts: ExchangeParts, symbol: string): number {
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) / 1000;
  let guess = wall;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = exchangeParts(guess, symbol);
    guess += wall - Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) / 1000;
  }
  return guess;
}

/** 校验外部时段和天数，参数为未知输入，合法无返回值，否则明确报错。 */
export function validateIntradaySelection(session: unknown, days: unknown): void {
  if (typeof session !== 'string' || !['overnight', 'pre', 'regular', 'post', 'all'].includes(session)) throw new Error('不支持的分时时段。');
  if (days !== 1 && days !== 5) throw new Error('分时天数仅支持 1 或 5。');
}

/** 一日或五个最近可用交易日的分时响应。 */
export interface IntradayData {
  source: SourceMode;
  symbol: string;
  session: IntradaySession;
  days: 1 | 5;
  points: IntradayPoint[];
  fetchedAt: string;
  warnings: string[];
}
