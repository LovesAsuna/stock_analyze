import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateIndicators } from '../shared/indicators';
import { generateSignals } from '../shared/signals';
import { barOpenTime, buildReview, getChinaWeekRange, inChinaRange, signalConfirmationTime } from '../shared/review';
import { DEFAULT_CONFIG, type Candle, type Execution, type IndicatorPoint, type Signal } from '../shared/types';

/**
 * 构造确定性测试行情，不表示任何用户或账户的历史。
 * @param count 行情数量。
 * @param price 按索引计算收盘价的函数。
 * @returns 相邻一小时、均已确认的合法行情。
 */
function makeCandles(count: number, price: (index: number) => number = (index) => 100 + index): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = price(index);
    return { time: 1_700_000_000 + index * 3600, open: close - 0.1,
      high: close + 1, low: close - 1, close, volume: 1000 + index % 7 * 100, confirmed: true };
  });
}

/**
 * 构造单个可控的完整指标点，用来隔离信号规则测试。
 * @param time 对应 K 线时间。
 * @param overrides 需要覆盖的指标。
 * @returns 默认满足买入条件的指标点。
 */
function indicator(time: number, overrides: Partial<IndicatorPoint> = {}): IndicatorPoint {
  return { time, fastMA: 99, slowMA: 98, macd: 1, macdSignal: 0.5, histogram: 0.5,
    rsi: 60, plusDI: 30, minusDI: 10, adx: 25, sar: 97, sarBull: true,
    bollUpper: 105, bollMiddle: 100, bollLower: 95, volumeRatio: 1.5, ...overrides };
}

/**
 * 构造用于复盘的显式测试信号，字段均与给定行情对应。
 * @param candles 行情。
 * @param index 信号位置。
 * @param side 信号方向。
 * @returns 已确认的测试信号。
 */
function signal(candles: Candle[], index = 0, side: Signal['side'] = 'buy'): Signal {
  return { id: `${candles[index].time}-${side}`, time: candles[index].time, index, side,
    title: '测试规则', reasons: ['仅用于引擎测试'], close: candles[index].close,
    eligibleTime: candles[index + 1]?.time ?? null, referencePrice: candles[index + 1]?.open ?? null,
    nextFiveReturn: null, confirmed: true };
}

/**
 * 构造成交测试记录，禁止将其解释为用户成交。
 * @param time 成交绝对时间。
 * @param overrides 方向、证券等覆盖字段。
 * @returns 有合法唯一标识的测试成交。
 */
function execution(time: number, overrides: Partial<Execution> = {}): Execution {
  return { id: `test-${time}`, symbol: 'TEST.HK', side: 'buy', time, price: 100, quantity: 10, ...overrides };
}

/**
 * 比较浮点数，保留能检出错误初始化与平滑算法的严格精度。
 * @param actual 实际结果。
 * @param expected 独立期望值。
 * @returns 无返回值；不满足容差时断言失败。
 */
function closeTo(actual: number | null, expected: number): void {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual! - expected) < 1e-9, `${actual} 不接近 ${expected}`);
}

/**
 * 转换测试中的显式 ISO 时间为 UTC Unix 秒。
 * @param iso 带时区的 ISO 时间。
 * @returns UTC Unix 秒。
 */
function seconds(iso: string): number { return Date.parse(iso) / 1000; }

test('空行情不产生指标、信号或复盘记录', () => {
  assert.deepEqual(calculateIndicators([]), []);
  assert.deepEqual(generateSignals([], []), []);
  assert.deepEqual(buildReview([], [], []), []);
});

test('默认 SMA10/20、布林20/2总体标准差及量比窗口', () => {
  const candles = makeCandles(30, (index) => index + 2);
  candles.forEach((candle, index) => { candle.volume = index + 1; });
  const points = calculateIndicators(candles);
  assert.equal(points[8].fastMA, null);
  closeTo(points[9].fastMA, 6.5);
  assert.equal(points[18].slowMA, null);
  closeTo(points[19].slowMA, 11.5);
  closeTo(points[19].bollMiddle, 11.5);
  closeTo(points[19].bollUpper, 11.5 + 2 * Math.sqrt(33.25));
  closeTo(points[19].bollLower, 11.5 - 2 * Math.sqrt(33.25));
  closeTo(points[19].volumeRatio, 20 / 10.5);
  const configured = calculateIndicators(candles, { ...DEFAULT_CONFIG, fastMA: 3, slowMA: 5 });
  assert.equal(configured[1].fastMA, null);
  closeTo(configured[2].fastMA, 3);
  closeTo(configured[4].slowMA, 4);
});

test('MACD12/26/9用SMA种子：DIF索引25，DEA及柱索引33起有效', () => {
  const points = calculateIndicators(makeCandles(50));
  assert.equal(points[24].macd, null);
  closeTo(points[25].macd, 7);
  assert.equal(points[32].macdSignal, null);
  assert.equal(points[32].histogram, null);
  closeTo(points[33].macdSignal, 7);
  closeTo(points[33].histogram, 0);
});

test('MACD非线性价格与独立SMA种子递推一致', () => {
  const candles = makeCandles(50, (index) => 100 + index * index / 10);
  const points = calculateIndicators(candles);
  let fast = candles.slice(0, 12).reduce((sum, candle) => sum + candle.close, 0) / 12;
  let slow = candles.slice(0, 26).reduce((sum, candle) => sum + candle.close, 0) / 26;
  const differences: number[] = [];
  for (let index = 12; index < candles.length; index += 1) {
    fast += 2 / 13 * (candles[index].close - fast);
    if (index < 25) continue;
    if (index > 25) slow += 2 / 27 * (candles[index].close - slow);
    differences.push(fast - slow);
    closeTo(points[index].macd, fast - slow);
  }
  let average = differences.slice(0, 9).reduce((sum, value) => sum + value, 0) / 9;
  closeTo(points[33].macdSignal, average);
  for (let index = 34; index < candles.length; index += 1) {
    average += 0.2 * (differences[index - 25] - average);
    closeTo(points[index].macdSignal, average);
    closeTo(points[index].histogram, differences[index - 25] - average);
  }
});

test('RSI Wilder单边上涨100、下跌0、不动50；周期可配置', () => {
  for (const [price, expected] of [
    [(index: number) => 100 + index, 100], [(index: number) => 100 - index, 0], [() => 100, 50],
  ] as const) {
    const points = calculateIndicators(makeCandles(30, price));
    assert.equal(points[13].rsi, null);
    for (const point of points.slice(14)) closeTo(point.rsi, expected);
  }
  const points = calculateIndicators(makeCandles(5, (index) => [100, 102, 101, 104, 102][index]),
    { ...DEFAULT_CONFIG, rsiPeriod: 3 });
  assert.equal(points[2].rsi, null);
  closeTo(points[3].rsi, 100 - 100 / 6);
  closeTo(points[4].rsi, 100 - 100 / (1 + (10 / 9) / (8 / 9)));
});

test('DMI/ADX14 Wilder预热、单边趋势及零波动处理', () => {
  const points = calculateIndicators(makeCandles(35));
  assert.equal(points[13].plusDI, null);
  closeTo(points[14].plusDI, 50);
  closeTo(points[14].minusDI, 0);
  assert.equal(points[26].adx, null);
  closeTo(points[27].adx, 100);
  closeTo(points[34].adx, 100);
  const flat = makeCandles(35, () => 100).map((candle) => ({ ...candle, open: 100, low: 100, high: 100, volume: 0 }));
  const flatPoints = calculateIndicators(flat);
  closeTo(flatPoints[14].plusDI, 0);
  closeTo(flatPoints[27].adx, 0);
  assert.equal(flatPoints[25].volumeRatio, null);
});

test('DMI用Wilder累积平滑，不使用滚动窗口替代', () => {
  const candles = makeCandles(40, (index) => 100 + Math.sin(index * 1.4) * 8 + index / 4);
  const points = calculateIndicators(candles);
  let rangeSum = 0;
  let positiveSum = 0;
  let negativeSum = 0;
  const dx: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    const up = current.high - previous.high;
    const down = previous.low - current.low;
    const range = Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close));
    const positive = up > 0 && up > down ? up : 0;
    const negative = down > 0 && down > up ? down : 0;
    const retained = index <= 14 ? 1 : 13 / 14;
    rangeSum = rangeSum * retained + range;
    positiveSum = positiveSum * retained + positive;
    negativeSum = negativeSum * retained + negative;
    if (index < 14) continue;
    const plus = 100 * positiveSum / rangeSum;
    const minus = 100 * negativeSum / rangeSum;
    closeTo(points[index].plusDI, plus);
    closeTo(points[index].minusDI, minus);
    dx.push(100 * Math.abs(plus - minus) / (plus + minus));
  }
  let average = dx.slice(0, 14).reduce((sum, value) => sum + value, 0) / 14;
  closeTo(points[27].adx, average);
  for (let index = 28; index < candles.length; index += 1) {
    average = (average * 13 + dx[index - 14]) / 14;
    closeTo(points[index].adx, average);
  }
});

test('SAR约束之前两柱，反转到旧极值，配置控制加速路径', () => {
  const candles = makeCandles(12, (index) => [10, 11, 12, 13, 14, 15, 7, 6, 5, 4, 12, 14][index]);
  const points = calculateIndicators(candles);
  assert.equal(points[0].sar, null);
  closeTo(points[1].sar, 9);
  closeTo(points[2].sar, 9);
  closeTo(points[3].sar, 9.16);
  assert.equal(points[6].sarBull, false);
  closeTo(points[6].sar, 16);
  for (let index = 2; index < points.length; index += 1) {
    if (points[index].sarBull) {
      assert.ok(points[index].sar! <= Math.min(candles[index - 1].low, candles[index - 2].low));
      assert.ok(points[index].sar! <= candles[index].low);
    } else {
      assert.ok(points[index].sar! >= Math.max(candles[index - 1].high, candles[index - 2].high));
      assert.ok(points[index].sar! >= candles[index].high);
    }
  }
  const configured = calculateIndicators(candles, { ...DEFAULT_CONFIG, sarStart: 0.04, sarStep: 0.03, sarMax: 0.1 });
  closeTo(configured[3].sar, 9.28);
  assert.notEqual(configured[4].sar, points[4].sar);
});

test('指标前缀不变：追加或修改未来行情不能改变已有指标', () => {
  const candles = makeCandles(270, (index) => 150 + Math.sin(index * 0.7) * 20 + index / 10);
  const all = calculateIndicators(candles);
  for (const length of [1, 2, 14, 26, 34, 100, 200, 239]) {
    assert.deepEqual(calculateIndicators(candles.slice(0, length)), all.slice(0, length));
  }
  const changed = candles.map((candle, index) => index < 220 ? candle :
    { ...candle, open: 1000, close: 1000, high: 1100, low: 900, volume: 999999 });
  assert.deepEqual(calculateIndicators(changed).slice(0, 220), all.slice(0, 220));
});

test('200根预热门槛、仅确认柱、条件持续成立只发一次、重入再发', () => {
  const candles = makeCandles(210, () => 100);
  const points = candles.map((candle) => indicator(candle.time));
  assert.deepEqual(generateSignals(candles.slice(0, 199), points.slice(0, 199)), []);
  assert.deepEqual(generateSignals(candles, points).map((item) => item.index), [199]);
  points[202].rsi = 80;
  assert.deepEqual(generateSignals(candles, points).map((item) => item.index), [199, 203]);
  candles[203].confirmed = false;
  candles.slice(204).forEach((candle) => { candle.confirmed = false; });
  assert.deepEqual(generateSignals(candles, points).map((item) => item.index), [199]);
  assert.equal(generateSignals(candles, points)[0].confirmed, true);
});

test('买入组合逐项验证、RSI边界、可配置ADX及量比阈值', () => {
  const candles = makeCandles(200, () => 100);
  const points = candles.map((candle) => indicator(candle.time));
  for (const overrides of [
    { fastMA: 100 }, { slowMA: 99 }, { histogram: 0 }, { sarBull: false },
    { plusDI: 10 }, { adx: 19.99 }, { rsi: 44.99 }, { rsi: 75.01 }, { volumeRatio: 1.19 }, { sar: null },
  ]) {
    const changed = [...points];
    changed[199] = indicator(candles[199].time, overrides);
    assert.equal(generateSignals(candles, changed).length, 0, JSON.stringify(overrides));
  }
  for (const rsi of [45, 75]) {
    points[199] = indicator(candles[199].time, { rsi, adx: 20, volumeRatio: 1.2 });
    assert.equal(generateSignals(candles, points).length, 1);
  }
  assert.equal(generateSignals(candles, points, { ...DEFAULT_CONFIG, adxThreshold: 21 }).length, 0);
  assert.equal(generateSignals(candles, points, { ...DEFAULT_CONFIG, volumeRatio: 2 }).length, 0);
});

test('卖出组合与带负柱/-DI动量的SAR翻空；持续成立不重复', () => {
  const candles = makeCandles(205, () => 100);
  const points = candles.map((candle) => indicator(candle.time, { rsi: 80 }));
  for (let index = 200; index < points.length; index += 1) {
    points[index] = indicator(candles[index].time,
      { slowMA: 110, histogram: -1, minusDI: 40, plusDI: 10, sarBull: false });
  }
  const result = generateSignals(candles, points);
  assert.deepEqual(result.map((item) => [item.index, item.side]), [[200, 'sell']]);
  const flipPoints = candles.map((candle) => indicator(candle.time, { rsi: 80 }));
  flipPoints[200] = indicator(candles[200].time,
    { histogram: -1, sarBull: false, minusDI: 30, plusDI: 10 });
  assert.equal(generateSignals(candles, flipPoints)[0].side, 'sell');
  assert.match(generateSignals(candles, flipPoints)[0].reasons[0], /SAR 由多头翻为空头/);
  flipPoints[200].histogram = 1;
  assert.equal(generateSignals(candles, flipPoints).length, 0);
  flipPoints[200].histogram = -1;
  flipPoints[200].minusDI = 5;
  assert.equal(generateSignals(candles, flipPoints).length, 0);
});

test('卖出不受无关的RSI、量比和ADX空值阻止', () => {
  const candles = makeCandles(201, () => 100);
  const points = candles.map((candle) => indicator(candle.time, { rsi: null, volumeRatio: null, adx: null,
    slowMA: 110, histogram: -1, sarBull: false, plusDI: 10, minusDI: 30 }));
  assert.equal(generateSignals(candles, points).length, 1);
  assert.equal(generateSignals(candles, points)[0].side, 'sell');
});

test('五柱统计使用下一根开盘与index+5收盘，不使用信号收盘或index+6', () => {
  const candles = makeCandles(207, () => 100);
  candles[200] = { ...candles[200], open: 120, high: 121, close: 120, low: 119 };
  candles[204] = { ...candles[204], open: 132, high: 133, close: 132, low: 131 };
  candles[205] = { ...candles[205], open: 180, high: 181, close: 180, low: 179 };
  const points = candles.map((candle) => indicator(candle.time));
  const first = generateSignals(candles, points)[0];
  assert.equal(first.eligibleTime, candles[200].time);
  assert.equal(first.referencePrice, 120);
  closeTo(first.nextFiveReturn, 10);
  const short = generateSignals(candles.slice(0, 204), points.slice(0, 204))[0];
  assert.equal(short.nextFiveReturn, null);
  const last = generateSignals(candles.slice(0, 200), points.slice(0, 200))[0];
  assert.equal(last.eligibleTime, null);
  assert.equal(last.referencePrice, null);
  assert.equal(last.nextFiveReturn, null);
  candles[204].confirmed = false;
  candles.slice(205).forEach((candle) => { candle.confirmed = false; });
  assert.equal(generateSignals(candles, points)[0].nextFiveReturn, null);
});

test('信号前缀不变：核心决策完全一致，只有事后参考字段可以随后续柱补齐', () => {
  const candles = makeCandles(245, () => 100);
  const points = candles.map((candle, index) => indicator(candle.time, { rsi: index % 8 === 0 ? 80 : 60 }));
  const all = generateSignals(candles, points);
  const causal = (item: Signal): object => ({ id: item.id, time: item.time, index: item.index, side: item.side,
    title: item.title, reasons: item.reasons, close: item.close, confirmed: item.confirmed });
  for (const length of [200, 202, 211, 228, 240]) {
    const prefix = generateSignals(candles.slice(0, length), points.slice(0, length));
    assert.deepEqual(prefix.map(causal), all.filter((item) => item.index < length).map(causal));
    assert.deepEqual(prefix.filter((item) => item.index + 5 < length), all.filter((item) => item.index + 5 < length));
  }
  assert.deepEqual(generateSignals(candles, points), generateSignals(candles, points));
  assert.ok(all.length > 3);
});

test('实际指标信号流水线在未来价格剧变时保持历史决策', () => {
  const candles = makeCandles(440, (index) => 150 + Math.sin(index / 18) * 20 + Math.sin(index * 0.6) * 2);
  const points = calculateIndicators(candles);
  const all = generateSignals(candles, points, { ...DEFAULT_CONFIG, volumeRatio: 0 });
  assert.ok(all.length > 0, '波动行情应覆盖实际指标产生的信号');
  const prefixLength = 360;
  const prefix = candles.slice(0, prefixLength);
  const causal = (items: Signal[]): object[] => items.map(({ eligibleTime, referencePrice, nextFiveReturn, ...item }) => item);
  assert.deepEqual(causal(generateSignals(prefix, calculateIndicators(prefix), { ...DEFAULT_CONFIG, volumeRatio: 0 })),
    causal(all.filter((item) => item.index < prefixLength)));
});

test('验证错误输入：乱序、非法OHLC、负量、配置与指标错位', () => {
  const candles = makeCandles(10);
  assert.throws(() => calculateIndicators([...candles].reverse()), /时间必须严格递增/);
  assert.throws(() => calculateIndicators([{ ...candles[0], high: 1 }]), /最高价、最低价/);
  assert.throws(() => calculateIndicators([{ ...candles[0], volume: -1 }]), /成交量/);
  assert.throws(() => calculateIndicators(candles, { ...DEFAULT_CONFIG, rsiPeriod: 0 }), /正整数/);
  assert.throws(() => calculateIndicators(candles, { ...DEFAULT_CONFIG, fastMA: 20 }), /快速均线/);
  assert.throws(() => calculateIndicators(candles, { ...DEFAULT_CONFIG, sarStart: 0.5 }), /SAR 初始/);
  assert.throws(() => generateSignals(candles, []), /数量/);
  const points = calculateIndicators(candles);
  points[0].time += 1;
  assert.throws(() => generateSignals(candles, points), /时间与 K 线/);
  candles[2].confirmed = false;
  assert.throws(() => generateSignals(candles, calculateIndicators(candles)), /之前存在未确认柱/);
});

test('中国工作周以周一到周六闭开，周末锚点不滚到未来', () => {
  const expected = { start: '2024-03-04T00:00:00+08:00', end: '2024-03-09T00:00:00+08:00' };
  for (const date of ['2024-03-04T00:00:00+08:00', '2024-03-08T23:59:59+08:00',
    '2024-03-09T12:00:00+08:00', '2024-03-10T23:59:59+08:00']) {
    assert.deepEqual(getChinaWeekRange(new Date(date)), expected);
  }
  assert.equal(inChinaRange(seconds(expected.start), expected.start, expected.end), true);
  assert.equal(inChinaRange(seconds(expected.end), expected.start, expected.end), false);
  assert.equal(inChinaRange(seconds(expected.start) - 1, expected.start, expected.end), false);
  assert.equal(inChinaRange(seconds(expected.start), '2024-03-04', '2024-03-09'), true);
  assert.deepEqual(getChinaWeekRange(new Date('2024-12-31T12:00:00+08:00')),
    { start: '2024-12-30T00:00:00+08:00', end: '2025-01-04T00:00:00+08:00' });
});

test('美股日线确认与开盘跨DST，UTC午夜和交易所午夜日期标签一致', () => {
  const cases = [
    ['2024-03-08', '21:00', '14:30'], ['2024-03-11', '20:00', '13:30'],
    ['2024-11-01', '20:00', '13:30'], ['2024-11-04', '21:00', '14:30'],
  ];
  for (const [day, closeTime, openTime] of cases) {
    const utc = seconds(`${day}T00:00:00Z`);
    assert.equal(signalConfirmationTime(utc, 'TEST.US', 'day'), seconds(`${day}T${closeTime}:00Z`));
    assert.equal(barOpenTime(utc, 'TEST.US', 'day'), seconds(`${day}T${openTime}:00Z`));
    const localMidnight = seconds(`${day}T${closeTime === '21:00' ? '05:00' : '04:00'}:00Z`);
    assert.equal(signalConfirmationTime(localMidnight, 'US', 'day'), seconds(`${day}T${closeTime}:00Z`));
  }
  assert.equal(signalConfirmationTime(seconds('2024-03-11T00:00:00+08:00'), '700.HK', 'day'),
    seconds('2024-03-11T16:00:00+08:00'));
  assert.equal(barOpenTime(seconds('2024-03-11T00:00:00Z'), 'HK', 'day'), seconds('2024-03-11T09:30:00+08:00'));
});

test('复盘周筛选按实际确认时间：美股周五收盘在中国周六应排除', () => {
  const range = getChinaWeekRange(new Date('2024-03-08T12:00:00+08:00'));
  const friday = seconds('2024-03-08T00:00:00Z');
  assert.equal(inChinaRange(friday, range.start, range.end), true);
  assert.equal(inChinaRange(signalConfirmationTime(friday, 'US', 'day'), range.start, range.end), false);
  assert.equal(inChinaRange(signalConfirmationTime(friday, 'HK', 'day'), range.start, range.end), true);
  const summerRange = getChinaWeekRange(new Date('2024-03-15T12:00:00+08:00'));
  assert.equal(inChinaRange(signalConfirmationTime(seconds('2024-03-15T00:00:00Z'), 'US', 'day'),
    summerRange.start, summerRange.end), false);
  const intraday = seconds('2024-03-08T23:30:00+08:00');
  assert.equal(inChinaRange(signalConfirmationTime(intraday, 'HK', '1h'), range.start, range.end), false);
  assert.equal(signalConfirmationTime(intraday, 'US', '15m'), intraday + 900);
});

test('日内成交只匹配确认后下一柱，禁止同柱事后看最高最低回填', () => {
  const candles = makeCandles(4, () => 100);
  const item = signal(candles);
  const before = execution(candles[0].time + 1800);
  const tooLate = execution(candles[2].time);
  const wrongSide = execution(candles[1].time + 10, { side: 'sell' });
  const valid = execution(candles[1].time + 20);
  const result = buildReview([item], [before, tooLate, wrongSide, valid], candles, true, 'TEST.HK', '1h')[0];
  assert.equal(result.state, 'matched');
  assert.equal(result.execution?.id, valid.id);
  assert.equal(buildReview([item], [before, tooLate, wrongSide], candles, true, 'TEST.HK', '1h')[0].state, 'unmatched');
  assert.match(result.note, /不代表实际、未实现或保证盈亏/);
});

test('相邻柱开盘等于前柱确认时刻时可成交，闭开窗口不含下一柱收盘', () => {
  const candles = makeCandles(3, () => 100);
  const atOpen = execution(candles[1].time);
  assert.equal(buildReview([signal(candles)], [atOpen], candles, true, 'TEST.HK', '1h')[0].state, 'matched');
  const atClose = execution(candles[1].time + 3600);
  assert.equal(buildReview([signal(candles)], [atClose], candles, true, 'TEST.HK', '1h')[0].state, 'unmatched');
});

test('缺柱不扩大日内窗口，15分钟周期只匹配随后15分钟', () => {
  const candles = makeCandles(3, () => 100);
  candles[1].time = candles[0].time + 900;
  candles[2].time = candles[0].time + 86400;
  const valid = execution(candles[1].time + 899);
  const late = execution(candles[1].time + 901);
  assert.equal(buildReview([signal(candles)], [valid], candles, true, 'TEST.HK', '15m')[0].state, 'matched');
  assert.equal(buildReview([signal(candles)], [late], candles, true, 'TEST.HK', '15m')[0].state, 'unmatched');
  const unconfirmed = { ...signal(candles), confirmed: false };
  assert.equal(buildReview([unconfirmed], [valid], candles, true, 'TEST.HK', '15m')[0].state, 'pending');
  const wrongMarket = execution(valid.time, { symbol: 'TEST.US' });
  assert.equal(buildReview([signal(candles)], [wrongMarket], candles, true, 'HK', '15m')[0].state, 'unmatched');
});

test('港股日线不能匹配同日收盘前或次日开盘前成交', () => {
  const candles = makeCandles(3, () => 100).map((candle, index) => ({ ...candle,
    time: seconds(`2024-03-${String(11 + index).padStart(2, '0')}T00:00:00+08:00`) }));
  const invalid = [execution(seconds('2024-03-11T15:59:59+08:00')),
    execution(seconds('2024-03-12T09:29:59+08:00'))];
  assert.equal(buildReview([signal(candles)], invalid, candles)[0].state, 'unmatched');
  const open = execution(seconds('2024-03-12T09:30:00+08:00'));
  assert.equal(buildReview([signal(candles)], [...invalid, open], candles)[0].execution?.id, open.id);
});

test('美股周末及DST不扩大下一根日线成交窗口', () => {
  const candles = makeCandles(3, () => 100).map((candle, index) => ({ ...candle,
    time: seconds(`${['2024-03-08', '2024-03-11', '2024-03-12'][index]}T00:00:00Z`) }));
  const invalid = [execution(seconds('2024-03-08T20:59:59Z'), { symbol: 'TEST.US' }),
    execution(seconds('2024-03-09T15:00:00Z'), { symbol: 'TEST.US' }),
    execution(seconds('2024-03-11T13:29:59Z'), { symbol: 'TEST.US' })];
  assert.equal(buildReview([signal(candles)], invalid, candles, true, 'TEST.US')[0].state, 'unmatched');
  const valid = execution(seconds('2024-03-11T13:30:00Z'), { symbol: 'TEST.US' });
  assert.equal(buildReview([signal(candles)], [...invalid, valid], candles, true, 'TEST.US')[0].execution?.id, valid.id);
});

test('同一笔成交不复用，信号和成交排序确定，不同证券不误配', () => {
  const candles = makeCandles(4, () => 100);
  const first = signal(candles);
  const duplicate = { ...first, id: 'second' };
  const fill = execution(candles[1].time + 1);
  const wrongSymbol = execution(candles[1].time + 2, { symbol: 'OTHER.HK' });
  const result = buildReview([duplicate, first], [wrongSymbol, fill], candles, true, 'TEST.HK', '1h');
  assert.equal(result.filter((item) => item.state === 'matched').length, 1);
  assert.equal(result[0].signal.id, 'second');
  assert.equal(result[1].execution?.id, fill.id);
  assert.deepEqual(buildReview([first], [wrongSymbol], candles, true, 'TEST.HK', '1h')[0].state, 'unmatched');
});

test('不完整成交未匹配为unknown，已有成交仍可matched；未结束窗口为pending', () => {
  const candles = makeCandles(3, () => 100);
  const item = signal(candles);
  const unknown = buildReview([item], [], candles, false, 'TEST.HK', '1h')[0];
  assert.equal(unknown.state, 'unknown');
  assert.match(unknown.note, /成交记录不完整/);
  const fill = execution(candles[1].time + 1);
  assert.equal(buildReview([item], [fill], candles, false, 'TEST.HK', '1h')[0].state, 'matched');
  assert.equal(buildReview([signal(candles, 2)], [], candles, true, 'TEST.HK', '1h')[0].state, 'pending');
  assert.equal(buildReview([signal(candles, 2)], [], candles, false, 'TEST.HK', '1h')[0].state, 'unknown');
  candles[1].confirmed = false;
  assert.equal(buildReview([item], [], candles, true, 'TEST.HK', '1h')[0].state, 'pending');
});

test('港股周五信号的下周一窗口超出周成交查询范围时为unknown', () => {
  const candles = makeCandles(2, () => 100).map((candle, index) => ({ ...candle,
    time: seconds(`${['2024-03-08', '2024-03-11'][index]}T00:00:00+08:00`) }));
  const range = getChinaWeekRange(new Date('2024-03-08T12:00:00+08:00'));
  const result = buildReview([signal(candles)], [], candles, true, 'TEST.HK', 'day', range)[0];
  assert.equal(result.state, 'unknown');
  assert.match(result.note, /成交查询窗口不足/);
  const fill = execution(barOpenTime(candles[1].time, 'TEST.HK', 'day'));
  assert.equal(buildReview([signal(candles)], [fill], candles, true, 'TEST.HK', 'day', range)[0].state, 'matched');
  const fullRange = { start: range.start, end: '2024-03-12T00:00:00+08:00' };
  assert.equal(buildReview([signal(candles)], [], candles, true, 'TEST.HK', 'day', fullRange)[0].state, 'unmatched');
});

test('美股周四信号的周五窗口延伸中国周六，工作周查询范围不足', () => {
  for (const dates of [['2024-03-07', '2024-03-08'], ['2024-03-14', '2024-03-15']]) {
    const candles = makeCandles(2, () => 100).map((candle, index) => ({ ...candle,
      time: seconds(`${dates[index]}T00:00:00Z`) }));
    const range = getChinaWeekRange(new Date(`${dates[1]}T12:00:00+08:00`));
    assert.equal(inChinaRange(signalConfirmationTime(candles[0].time, 'TEST.US', 'day'), range.start, range.end), true);
    const result = buildReview([signal(candles)], [], candles, true, 'TEST.US', 'day', range)[0];
    assert.equal(result.state, 'unknown');
    assert.match(result.note, /成交查询窗口不足/);
    const fill = execution(barOpenTime(candles[1].time, 'TEST.US', 'day'), { symbol: 'TEST.US' });
    assert.equal(buildReview([signal(candles)], [fill], candles, true, 'TEST.US', 'day', range)[0].state, 'matched');
  }
});

test('成交查询范围闭开边界必须完整覆盖下一柱，开始或结束缺失均unknown', () => {
  const candles = makeCandles(3, () => 100);
  const start = candles[1].time;
  const end = candles[2].time;
  const iso = (time: number): string => new Date(time * 1000).toISOString();
  const run = (queryStart: number, queryEnd: number): string => buildReview([signal(candles)], [],
    candles, true, 'TEST.HK', '1h', { start: iso(queryStart), end: iso(queryEnd) })[0].state;
  assert.equal(run(start, end), 'unmatched');
  assert.equal(run(start + 1, end), 'unknown');
  assert.equal(run(start, end - 1), 'unknown');
  assert.throws(() => run(end, start), /成交查询区间起点必须早于终点/);
});

test('时间区间与成交输入非法时明确失败', () => {
  assert.throws(() => getChinaWeekRange(new Date('invalid')), /锚点日期/);
  assert.throws(() => inChinaRange(0, '2024-03-11T00:00:00', '2024-03-12'), /明确时区/);
  assert.throws(() => inChinaRange(0, '2024-02-30', '2024-03-12'), /日期无效/);
  assert.throws(() => inChinaRange(0, '2024-03-12', '2024-03-11'), /起点必须早于/);
  assert.throws(() => signalConfirmationTime(NaN, 'HK', 'day'), /Unix 秒/);
  const candles = makeCandles(3);
  const fill = execution(candles[1].time);
  assert.throws(() => buildReview([signal(candles)], [fill, fill], candles), /ID 必须存在且唯一/);
  assert.throws(() => buildReview([signal(candles)], [{ ...fill, quantity: -1 }], candles), /成交记录字段/);
});
