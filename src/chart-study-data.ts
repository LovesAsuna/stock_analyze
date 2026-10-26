import { validateCandles } from '../shared/indicators';
import type { Candle } from '../shared/types';

/** 单根 K 线对应的图表指标；窗口不足时为 null，不参与策略配置。 */
export interface ChartStudyPoint {
  /** 原始 K 线时间，单位为 UTC Unix 秒。 */
  time: number;
  /** 最近 5 根收盘价的简单移动平均。 */
  ma5: number | null;
  /** 最近 10 根收盘价的简单移动平均。 */
  ma10: number | null;
  /** 最近 20 根收盘价的简单移动平均。 */
  ma20: number | null;
  /** 最近 50 根收盘价的简单移动平均。 */
  ma50: number | null;
  /** 使用 6 个价格变化预热的 Wilder RSI。 */
  rsi6: number | null;
  /** 使用 12 个价格变化预热的 Wilder RSI。 */
  rsi12: number | null;
  /** 使用 24 个价格变化预热的 Wilder RSI。 */
  rsi24: number | null;
}

// shared 中的 sma、wilderRsi 均未导出；为避免计算无关策略指标或修改 shared，
// 在此独立实现仅供图表使用的纯函数，保持相同的预热与 Wilder 平滑约定。

/**
 * 按完整窗口计算 SMA，每个结果只使用当前和之前的收盘价。
 * @param closes 已通过行情校验的收盘价序列，不会被修改。
 * @param period 模块内部固定的正整数窗口长度。
 * @returns 与输入等长的均线序列，前 period - 1 项为 null。
 */
function calculateSma(closes: readonly number[], period: number): (number | null)[] {
  let total = 0;
  return closes.map((close, index) => {
    total += close;
    if (index >= period) total -= closes[index - period];
    return index + 1 >= period ? total / period : null;
  });
}

/**
 * 计算 Wilder RSI，首个值取 period 个变化的平均涨跌，之后按 1/period 平滑。
 * @param closes 已通过行情校验的收盘价序列，不会被修改。
 * @param period 模块内部固定的正整数变化数量。
 * @returns 与输入等长的 RSI；预热为 null，平盘为 50，零亏损上涨为 100。
 */
function calculateWilderRsi(closes: readonly number[], period: number): (number | null)[] {
  let averageGain = 0;
  let averageLoss = 0;
  return closes.map((close, index) => {
    if (index === 0) return null;
    const change = close - closes[index - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (index <= period) {
      averageGain += gain / period;
      averageLoss += loss / period;
    } else {
      averageGain = (averageGain * (period - 1) + gain) / period;
      averageLoss = (averageLoss * (period - 1) + loss) / period;
    }
    if (index < period) return null;
    if (averageGain === 0 && averageLoss === 0) return 50;
    if (averageLoss === 0) return 100;
    return 100 - 100 / (1 + averageGain / averageLoss);
  });
}

/**
 * 计算仅供图表显示的 MA5/10/20/50 和 RSI6/12/24，不读取或修改策略配置。
 * 未确认的当前 K 线也参与绘图；所有结果仅依赖当前及历史 K 线，不读取未来。
 * @param candles 时间严格递增的合法 OHLCV 序列；数组和 K 线对象均不会被修改。
 * @returns 与输入等长、时间一一对应的指标数组；空输入返回空数组，行情无效时抛出中文错误。
 */
export function calculateChartStudies(candles: readonly Candle[]): ChartStudyPoint[] {
  // validateCandles 只读数据，但签名要求可变数组；浅拷贝适配，避免断言去除 readonly。
  validateCandles([...candles]);
  const closes = candles.map((candle) => candle.close);
  const ma5 = calculateSma(closes, 5);
  const ma10 = calculateSma(closes, 10);
  const ma20 = calculateSma(closes, 20);
  const ma50 = calculateSma(closes, 50);
  const rsi6 = calculateWilderRsi(closes, 6);
  const rsi12 = calculateWilderRsi(closes, 12);
  const rsi24 = calculateWilderRsi(closes, 24);
  return candles.map((candle, index) => ({
    time: candle.time,
    ma5: ma5[index], ma10: ma10[index], ma20: ma20[index], ma50: ma50[index],
    rsi6: rsi6[index], rsi12: rsi12[index], rsi24: rsi24[index],
  }));
}
