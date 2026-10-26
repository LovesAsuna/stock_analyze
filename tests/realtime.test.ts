import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLiveCandles } from '../shared/live-candles.js';
import { parseStreamEvent } from '../shared/realtime.js';
import type { Candle } from '../shared/types.js';

/** 返回可控OHLCV样本；时间为UTC秒，确认状态由调用方指定。 */
function candle(time: number, confirmed = true, close = 100): Candle {
  return { time, open: 100, high: 110, low: 90, close, volume: 1000, confirmed };
}

test('实时原生K线更新尾柱并保留长历史，不修改输入', () => {
  const start = Date.parse('2026-10-19T13:30:00Z') / 1000;
  const history = [candle(start), candle(start + 900, false)];
  const copy = structuredClone(history);
  const result = mergeLiveCandles(history, [candle(start + 900, true, 102), candle(start + 1800, false, 103)], 'DRAM.US', '15m');
  assert.equal(result.length, 3);
  assert.equal(result[1].close, 102);
  assert.equal(result[1].confirmed, true);
  assert.equal(result[2].confirmed, false);
  assert.deepEqual(history, copy);
});

test('补齐快照不扩大已选研究历史起点', () => {
  const time = Date.parse('2026-10-19T13:30:00Z') / 1000;
  const result = mergeLiveCandles([candle(time)], [candle(time - 900), candle(time, true, 102)], 'DRAM.US', '15m');
  assert.equal(result.length, 1);
  assert.equal(result[0].time, time);
});

test('实时快照不会将已确认柱倒退成未确认柱', () => {
  const time = Date.parse('2026-10-19T13:30:00Z') / 1000;
  const result = mergeLiveCandles([candle(time)], [candle(time, false, 105)], 'DRAM.US', '1h');
  assert.equal(result[0].close, 100);
  assert.equal(result[0].confirmed, true);
});

test('日线UTC日期标签和交易所午夜视为同一原生柱', () => {
  const label = Date.parse('2026-10-19T00:00:00Z') / 1000;
  const localMidnight = Date.parse('2026-10-19T04:00:00Z') / 1000;
  const result = mergeLiveCandles([candle(label, false)], [candle(localMidnight, false, 105)], 'DRAM.US', 'day');
  assert.equal(result.length, 1);
  assert.equal(result[0].time, label);
  assert.equal(result[0].close, 105);
});

test('实时补柱不得凭新柱确认缺失的上一柱', () => {
  const time = Date.parse('2026-10-19T13:30:00Z') / 1000;
  assert.throws(() => mergeLiveCandles([candle(time, false)], [candle(time + 900)], 'DRAM.US', '15m'), /缺口/);
});

test('实时事件接受全部原生及季度K线周期', () => {
  for (const period of ['1m', '5m', '15m', '30m', '1h', 'day', 'week', 'month', 'quarter', 'year']) {
    const event = { type: 'candles', symbol: 'DRAM.US', period,
      candles: [candle(Date.parse('2026-10-01T00:00:00Z') / 1000, false)], receivedAt: '2026-10-19T14:30:00Z' };
    assert.deepEqual(parseStreamEvent(event), event);
  }
});

test('实时事件拒绝不合法报价、周期与时间字段', () => {
  assert.throws(() => parseStreamEvent({ type: 'quote', quote: { symbol: 'DRAM.US', timestamp: 1, price: -1 } }), /报价/);
  assert.throws(() => parseStreamEvent({ type: 'candles', symbol: 'DRAM.US', period: '1m', candles: [], receivedAt: 'invalid' }), /K线/);
  for (const period of ['2m', 'Quarter', '', null, 15, { toString: () => 'day' }]) {
    assert.throws(() => parseStreamEvent({ type: 'candles', symbol: 'DRAM.US', period, candles: [], receivedAt: '2026-10-19T14:30:00Z' }), /K线/);
  }
  const event = { type: 'quote', quote: { symbol: 'DRAM.US', timestamp: 1792418400, price: 48, previousClose: 46, session: 'regular' } };
  assert.deepEqual(parseStreamEvent(event), event);
});
