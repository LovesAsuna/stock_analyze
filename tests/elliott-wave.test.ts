import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../shared/types';
import { analyzeElliottWaves, isImpulseWave, type WavePivot } from '../shared/elliott-wave';

/** 在锚点间生成确定性OHLCV，非真实行情。参数：价格锚点、每段柱数；返回：严格有序已收盘柱。 */
export function waveCandles(prices = [110, 100, 120, 110, 145, 130, 155, 140, 149, 125, 138], spacing = 8): Candle[] {
  const candles: Candle[] = [];
  for (let index = 0; index <= (prices.length - 1) * spacing; index += 1) {
    const segment = Math.min(Math.floor(index / spacing), prices.length - 2);
    const close = prices[segment] + (prices[segment + 1] - prices[segment]) * (index - segment * spacing) / spacing;
    candles.push({ time: 1700000000 + index * 86400, open: close, close, high: close + 0.25, low: close - 0.25, volume: 1000, confirmed: true });
  }
  return candles;
}

/** 将价格数组转为交替测试拐点。参数：价格和方向；返回：六点样本。 */
function pivots(prices: number[], up = true): WavePivot[] {
  return prices.map((price, index) => ({ index, time: 1700000000 + index, confirmedAt: 1700000010 + index,
    price, kind: (index % 2 === 0) === up ? 'low' : 'high' }));
}

test('已确认拐点识别上涨1至5及完整ABC，记录真实确认时间且不修改输入', () => {
  const candles = waveCandles(); const before = JSON.stringify(candles);
  candles.forEach(Object.freeze); Object.freeze(candles);
  const analysis = analyzeElliottWaves(candles, 3);
  assert.equal(analysis.pattern?.direction, 'up');
  assert.deepEqual(analysis.pattern?.impulse.map(point => point.label), ['0', '1', '2', '3', '4', '5']);
  assert.deepEqual(analysis.pattern?.correction.map(point => point.label), ['A', 'B', 'C']);
  for (const point of analysis.pivots) assert.equal(point.confirmedAt, candles[point.index + 3].time);
  assert.equal(JSON.stringify(candles), before);
});

test('下降推动浪使用完全对称规则，不把上涨逻辑直接套价格', () => {
  const candles = waveCandles([190, 200, 180, 190, 155, 170, 145, 160, 151, 175, 162]);
  const pattern = analyzeElliottWaves(candles, 3).pattern;
  assert.equal(pattern?.direction, 'down'); assert.equal(pattern?.correction.length, 3);
});

test('拒绝2越起点、3最短、4重叠及未突破的5浪，允许等长推动浪', () => {
  assert.equal(isImpulseWave(pivots([100, 120, 110, 145, 130, 155])), true);
  assert.equal(isImpulseWave(pivots([100, 120, 110, 130, 125, 145])), true);
  for (const prices of [[100, 120, 99, 145, 130, 155], [100, 120, 110, 125, 122, 150],
    [100, 120, 110, 145, 119, 155], [100, 120, 110, 145, 130, 144]]) {
    assert.equal(isImpulseWave(pivots(prices)), false);
    assert.equal(isImpulseWave(pivots(prices.map(value => 300 - value), false)), false);
  }
});

test('未收盘或不足右侧窗口时不提前确认，尾柱变化不改变已确认拐点', () => {
  const candles = waveCandles();
  const short = candles.slice(0, 51); // 第48根是5浪极值，还缺第51根确认柱。
  assert.equal(analyzeElliottWaves(short, 3).pattern, null);
  const candidate = candles.slice(0, 52).map(candle => ({ ...candle }));
  candidate[51].confirmed = false;
  assert.equal(analyzeElliottWaves(candidate, 3).pattern, null);
  candidate[51].confirmed = true;
  assert.equal(analyzeElliottWaves(candidate, 3).pattern?.impulse.at(-1)?.index, 48);
  candidate.push({ ...candles[52], confirmed: false });
  const before = analyzeElliottWaves(candidate, 3).pivots;
  candidate[52] = { ...candidate[52], high: 999 };
  assert.deepEqual(analyzeElliottWaves(candidate, 3).pivots, before);
});

test('高于5浪起点的B不标ABC，横盘和不足数据不伪造波浪', () => {
  assert.equal(analyzeElliottWaves(waveCandles([110, 100, 120, 110, 145, 130, 155, 140, 160, 125, 138]), 3).pattern?.correction.length, 0);
  assert.equal(analyzeElliottWaves([]).pattern, null);
  assert.equal(analyzeElliottWaves(waveCandles([100, 100, 100, 100])).pattern, null);
  assert.equal(analyzeElliottWaves(waveCandles().slice(0, 10)).pattern, null);
});

test('只使用传入窗口内的结构与确认柱，显式选中旧窗口仍可识别', () => {
  const candles = waveCandles(); const latest = candles.at(-1)!;
  const extended = [...candles, ...Array.from({ length: 100 }, (_, index) => ({ ...latest, time: latest.time + (index + 1) * 86400 }))];
  assert.equal(analyzeElliottWaves(extended.slice(100), 3).pattern, null);
  assert.equal(analyzeElliottWaves(extended.slice(0, 81), 3).pattern?.impulse[5].index, 48);
  assert.equal(analyzeElliottWaves(extended.slice(0, 51), 3).pattern, null);
  assert.equal(analyzeElliottWaves(extended.slice(0, 52), 3).pattern?.impulse[5].index, 48);
});

test('验证K线和确认窗口边界，拒绝乱序、无效价格及未知灵敏度', () => {
  const candles = waveCandles();
  assert.throws(() => analyzeElliottWaves(candles, 0), /确认窗口/);
  assert.throws(() => analyzeElliottWaves([...candles].reverse()), /严格递增/);
  assert.throws(() => analyzeElliottWaves([{ ...candles[0], high: NaN }]), /有限数/);
});
