import type { Candle, Execution, Period, ReviewItem, Signal } from './types';
import { validateCandles } from './indicators';
import { isPeriod, periodSeconds } from './periods';
import { calendarBarWindow, intradayConfirmationTime, isRegularTradingTime, marketZone, validateTime } from './calendar-bars';

const CHINA_OFFSET_SECONDS = 8 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;

/**
 * 将 K 线起始时间/日期标签转换为实际收盘确认时间，不能直接用日线午夜筛选复盘。
 * @param signalTime 原始 K 线时间（UTC Unix 秒）。
 * @param symbol 证券代码或 HK/US，决定市场时区。
 * @param period 日内按名义周期并截断午休/收盘；日历周期按交易所周期末日收盘。
 * @returns 确认 UTC 秒；无节假日日历时按最后工作日 16:00 保守确认，未建模半日市。
 */
export function signalConfirmationTime(signalTime: number, symbol: string, period: Period): number {
  validateTime(signalTime);
  const seconds = periodSeconds(period);
  return seconds === null ? calendarBarWindow(signalTime, symbol, period).end
    : intradayConfirmationTime(signalTime, symbol, seconds);
}

/**
 * 取得锚点所在中国自然周的工作日范围，即周一 00:00 至周六 00:00。
 * @param now 锚点绝对时间，默认系统当前时间；周六日仍属于刚结束的工作周。
 * @returns 中国时区带 +08:00 的 ISO 闭开区间，不排除法定休市日。
 */
export function getChinaWeekRange(now: Date = new Date()): { start: string; end: string } {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('周范围锚点日期无效');
  const shifted = new Date(now.getTime() + CHINA_OFFSET_SECONDS * 1000);
  const midnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  const daysSinceMonday = (shifted.getUTCDay() + 6) % 7;
  const monday = midnight - daysSinceMonday * DAY_SECONDS * 1000;
  const isoDate = (time: number): string => `${new Date(time).toISOString().slice(0, 10)}T00:00:00+08:00`;
  return { start: isoDate(monday), end: isoDate(monday + 5 * DAY_SECONDS * 1000) };
}

/**
 * 解析中国日期或带显式时区的 ISO 边界，不依赖运行机器时区。
 * @param value YYYY-MM-DD（解释为中国午夜）或带 Z/时区偏移的 ISO 时间。
 * @returns UTC Unix 秒，非法输入抛错。
 */
function rangeBoundary(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) {
    throw new Error('复盘边界必须是 ISO 日期或时间');
  }
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!isDate && !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('ISO 时间必须包含明确时区');
  const normalized = isDate ? `${value}T00:00:00+08:00` : value;
  const parsed = Date.parse(normalized);
  const date = value.slice(0, 10);
  if (!Number.isFinite(parsed) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error('复盘边界日期无效');
  }
  return parsed / 1000;
}

/**
 * 判断实际确认时间是否落入中国工作周闭开区间。
 * @param time UTC Unix 秒；日线应先使用 signalConfirmationTime 转换。
 * @param start 中国日期或带明确时区的起点。
 * @param end 中国日期或带明确时区的终点。
 * @returns start <= time < end；无效边界抛错。
 */
export function inChinaRange(time: number, start: string, end: string): boolean {
  validateTime(time);
  const startTime = rangeBoundary(start);
  const endTime = rangeBoundary(end);
  if (startTime >= endTime) throw new Error('复盘区间起点必须早于终点');
  return time >= startTime && time < endTime;
}

/**
 * 获取 K 线实际开盘时间，兼容日线的午夜日期标签。
 * @param time 原始 K 线时间（UTC Unix 秒）。
 * @param symbol 证券代码或 HK/US。
 * @param period 日历周期按当地首个工作日 09:30（日线保持原日期），日内沿用原始起点。
 * @returns 开盘 UTC Unix 秒。
 */
export function barOpenTime(time: number, symbol: string, period: Period): number {
  validateTime(time);
  const seconds = periodSeconds(period);
  marketZone(symbol);
  return seconds === null ? calendarBarWindow(time, symbol, period).start : time;
}

/**
 * 获取下一根 K 线的实际可成交窗口，日历周期按当地工作日开收盘为界。
 * @param candle 下一根行情。
 * @param symbol 证券代码或市场。
 * @param period 行情周期。
 * @returns 闭开成交窗口；不通过下一根时间差推断周期，避免周末或缺柱扩大窗口。
 */
function nextBarWindow(candle: Candle, symbol: string, period: Period): { start: number; end: number } {
  return { start: barOpenTime(candle.time, symbol, period),
    end: signalConfirmationTime(candle.time, symbol, period) };
}

/**
 * 检查真实成交结构与唯一标识，不把缺失记录伪装成交易历史。
 * @param executions 调用方提供的真实或显式演示成交。
 * @returns 验证成功无返回值；重复 ID、非法价格数量等抛错。
 */
function validateExecutions(executions: Execution[]): void {
  const ids = new Set<string>();
  for (const execution of executions) {
    validateTime(execution.time);
    if (!execution.id || ids.has(execution.id)) throw new Error('成交 ID 必须存在且唯一');
    if (!execution.symbol || (execution.side !== 'buy' && execution.side !== 'sell') ||
        !Number.isFinite(execution.price) || execution.price <= 0 ||
        !Number.isFinite(execution.quantity) || execution.quantity <= 0) throw new Error('成交记录字段无效');
    ids.add(execution.id);
  }
}

/**
 * 匹配确认后的下一柱窗口内首个同方向成交，每笔成交最多使用一次。
 * @param signals 已按所需周范围筛选的信号；日线筛选必须使用实际确认时间。
 * @param executions 可匹配的成交记录；不完整时将未匹配项标记为 unknown。
 * @param candles 信号所用的完整行情。
 * @param executionsComplete 成交查询是否完整，默认 true。
 * @param symbol 证券代码或市场，默认 HK；具体代码同时限制成交证券。
 * @param period K 线周期，默认 day。
 * @param executionRange 成交查询的 ISO 闭开范围；未覆盖整个匹配窗口时，未匹配项为 unknown。
 * @returns 原信号顺序的复盘项；先按信号时间分配成交，金额与五柱价格变化不视为已实现盈亏。
 */
export function buildReview(signals: Signal[], executions: Execution[], candles: Candle[],
  executionsComplete = true, symbol = 'HK', period: Period = 'day',
  executionRange?: { start: string; end: string }): ReviewItem[] {
  validateCandles(candles);
  validateExecutions(executions);
  marketZone(symbol);
  if (!isPeriod(period)) throw new Error('不支持的 K 线周期');
  const longPeriod = periodSeconds(period) === null && period !== 'day';
  const queryStart = executionRange ? rangeBoundary(executionRange.start) : -Infinity;
  const queryEnd = executionRange ? rangeBoundary(executionRange.end) : Infinity;
  if (queryStart >= queryEnd) throw new Error('成交查询区间起点必须早于终点');
  const used = new Set<string>();
  const sortedExecutions = [...executions].sort((left, right) => left.time - right.time || left.id.localeCompare(right.id));
  const results = new Map<Signal, ReviewItem>();
  const specificSymbol = !['HK', 'US'].includes(symbol.toUpperCase());
  const ordered = [...signals].sort((left, right) => left.time - right.time || left.id.localeCompare(right.id));
  for (const signal of ordered) {
    const candle = candles[signal.index];
    if (!Number.isInteger(signal.index) || !candle || candle.time !== signal.time || candle.close !== signal.close ||
        (signal.side !== 'buy' && signal.side !== 'sell')) throw new Error(`信号 ${signal.id} 与行情不一致`);
    const next = candles[signal.index + 1];
    let state: ReviewItem['state'];
    let execution: Execution | null = null;
    let note: string;
    if (!signal.confirmed || !candle.confirmed) {
      state = 'pending';
      note = '当前 K 线尚未确认，不匹配成交。';
    } else if (!next) {
      state = executionsComplete ? 'pending' : 'unknown';
      note = executionsComplete ? '下一根 K 线尚未出现，等待可成交窗口。' : '成交记录不完整，无法判断是否执行。';
    } else {
      const window = nextBarWindow(next, symbol, period);
      const start = Math.max(window.start, signalConfirmationTime(signal.time, symbol, period));
      execution = sortedExecutions.find((candidate) => !used.has(candidate.id) && candidate.side === signal.side &&
        (specificSymbol ? candidate.symbol.toUpperCase() === symbol.toUpperCase()
          : marketZone(candidate.symbol) === marketZone(symbol)) &&
        candidate.time >= start && candidate.time < window.end &&
        (!longPeriod || isRegularTradingTime(candidate.time, symbol))) ?? null;
      if (execution) {
        used.add(execution.id);
        state = 'matched';
        note = '已匹配信号确认后、下一根 K 线窗口内的同方向成交；这不证明成交由信号触发。';
      } else if (queryStart > start || queryEnd < window.end) {
        state = 'unknown';
        note = '成交查询窗口不足，未完整覆盖信号确认后的下一根 K 线窗口，无法判断是否执行。';
      } else if (!executionsComplete) {
        state = 'unknown';
        note = '成交记录不完整，无法判断是否执行，不能当作未执行。';
      } else if (!next.confirmed) {
        state = 'pending';
        note = '下一根 K 线尚未结束，成交匹配窗口仍在等待确认。';
      } else {
        state = 'unmatched';
        note = '完整成交记录中，未发现确认后的下一根 K 线窗口内同方向成交。';
      }
    }
    results.set(signal, { signal, execution, state,
      note: `${note} 五柱变化仅为下一柱开盘至第五柱收盘的价格统计，不代表实际、未实现或保证盈亏。` });
  }
  return signals.map((signal) => results.get(signal)!);
}
