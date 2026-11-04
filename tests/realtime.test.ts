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

test('相同原生快照复用历史数组和全部柱，空更新及被忽略更新也不换引用', () => {
  const time = Date.parse('2026-10-19T13:30:00Z') / 1000;
  const history = [candle(time), candle(time + 900, false)];
  for (const updates of [structuredClone(history), [structuredClone(history[1])], [], [candle(time - 900)], [candle(time, false, 105)]]) {
    const result = mergeLiveCandles(history, updates, 'DRAM.US', '15m');
    assert.strictEqual(result, history);
    result.forEach((bar, index) => assert.strictEqual(bar, history[index]));
  }
  const empty: Candle[] = [];
  assert.strictEqual(mergeLiveCandles(empty, [], 'DRAM.US', '15m'), empty);
});

test('逐项OHLCV及确认状态修订只替换变化柱，追加保留前缀引用', () => {
  const time = Date.parse('2026-10-19T13:30:00Z') / 1000;
  const history = [candle(time), candle(time + 900, false)];
  for (const change of [{ open: 101 }, { high: 111 }, { low: 89 }, { close: 101 }, { volume: 1001 }, { confirmed: true }]) {
    const updated = { ...history[1], ...change };
    const result = mergeLiveCandles(history, [updated], 'DRAM.US', '15m');
    assert.notStrictEqual(result, history);
    assert.strictEqual(result[0], history[0]);
    assert.notStrictEqual(result[1], history[1]);
    assert.deepEqual(result[1], updated);
    assert.strictEqual(mergeLiveCandles(result, [{ ...updated }], 'DRAM.US', '15m'), result);
  }
  const appended = candle(time + 1800, false);
  const result = mergeLiveCandles(history, [appended], 'DRAM.US', '15m');
  assert.notStrictEqual(result, history);
  assert.strictEqual(result[0], history[0]);
  assert.strictEqual(result[1], history[1]);
  assert.strictEqual(result[2], appended);
});

test('美港日线日期标签别名保留原时间及引用，真实修订仍替换', () => {
  const label = Date.parse('2026-10-19T00:00:00Z') / 1000;
  for (const [symbol, midnight] of [['DRAM.US', '2026-10-19T04:00:00Z'], ['700.HK', '2026-10-18T16:00:00Z']]) {
    const local = Date.parse(midnight) / 1000;
    for (const [time, alias] of [[label, local], [local, label]]) {
      const history = [candle(time, false)];
      assert.strictEqual(mergeLiveCandles(history, [candle(alias, false)], symbol, 'day'), history);
      const revised = mergeLiveCandles(history, [candle(alias, false, 105)], symbol, 'day');
      assert.notStrictEqual(revised[0], history[0]);
      assert.equal(revised[0].time, time);
      assert.equal(revised[0].close, 105);
    }
  }
});

test('相同引用、忽略旧柱或禁止确认倒退均不能跳过非法数据校验', () => {
  const time = Date.parse('2026-10-19T13:30:00Z') / 1000;
  const history = [candle(time)];
  for (const change of [{ time: NaN }, { open: 0 }, { high: 99 }, { low: 101 }, { close: Infinity },
    { volume: -1 }, { confirmed: 'true' }]) {
    const invalid = { ...history[0], ...change } as Candle;
    assert.throws(() => mergeLiveCandles([invalid], [invalid], 'DRAM.US', '15m'));
    assert.throws(() => mergeLiveCandles(history, [invalid], 'DRAM.US', '15m'));
  }
  assert.throws(() => mergeLiveCandles(history, [candle(time - 900, true, -1)], 'DRAM.US', '15m'));
  assert.throws(() => mergeLiveCandles(history, [{ ...candle(time, false), volume: -1 }], 'DRAM.US', '15m'));
  assert.throws(() => mergeLiveCandles(history, [candle(time), candle(time)], 'DRAM.US', '15m'), /递增/);
  const gap = [candle(time, false), candle(time + 900)];
  assert.throws(() => mergeLiveCandles(gap, gap, 'DRAM.US', '15m'), /缺口/);
});

test('实时事件接受全部原生及季度K线周期', () => {
  for (const period of ['1m', '5m', '15m', '30m', '1h', 'day', 'week', 'month', 'quarter', 'year']) {
    const event = { type: 'candles', symbol: 'DRAM.US', period,
      candles: [candle(Date.parse('2026-10-01T00:00:00Z') / 1000, false)], receivedAt: '2026-10-19T14:30:00Z' };
    assert.deepEqual(parseStreamEvent(event), event);
  }
});

test('同步元数据独立确认各频道和来源，支持推送、事件触发与实际快照间隔', () => {
  for (const channel of ['quote', 'candles', 'intraday']) {
    for (const transport of ['desktop-ws', 'desktop-http', 'cli']) {
      for (const state of ['connecting', 'connected', 'reconnecting', 'error']) {
        for (const mode of ['push', 'event', 'snapshot']) {
          const event = { type: 'sync', symbol: 'DRAM.US', channel, transport, state, mode,
            ...(mode === 'snapshot' ? { intervalMs: 1250 } : {}), period: 'day', message: '独立同步元数据' };
          assert.deepEqual(parseStreamEvent(event), event);
        }
      }
    }
  }
  const event = { type: 'sync', symbol: 'DRAM.US', channel: 'quote', transport: 'desktop-ws', mode: 'push', state: 'connected' };
  assert.deepEqual(parseStreamEvent(event), event);
});

test('快照必须有有限正数间隔，推送和事件触发不得携带间隔', () => {
  const base = { type: 'sync', symbol: 'DRAM.US', channel: 'candles', transport: 'desktop-http', state: 'connected' };
  for (const intervalMs of [undefined, null, 0, -1, NaN, Infinity, -Infinity, '5000', {}, true]) {
    assert.throws(() => parseStreamEvent({ ...base, mode: 'snapshot', intervalMs }), /间隔/);
  }
  assert.throws(() => parseStreamEvent({ ...base, mode: 'snapshot' }), /间隔/);
  for (const mode of ['push', 'event']) {
    for (const intervalMs of [undefined, null, 0, 5000]) {
      assert.throws(() => parseStreamEvent({ ...base, mode, intervalMs }), /间隔/);
    }
  }
});

test('同步事件拒绝非法频道、来源、状态、周期及消息，禁止隐式字符串转换', () => {
  const base = { type: 'sync', symbol: 'DRAM.US', channel: 'quote', transport: 'desktop-ws', mode: 'push', state: 'connected' };
  for (const [field, values] of Object.entries({
    channel: ['', 'trades', null, 1, { toString: () => 'quote' }],
    transport: ['', 'ws', null, { toString: () => 'desktop-ws' }],
    mode: ['', 'poll', null, { toString: () => 'push' }],
    state: ['', 'ready', null, { toString: () => 'connected' }],
    period: [undefined, '', '2m', null, { toString: () => 'day' }],
    message: [undefined, null, 1, {}],
    symbol: ['', '   ', null, 1],
  })) {
    for (const value of values) assert.throws(() => parseStreamEvent({ ...base, [field]: value }), /同步|证券/);
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
