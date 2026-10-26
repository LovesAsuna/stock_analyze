import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandles, normalizeExecutions, normalizeSymbol, rows, timestamp } from '../server/longbridge';

/** 外部响应标准化测试覆盖系统边界，防止无效数据悄悄进入图表和复盘。 */
test('行情解析保留秒级时间、排序去重，拒绝畸形OHLC', () => {
  const row = { time: '2026-10-14T04:00:00Z', open: '10', high: '12', low: '9', close: '11', volume: '1000' };
  assert.equal(normalizeCandles([row, row], 'NVDA.US', 'day').length, 1);
  assert.equal(normalizeCandles([row], 'NVDA.US', 'day')[0].time, Date.parse(row.time) / 1000);
  assert.throws(() => normalizeCandles([{ ...row, high: '8' }], 'NVDA.US', 'day'), /结构无效/);
  assert.throws(() => normalizeCandles([{ ...row, close: '' }], 'NVDA.US', 'day'), /有效数字/);
});

test('证券代码和时间必须经过验证，禁止命令和歧义时间', () => {
  assert.equal(normalizeSymbol('00700.hk'), '700.HK');
  assert.equal(normalizeSymbol('NVDA.US'), 'NVDA.US');
  assert.throws(() => normalizeSymbol('NVDA.US; whoami'), /证券代码/);
  assert.throws(() => timestamp('2026-10-14 12:00:00'), /时区/);
  assert.throws(() => rows({ unexpected: [] }), /结构/);
  assert.equal(timestamp(1791946800000), 1791946800);
});

test('成交缺失方向时不能猜测买卖，完整数据保留精确成交时间', () => {
  const row = { trade_id: 'fill-1', symbol: 'NVDA.US', side: 'Buy', price: '220', quantity: '10', trade_done_at: '2026-10-14T15:01:00Z' };
  assert.equal(normalizeExecutions([row], 'NVDA.US')[0].side, 'buy');
  assert.equal(normalizeExecutions([row], '700.HK').length, 0);
  assert.throws(() => normalizeExecutions([{ ...row, side: null }], 'NVDA.US'), /方向/);
});
