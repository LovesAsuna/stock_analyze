import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, type Candle, type IndicatorPoint } from '../shared/types';
import { calculateIndicators } from '../shared/indicators';
import { barOpenTime, signalConfirmationTime } from '../shared/review';
import { conditionLabel, createDefaultPlan, evaluateGroup, validatePlan,
  type Condition, type ConditionGroup, type TradingPlan } from '../shared/strategy';
import { runBacktest } from '../shared/backtest';

/**
 * 构造隔离账户和行情服务的固定测试序列，研究柱之前仅提供预热。
 * @param count 总柱数。
 * @returns 以 100 为基准的已确认小时线。
 */
function candles(count = 206): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    time: 1_700_000_000 + index * 3600, open: 100, high: 101, low: 99,
    close: 100, volume: 1000, confirmed: true,
  }));
}

/**
 * 构造可控指标，验证的是状态机而非重复指标公式。
 * @param bars 测试行情。
 * @returns 默认入场不满足的同时间指标。
 */
function indicators(bars: Candle[]): IndicatorPoint[] {
  return bars.map((bar) => ({
    time: bar.time, fastMA: 99, slowMA: 100, macd: 1, macdSignal: 0.5, histogram: 1,
    rsi: 60, plusDI: 30, minusDI: 10, adx: 25, sar: 95, sarBull: true,
    bollUpper: 110, bollMiddle: 100, bollLower: 90, volumeRatio: 1,
  }));
}

/**
 * 构造只在指定柱满足入场条件、禁用自动风险的研究计划。
 * @param bars 测试行情。
 * @param entryIndices 入场确认位置。
 * @returns 独立计划和配套指标。
 */
function fixture(bars: Candle[], entryIndices = [199]): { plan: TradingPlan; points: IndicatorPoint[] } {
  const plan = createDefaultPlan('TEST.HK', 'demo', '1h', DEFAULT_CONFIG);
  Object.assign(plan, { feeBps: 0, slippageBps: 0, stopLossPct: 0, takeProfitPct: 0,
    trailingStopPct: 0, maxHoldingBars: 0, initialCapital: 10000 });
  const points = indicators(bars);
  for (const index of entryIndices) points[index].fastMA = 101;
  plan.exit = { mode: 'all', conditions: [rule({ left: 'histogram', operator: 'lt', value: 0 })] };
  return { plan, points };
}

/**
 * 构造数值比较规则。
 * @param overrides 覆盖字段。
 * @returns 完整规则。
 */
function rule(overrides: Partial<Condition> = {}): Condition {
  return { id: 'test-rule', left: 'close', operator: 'gt', right: 'constant', value: 0, ...overrides };
}

/**
 * 修改单柱 OHLC 并保持结构合法。
 * @param bars 测试行情。
 * @param index 修改位置。
 * @param open 开盘价。
 * @param close 收盘价。
 * @param low 最低价，默认端点较小值。
 * @param high 最高价，默认端点较大值。
 * @returns 原地更新，无返回值。
 */
function setBar(bars: Candle[], index: number, open: number, close = open,
  low = Math.min(open, close), high = Math.max(open, close)): void {
  Object.assign(bars[index], { open, close, low, high });
}

/**
 * 断言计算结果足够接近独立期望值。
 * @param actual 实际结果。
 * @param expected 期望值。
 * @returns 不满足时抛出断言错误。
 */
function closeTo(actual: number | null | undefined, expected: number): void {
  assert.equal(typeof actual, 'number');
  assert.ok(Math.abs(actual! - expected) < 1e-8, `${actual} 不接近 ${expected}`);
}

/**
 * 将 UTC 秒转换为计划边界。
 * @param time UTC 秒。
 * @returns 带 Z 时区的 ISO 时间。
 */
function iso(time: number): string { return new Date(time * 1000).toISOString(); }

test('默认计划接口、研究范围、风险和配置副本符合契约', () => {
  const config = { ...DEFAULT_CONFIG };
  const plan = createDefaultPlan('TEST.HK', 'demo', 'day', config);
  validatePlan(plan);
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.validFrom, '2000-01-01T00:00:00Z');
  assert.equal(plan.validUntil, '2100-01-01T00:00:00Z');
  assert.deepEqual([plan.stopLossPct, plan.takeProfitPct, plan.trailingStopPct, plan.maxHoldingBars], [3, 6, 0, 20]);
  assert.deepEqual([plan.quantity, plan.feeBps, plan.slippageBps], [100, 10, 5]);
  assert.equal(plan.initialCapital, 100000);
  assert.deepEqual([plan.entryPrice, plan.stopPrice, plan.targetPrice], [null, null, null]);
  config.fastMA = 5;
  assert.equal(plan.indicatorConfig.fastMA, DEFAULT_CONFIG.fastMA);
  assert.match(conditionLabel(plan.entry.conditions[0]), /快速均线 大于 慢速均线/);
});

test('计划边界拒绝非对象、错误版本、缺失和非法数值字段', () => {
  const plan = createDefaultPlan('TEST.US', 'demo', 'day', DEFAULT_CONFIG);
  for (const bad of [null, [], 5, {}, { ...plan, schemaVersion: 2 }, { ...plan, source: 'live' },
    { ...plan, quantity: 0 }, { ...plan, quantity: 1.2 }, { ...plan, revision: 0 },
    { ...plan, entryPrice: undefined }, { ...plan, stopPrice: -1 }, { ...plan, targetPrice: 0 },
    { ...plan, stopLossPct: 100 }, { ...plan, trailingStopPct: 100 }, { ...plan, takeProfitPct: NaN },
    { ...plan, feeBps: 10000 }, { ...plan, slippageBps: -1 }, { ...plan, maxHoldingBars: 1.5 },
    { ...plan, initialCapital: undefined }, { ...plan, initialCapital: 0 }, { ...plan, initialCapital: 1e12 + 1 },
    { ...plan, indicatorConfig: { ...DEFAULT_CONFIG, fastMA: '10' } }, { ...plan, symbol: ' ' }]) {
    assert.throws(() => validatePlan(bad));
  }
});

test('ISO 边界必须带时区、日历有效且闭开范围非空', () => {
  const plan = createDefaultPlan('TEST.HK', 'demo', 'day', DEFAULT_CONFIG);
  for (const validFrom of ['2024-02-30T00:00:00Z', '2024-01-01T24:00:00Z',
    '2024-01-01T00:00:00', '2024-01-01', plan.validUntil]) {
    assert.throws(() => validatePlan({ ...plan, validFrom }));
  }
  assert.throws(() => validatePlan({ ...plan, updatedAt: '1999-01-01T00:00:00Z' }), /更新时间/);
  validatePlan({ ...plan, validFrom: '2024-01-01T00:00:00+08:00' });
});

test('规则校验拒绝空组、重复 ID、原型属性和无效运算符', () => {
  const plan = createDefaultPlan('TEST.HK', 'demo', 'day', DEFAULT_CONFIG);
  for (const conditions of [[], [rule(), rule()], [rule({ left: 'toString' as never })],
    [rule({ operator: 'gte' as never })], [rule({ right: 'invalid' as never })], [rule({ value: Infinity })]]) {
    assert.throws(() => validatePlan({ ...plan, entry: { mode: 'all', conditions } }));
  }
});

test('null 比较为未知，any 可由另一条已知规则满足，空组不匹配', () => {
  const bars = candles(2);
  const points = indicators(bars);
  points[1].rsi = null;
  const group: ConditionGroup = { mode: 'all', conditions: [rule({ left: 'rsi', operator: 'lt', value: 50 })] };
  const result = evaluateGroup(group, bars, points, 1);
  assert.equal(result.matched, false);
  assert.equal(result.checks[0].available, false);
  assert.match(result.reasons[0], /未知/);
  group.mode = 'any';
  group.conditions.push(rule({ id: 'known', left: 'close', value: 90 }));
  assert.equal(evaluateGroup(group, bars, points, 1).matched, true);
  assert.equal(evaluateGroup({ mode: 'all', conditions: [] }, bars, points, 1).matched, false);
  bars[1].confirmed = false;
  assert.equal(evaluateGroup(group, bars, points, 1).matched, false);
});

test('交叉使用当前及前一柱两侧指标，允许从相等穿越，禁止未来或缺失值', () => {
  const bars = candles(3);
  const points = indicators(bars);
  points[0].fastMA = 100;
  points[1].fastMA = 101;
  const group: ConditionGroup = { mode: 'all', conditions: [rule({ left: 'fastMA', right: 'slowMA', operator: 'crossUp' })] };
  assert.equal(evaluateGroup(group, bars, points, 0).checks[0].available, false);
  assert.equal(evaluateGroup(group, bars, points, 1).matched, true);
  points[2].fastMA = 1000;
  assert.equal(evaluateGroup(group, bars, points, 1).matched, true);
  points[0].slowMA = null;
  assert.equal(evaluateGroup(group, bars, points, 1).checks[0].available, false);
  group.conditions = [rule({ left: 'fastMA', operator: 'crossDown', value: 100 })];
  assert.equal(evaluateGroup(group, bars, points, 2).matched, false);
  points[2].fastMA = 99;
  assert.equal(evaluateGroup(group, bars, points, 2).matched, true);
});

test('200 柱预热、最后柱信号保留 pending，空输入无绩效', () => {
  const bars = candles(200);
  const { plan, points } = fixture(bars);
  const short = runBacktest(bars.slice(0, 199), points.slice(0, 199), plan);
  assert.equal(short.signals.length, 0);
  assert.equal(short.metrics.totalReturn, 0);
  const result = runBacktest(bars, points, plan);
  assert.deepEqual(result.signals.map((signal) => [signal.index, signal.side]), [[199, 'buy']]);
  assert.equal(result.signals[0].eligibleTime, null);
  assert.equal(result.signals[0].referencePrice, null);
  assert.equal(result.openTrade, null);
  assert.match(result.warnings.join(' '), /等待下一根/);
  assert.equal(runBacktest([], [], plan).metrics.closedTrades, 0);
});

test('已确认收盘信号次柱开盘买入，观察价是过滤而非限价', () => {
  const bars = candles(202);
  const { plan, points } = fixture(bars);
  plan.entryPrice = 99;
  setBar(bars, 200, 90, 95, 89, 96);
  const result = runBacktest(bars, points, plan);
  assert.equal(result.openTrade?.entryIndex, 200);
  assert.equal(result.openTrade?.entryTime, bars[200].time);
  assert.equal(result.openTrade?.entryPrice, 90);
  assert.equal(result.signals[0].referencePrice, 90);
  assert.equal(result.openTrade?.barsHeld, 2);
  plan.entryPrice = 101;
  assert.equal(runBacktest(bars, points, plan).signals.length, 0);
});

test('持仓不重入，空仓即使离场条件满足也不卖出', () => {
  const bars = candles(207);
  const { plan, points } = fixture(bars, [199, 200, 201, 202, 203, 204, 205, 206]);
  const result = runBacktest(bars, points, plan);
  assert.deepEqual(result.signals.map((signal) => signal.side), ['buy']);
  assert.equal(result.openTrade?.entryIndex, 200);
  points.forEach((point) => { point.histogram = -1; });
  assert.equal(runBacktest(bars, points, plan).signals.length, 0);
});

test('未确认尾柱的开盘和剧烈价格均不执行、不估值、不提供收益参考', () => {
  const bars = candles(203);
  const { plan, points } = fixture(bars);
  bars[200].confirmed = bars[201].confirmed = bars[202].confirmed = false;
  setBar(bars, 200, 1, 500, 1, 1000);
  const result = runBacktest(bars, points, plan);
  assert.equal(result.openTrade, null);
  assert.equal(result.equity.length, 1);
  assert.equal(result.metrics.totalReturn, 0);
  assert.equal(result.signals[0].referencePrice, null);
  assert.equal(result.signals[0].nextFiveReturn, null);
  assert.equal(result.signals[0].eligibleTime, bars[200].time);
});

test('已有持仓遇到未确认柱保留上个已确认收盘市值', () => {
  const bars = candles(203);
  const { plan, points } = fixture(bars);
  bars[202].confirmed = false;
  const prefix = runBacktest(bars.slice(0, 202), points.slice(0, 202), plan);
  setBar(bars, 202, 1, 500, 1, 1000);
  const result = runBacktest(bars, points, plan);
  assert.deepEqual(result.equity, prefix.equity);
  assert.deepEqual(result.openTrade, prefix.openTrade);
});

test('收盘风险模型忽略盘中穿越，止损收盘触发后按次柱跳空及不利滑点成交', () => {
  const bars = candles(204);
  const { plan, points } = fixture(bars);
  Object.assign(plan, { stopPrice: 90, targetPrice: 110, slippageBps: 100, feeBps: 100 });
  setBar(bars, 200, 90, 100, 80, 120);
  setBar(bars, 201, 100, 85, 80, 105);
  setBar(bars, 202, 70, 100, 60, 120);
  const result = runBacktest(bars, points, plan);
  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.exitIndex, 202);
  assert.match(trade.exitReason!, /收盘止损/);
  closeTo(trade.entryPrice, 90.9);
  closeTo(trade.exitPrice, 69.3);
  const expected = 69.3 * 100 * 0.99 - 90.9 * 100 * 1.01;
  closeTo(trade.pnl, expected);
  closeTo(trade.returnPct, expected / (90.9 * 100 * 1.01) * 100);
  assert.deepEqual(result.signals.map((signal) => signal.index), [199, 201]);
  closeTo(result.metrics.totalReturn, expected / 10000 * 100);
});

test('止盈是收盘条件，向下跳空可导致亏损而非按目标价填单', () => {
  const bars = candles(203);
  const { plan, points } = fixture(bars);
  plan.targetPrice = 105;
  setBar(bars, 200, 100, 106, 100, 110);
  setBar(bars, 201, 80);
  const result = runBacktest(bars, points, plan);
  assert.equal(result.trades[0].exitPrice, 80);
  assert.match(result.trades[0].exitReason!, /收盘止盈/);
  closeTo(result.trades[0].pnl, -2000);
  assert.match(result.warnings.join(' '), /不是券商盘中保护单/);
});

test('追踪止损只使用前已完成柱高点，本柱新高不会同柱追踪止损', () => {
  const bars = candles(204);
  const { plan, points } = fixture(bars);
  plan.trailingStopPct = 10;
  setBar(bars, 200, 100, 100, 99, 150);
  setBar(bars, 201, 100, 100, 99, 200);
  setBar(bars, 202, 95);
  const result = runBacktest(bars, points, plan);
  assert.deepEqual(result.signals.map((signal) => [signal.index, signal.side]), [[199, 'buy'], [201, 'sell']]);
  assert.equal(result.trades[0].trailPrice, 135);
  assert.equal(result.trades[0].exitIndex, 202);
});

test('最长持仓柱数在完整收盘计数，触发后次柱开盘离场', () => {
  const bars = candles(205);
  const { plan, points } = fixture(bars);
  plan.maxHoldingBars = 2;
  const result = runBacktest(bars, points, plan);
  assert.equal(result.trades[0].barsHeld, 2);
  assert.equal(result.trades[0].exitIndex, 202);
  assert.match(result.trades[0].exitReason!, /最长持仓/);
  closeTo(result.metrics.exposurePct, 2 / 6 * 100);
});

test('固定止损或止盈相对实际模拟入场价无效时跳过并警告', () => {
  const bars = candles(202);
  const { plan, points } = fixture(bars);
  for (const fields of [{ stopPrice: 101 }, { stopPrice: 100 }, { targetPrice: 99 }, { targetPrice: 100 }]) {
    const result = runBacktest(bars, points, { ...plan, ...fields });
    assert.equal(result.openTrade, null);
    assert.equal(result.trades.length, 0);
    assert.match(result.warnings.join(' '), /固定止损必须低于实际入场价/);
  }
  // 同价观察条件与固定风险价之间不做预校验，实际入场采用滑点后价格。
  plan.stopPrice = 100;
  plan.slippageBps = 100;
  setBar(bars, 200, 98);
  assert.equal(runBacktest(bars, points, plan).openTrade, null);
});

test('现金不足包含买入手续费和滑点，固定数量不自动缩量也不借款', () => {
  const bars = candles(202);
  const { plan, points } = fixture(bars);
  plan.feeBps = 10;
  const feeResult = runBacktest(bars, points, plan);
  assert.equal(feeResult.openTrade, null);
  assert.match(feeResult.warnings.join(' '), /现金不足/);
  plan.feeBps = 0;
  plan.slippageBps = 5;
  assert.equal(runBacktest(bars, points, plan).openTrade, null);
  plan.slippageBps = 0;
  setBar(bars, 200, 101);
  assert.equal(runBacktest(bars, points, plan).openTrade, null);
});

test('固定数量多笔交易按现金账本累计，不把单笔收益率相乘', () => {
  const bars = candles(208);
  const { plan, points } = fixture(bars, [199, 202]);
  points[201].histogram = points[204].histogram = -1;
  setBar(bars, 200, 90);
  setBar(bars, 202, 100);
  setBar(bars, 203, 90);
  setBar(bars, 205, 100);
  const result = runBacktest(bars, points, plan);
  assert.equal(result.trades.length, 2);
  closeTo(result.trades[0].pnl, 1000);
  closeTo(result.trades[1].pnl, 1000);
  closeTo(result.metrics.totalReturn, 20);
  assert.equal(result.metrics.winRate, 100);
  assert.equal(result.metrics.profitFactor, null);
  assert.equal(result.equity.at(-1)?.value, 12000);
});

test('胜率、盈亏比与最大回撤由净现金盈亏和权益曲线推导', () => {
  const bars = candles(208);
  const { plan, points } = fixture(bars, [199, 202]);
  points[201].histogram = points[204].histogram = -1;
  setBar(bars, 200, 90);
  setBar(bars, 202, 100);
  setBar(bars, 203, 100);
  setBar(bars, 204, 95);
  setBar(bars, 205, 95);
  const result = runBacktest(bars, points, plan);
  closeTo(result.metrics.totalReturn, 5);
  closeTo(result.metrics.winRate, 50);
  closeTo(result.metrics.profitFactor, 2);
  closeTo(result.metrics.maxDrawdown, 500 / 11000 * 100);
});

test('有效开始时间限制确认，即使原始日线日期标签在范围内也不提前确认', () => {
  const bars = candles(203).map((bar, index) => ({ ...bar, time: Date.UTC(2024, 0, 1 + index) / 1000 }));
  const { plan, points } = fixture(bars, [199, 200]);
  plan.period = 'day';
  plan.validFrom = iso(signalConfirmationTime(bars[199].time, plan.symbol, 'day') + 1);
  const result = runBacktest(bars, points, plan);
  assert.equal(result.signals[0].index, 200);
  assert.equal(result.openTrade?.entryIndex, 201);
  assert.equal(result.openTrade?.entryTime, barOpenTime(bars[201].time, plan.symbol, 'day'));
});

test('有效期结束不强制成交，次柱开盘等于 validUntil 时不执行', () => {
  const bars = candles(204);
  const { plan, points } = fixture(bars);
  points[200].histogram = -1;
  plan.validUntil = iso(bars[201].time);
  const result = runBacktest(bars, points, plan);
  assert.equal(result.openTrade?.entryIndex, 200);
  assert.equal(result.trades.length, 0);
  // 200 柱的收盘恰为右边界，不再使用该收盘触发卖出。
  assert.deepEqual(result.signals.map((signal) => signal.side), ['buy']);
  assert.match(result.warnings.join(' '), /未强制卖出/);
});

test('有效期在柱内结束，不使用边界后收盘、高低价估值或触发风险', () => {
  const bars = candles(204);
  const { plan, points } = fixture(bars);
  plan.stopLossPct = 3;
  plan.validUntil = iso(bars[201].time + 1800);
  setBar(bars, 201, 105, 1, 1, 1000);
  const result = runBacktest(bars, points, plan);
  assert.equal(result.openTrade?.barsHeld, 1);
  assert.equal(result.signals.length, 1);
  assert.equal(result.equity.at(-1)?.value, 10500);
  assert.equal(result.equity.at(-1)?.time, bars[201].time);
});

test('有效期在柱内结束时，已知开盘跳空计入浮亏且忽略后续高低', () => {
  const bars = candles(204);
  const { plan, points } = fixture(bars);
  plan.validUntil = iso(bars[201].time + 1800);
  setBar(bars, 200, 100, 100, 99, 101);
  setBar(bars, 201, 60, 500, 1, 1000);
  const result = runBacktest(bars, points, plan);
  closeTo(result.openTrade?.maePct, -40);
  closeTo(result.openTrade?.mfePct, 1);
  closeTo(result.equity.at(-1)?.value, 6000);
});

test('日线确认到下一日开盘跨有效期时不把待买信号伪装成交', () => {
  const bars = candles(202).map((bar, index) => ({ ...bar, time: Date.UTC(2024, 0, 1 + index) / 1000 }));
  const { plan, points } = fixture(bars);
  plan.period = 'day';
  plan.validUntil = iso(barOpenTime(bars[200].time, plan.symbol, 'day'));
  const result = runBacktest(bars, points, plan);
  assert.equal(result.signals.length, 1);
  assert.equal(result.openTrade, null);
  assert.equal(result.trades.length, 0);
  assert.equal(result.signals[0].referencePrice, null);
  assert.equal(result.signals[0].nextFiveReturn, null);
  assert.match(result.warnings.join(' '), /等待下一根/);
});

test('路径 offset0=0、offset1=入场柱收盘，相对原始开盘且不采样离场柱收盘', () => {
  const bars = candles(205);
  const { plan, points } = fixture(bars);
  plan.maxHoldingBars = 2;
  plan.slippageBps = 10;
  setBar(bars, 200, 90, 99);
  setBar(bars, 201, 99, 108);
  setBar(bars, 202, 100, 1000);
  const result = runBacktest(bars, points, plan);
  assert.deepEqual(result.paths.map((point) => [point.offset, point.count]), [[0, 1], [1, 1], [2, 1]]);
  closeTo(result.paths[0].mean, 0);
  closeTo(result.paths[1].mean, 10);
  closeTo(result.paths[2].median, 20);
  closeTo(result.paths[2].p25, 20);
  closeTo(result.paths[2].p75, 20);
});

test('路径均值与插值分位数聚合多笔实际持仓样本', () => {
  const bars = candles(208);
  const { plan, points } = fixture(bars, [199, 202]);
  plan.maxHoldingBars = 1;
  setBar(bars, 200, 80, 88);
  setBar(bars, 203, 80, 104);
  const result = runBacktest(bars, points, plan);
  assert.equal(result.paths[1].count, 2);
  closeTo(result.paths[1].mean, 20);
  closeTo(result.paths[1].median, 20);
  closeTo(result.paths[1].p25, 15);
  closeTo(result.paths[1].p75, 25);
});

test('变更未来行情不会改变已有信号决策、成交、路径前缀或权益', () => {
  const bars = candles(212);
  const { plan, points } = fixture(bars, [199, 204]);
  plan.maxHoldingBars = 2;
  const prefix = runBacktest(bars.slice(0, 204), points.slice(0, 204), plan);
  for (let index = 204; index < bars.length; index += 1) setBar(bars, index, 10, 200, 1, 1000);
  const full = runBacktest(bars, points, plan);
  assert.deepEqual(full.trades.filter((trade) => trade.exitIndex! < 204), prefix.trades);
  assert.deepEqual(full.equity.filter((point) => point.time <= bars[204].time), prefix.equity);
  const causal = (signals: typeof full.signals): object[] => signals.map(({ eligibleTime, referencePrice, nextFiveReturn, ...signal }) => signal);
  assert.deepEqual(causal(full.signals.filter((signal) => signal.index < 204)), causal(prefix.signals));
});

test('实际研究范围来自预热后有效估值段，空研究边界为 null', () => {
  const bars = candles(203);
  const { plan, points } = fixture(bars);
  const result = runBacktest(bars, points, plan);
  assert.deepEqual(result.researchRange, { start: bars[199].time + 3600, end: bars[202].time + 3600 });
  assert.deepEqual(runBacktest([], [], plan).researchRange, { start: null, end: null });
});

test('离场开盘跳空计入 MAE/MFE，不使用离场柱其余价格', () => {
  const bars = candles(204);
  const { plan, points } = fixture(bars);
  plan.maxHoldingBars = 1;
  setBar(bars, 200, 100, 100, 99, 101);
  setBar(bars, 201, 60, 500, 1, 1000);
  const result = runBacktest(bars, points, plan);
  closeTo(result.trades[0].maePct, -40);
  closeTo(result.trades[0].mfePct, 1);
});

test('输入对象不变且重复运行确定，长行情的拒单警告有上限', () => {
  const bars = candles(400);
  const { plan, points } = fixture(bars, Array.from({ length: 201 }, (_, index) => index + 199));
  plan.feeBps = 10;
  const snapshot = structuredClone({ bars, points, plan });
  const result = runBacktest(bars, points, plan);
  assert.equal(result.warnings.length, 100);
  assert.match(result.warnings.at(-1)!, /省略/);
  assert.deepEqual({ bars, points, plan }, snapshot);
  assert.deepEqual(runBacktest(bars, points, plan), result);
});

test('真实指标复用流水线可执行，拒绝错位及中途未确认柱', () => {
  const bars = candles(210);
  const plan = createDefaultPlan('TEST.HK', 'demo', '1h', DEFAULT_CONFIG);
  const points = calculateIndicators(bars, plan.indicatorConfig);
  assert.doesNotThrow(() => runBacktest(bars, points, plan));
  assert.throws(() => runBacktest(bars, [], plan), /数量/);
  const changed = points.map((point) => ({ ...point }));
  changed[200].time += 1;
  assert.throws(() => runBacktest(bars, changed, plan), /指标时间/);
  bars[200].confirmed = false;
  assert.throws(() => runBacktest(bars, points, plan), /之前存在未确认柱/);
});
