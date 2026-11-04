import type { Period } from '../shared/types';
import { barOpenTime } from '../shared/review';
import { isCalendarPeriod } from '../shared/periods';

// 缓存格式规则而非行情值；报价变化时复用地区设置，仍格式化最新数值与时间。
const numberFormatters = new Map<number, Intl.NumberFormat>();
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

/** 格式化有限数值；参数为数值及小数位，空值返回破折号，否则返回中文地区字符串。 */
export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  let formatter = numberFormatters.get(digits);
  if (!formatter) {
    formatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
    numberFormatters.set(digits, formatter);
  }
  return formatter.format(value);
}

/** 返回带正负号的百分比；输入为百分数而非比例。 */
export function formatPercent(value: number | null | undefined): string {
  return value == null ? '—' : `${value > 0 ? '+' : ''}${formatNumber(value)}%`;
}

/** 保留原始 UTC 时间；参数为时间、证券、周期和中国时区开关，返回相同口径的显示时间。 */
export function formatTime(time: number, symbol: string, period: Period, china = false): string {
  const calendar = isCalendarPeriod(period);
  const timeZone = china ? 'Asia/Shanghai' : symbol.endsWith('.HK') ? 'Asia/Hong_Kong' : 'America/New_York';
  const withYear = calendar && period !== 'day'; const withTime = !calendar || china;
  const key = `${timeZone}:${withYear}:${withTime}`;
  let formatter = timeFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('zh-CN', { timeZone,
      ...(withYear ? { year: 'numeric' as const } : {}), month: '2-digit', day: '2-digit',
      ...(withTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const } : {}) });
    timeFormatters.set(key, formatter);
  }
  return formatter.format(new Date((calendar && !china ? barOpenTime(time, symbol, period) : time) * 1000));
}

/** 下载本机生成的复盘文本。参数为文件名及内容，无上传动作。 */
export function downloadText(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
