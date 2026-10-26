import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { candleHistory, marketHistoryWindow, normalizeCandles } from '../server/longbridge';
import { demoCandles, demoMarket } from '../server/demo';
import { PERIODS } from '../shared/periods';
import { signalConfirmationTime } from '../shared/review';
import { calculateIndicators } from '../shared/indicators';
import { generateSignals } from '../shared/signals';
import { executionIdentities, LEGACY_DEMO_CASES, LEGACY_EXECUTION_RANGE, signalIdentities,
  type LegacyDemoBaseline } from './helpers/legacy-demo-baseline';

/** 返回月线原始字段样本，参数为月份、价格和数量，输出供聚合的CLI响应。 */
function monthRow(month: number, open: number, close: number, volume: number): Record<string, unknown> {
  return { timestamp: `2025-${String(month).padStart(2, '0')}-01T00:00:00Z`,
    open, close, high: Math.max(open, close) + 2, low: Math.min(open, close) - 2, volume };
}

test('季度合并完整月线OHLCV，缺首月或中月不覆盖完整季度', () => {
  const january = monthRow(1, 10, 12, 100);
  const february = monthRow(2, 12, 11, 200);
  const march = monthRow(3, 11, 15, 300);
  const result = normalizeCandles([march, january, february, march], 'NVDA.US', 'quarter');
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { time: Date.parse('2025-01-01T00:00:00Z') / 1000,
    open: 10, close: 15, high: 17, low: 8, volume: 600, confirmed: true });
  assert.deepEqual(normalizeCandles([february, march], 'NVDA.US', 'quarter'), []);
  assert.deepEqual(normalizeCandles([january, march], 'NVDA.US', 'quarter'), []);
});

test('季度按交易所年月归组，保留季度结束前未确认语义', () => {
  // HK本地4月1日，UTC仍为3月31日，必须归第二季度。
  const april = { ...monthRow(4, 10, 12, 100), timestamp: '2025-03-31T16:00:00Z' };
  const result = normalizeCandles([april, monthRow(5, 12, 13, 200), monthRow(6, 13, 14, 300)], '700.HK', 'quarter');
  assert.equal(result[0].time, Date.parse('2025-04-01T00:00:00Z') / 1000);
  const current = new Date();
  const month = Math.floor(current.getUTCMonth() / 3) * 3;
  const currentFirst = Date.UTC(current.getUTCFullYear(), month, 1) / 1000;
  if (signalConfirmationTime(currentFirst, 'NVDA.US', 'quarter') * 1000 > Date.now()) {
    const partial = normalizeCandles([{ ...monthRow(1, 10, 12, 100), timestamp: currentFirst }], 'NVDA.US', 'quarter');
    assert.equal(partial[0].confirmed, false);
  }
});

test('历史窗口只覆盖复盘与有限预热，分钟不强行拉90天且超范围明确拒绝', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const minute = marketHistoryWindow('1m', '2026-10-12', '2026-10-17', now);
  assert.deepEqual(minute, { start: '2026-10-05', end: '2026-10-20' });
  assert.throws(() => marketHistoryWindow('1m', '2026-08-10', '2026-08-15', now), /至当前实时行情/);
  assert.throws(() => marketHistoryWindow('1m', '2026-01-01', '2026-10-17', now), /范围过大/);
  assert.throws(() => marketHistoryWindow('day', '2026-02-30', '2026-03-05', now), /日期/);
  assert.throws(() => marketHistoryWindow('day', '2026-10-17', '2026-10-12', now), /起点/);
  assert.throws(() => marketHistoryWindow('day', '2027-10-12', '2027-10-17', now), /未来/);
  const quarter = marketHistoryWindow('quarter', '2026-10-12', '2026-10-17', now);
  assert.equal(new Date(quarter.start).getUTCDate(), 1);
  assert.equal(new Date(quarter.start).getUTCMonth() % 3, 0);
  assert.ok(Number(quarter.start.slice(0, 4)) < 2000);
  const annual = marketHistoryWindow('year', '2026-10-12', '2026-10-17', now);
  assert.ok(Number(annual.start.slice(0, 4)) >= 1980);
});

test('分钟安全分块并发有界，5m至多七天；1000上限及48请求上限报错', async () => {
  const calls: string[][] = [];
  let active = 0;
  let maxActive = 0;
  const request = async (args: string[]): Promise<unknown> => {
    calls.push(args);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return [];
  };
  await candleHistory('NVDA.US', '1m', '2026-10-01', '2026-10-12', request);
  assert.equal(calls.length, 6);
  assert.equal(maxActive, 2);
  for (const args of calls) {
    const start = args[args.indexOf('--start') + 1];
    const end = args[args.indexOf('--end') + 1];
    assert.ok((Date.parse(end) - Date.parse(start)) / 86400000 <= 1);
    assert.equal(args[args.indexOf('--session') + 1], 'intraday');
  }
  calls.length = 0;
  await candleHistory('700.HK', '5m', '2026-10-01', '2026-10-14', request);
  assert.equal(calls.length, 2);
  await assert.rejects(candleHistory('NVDA.US', '1m', '2026-01-01', '2026-12-31', request), /48/);
  await assert.rejects(candleHistory('NVDA.US', 'day', '2026-10-01', '2026-10-02', async () => Array.from({ length: 1000 }, () => ({}))), /1000/);
});

test('季度history调用月线、完整拼块后聚合，避免分块首月丢失', async () => {
  const history = marketHistoryWindow('quarter', '2026-10-12', '2026-10-17', Date.parse('2026-10-20T12:00:00Z'));
  const calls: string[][] = [];
  await candleHistory('NVDA.US', 'quarter', history.start, history.end, async (args) => { calls.push(args); return []; });
  assert.ok(calls.length >= 2);
  assert.ok(calls.every((args) => args[args.indexOf('--period') + 1] === 'month'));
  assert.equal(calls[0][calls[0].indexOf('--start') + 1], history.start);
});

// Node v26.8.2/V8 导出前验证全部六个旧 SHA256；fixture 每根一行，保存原始双精度值。
// 来源及可复现导出命令见 helpers/export-legacy-demo-baseline.ts，禁止用 Bun 覆盖旧基准。
// 实测 Bun 1.4.3/JSC 仅 NVDA 三周期各第340索引 high 偏差 5.684341886080802e-14，
// 最大相对误差 2.0436373966669157e-16（0.921 * Number.EPSILON）；其余 OHLC 完全相同。
// 同时限制绝对误差 6e-14 和相对误差 1 * Number.EPSILON，不舍入、不放宽离散字段。
for (const { symbol, period, sha256 } of LEGACY_DEMO_CASES) {
  test(`旧demo ${symbol}/${period} 完整OHLCV、信号及演示成交维持兼容`, () => {
    const baseline = JSON.parse(readFileSync(new URL(
      `./fixtures/legacy-demo/${symbol}-${period}.json`, import.meta.url), 'utf8')) as LegacyDemoBaseline;
    const label = `${symbol}/${period}`;
    assert.equal(baseline.symbol, symbol);
    assert.equal(baseline.period, period);
    assert.equal(baseline.sha256, sha256);
    // 对固定旧基准保留严格哈希，防止用当前运行时重新生成 fixture 掩盖业务回归。
    assert.equal(createHash('sha256').update(JSON.stringify(baseline.candles)).digest('hex'), sha256,
      `${label} fixture 必须仍对应旧完整 OHLCV 哈希`);
    const actual = demoCandles(symbol, period);
    assert.equal(actual.length, baseline.candles.length, `${label} K线数量`);
    assert.deepEqual(actual, demoCandles(symbol, period), `${label} 同runtime逐位确定性`);
    for (const [index, candle] of actual.entries()) {
      const expected = baseline.candles[index];
      assert.deepEqual(Object.keys(candle).sort(), Object.keys(expected).sort(), `${label}[${index}] 字段结构`);
      for (const field of ['time', 'volume', 'confirmed'] as const) {
        assert.equal(candle[field], expected[field], `${label}[${index}].${field} 必须精确相等`);
      }
      for (const field of ['open', 'high', 'low', 'close'] as const) {
        const difference = Math.abs(candle[field] - expected[field]);
        const tolerance = Math.min(6e-14, Number.EPSILON * Math.abs(expected[field]));
        assert.ok(Number.isFinite(candle[field]) && difference <= tolerance,
          `${label}[${index}].${field}: actual=${candle[field]}, expected=${expected[field]}, `
          + `误差=${difference}, 容差=${tolerance}`);
      }
    }
    const signals = signalIdentities(generateSignals(actual, calculateIndicators(actual)));
    assert.ok(baseline.signals.length > 0, `${label} 必须覆盖策略信号`);
    assert.deepEqual(signals, baseline.signals, `${label} 信号数量、身份、方向、时间和决策依据`);
    const executions = executionIdentities(demoMarket(symbol, period,
      LEGACY_EXECUTION_RANGE.start, LEGACY_EXECUTION_RANGE.end).executions);
    assert.ok(baseline.executions.length > 0, `${label} 必须覆盖演示成交`);
    assert.deepEqual(executions, baseline.executions, `${label} 成交笔数、身份、方向、时间和数量`);
  });
}

test('demo全部周期有效确定性，长周期无需200根年度数据', () => {
  for (const period of PERIODS) {
    const candles = demoCandles('NVDA.US', period);
    assert.ok(candles.length > 0, period);
    assert.deepEqual(candles, demoCandles('NVDA.US', period));
    assert.ok(candles.every((candle, index) => candle.high >= Math.max(candle.open, candle.close)
      && candle.low <= Math.min(candle.open, candle.close) && (index === 0 || candle.time > candles[index - 1].time)));
    const market = demoMarket('NVDA.US', period, '2026-10-12', '2026-10-17');
    assert.equal(market.source, 'demo');
  }
  assert.equal(demoCandles('NVDA.US', 'year').length, 26);
  assert.equal(demoCandles('NVDA.US', 'day').length, 440);
  assert.equal(demoCandles('NVDA.US', '1h').length, 640);
  assert.equal(demoCandles('NVDA.US', '15m').length, 640);
});
