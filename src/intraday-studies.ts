import type { IntradayPoint } from '../shared/intraday';

/** 仅由真实分时价格计算的读数；预热期为 null，不用于生成策略信号。 */
export interface IntradayStudyPoint {
  time: number;
  rsi6: number | null;
  rsi12: number | null;
  rsi24: number | null;
  dif: number | null;
  dea: number | null;
  /** 长桥常用柱值口径：2 × (DIF − DEA)。 */
  macd: number | null;
}

/** 可直接交给图表的连续线段点；时间仍为原始 UTC 秒。 */
export interface IntradayLinePoint { time: number; value: number }

/**
 * 校验图表计算入口，不排序、不填补分钟，也不构造 OHLC 数据。
 * @param points 时间严格递增、价格为正、成交量非负的分时点。
 * @returns 无返回值；输入不合法时抛出明确错误。
 */
function validatePoints(points: readonly IntradayPoint[]): void {
  points.forEach((point, index) => {
    if (!Number.isSafeInteger(point.time) || point.time <= 0 || !Number.isFinite(new Date(point.time * 1000).getTime()) ||
      (index > 0 && point.time <= points[index - 1].time)) throw new Error('分时图时间必须为有效、严格递增的 UTC 秒。');
    if (!Number.isFinite(point.price) || point.price <= 0) throw new Error('分时图价格必须为有限正数。');
    if (!Number.isFinite(point.volume) || point.volume < 0) throw new Error('分时图成交量必须为有限非负数。');
    if (point.averagePrice !== null && (!Number.isFinite(point.averagePrice) || point.averagePrice <= 0)) {
      throw new Error('分时图均价必须为空或有限正数。');
    }
    if (!['overnight', 'pre', 'regular', 'post'].includes(point.session)) throw new Error('分时图交易时段无效。');
  });
}

/**
 * 判断两个分时点能否直接相连；缺失分钟、午休、跨日与时段切换都会分段。
 * @param previous 前一个真实分时点，首点时为空。
 * @param current 当前真实分时点。
 * @returns 时间恰好相差一分钟且属于同一时段时返回 true。
 */
export function isContinuousMinute(previous: IntradayPoint | undefined, current: IntradayPoint): boolean {
  return previous !== undefined && current.time - previous.time === 60 && current.session === previous.session;
}

/**
 * 将缺失数值与缺失时段切成独立线段；不用仅供时间对齐的 whitespace 假设折线会断开。
 * @param points 已校验、严格递增的分时点。
 * @param select 数值选择器；返回 null 的点不绘制，也不跨过该点连线。
 * @returns 无空段、无伪造价格的连续线段数组。
 */
export function splitIntradayLine(points: readonly IntradayPoint[], select: (point: IntradayPoint, index: number) => number | null): IntradayLinePoint[][] {
  const segments: IntradayLinePoint[][] = [];
  let active: IntradayLinePoint[] | null = null;
  points.forEach((point, index) => {
    const value = select(point, index);
    if (value === null || !Number.isFinite(value)) { active = null; return; }
    if (!active || !isContinuousMinute(points[index - 1], point)) { active = []; segments.push(active); }
    active.push({ time: point.time, value });
  });
  return segments;
}

/**
 * 在连续真实分钟上计算 Wilder RSI，与已有图表指标保持相同预热及平盘约定。
 * @param prices 当前连续时段的分时价格，不构造蜡烛数据。
 * @param period 需要的价格变化数，内部固定为 6、12 或 24。
 * @returns 等长 RSI 数组，前 period 项为 null，平盘为 50。
 */
function rsi(prices: readonly number[], period: number): (number | null)[] {
  let gain = 0;
  let loss = 0;
  return prices.map((price, index) => {
    if (index === 0) return null;
    const change = price - prices[index - 1];
    if (index <= period) { gain += Math.max(change, 0) / period; loss += Math.max(-change, 0) / period; }
    else { gain = (gain * (period - 1) + Math.max(change, 0)) / period; loss = (loss * (period - 1) + Math.max(-change, 0)) / period; }
    if (index < period) return null;
    return gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  });
}

/**
 * 以首个完整窗口的 SMA 初始化 EMA，避免把未预热值伪装成有效指标。
 * @param values 连续数值；前置 null 作为预热期跳过。
 * @param period 固定的正整数 EMA 窗口。
 * @returns 等长 EMA，收集到 period 个有效值之前为 null。
 */
function ema(values: readonly (number | null)[], period: number): (number | null)[] {
  let count = 0;
  let sum = 0;
  let previous: number | null = null;
  const weight = 2 / (period + 1);
  return values.map(value => {
    if (value === null) return null;
    count += 1;
    if (count <= period) sum += value;
    if (count < period) return null;
    previous = previous === null ? sum / period : value * weight + previous * (1 - weight);
    return previous;
  });
}

/**
 * 为一个连续时段计算 RSI(6/12/24)、MACD(12/26/9)。
 * @param points 同一时段且分钟连续的合法分时点。
 * @returns 与输入时间一一对应的指标；DIF 第 26 点起、DEA 与柱值第 34 点起有效。
 */
function calculateSegment(points: readonly IntradayPoint[]): IntradayStudyPoint[] {
  const prices = points.map(point => point.price);
  const rsi6 = rsi(prices, 6); const rsi12 = rsi(prices, 12); const rsi24 = rsi(prices, 24);
  const fast = ema(prices, 12); const slow = ema(prices, 26);
  const dif = prices.map((_, index) => fast[index] === null || slow[index] === null ? null : fast[index]! - slow[index]!);
  const dea = ema(dif, 9);
  return points.map((point, index) => ({
    time: point.time, rsi6: rsi6[index], rsi12: rsi12[index], rsi24: rsi24[index], dif: dif[index], dea: dea[index],
    macd: dif[index] === null || dea[index] === null ? null : 2 * (dif[index]! - dea[index]!),
  }));
}

/**
 * 从分时价格计算显示指标；在缺失分钟及交易时段边界重新预热，不跨未知行情计算变化。
 * 现有 chart-study-data 只接收 OHLCV 且内部算法未导出，因此此入口直接消费分时点。
 * @param points 真实分时点，不会被修改；合法空数组返回空数组。
 * @returns 等长的纯展示指标数组；无效输入抛出中文错误。
 */
export function calculateIntradayStudies(points: readonly IntradayPoint[]): IntradayStudyPoint[] {
  validatePoints(points);
  const studies: IntradayStudyPoint[] = [];
  let start = 0;
  for (let index = 1; index <= points.length; index += 1) {
    if (index === points.length || !isContinuousMinute(points[index - 1], points[index])) {
      studies.push(...calculateSegment(points.slice(start, index)));
      start = index;
    }
  }
  return studies;
}
