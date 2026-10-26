import type { MarketEvent } from '../shared/events';

/** 事件归入显示日期。参数：事件；返回：北京时间日期，只有日期的财报保留来源当地日期，非法值返回null。 */
export function eventDay(event: MarketEvent): string | null {
  const value = event.scheduledAt ?? event.publishedAt;
  if (!value) return null;
  if (event.dateOnly) return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds + 8 * 3_600_000).toISOString().slice(0, 10) : null;
}

/** 构造周一开始的完整月历。参数：YYYY-MM月份；返回：日期标签，月外占位为null。 */
export function monthDays(month: string): (string | null)[] {
  const first = new Date(`${month}-01T00:00:00Z`);
  const offset = (first.getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const length = Math.ceil((offset + count) / 7) * 7;
  return Array.from({ length }, (_, index) => index >= offset && index < offset + count
    ? `${month}-${String(index - offset + 1).padStart(2, '0')}` : null);
}

/** 月份平移。参数：有效月份及月数偏移；返回：跨年安全的YYYY-MM。 */
export function shiftMonth(month: string, offset: number): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}
