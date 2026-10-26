import { validateCandles } from './indicators.js';
import { barOpenTime } from './review.js';
import type { Candle, Period } from './types.js';

/**
 * 合并同一原生数据源的历史与实时K线，不从最新价或累计成交量构造柱。
 * @param history 历史基线，包含指标所需的长历史。
 * @param updates Longbridge原生K线快照；同一柱允许修订，确认状态不得倒退。
 * @param symbol 当前证券，用于统一日线日期标签。
 * @param period 当前周期。
 * @returns 按时间排序的新数组，保留原历史起点与已确认前缀。
 */
export function mergeLiveCandles(history: Candle[], updates: Candle[], symbol: string, period: Period): Candle[] {
  validateCandles(history);
  validateCandles(updates);
  const result = new Map(history.map((candle) => [barOpenTime(candle.time, symbol, period), candle]));
  const historyStart = history.length ? barOpenTime(history[0].time, symbol, period) : -Infinity;
  for (const candle of updates) {
    const key = barOpenTime(candle.time, symbol, period);
    if (key < historyStart) continue;
    const existing = result.get(key);
    if (existing?.confirmed && !candle.confirmed) continue;
    result.set(key, existing ? { ...candle, time: existing.time } : candle);
  }
  const candles = [...result.values()].sort((left, right) => left.time - right.time);
  // 未确认柱保持在尾部；缺口由原生快照补齐，不能仅因收到新柱就确认上一柱。
  const firstUnknown = candles.findIndex((candle) => !candle.confirmed);
  if (firstUnknown >= 0 && candles.slice(firstUnknown + 1).some((candle) => candle.confirmed)) {
    throw new Error('实时K线存在未完成的历史缺口，等待原生数据重新同步。');
  }
  return candles;
}
