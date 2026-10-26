import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateChartStudies, type ChartStudyPoint } from '../src/chart-study-data';
import type { Candle } from '../shared/types';

/**
 * 将确定的收盘价转换为合法测试 K 线，不代表真实行情。
 * @param closes 显式给定的收盘价序列。
 * @returns 按分钟递增、开高低收相同的测试 K 线。
 */
function makeCandles(closes: readonly number[]): Candle[] {
  return closes.map((close, index) => ({
    time: 1_700_000_000 + index * 60,
    open: close, high: close, low: close, close, volume: 100, confirmed: true,
  }));
}

/**
 * 比较指标与独立手算期望值，拒绝 null、NaN 和无穷大。
 * @param actual 实际指标值。
 * @param expected 手算的指标期望值。
 * @returns 无返回值；误差超过容差时断言失败。
 */
function assertClose(actual: number | null, expected: number): void {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual! - expected) < 1e-10, `${actual} 应接近 ${expected}`);
}

const movingAverages = [
  { key: 'ma5', period: 5, first: 3, last: 53 },
  { key: 'ma10', period: 10, first: 5.5, last: 50.5 },
  { key: 'ma20', period: 20, first: 10.5, last: 45.5 },
  { key: 'ma50', period: 50, first: 25.5, last: 30.5 },
] as const;
const relativeStrengths = [
  { key: 'rsi6', period: 6, afterGain: 1400 / 19, afterLoss: 7000 / 107 },
  { key: 'rsi12', period: 12, afterGain: 2600 / 37, afterLoss: 28600 / 431 },
  { key: 'rsi24', period: 24, afterGain: 5000 / 73, afterLoss: 115000 / 1727 },
] as const;

test('空输入返回空数组，单根行情保留时间且所有指标未预热', () => {
  assert.deepEqual(calculateChartStudies([]), []);
  const [candle] = makeCandles([100]);
  assert.deepEqual(calculateChartStudies([candle]), [{
    time: candle.time,
    ma5: null, ma10: null, ma20: null, ma50: null,
    rsi6: null, rsi12: null, rsi24: null,
  }]);
});

test('四条 SMA 的完整窗口边界及已知等差序列均值正确', () => {
  const candles = makeCandles(Array.from({ length: 55 }, (_, index) => index + 1));
  const points = calculateChartStudies(candles);
  assert.equal(points.length, candles.length);
  assert.deepEqual(points.map((point) => point.time), candles.map((candle) => candle.time));
  for (const { key, period, first, last } of movingAverages) {
    assert.ok(points.slice(0, period - 1).every((point) => point[key] === null));
    assertClose(points[period - 1][key], first);
    assertClose(points[54][key], last);
  }
});

test('SMA 按窗口移除旧价格，单次尖峰离开 MA5 后不再影响该均线', () => {
  const closes = Array<number>(51).fill(10);
  closes[45] = 60;
  const points = calculateChartStudies(makeCandles(closes));
  assertClose(points[49].ma5, 20);
  assertClose(points[49].ma10, 15);
  assertClose(points[49].ma20, 12.5);
  assertClose(points[49].ma50, 11);
  assertClose(points[50].ma5, 10);
  assertClose(points[50].ma10, 15);
  assertClose(points[50].ma20, 12.5);
  assertClose(points[50].ma50, 11);
});

for (const { key, period, afterGain, afterLoss } of relativeStrengths) {
  test(`${key} 使用完整变化数预热，并与手算的 Wilder 平滑结果一致`, () => {
    // 价格交替上涨 2、下跌 1；偶数周期的种子均涨 1、均跌 1/2，RSI 为 200/3。
    // 表中给出继续上涨 2、下跌 1 后手算的精确分数，用于区分 Wilder、EMA 和滚动 RSI。
    const closes = Array.from({ length: period + 3 }, (_, index) =>
      100 + Math.floor(index / 2) + (index % 2 === 1 ? 2 : 0));
    const points = calculateChartStudies(makeCandles(closes));
    assert.ok(points.slice(0, period).every((point) => point[key] === null));
    assertClose(points[period][key], 200 / 3);
    assertClose(points[period + 1][key], afterGain);
    assertClose(points[period + 2][key], afterLoss);
  });
}

test('所有 RSI 正确处理平盘、零亏损上涨和零收益下跌', () => {
  for (const { closes, expected } of [
    { closes: Array<number>(40).fill(100), expected: 50 },
    { closes: Array.from({ length: 40 }, (_, index) => 100 + index), expected: 100 },
    { closes: Array.from({ length: 40 }, (_, index) => 100 - index), expected: 0 },
  ]) {
    const points = calculateChartStudies(makeCandles(closes));
    for (const { key, period } of relativeStrengths) {
      assert.ok(points.slice(0, period).every((point) => point[key] === null));
      for (const point of points.slice(period)) assert.equal(point[key], expected);
    }
  }
});

test('平盘预热后首次上涨或下跌仍能计算有效 RSI', () => {
  const flat = Array<number>(25).fill(100);
  const rising = calculateChartStudies(makeCandles([...flat, 101, 101]));
  const falling = calculateChartStudies(makeCandles([...flat, 99, 99]));
  for (const { key } of relativeStrengths) {
    assert.equal(rising[24][key], 50);
    assert.equal(falling[24][key], 50);
    assert.equal(rising[25][key], 100);
    assert.equal(rising[26][key], 100);
    assert.equal(falling[25][key], 0);
    assert.equal(falling[26][key], 0);
  }
});

test('追加未来行情不会改变任意历史前缀，包括所有预热边界', () => {
  const candles = makeCandles(Array.from({ length: 75 }, (_, index) =>
    100 + index % 9 * 3 + Math.floor(index / 9)));
  const full = calculateChartStudies(candles);
  for (let length = 0; length <= candles.length; length += 1) {
    assert.deepEqual(calculateChartStudies(candles.slice(0, length)), full.slice(0, length));
  }
});

test('接受冻结的只读输入且不修改数组或 K 线，未确认柱也参与显示', () => {
  const mutable = makeCandles(Array.from({ length: 55 }, (_, index) => 100 + index));
  mutable[54].confirmed = false;
  const before = structuredClone(mutable);
  const candles: readonly Candle[] = Object.freeze(mutable.map((candle) => Object.freeze(candle)));
  const points: ChartStudyPoint[] = calculateChartStudies(candles);
  assert.deepEqual(candles, before);
  assert.equal(points.length, 55);
  assert.equal(points[54].time, candles[54].time);
  assertClose(points[54].ma5, 152);
  assert.equal(points[54].rsi24, 100);
  points[54].ma5 = -1;
  assert.deepEqual(candles, before);
  assertClose(calculateChartStudies(candles)[54].ma5, 152);
});

test('复用行情校验，拒绝乱序、重复时间及非法 OHLCV 和确认标志', () => {
  const candles = makeCandles([100, 101]);
  assert.throws(() => calculateChartStudies([...candles].reverse()), /时间必须严格递增/);
  assert.throws(() => calculateChartStudies([candles[0], candles[0]]), /时间必须严格递增/);
  const invalidCases: { patch: Partial<Candle>; error: RegExp }[] = [
    { patch: { time: NaN }, error: /时间无效/ },
    { patch: { close: Infinity }, error: /close 必须是正有限数/ },
    { patch: { open: 0 }, error: /open 必须是正有限数/ },
    { patch: { low: 102 }, error: /最高价、最低价与开收盘价不一致/ },
    { patch: { volume: -1 }, error: /成交量或确认标志无效/ },
    { patch: { confirmed: undefined }, error: /成交量或确认标志无效/ },
  ];
  for (const { patch, error } of invalidCases) {
    assert.throws(() => calculateChartStudies([{ ...candles[0], ...patch }]), error);
  }
});
