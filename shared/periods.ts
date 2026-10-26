import type { Period } from './types';

/** 策略和常规 K 线使用的完整周期列表，按日内到年度排序；不包含分时视图。 */
export const PERIODS: readonly Period[] = Object.freeze([
  '1m', '5m', '15m', '30m', '1h', 'day', 'week', 'month', 'quarter', 'year',
]);

/** 常规 K 线周期的中文展示名称。 */
export const PERIOD_LABELS: Readonly<Record<Period, string>> = Object.freeze({
  '1m': '1分钟', '5m': '5分钟', '15m': '15分钟', '30m': '30分钟', '1h': '1小时',
  day: '日线', week: '周线', month: '月线', quarter: '季线', year: '年线',
});

const INTRADAY_SECONDS: Readonly<Partial<Record<Period, number>>> = Object.freeze({
  '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600,
});

/**
 * 校验来自系统边界的周期值，仅接受常规 K 线周期。
 * @param value 待校验的任意输入。
 * @returns 输入属于 Period 时返回 true，并收窄类型。
 */
export function isPeriod(value: unknown): value is Period {
  return typeof value === 'string' && Object.hasOwn(PERIOD_LABELS, value);
}

/**
 * 获取日内周期的名义秒数；日历周期必须结合交易所日历计算。
 * @param period 常规 K 线周期，运行时非法值会抛错。
 * @returns 日内周期秒数；日、周、月、季、年返回 null。
 */
export function periodSeconds(period: Period): number | null {
  if (!isPeriod(period)) throw new Error('不支持的 K 线周期');
  return INTRADAY_SECONDS[period] ?? null;
}

/**
 * 判断周期是否依赖交易所日历，而非固定持续秒数。
 * @param period 常规 K 线周期，运行时非法值会抛错。
 * @returns 日、周、月、季、年返回 true，其余返回 false。
 */
export function isCalendarPeriod(period: Period): boolean {
  return periodSeconds(period) === null;
}
