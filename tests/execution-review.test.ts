import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildExecutionReview, type OpeningPosition } from '../shared/execution-review';
import { barOpenTime, signalConfirmationTime } from '../shared/review';
import type { Candle, Execution, MarketData, Signal } from '../shared/types';
import { ExecutionReview, type ExecutionReviewProps } from '../src/ExecutionReview';

/**
 * 转换显式时区日期为测试用 UTC 秒。
 * @param iso 带时区 ISO 日期时间。
 * @returns UTC Unix 秒。
 */
function seconds(iso: string): number { return Date.parse(iso) / 1000; }

/**
 * 生成不含账户信息的确定性小时行情。
 * @param count 行情数量。
 * @returns 相邻小时、已确认的固定价格 K 线。
 */
function candles(count = 9): Candle[] {
  return Array.from({ length: count }, (_, index) => ({ time: seconds('2024-03-11T01:30:00Z') + index * 3600,
    open: 100, close: 101, high: 102, low: 99, volume: 1000, confirmed: true }));
}

/**
 * 构造显式合成行情快照，不读取账户或当前持仓。
 * @param overrides 需要覆盖的测试字段。
 * @returns 合法的单证券行情数据。
 */
function market(overrides: Partial<MarketData> = {}): MarketData {
  return { source: 'demo', symbol: 'TEST.HK', period: '1h', candles: candles(), executions: [],
    fetchedAt: '2024-03-12T00:00:00Z', warnings: [], executionsComplete: true,
    executionRange: { start: '2024-03-11', end: '2024-03-13' }, adjustment: 'none', ...overrides };
}

/**
 * 构造真实结构的合成逐笔成交。
 * @param id 明确唯一的测试 ID。
 * @param time UTC 秒。
 * @param overrides 方向、数量、价格等覆盖字段。
 * @returns 合法逐笔成交。
 */
function fill(id: string, time: number, overrides: Partial<Execution> = {}): Execution {
  return { id, symbol: 'TEST.HK', side: 'buy', time, price: 100, quantity: 10, ...overrides };
}

/**
 * 构造与行情对应的全部字段信号，参考字段可独立覆盖以测试不信任事后值。
 * @param data 对应行情。
 * @param index 信号柱索引。
 * @param overrides 信号覆盖字段。
 * @returns 已确认的测试信号。
 */
function signal(data: MarketData, index = 0, overrides: Partial<Signal> = {}): Signal {
  const candle = data.candles[index];
  return { id: `signal-${index}`, time: candle.time, index, side: 'buy', title: '合成测试信号',
    reasons: ['仅用于测试'], close: candle.close, confirmed: true,
    eligibleTime: data.candles[index + 1]?.time ?? null, referencePrice: data.candles[index + 1]?.open ?? null,
    nextFiveReturn: null, ...overrides };
}

/**
 * 使用明确空仓简化普通匹配测试，调用方可覆盖为无期初或其他快照。
 * @param data 行情数据。
 * @param signals 父传全部信号。
 * @param openingPosition 显式期初。
 * @returns 共享入口结果。
 */
function review(data: MarketData, signals: Signal[] = [], openingPosition: OpeningPosition | null = { quantity: 0, costPrice: null }) {
  return buildExecutionReview({ data, signals, openingPosition });
}

/**
 * 浮点结果使用严格但兼容计算舍入的容差。
 * @param actual 实际值。
 * @param expected 独立期望值。
 * @returns 无返回值；不符合时断言失败。
 */
function closeTo(actual: number | null, expected: number): void {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual! - expected) < 1e-9, `${actual} != ${expected}`);
}

test('导出组件契约包含且仅需要 data/signals/onSelect，并渲染可折叠手工期初表单', () => {
  const props: ExecutionReviewProps = { data: market(), signals: [], onSelect: (_time: number) => undefined };
  const html = renderToStaticMarkup(createElement(ExecutionReview, props));
  assert.match(html, /class="review-panel execution-ledger"/);
  assert.match(html, /<details><summary>设置期初仓位<\/summary>/);
  assert.match(html, /用户手工声明的区间起点快照/);
  assert.match(html, /不从当前持仓反推历史/);
  assert.match(html, /不保存、上传或导出/);
  assert.match(html, /未提供手工期初快照/);
  assert.doesNotMatch(html, /<details open/);
});

/** 周线窗口跨越休市时段，扩展时段不能匹配常规K线信号；参数无，返回测试断言。 */
test('周线执行核对排除盘前盘后周末及港股午休，仍匹配常规成交', () => {
  for (const symbol of ['NVDA.US', '700.HK']) {
    const data = market({ symbol, period: 'week', candles: ['2026-10-05', '2026-10-12'].map(date => ({
      time: seconds(`${date}T00:00:00Z`), open: 100, close: 101, high: 102, low: 99, volume: 1000, confirmed: true,
    })), executionRange: { start: '2026-10-01', end: '2026-11-01' } });
    const excluded = symbol.endsWith('.HK')
      ? ['2026-10-13T04:30:00Z', '2026-10-12T09:00:00Z', '2026-10-17T02:00:00Z']
      : ['2026-10-13T12:00:00Z', '2026-10-12T21:00:00Z', '2026-10-17T14:00:00Z'];
    for (const time of excluded) {
      data.executions = [fill('outside', seconds(time), { symbol })];
      const outside = review(data, [signal(data)]).signalReviews[0];
      assert.equal(outside.execution, null);
      data.executions.push(fill('regular', seconds(symbol.endsWith('.HK') ? '2026-10-14T02:00:00Z' : '2026-10-14T14:00:00Z'), { symbol }));
      assert.equal(review(data, [signal(data)]).signalReviews[0].execution?.id, 'regular');
    }
  }
});

test('没有期初时所有仓位与操作未知，不从任意当前持仓字段反推、不判遗漏', () => {
  const data = market();
  data.executions = [fill('buy', data.candles[1].time), fill('sell', data.candles[2].time, { side: 'sell' })];
  const poisoned = Object.assign(data, { positions: [{ symbol: data.symbol, quantity: 999, costPrice: 1 }] });
  const result = buildExecutionReview({ data: poisoned, signals: [signal(data, 3)] });
  assert.equal(result.status, 'unknown');
  assert.ok(result.ledger.every((entry) => entry.action === 'unknown' && entry.quantityAfter === null && entry.quantityBefore === null));
  assert.equal(result.signalReviews[0].state, 'unknown');
  assert.match(result.signalReviews[0].note, /不能判定遗漏/);
  assert.deepEqual(result.sellBuyCandidates, []);
});

test('明确空仓与无期初不同，按顺序正确区分建仓、加仓、减仓、清仓', () => {
  const data = market();
  const time = data.candles[0].time;
  data.executions = [fill('close', time + 4, { side: 'sell', quantity: 15, price: 130 }),
    fill('open', time + 1, { quantity: 10, price: 100 }),
    fill('reduce', time + 3, { side: 'sell', quantity: 5, price: 120 }),
    fill('add', time + 2, { quantity: 10, price: 110 })];
  const result = review(data);
  assert.equal(result.status, 'known');
  assert.deepEqual(result.ledger.map((entry) => entry.action), ['open', 'add', 'reduce', 'close']);
  assert.deepEqual(result.ledger.map((entry) => entry.quantityAfter), [10, 20, 15, 0]);
  assert.deepEqual(result.ledger.map((entry) => entry.averageCostAfter), [100, 105, 105, null]);
  assert.deepEqual(result.ledger.map((entry) => entry.grossPriceDifference), [null, null, 75, 375]);
  assert.match(result.notes.join(' '), /不能作为已实现净利/);
});

test('期初成本可空：数量可重放，未知成本持续传播；清仓后新建仓成本重新可知', () => {
  const data = market();
  const time = data.candles[0].time;
  data.executions = [fill('add', time + 1, { quantity: 5 }),
    fill('close', time + 2, { side: 'sell', quantity: 15 }), fill('reopen', time + 3, { price: 80, quantity: 2 })];
  const result = review(data, [], { quantity: 10, costPrice: null });
  assert.deepEqual(result.ledger.map((entry) => entry.action), ['add', 'close', 'open']);
  assert.deepEqual(result.ledger.map((entry) => entry.averageCostAfter), [null, null, 80]);
  assert.equal(result.ledger[1].grossPriceDifference, null);
  assert.equal(review(data, [], { quantity: 10, costPrice: 90 }).ledger[0].averageCostAfter, 280 / 3);
});

test('卖超流水可用量标异常，不生成负仓；后续买入也不伪造已知仓位', () => {
  const data = market();
  const time = data.candles[0].time;
  data.executions = [fill('oversell', time, { side: 'sell', quantity: 11 }), fill('later', time + 1)];
  const result = review(data, [], { quantity: 10, costPrice: 80 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.ledger[0].action, 'anomaly');
  assert.equal(result.ledger[0].quantityBefore, 10);
  assert.equal(result.ledger[0].quantityAfter, null);
  assert.equal(result.ledger[1].action, 'unknown');
  assert.equal(result.ledger[1].quantityAfter, null);
  assert.deepEqual(result.sellBuyCandidates, []);
});

test('零股精度相等可清仓，真实微小超卖仍异常', () => {
  const data = market();
  const time = data.candles[0].time;
  data.executions = [fill('first', time, { quantity: 0.1 }), fill('second', time + 1, { quantity: 0.2 }),
    fill('close', time + 2, { side: 'sell', quantity: 0.3 })];
  assert.equal(review(data).ledger[2].quantityAfter, 0);
  data.executions[2].quantity = 0.300001;
  assert.equal(review(data).ledger[2].action, 'anomaly');
});

test('同秒异向成交不使用 ID 冒充先后顺序，同秒同向可逐笔重放', () => {
  const data = market();
  const time = data.candles[0].time;
  data.executions = [fill('a-buy', time), fill('z-sell', time, { side: 'sell' }), fill('later', time + 1)];
  assert.ok(review(data).ledger.every((entry) => entry.action === 'unknown'));
  data.executions[1].side = 'buy';
  assert.deepEqual(review(data).ledger.map((entry) => entry.quantityAfter), [10, 20, 30]);
});

test('逐笔缺失或完整性为 false 时仓位和成交对应均 unknown，即使存在可见成交', () => {
  const data = market({ executionsComplete: false });
  data.executions = [fill('visible', data.candles[1].time)];
  const result = review(data, [signal(data)]);
  assert.equal(result.ledger[0].action, 'unknown');
  assert.equal(result.signalReviews[0].state, 'unknown');
  assert.equal(result.signalReviews[0].execution, null);
  assert.equal(result.status, 'unknown');
  const missing = { ...data, executions: undefined, executionsComplete: true } as unknown as MarketData;
  assert.equal(review(missing, [signal(data)]).signalReviews[0].state, 'unknown');
  assert.equal(review(missing).status, 'unknown');
});

test('单证券闭开区间过滤，不让区间外成交或其他证券影响期初与统计', () => {
  const start = seconds('2024-03-11T00:00:00+08:00');
  const end = seconds('2024-03-13T00:00:00+08:00');
  const data = market({ executions: [fill('before', start - 1), fill('start', start),
    fill('other', start + 1, { symbol: 'OTHER.HK' }), fill('end', end), fill('case', start + 2, { symbol: 'test.hk' })] });
  assert.deepEqual(review(data).ledger.map((entry) => entry.execution.id), ['start', 'case']);
  assert.equal(review(data).ledger[1].quantityAfter, 20);
});

test('卖后买回仅为候选，FIFO 按部分数量分配，不能以整笔或总买量计算价差', () => {
  const data = market();
  const time = data.candles[0].time;
  data.executions = [fill('sell-1', time, { side: 'sell', quantity: 8, price: 110 }),
    fill('sell-2', time + 1, { side: 'sell', quantity: 4, price: 108 }),
    fill('buy-1', time + 2, { quantity: 5, price: 100 }), fill('buy-2', time + 3, { quantity: 10, price: 102 })];
  const result = review(data, [], { quantity: 20, costPrice: 90 });
  assert.deepEqual(result.sellBuyCandidates.map((item) => [item.sell.id, item.buy.id, item.matchedQuantity, item.priceDifferenceAmount]),
    [['sell-1', 'buy-1', 5, 50], ['sell-1', 'buy-2', 3, 24], ['sell-2', 'buy-2', 4, 24]]);
  assert.ok(result.sellBuyCandidates.every((item) => item.label === '卖出后买回候选'));
  assert.equal(result.sellBuyCandidates.reduce((sum, item) => sum + item.matchedQuantity, 0), 12);
  assert.match(result.notes.join(' '), /价差金额不是净盈利/);
});

test('买后卖不反向匹配，卖低买高保留负价差且不命名损失或意图', () => {
  const data = market();
  const time = data.candles[0].time;
  data.executions = [fill('buy', time), fill('sell', time + 1, { side: 'sell', price: 90 }), fill('rebuy', time + 2, { price: 110, quantity: 3 })];
  const candidates = review(data).sellBuyCandidates;
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].buy.id, 'rebuy');
  assert.equal(candidates[0].priceDifferenceAmount, -60);
});

test('完整下一柱只匹配最早同向同证券成交，延迟从确认计算，偏差基准为真实下一柱 open', () => {
  const data = market();
  const time = data.candles[1].time;
  data.executions = [fill('late', time + 30, { price: 103 }), fill('first', time + 20, { price: 102 }),
    fill('wrong-side', time + 5, { side: 'sell' }), fill('wrong-symbol', time + 3, { symbol: 'OTHER.HK' }),
    fill('same-bar', time - 1)];
  const item = review(data, [signal(data, 0, { eligibleTime: 1, referencePrice: 500 })]).signalReviews[0];
  assert.equal(item.state, 'matched');
  assert.equal(item.execution?.id, 'first');
  assert.equal(item.delaySeconds, 20);
  assert.equal(item.nextOpenPrice, 100);
  assert.equal(item.priceDeviation, 2);
  assert.equal(item.priceDeviationPercent, 2);
  assert.match(item.note, /不证明因果/);
});

test('卖出价格偏差仍为实际价减下一柱 open，不按方向伪装盈亏', () => {
  const data = market();
  data.executions = [fill('sell', data.candles[1].time, { side: 'sell', price: 98 })];
  const item = review(data, [signal(data, 0, { side: 'sell' })], { quantity: 10, costPrice: 90 }).signalReviews[0];
  assert.equal(item.priceDeviation, -2);
  assert.equal(item.priceDeviationPercent, -2);
  assert.equal(item.delaySeconds, 0);
});

test('下一柱完整覆盖是匹配前提，部分查询即使已有成交也不能宣称首笔匹配', () => {
  const data = market();
  const start = data.candles[1].time;
  const end = start + 3600;
  data.executions = [fill('visible', start + 100)];
  for (const range of [[start + 1, end], [start, end - 1]]) {
    data.executionRange = { start: new Date(range[0] * 1000).toISOString(), end: new Date(range[1] * 1000).toISOString() };
    const item = review(data, [signal(data)]).signalReviews[0];
    assert.equal(item.state, 'unknown');
    assert.equal(item.execution, null);
  }
  data.executionRange = { start: new Date(start * 1000).toISOString(), end: new Date(end * 1000).toISOString() };
  assert.equal(review(data, [signal(data)]).signalReviews[0].state, 'matched');
});

test('窗口闭开：开盘成交可匹配，收盘成交只可作下一根延后候选', () => {
  const data = market();
  data.executions = [fill('open', data.candles[1].time)];
  assert.equal(review(data, [signal(data)]).signalReviews[0].state, 'matched');
  data.executions = [fill('close', data.candles[1].time + 3600)];
  assert.equal(review(data, [signal(data)]).signalReviews[0].state, 'delayed-candidate');
});

test('延后仅查确认后第2～5根柱首笔同向成交，不跳到第6根或更晚', () => {
  const data = market();
  data.executions = [fill('later-in-five', data.candles[5].time + 100), fill('first-in-five', data.candles[5].time),
    fill('wrong-direction', data.candles[2].time, { side: 'sell' })];
  let item = review(data, [signal(data)]).signalReviews[0];
  assert.equal(item.state, 'delayed-candidate');
  assert.equal(item.execution?.id, 'first-in-five');
  assert.equal(item.delaySeconds, 4 * 3600);
  data.executions = [fill('sixth', data.candles[6].time)];
  item = review(data, [signal(data)]).signalReviews[0];
  assert.equal(item.state, 'unmatched');
  assert.equal(item.execution, null);
  assert.doesNotMatch(item.note, /造成|损失金额|遗漏操作/);
});

test('每笔成交最多使用一次，所有直接窗口先于延后候选，保持父传全部信号及其顺序', () => {
  const data = market();
  data.executions = [fill('direct-second', data.candles[2].time), fill('delayed-first', data.candles[3].time)];
  const second = signal(data, 1);
  const first = signal(data, 0);
  const result = review(data, [second, first]);
  assert.deepEqual(result.signalReviews.map((item) => item.signal.id), [second.id, first.id]);
  assert.deepEqual(result.signalReviews.map((item) => item.execution?.id), ['direct-second', 'delayed-first']);
  assert.deepEqual(result.signalReviews.map((item) => item.state), ['matched', 'delayed-candidate']);
  data.executions = [fill('one', data.candles[1].time)];
  const duplicateWindow = review(data, [signal(data, 0, { id: 'z' }), signal(data, 0, { id: 'a' })]);
  assert.equal(duplicateWindow.signalReviews.filter((item) => item.execution).length, 1);
  assert.equal(duplicateWindow.signalReviews[1].execution?.id, 'one');
});

test('无期初仍可描述完整窗口的成交时间对应，但未匹配不判遗漏', () => {
  const data = market();
  data.executions = [fill('one', data.candles[1].time)];
  const result = review(data, [signal(data), signal(data, 5)], null);
  assert.equal(result.signalReviews[0].state, 'matched');
  assert.equal(result.signalReviews[1].state, 'unknown');
  assert.equal(result.ledger[0].action, 'unknown');
});

test('未确认信号或下一柱、缺少下一柱保持 pending；不完整成交保持 unknown', () => {
  const data = market();
  data.executions = [fill('one', data.candles[1].time)];
  assert.equal(review(data, [signal(data, 0, { confirmed: false })]).signalReviews[0].state, 'pending');
  data.candles[1].confirmed = false;
  assert.equal(review(data, [signal(data)]).signalReviews[0].state, 'pending');
  assert.equal(review(data, [signal(data, 8)]).signalReviews[0].state, 'pending');
  data.executionsComplete = false;
  assert.equal(review(data, [signal(data, 8)]).signalReviews[0].state, 'unknown');
});

test('缺柱不扩大窗口，未来成交必须处于某根实际 bar 的固定窗口', () => {
  const data = market({ period: '15m' });
  data.candles = data.candles.slice(0, 3);
  data.candles[1].time = data.candles[0].time + 900;
  data.candles[2].time = data.candles[0].time + 86400;
  data.executions = [fill('in-gap', data.candles[1].time + 901)];
  assert.equal(review(data, [signal(data)]).signalReviews[0].execution, null);
  data.executions.push(fill('in-later-bar', data.candles[2].time + 10));
  assert.equal(review(data, [signal(data)]).signalReviews[0].execution?.id, 'in-later-bar');
});

test('延后搜索不能跳过未完整覆盖的中间窗口来宣称首笔', () => {
  const data = market();
  data.candles[2].confirmed = false;
  data.executions = [fill('later', data.candles[3].time)];
  const item = review(data, [signal(data)]).signalReviews[0];
  assert.equal(item.execution, null);
  assert.equal(item.state, 'unmatched');
});

test('日线港股按当地开收盘匹配，排除次日盘前、收盘以及周末空档', () => {
  const data = market({ period: 'day' });
  data.candles = candles(3).map((candle, index) => ({ ...candle, time: seconds(`${['2024-03-08', '2024-03-11', '2024-03-12'][index]}T00:00:00+08:00`) }));
  data.executionRange = { start: '2024-03-08', end: '2024-03-13' };
  data.executions = [fill('weekend', seconds('2024-03-09T10:00:00+08:00')),
    fill('preopen', seconds('2024-03-11T09:29:59+08:00')), fill('valid', seconds('2024-03-11T09:30:00+08:00'))];
  const item = review(data, [signal(data)]).signalReviews[0];
  assert.equal(item.execution?.id, 'valid');
  assert.equal(item.confirmationTime, seconds('2024-03-08T16:00:00+08:00'));
  assert.equal(item.delaySeconds, 65.5 * 3600);
  data.executions = [fill('at-close', seconds('2024-03-11T16:00:00+08:00'))];
  assert.equal(review(data, [signal(data)]).signalReviews[0].execution, null);
});

test('美股日线跨 DST，确认到成交使用真实 UTC 秒，UTC/当地午夜标签等价', () => {
  for (const localMidnight of [false, true]) {
    const data = market({ symbol: 'TEST.US', period: 'day', executionRange: { start: '2024-03-08', end: '2024-03-13' } });
    data.candles = candles(3).map((candle, index) => ({ ...candle,
      time: seconds(`${['2024-03-08', '2024-03-11', '2024-03-12'][index]}T${localMidnight ? index === 0 ? '05:00' : '04:00' : '00:00'}:00Z`) }));
    data.executions = [fill('pre', seconds('2024-03-11T13:29:59Z'), { symbol: 'TEST.US' }),
      fill('open', seconds('2024-03-11T13:30:00Z'), { symbol: 'TEST.US', price: 101 })];
    const item = review(data, [signal(data)]).signalReviews[0];
    assert.equal(item.execution?.id, 'open');
    assert.equal(item.confirmationTime, seconds('2024-03-08T21:00:00Z'));
    assert.equal(item.delaySeconds, 64.5 * 3600);
    assert.equal(item.priceDeviation, 1);
  }
});

test('美股日线查询末端没有覆盖中国次日收盘时 unknown，不以内含开盘成交掩盖覆盖不足', () => {
  const data = market({ symbol: 'TEST.US', period: 'day' });
  data.candles = candles(2).map((candle, index) => ({ ...candle, time: seconds(`${['2024-03-07', '2024-03-08'][index]}T00:00:00Z`) }));
  data.executionRange = { start: '2024-03-04', end: '2024-03-09' };
  data.executions = [fill('open', barOpenTime(data.candles[1].time, data.symbol, data.period), { symbol: 'TEST.US' })];
  assert.ok(signalConfirmationTime(data.candles[1].time, data.symbol, data.period) > seconds('2024-03-09T00:00:00+08:00'));
  assert.equal(review(data, [signal(data)]).signalReviews[0].state, 'unknown');
});

test('输入边界：数量、成本、成交、信号、行情和区间必须严格合法', () => {
  const data = market();
  for (const quantity of [-1, NaN, Infinity, '1']) {
    assert.throws(() => review(data, [], { quantity: quantity as number, costPrice: null }), /期初数量/);
  }
  for (const costPrice of [0, -1, NaN, Infinity, undefined, '2']) {
    assert.throws(() => review(data, [], { quantity: 1, costPrice: costPrice as number }), /期初单位成本/);
  }
  for (const override of [{ price: 0 }, { quantity: -1 }, { time: NaN }, { time: Date.now() }, { symbol: '' }, { id: ' ' }, { side: 'hold' }]) {
    assert.throws(() => review(market({ executions: [fill('bad', data.candles[1].time, override as Partial<Execution>)] })));
  }
  const duplicate = fill('duplicate', data.candles[1].time);
  assert.throws(() => review(market({ executions: [duplicate, duplicate] })), /ID 必须唯一/);
  assert.throws(() => review(data, [signal(data), signal(data)]), /信号 ID 必须唯一/);
  assert.throws(() => review(data, [signal(data, 0, { index: 1 })]), /与行情/);
  assert.throws(() => review(data, [signal(data, 0, { referencePrice: 0 })]), /参考价格/);
  assert.throws(() => review(market({ candles: [...data.candles].reverse() })), /严格递增/);
  assert.throws(() => review(market({ symbol: 'HK' })), /单个证券/);
  for (const executionRange of [{ start: '2024-02-30', end: '2024-03-12' },
    { start: '2024-03-12', end: '2024-03-11' }, { start: '2024-03-11T00:00:00', end: '2024-03-13' },
    { start: '2024-03-11T24:00:00Z', end: '2024-03-13' }]) {
    assert.throws(() => review(market({ executionRange })));
  }
});

test('数值运算溢出明确失败而非返回无穷大统计', () => {
  const data = market();
  data.executions = [fill('huge', data.candles[1].time, { quantity: Number.MAX_VALUE })];
  assert.throws(() => review(data, [], { quantity: Number.MAX_VALUE, costPrice: 1 }), /超出有限数值范围/);
});

test('计算保持调用方对象不变，相同输入产生确定结果', () => {
  const data = market();
  data.executions = [fill('later', data.candles[2].time), fill('first', data.candles[1].time)];
  const signals = [signal(data, 1), signal(data)];
  const before = JSON.stringify({ data, signals });
  const first = review(data, signals);
  assert.equal(JSON.stringify({ data, signals }), before);
  assert.deepEqual(review(data, signals), first);
  closeTo(first.signalReviews[0].priceDeviation, 0);
});

test('组件对非法数据呈现明确错误，不把输入错误渲染成无成交', () => {
  const data = market({ executionRange: { start: 'invalid', end: '2024-03-13' } });
  const previous = console.error;
  const messages: unknown[][] = [];
  console.error = (...args: unknown[]) => { messages.push(args); };
  try {
    const html = renderToStaticMarkup(createElement(ExecutionReview, { data, signals: [], onSelect: (_time: number) => undefined }));
    assert.match(html, /role="alert"/);
    assert.match(html, /无法生成执行复盘/);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], ['执行复盘输入校验失败；请检查数据结构与查询范围。']);
  } finally {
    console.error = previous;
  }
});
