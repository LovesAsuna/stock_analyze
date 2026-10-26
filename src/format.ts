import type { Period } from '../shared/types';
import { barOpenTime } from '../shared/review';
import { isCalendarPeriod } from '../shared/periods';

/** 格式化有限数值；空值以破折号显示，返回中文地区格式字符串。 */
export function formatNumber(value: number | null | undefined, digits = 2): string {
  return value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

/** 返回带正负号的百分比；输入为百分数而非比例。 */
export function formatPercent(value: number | null | undefined): string {
  return value == null ? '—' : `${value > 0 ? '+' : ''}${formatNumber(value)}%`;
}

/** 保留原始 UTC 时间，以指定交易所或中国时区格式化。 */
export function formatTime(time: number, symbol: string, period: Period, china = false): string {
  const calendar = isCalendarPeriod(period);
  return new Intl.DateTimeFormat('zh-CN', { timeZone: china ? 'Asia/Shanghai' : symbol.endsWith('.HK') ? 'Asia/Hong_Kong' : 'America/New_York',
    ...(calendar && period !== 'day' ? { year: 'numeric' as const } : {}), month: '2-digit', day: '2-digit',
    ...(calendar && !china ? {} : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const }) }).format(new Date((calendar && !china ? barOpenTime(time, symbol, period) : time) * 1000));
}

/** 下载本机生成的复盘文本。参数为文件名及内容，无上传动作。 */
export function downloadText(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
