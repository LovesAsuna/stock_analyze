import type { Candle } from './types';
import { validateCandles } from './indicators';

export type WaveLabel = '0' | '1' | '2' | '3' | '4' | '5' | 'A' | 'B' | 'C';
export interface WavePivot {
  index: number; time: number; price: number; kind: 'high' | 'low';
  /** 拐点所在柱之后第radius根已收盘柱的时间，不能当作拐点当时已知。 */
  confirmedAt: number;
}
export interface ElliottPattern {
  direction: 'up' | 'down';
  impulse: (WavePivot & { label: WaveLabel })[];
  correction: (WavePivot & { label: WaveLabel })[];
}
export interface ElliottAnalysis { radius: number; pivots: WavePivot[]; pattern: ElliottPattern | null }

/** 提取左右窗口确认的交替高低点。参数：严格有序K线、左右窗口；返回：拐点，末端同类极值可替换前值。 */
function confirmedPivots(candles: Candle[], radius: number): WavePivot[] {
  const pivots: WavePivot[] = [];
  // 中间未收盘或缺失确认时不跨越该柱使用未来数据。
  const firstOpen = candles.findIndex(candle => !candle.confirmed);
  const closed = firstOpen < 0 ? candles.length : firstOpen;
  for (let index = radius; index + radius < closed; index += 1) {
    const candle = candles[index];
    let high = true; let low = true;
    for (let neighbor = index - radius; neighbor <= index + radius; neighbor += 1) {
      if (neighbor === index) continue;
      // 同价平台取最后一根；同柱同时为高低点时无法还原先后，直接跳过。
      if (candles[neighbor].high > candle.high || (neighbor > index && candles[neighbor].high === candle.high)) high = false;
      if (candles[neighbor].low < candle.low || (neighbor > index && candles[neighbor].low === candle.low)) low = false;
    }
    if (high === low) continue;
    const pivot: WavePivot = { index, time: candle.time, price: high ? candle.high : candle.low,
      kind: high ? 'high' : 'low', confirmedAt: candles[index + radius].time };
    const previous = pivots.at(-1);
    if (!previous || previous.kind !== pivot.kind) pivots.push(pivot);
    else if (high ? pivot.price >= previous.price : pivot.price <= previous.price) pivots[pivots.length - 1] = pivot;
  }
  return pivots;
}

/** 校验标准推动浪，移植自ESJavadex的MIT规则核心。参数：六个交替拐点；返回：是否符合标准推动浪。 */
export function isImpulseWave(pivots: readonly WavePivot[]): boolean {
  if (pivots.length !== 6) return false;
  const direction = pivots[0].kind === 'low' ? 1 : -1;
  const values = pivots.map(pivot => pivot.price * direction);
  if (pivots.some((pivot, index) => !Number.isFinite(pivot.price) || pivot.price <= 0 ||
    pivot.kind !== (index % 2 === 0 ? pivots[0].kind : direction === 1 ? 'high' : 'low') ||
    (index > 0 && pivot.time <= pivots[index - 1].time))) return false;
  const [origin, first, second, third, fourth, fifth] = values;
  // 标准推动浪：2不越起点、3突破1、4不重叠1；首版不把楔形或失败5浪混入。
  if (!(first > origin && second > origin && second < first && third > first && fourth > first && fourth < third && fifth > third)) return false;
  const wave1 = first - origin; const wave3 = third - second; const wave5 = fifth - fourth;
  // 与上游相比允许等长；只有3严格短于1和5时才违反“3不能最短”。
  return !(wave3 < wave1 && wave3 < wave5);
}

/** 验证推动浪之后的简单锯齿修正，不把普通三次摆动强制标成ABC。参数：推动浪终点及三个拐点、方向；返回：是否合法。 */
function isZigzagCorrection(pivots: WavePivot[], direction: 'up' | 'down'): boolean {
  if (pivots.length !== 4) return false;
  const sign = direction === 'up' ? 1 : -1;
  const [start, first, second, third] = pivots.map(pivot => pivot.price * sign);
  const lengthA = start - first;
  return lengthA > 0 && second > first && second < start && (second - first) / lengthA <= 0.786 && third < first;
}

/** 识别最新标准推动浪及可选完整ABC。参数：真实K线、确认窗口3/6/12；返回：拐点和最新候选，不产生预测或交易信号。 */
export function analyzeElliottWaves(candles: Candle[], radius = 6): ElliottAnalysis {
  validateCandles(candles);
  if (![3, 6, 12].includes(radius)) throw new Error('波浪确认窗口必须为3、6或12根K线');
  const pivots = confirmedPivots(candles, radius);
  let pattern: ElliottPattern | null = null;
  for (let start = pivots.length - 6; start >= 0; start -= 1) {
    const impulse = pivots.slice(start, start + 6);
    if (!isImpulseWave(impulse)) continue;
    const direction = impulse[0].kind === 'low' ? 'up' : 'down';
    const correction = pivots.slice(start + 5, start + 9);
    pattern = { direction, impulse: impulse.map((pivot, index) => ({ ...pivot, label: String(index) as WaveLabel })),
      correction: isZigzagCorrection(correction, direction)
        ? correction.slice(1).map((pivot, index) => ({ ...pivot, label: (['A', 'B', 'C'] as const)[index] })) : [] };
    break;
  }
  return { radius, pivots, pattern };
}
