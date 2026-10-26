import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IntradayPoint } from '../shared/intraday';
import { calculateIntradayStudies, isContinuousMinute, splitIntradayLine } from '../src/intraday-studies';

/**
 * 创建可确定复算的真实分时结构样本，不使用 OHLC 或策略字段。
 * @param prices 已知价格序列。
 * @returns 按一分钟递增的分时点。
 */
function minutePoints(prices: readonly number[]): IntradayPoint[] {
  return prices.map((price, index) => ({ time: 1_800_000_000 + index * 60, price, volume: 100 + index,
    averagePrice: index === 0 ? null : price - 0.1, session: 'regular' }));
}

/**
 * 验证浮点结果与手工推导值接近。
 * @param actual 计算结果。
 * @param expected 可独立推导的期望值。
 * @returns 无返回值；误差超限或仍处于预热时断言失败。
 */
function approximately(actual: number | null, expected: number): void {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual! - expected) < 1e-9, `${actual} 不接近 ${expected}`);
}

test('RSI 按 6/12/24 个价格变化预热，上涨100、下跌0、平盘50', () => {
  for (const [prices, expected] of [
    [Array.from({ length: 40 }, (_, index) => 100 + index), 100],
    [Array.from({ length: 40 }, (_, index) => 100 - index), 0],
    [Array(40).fill(100) as number[], 50],
  ] as const) {
    const studies = calculateIntradayStudies(minutePoints(prices));
    for (const [period, key] of [[6, 'rsi6'], [12, 'rsi12'], [24, 'rsi24']] as const) {
      assert.ok(studies.slice(0, period).every(point => point[key] === null));
      assert.equal(studies[period][key], expected);
      assert.equal(studies.at(-1)![key], expected);
    }
  }
});

test('Wilder RSI 首个窗口用平均涨跌，之后按 1/6 平滑', () => {
  const studies = calculateIntradayStudies(minutePoints([100, 102, 101, 104, 102, 105, 104, 108]));
  // 六次变化：上涨总计8，下跌总计4；下一步上涨4，平滑后涨/跌比为64/20。
  approximately(studies[6].rsi6, 100 - 100 / 3);
  approximately(studies[7].rsi6, 100 - 100 / (1 + 64 / 20));
});

test('MACD 使用 SMA 初始化 12/26 EMA，DIF第26点、DEA及双倍柱第34点有效', () => {
  const studies = calculateIntradayStudies(minutePoints(Array.from({ length: 60 }, (_, index) => 100 + index)));
  assert.ok(studies.slice(0, 25).every(point => point.dif === null));
  assert.ok(studies.slice(0, 33).every(point => point.dea === null && point.macd === null));
  // 等差序列中，12及26 EMA分别滞后5.5与12.5，故DIF稳定为7。
  approximately(studies[25].dif, 7);
  approximately(studies[33].dea, 7);
  approximately(studies.at(-1)!.macd, 0);
  const reversal = calculateIntradayStudies(minutePoints([...Array.from({ length: 40 }, (_, index) => 100 + index), 120, 110, 100]));
  const last = reversal.at(-1)!;
  approximately(last.macd, 2 * (last.dif! - last.dea!));
  assert.ok(last.macd! < 0);
});

test('不读取未来、保持原数组与原始UTC时间，空输入不产生指标', () => {
  const points = minutePoints(Array.from({ length: 80 }, (_, index) => 100 + Math.sin(index) * 5));
  const original = structuredClone(points);
  const all = calculateIntradayStudies(points);
  assert.deepEqual(calculateIntradayStudies(points.slice(0, 50)), all.slice(0, 50));
  assert.deepEqual(points, original);
  assert.deepEqual(all.map(point => point.time), points.map(point => point.time));
  assert.deepEqual(calculateIntradayStudies([]), []);
});

test('缺失分钟、午休、跨日和时段切换均重新预热，不计算未知区间涨跌', () => {
  const base = minutePoints(Array.from({ length: 45 }, (_, index) => 100 + index));
  for (const gap of [120, 3_660, 86_460]) {
    const points = [...base, ...minutePoints(Array(40).fill(200)).map(point => ({ ...point, time: point.time + 44 * 60 + gap }))];
    const studies = calculateIntradayStudies(points);
    assert.equal(studies[44].rsi6, 100);
    assert.equal(studies[45].rsi6, null);
    assert.equal(studies[50].rsi6, null);
    assert.equal(studies[51].rsi6, 50);
    assert.equal(studies[69].dif, null);
    approximately(studies[70].dif, 0);
    assert.equal(studies[77].dea, null);
    approximately(studies[78].dea, 0);
  }
  const switched = [...base, { ...base.at(-1)!, time: base.at(-1)!.time + 60, session: 'post' as const }];
  assert.equal(calculateIntradayStudies(switched).at(-1)!.rsi6, null);
});

test('独立线段不跨缺失时段或缺失均价连接，不合成价格点', () => {
  const points = minutePoints([100, 101, 102, 103, 104, 105]);
  points[2].averagePrice = null;
  points[4].time += 3_600; points[5].time += 3_600;
  const price = splitIntradayLine(points, point => point.price);
  assert.deepEqual(price.map(segment => segment.map(point => point.value)), [[100, 101, 102, 103], [104, 105]]);
  const average = splitIntradayLine(points, point => point.averagePrice);
  assert.deepEqual(average.map(segment => segment.map(point => point.time)), [[points[1].time], [points[3].time], [points[4].time, points[5].time]]);
  assert.equal(isContinuousMinute(undefined, points[0]), false);
  assert.equal(isContinuousMinute(points[3], points[4]), false);
  assert.equal(isContinuousMinute(points[0], { ...points[1], session: 'post' }), false);
});

test('边界拒绝重复或逆序时间、非有限价格、负量及非法均价', () => {
  const original = minutePoints([100, 101]);
  for (const change of [
    { time: original[0].time }, { time: original[0].time - 60 }, { time: Number.NaN },
    { price: 0 }, { price: Infinity }, { volume: -1 }, { averagePrice: Number.NaN },
  ]) {
    assert.throws(() => calculateIntradayStudies([original[0], { ...original[1], ...change }]), /分时图/);
  }
});
