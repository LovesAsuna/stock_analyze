import type { Period } from './types';

const DAY_SECONDS = 24 * 60 * 60;
const formatters = new Map<string, Intl.DateTimeFormat>();
type CalendarDate = { year: number; month: number; day: number };
type LocalParts = CalendarDate & { hour: number; minute: number; second: number };

/**
 * 校验 Unix 秒，避免无效时间进入交易所日历计算。
 * @param time UTC Unix 秒。
 * @returns 验证通过无返回值，否则抛出明确错误。
 */
export function validateTime(time: number): void {
  if (!Number.isFinite(time) || !Number.isFinite(new Date(time * 1000).getTime())) {
    throw new Error('时间必须是有效的 UTC Unix 秒');
  }
}

/**
 * 提取交易所当地日历字段，复用格式器以减少重复创建。
 * @param time UTC Unix 秒。
 * @param zone IANA 时区。
 * @returns 交易所当地年月日时分秒。
 */
function localParts(time: number, zone: string): LocalParts {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    formatters.set(zone, formatter);
  }
  return Object.fromEntries(formatter.formatToParts(new Date(time * 1000))
    .filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)])) as LocalParts;
}

/**
 * 将交易所墙上时间转换为 UTC，分别计算各端点的 DST 偏移。
 * @param date 本地年月日。
 * @param hour 本地小时。
 * @param minute 本地分钟。
 * @param zone IANA 时区。
 * @returns UTC Unix 秒；仅用于常规交易时段，不涉及凌晨 DST 歧义。
 */
function exchangeTime(date: CalendarDate, hour: number, minute: number, zone: string): number {
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour, minute) / 1000;
  let guess = wall;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = localParts(guess, zone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) / 1000;
    guess += wall - represented;
  }
  validateTime(guess);
  return guess;
}

/**
 * 确定交易所时区；HK/.HK 或纯数字视为港股，其余沿用美股约定。
 * @param symbol 证券代码或市场标识。
 * @returns 港股或美股的 IANA 时区，空代码抛错。
 */
export function marketZone(symbol: string): string {
  if (typeof symbol !== 'string' || symbol.trim() === '') throw new Error('证券代码不能为空');
  const normalized = symbol.trim().toUpperCase();
  return normalized === 'HK' || normalized.endsWith('.HK') || /^\d+$/.test(normalized)
    ? 'Asia/Hong_Kong' : 'America/New_York';
}

/**
 * 读取 K 线日期标签，保持日线对 UTC 午夜和当地午夜的兼容规则。
 * @param time 原始 K 线 UTC 秒。
 * @param zone 交易所时区。
 * @returns 标签对应的本地年月日；非 UTC 午夜取交易所当地日期。
 */
function labelDate(time: number, zone: string): CalendarDate {
  const utc = new Date(time * 1000);
  if (utc.getUTCHours() === 0 && utc.getUTCMinutes() === 0 && utc.getUTCSeconds() === 0) {
    return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
  }
  return localParts(time, zone);
}

/**
 * 将日历字段映射为仅供日期运算的 UTC 日期，不能当作交易所绝对时间。
 * @param date 日历年月日，允许月或日溢出以计算相邻日期。
 * @returns 用 UTC 字段进行日历运算的日期对象。
 */
function calendarDate(date: CalendarDate): Date {
  return new Date(Date.UTC(date.year, date.month - 1, date.day));
}

/**
 * 从日期运算对象提取日历字段。
 * @param date 以 UTC 字段保存日历的日期对象。
 * @returns 年月日字段。
 */
function dateFields(date: Date): CalendarDate {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/**
 * 在周期边界内跳过周末，未引入未知的节假日或从后续行情倒推历史。
 * @param date 日历周期首日或末日。
 * @param direction 首日向后取 1，末日向前取 -1。
 * @returns 相应方向最近的周一至周五日期。
 */
function weekdayDate(date: Date, direction: 1 | -1): CalendarDate {
  const result = new Date(date.getTime());
  while (result.getUTCDay() === 0 || result.getUTCDay() === 6) {
    result.setUTCDate(result.getUTCDate() + direction);
  }
  return dateFields(result);
}

/**
 * 计算标签所在日历周期的常规开收盘；周以周一为首日。
 * 无节假日日历时保守使用末个工作日 16:00，不因缺柱或半日市提前确认。
 * @param time 原始日期标签或周期内时间的 UTC 秒。
 * @param symbol 证券代码或 HK/US。
 * @param period 日、周、月、季、年；其他值抛错。
 * @returns 首个工作日 09:30 至末个工作日 16:00 的绝对时间，日线保持原日期。
 */
export function calendarBarWindow(time: number, symbol: string, period: Period): { start: number; end: number } {
  validateTime(time);
  const zone = marketZone(symbol);
  const date = labelDate(time, zone);
  let first = calendarDate(date);
  let last = calendarDate(date);
  if (period === 'week') {
    first.setUTCDate(first.getUTCDate() - (first.getUTCDay() + 6) % 7);
    last = new Date(first.getTime() + 6 * DAY_SECONDS * 1000);
  } else if (period === 'month' || period === 'quarter' || period === 'year') {
    const month = period === 'year' ? 1 : period === 'quarter' ? Math.floor((date.month - 1) / 3) * 3 + 1 : date.month;
    const months = period === 'year' ? 12 : period === 'quarter' ? 3 : 1;
    first = calendarDate({ year: date.year, month, day: 1 });
    last = calendarDate({ year: date.year, month: month + months, day: 0 });
  } else if (period !== 'day') {
    throw new Error('不支持的日历 K 线周期');
  }
  // 日线午夜标签保留既有语义，不为周末标签寻找邻近交易日。
  const startDate = period === 'day' ? date : weekdayDate(first, 1);
  const endDate = period === 'day' ? date : weekdayDate(last, -1);
  return { start: exchangeTime(startDate, 9, 30, zone), end: exchangeTime(endDate, 16, 0, zone) };
}

/**
 * 计算日内柱确认时间；港股上午柱截断于午休，港美股尾柱截断于 16:00。
 * @param time 原始柱起点 UTC 秒。
 * @param symbol 证券代码或 HK/US。
 * @param seconds 日内名义周期秒数。
 * @returns 确认 UTC 秒；非正常交易时段的既有时间标签仍按名义秒数处理。
 */
export function intradayConfirmationTime(time: number, symbol: string, seconds: number): number {
  const zone = marketZone(symbol);
  const parts = localParts(time, zone);
  const minute = parts.hour * 60 + parts.minute;
  const nominalEnd = time + seconds;
  validateTime(nominalEnd);
  if (minute >= 570 && minute < 960) {
    if (zone === 'Asia/Hong_Kong' && minute < 720) {
      return Math.min(nominalEnd, exchangeTime(parts, 12, 0, zone));
    }
    if (zone !== 'Asia/Hong_Kong' || minute >= 780) {
      return Math.min(nominalEnd, exchangeTime(parts, 16, 0, zone));
    }
  }
  return nominalEnd;
}

/**
 * 检查长周期窗口内的成交是否属于正常工作日交易时段，排除夜间、周末及港股午休。
 * 无节假日日历，不能识别假日、临时休市及半日市，调用方仍须保证成交数据真实。
 * @param time 成交 UTC 秒。
 * @param symbol 证券代码或 HK/US。
 * @returns 当地周一至周五的常规交易时段内返回 true，收盘端点不含。
 */
export function isRegularTradingTime(time: number, symbol: string): boolean {
  validateTime(time);
  const zone = marketZone(symbol);
  const parts = localParts(time, zone);
  const weekday = calendarDate(parts).getUTCDay();
  const minute = parts.hour * 60 + parts.minute;
  return weekday !== 0 && weekday !== 6 && minute >= 570 && minute < 960 &&
    (zone !== 'Asia/Hong_Kong' || minute < 720 || minute >= 780);
}
