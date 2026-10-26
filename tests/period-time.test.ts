import test from 'node:test';
import assert from 'node:assert/strict';
import { PERIODS, PERIOD_LABELS, isPeriod, periodSeconds, isCalendarPeriod } from '../shared/periods';
import { barOpenTime, buildReview, inChinaRange, signalConfirmationTime } from '../shared/review';
import type { Candle, Execution, Period, Signal } from '../shared/types';

/**
 * 将明确时区的测试日期转换为 UTC 秒。
 * @param iso 带时区 ISO 日期。
 * @returns UTC Unix 秒。
 */
function seconds(iso: string): number { return Date.parse(iso) / 1000; }

/**
 * 创建长周期边界匹配测试所需的已确认行情。
 * @param dates 日期标签列表。
 * @returns 价格固定且时间严格递增的行情。
 */
function bars(dates: string[]): Candle[] {
  return dates.map((date) => ({ time: seconds(`${date}T00:00:00Z`), open: 100,
    high: 102, low: 99, close: 101, volume: 1000, confirmed: true }));
}

/**
 * 创建第一根行情上的已确认信号，参考字段不参与确认时间推断。
 * @param candles 信号对应行情。
 * @returns 索引为零的买入信号。
 */
function signal(candles: Candle[]): Signal {
  return { id: 'signal', time: candles[0].time, index: 0, side: 'buy', title: '时间测试',
    reasons: [], close: 101, confirmed: true, eligibleTime: null, referencePrice: null, nextFiveReturn: null };
}

/**
 * 创建一笔与测试证券一致的合成成交。
 * @param iso 带明确时区的成交时间。
 * @param symbol 测试证券代码。
 * @returns 唯一标识为时间的买入成交。
 */
function fill(iso: string, symbol = 'TEST.HK'): Execution {
  return { id: iso, symbol, side: 'buy', time: seconds(iso), price: 100, quantity: 1 };
}

test('周期导出契约只包含十种常规 K 线，未知输入不能混入分时视图', () => {
  assert.deepEqual(PERIODS, ['1m', '5m', '15m', '30m', '1h', 'day', 'week', 'month', 'quarter', 'year']);
  assert.deepEqual(Object.keys(PERIOD_LABELS), PERIODS);
  for (const period of PERIODS) {
    assert.equal(isPeriod(period), true);
    assert.ok(PERIOD_LABELS[period].length > 0);
    assert.equal(isCalendarPeriod(period), ['day', 'week', 'month', 'quarter', 'year'].includes(period));
  }
  for (const value of [null, undefined, 1, {}, [], new String('day'), 'DAY', '60m', 'intraday', '5day', '分时', '5日', '__proto__', 'toString']) {
    assert.equal(isPeriod(value), false);
    assert.throws(() => periodSeconds(value as Period), /不支持/);
    assert.throws(() => isCalendarPeriod(value as Period), /不支持/);
  }
  assert.deepEqual(PERIODS.map(periodSeconds), [60, 300, 900, 1800, 3600, null, null, null, null, null]);
});

test('所有日内周期正常累加，港股午休和港美股日尾按实际时段截断', () => {
  const durations: [Period, number][] = [['1m', 60], ['5m', 300], ['15m', 900], ['30m', 1800], ['1h', 3600]];
  for (const [period, duration] of durations) {
    const start = seconds('2024-03-11T09:30:00+08:00');
    assert.equal(barOpenTime(start, 'HK', period), start);
    assert.equal(signalConfirmationTime(start, 'HK', period), start + duration);
    assert.equal(signalConfirmationTime(seconds('2024-03-11T11:59:45+08:00'), 'HK', period),
      seconds('2024-03-11T12:00:00+08:00'));
    assert.equal(signalConfirmationTime(seconds('2024-03-11T15:59:45+08:00'), 'HK', period),
      seconds('2024-03-11T16:00:00+08:00'));
    assert.equal(signalConfirmationTime(seconds('2024-03-11T19:59:45Z'), 'US', period),
      seconds('2024-03-11T20:00:00Z'));
  }
  assert.equal(signalConfirmationTime(seconds('2024-03-11T11:30:00+08:00'), 'HK', '1h'),
    seconds('2024-03-11T12:00:00+08:00'));
  assert.equal(signalConfirmationTime(seconds('2024-03-11T13:00:00+08:00'), 'HK', '1h'),
    seconds('2024-03-11T14:00:00+08:00'));
  assert.equal(signalConfirmationTime(seconds('2024-03-11T15:30:00+08:00'), 'HK', '1h'),
    seconds('2024-03-11T16:00:00+08:00'));
  // 保留原有非正常交易时段标签的加秒行为，不将任意时间倒退至过去收盘。
  const late = seconds('2024-03-08T23:30:00+08:00');
  assert.equal(signalConfirmationTime(late, 'HK', '1h'), late + 3600);
});

test('美股日内尾柱在 DST 切换前后都在当地 16:00 确认', () => {
  for (const [date, close] of [['2024-03-08', '21'], ['2024-03-11', '20'], ['2024-11-01', '20'], ['2024-11-04', '21']]) {
    const end = seconds(`${date}T${close}:00:00Z`);
    assert.equal(signalConfirmationTime(end - 1800, 'TEST.US', '1h'), end);
  }
});

test('周月季年按周期内首末工作日，UTC 与交易所午夜标签一致', () => {
  const cases: [Period, string, string, string][] = [
    ['week', '2024-12-31', '2024-12-30', '2025-01-03'],
    ['week', '2024-03-10', '2024-03-04', '2024-03-08'],
    ['month', '2024-06-01', '2024-06-03', '2024-06-28'],
    ['month', '2024-02-01', '2024-02-01', '2024-02-29'],
    ['quarter', '2024-04-15', '2024-04-01', '2024-06-28'],
    ['quarter', '2024-12-31', '2024-10-01', '2024-12-31'],
    ['year', '2023-08-01', '2023-01-02', '2023-12-29'],
    ['year', '2024-01-01', '2024-01-01', '2024-12-31'],
  ];
  for (const [period, label, first, last] of cases) {
    for (const suffix of ['Z', '+08:00']) {
      const time = seconds(`${label}T00:00:00${suffix}`);
      assert.equal(barOpenTime(time, 'HK', period), seconds(`${first}T09:30:00+08:00`));
      assert.equal(signalConfirmationTime(time, 'HK', period), seconds(`${last}T16:00:00+08:00`));
    }
  }
});

test('美股长周期端点独立计算 DST，不使用固定秒数，非午夜按交易所日期', () => {
  const cases: [Period, string, string, string][] = [
    ['month', '2024-03-01', '2024-03-01T14:30:00Z', '2024-03-29T20:00:00Z'],
    ['month', '2024-11-01', '2024-11-01T13:30:00Z', '2024-11-29T21:00:00Z'],
    ['quarter', '2024-01-01', '2024-01-01T14:30:00Z', '2024-03-29T20:00:00Z'],
    ['quarter', '2024-10-01', '2024-10-01T13:30:00Z', '2024-12-31T21:00:00Z'],
    ['week', '2024-03-11', '2024-03-11T13:30:00Z', '2024-03-15T20:00:00Z'],
    ['week', '2024-11-04', '2024-11-04T14:30:00Z', '2024-11-08T21:00:00Z'],
    ['year', '2024-01-01', '2024-01-01T14:30:00Z', '2024-12-31T21:00:00Z'],
  ];
  for (const [period, label, start, end] of cases) {
    for (const hour of ['00', label === '2024-11-01' || label === '2024-10-01' ? '04' : '05']) {
      const time = seconds(`${label}T${hour}:00:00Z`);
      assert.equal(barOpenTime(time, 'US', period), seconds(start));
      assert.equal(signalConfirmationTime(time, 'US', period), seconds(end));
    }
  }
  // UTC 已进入四月，但纽约仍在三月，必须使用纽约所属月。
  assert.equal(signalConfirmationTime(seconds('2024-04-01T02:00:00Z'), 'US', 'month'), seconds('2024-03-29T20:00:00Z'));
});

test('没有假日日历时保守保持末个工作日 16:00，不因休市或缺柱提前确认', () => {
  // 2024-03-29 美股休市；无日历仍保守等到该工作日的常规收盘，不能倒推到周四。
  const time = seconds('2024-03-01T00:00:00Z');
  const end = signalConfirmationTime(time, 'US', 'month');
  assert.equal(end, seconds('2024-03-29T20:00:00Z'));
  assert.equal(inChinaRange(end, '2024-03-28T00:00:00Z', '2024-03-29T19:59:59Z'), false);
  assert.ok(signalConfirmationTime(seconds('2099-01-01T00:00:00Z'), 'HK', 'year') > seconds('2099-12-30T16:00:00+08:00'));
});

test('长周期 review 匹配下一周期内成交，排除同柱、夜间、周末、港股午休及收盘', () => {
  const cases: [Period, string[], string, string, string][] = [
    ['week', ['2024-03-04', '2024-03-11'], '2024-03-08', '2024-03-11', '2024-03-15'],
    ['month', ['2024-02-01', '2024-03-01'], '2024-02-29', '2024-03-01', '2024-03-29'],
    ['quarter', ['2024-01-01', '2024-04-01'], '2024-03-29', '2024-04-01', '2024-06-28'],
    ['year', ['2023-01-01', '2024-01-01'], '2023-12-29', '2024-01-01', '2024-12-31'],
  ];
  for (const [period, dates, previousEnd, nextStart, nextEnd] of cases) {
    const candles = bars(dates);
    const invalid = [fill(`${previousEnd}T15:59:59+08:00`), fill(`${nextStart}T09:29:59+08:00`),
      fill(`${nextStart}T12:15:00+08:00`), fill(`${nextStart}T17:00:00+08:00`),
      fill(`${nextEnd}T16:00:00+08:00`)];
    // 下一周期中的首个周末，不允许被长周期的连续 UTC 区间吞入。
    const start = new Date(seconds(`${nextStart}T00:00:00Z`) * 1000);
    start.setUTCDate(start.getUTCDate() + (6 - start.getUTCDay() + 7) % 7);
    invalid.push(fill(`${start.toISOString().slice(0, 10)}T10:00:00+08:00`));
    assert.equal(buildReview([signal(candles)], invalid, candles, true, 'TEST.HK', period)[0].state, 'unmatched');
    const valid = fill(`${nextStart}T13:00:00+08:00`);
    assert.equal(buildReview([signal(candles)], [...invalid, valid], candles, true, 'TEST.HK', period)[0].execution?.id, valid.id);
    const last = fill(`${nextEnd}T15:59:59+08:00`);
    assert.equal(buildReview([signal(candles)], [last], candles, true, 'TEST.HK', period)[0].state, 'matched');
  }
});

test('长周期成交查询须覆盖完整下一柱，部分覆盖和未确认状态保留', () => {
  const candles = bars(['2024-02-01', '2024-03-01']);
  const range = { start: '2024-03-01T09:30:00+08:00', end: '2024-03-29T16:00:00+08:00' };
  assert.equal(buildReview([signal(candles)], [], candles, true, 'TEST.HK', 'month', range)[0].state, 'unmatched');
  for (const partial of [{ ...range, start: '2024-03-01T09:30:01+08:00' },
    { ...range, end: '2024-03-29T15:59:59+08:00' }]) {
    assert.equal(buildReview([signal(candles)], [], candles, true, 'TEST.HK', 'month', partial)[0].state, 'unknown');
  }
  candles[1].confirmed = false;
  assert.equal(buildReview([signal(candles)], [], candles, true, 'TEST.HK', 'month', range)[0].state, 'pending');
  candles[0].confirmed = false;
  assert.equal(buildReview([{ ...signal(candles), confirmed: false }], [], candles, true, 'TEST.HK', 'month')[0].state, 'pending');
});

test('长周期缺柱不扩大成交窗口，未来下一柱不能回填早期成交', () => {
  const candles = bars(['2024-01-01', '2024-04-01', '2024-05-01']);
  const invalid = fill('2024-03-01T10:00:00+08:00');
  assert.equal(buildReview([signal(candles)], [invalid], candles, true, 'TEST.HK', 'month')[0].execution, null);
  const valid = fill('2024-04-30T15:59:59+08:00');
  assert.equal(buildReview([signal(candles)], [invalid, valid], candles, true, 'TEST.HK', 'month')[0].execution?.id, valid.id);
});

test('新增分钟周期 review 窗口包含开盘不包含收盘，尾柱不跨过港股午休', () => {
  for (const period of ['1m', '5m', '30m'] as const) {
    const duration = periodSeconds(period)!;
    const time = seconds('2024-03-11T09:30:00+08:00');
    const candles = bars(['2024-03-11', '2024-03-12']).map((candle, index) => ({ ...candle, time: time + index * duration }));
    const atOpen = fill(new Date((time + duration) * 1000).toISOString());
    const atClose = fill(new Date((time + 2 * duration) * 1000).toISOString());
    assert.equal(buildReview([signal(candles)], [atOpen], candles, true, 'TEST.HK', period)[0].state, 'matched');
    assert.equal(buildReview([signal(candles)], [atClose], candles, true, 'TEST.HK', period)[0].state, 'unmatched');
  }
  const candles = bars(['2024-03-11', '2024-03-12']).map((candle, index) => ({ ...candle,
    time: seconds(`2024-03-11T${index === 0 ? '10:30' : '11:30'}:00+08:00`) }));
  assert.equal(buildReview([signal(candles)], [fill('2024-03-11T12:10:00+08:00')], candles, true, 'TEST.HK', '1h')[0].state, 'unmatched');
});

test('美股跨 DST 月线匹配保留每个交易日当地时段，排除 UTC 固定开盘和周末', () => {
  const candles = bars(['2024-02-01', '2024-03-01']);
  const invalid = [fill('2024-03-01T14:29:59Z', 'TEST.US'),
    fill('2024-03-10T14:30:00Z', 'TEST.US'), fill('2024-03-11T13:29:59Z', 'TEST.US'),
    fill('2024-03-11T20:00:00Z', 'TEST.US'), fill('2024-03-29T20:00:00Z', 'TEST.US')];
  const run = (executions: Execution[]) => buildReview([signal(candles)], executions, candles, true, 'TEST.US', 'month')[0];
  assert.equal(run(invalid).state, 'unmatched');
  const winter = fill('2024-03-01T14:30:00Z', 'TEST.US');
  assert.equal(run([...invalid, winter]).execution?.id, winter.id);
  const summer = fill('2024-03-11T13:30:00Z', 'TEST.US');
  assert.equal(run([...invalid, summer]).execution?.id, summer.id);
});

test('追加未来长周期行情不改变已有周期确认或匹配，输入对象不被修改', () => {
  const candles = bars(['2024-02-01', '2024-03-01']);
  const signals = [signal(candles)];
  const executions = [fill('2024-03-11T10:00:00+08:00')];
  const snapshot = JSON.stringify({ candles, signals, executions });
  const result = buildReview(signals, executions, candles, true, 'TEST.HK', 'month');
  assert.deepEqual(buildReview(signals, executions, [...candles, ...bars(['2099-01-01'])], true, 'TEST.HK', 'month'), result);
  assert.equal(JSON.stringify({ candles, signals, executions }), snapshot);
});

test('时间函数边界校验拒绝非法周期、时间及空证券代码', () => {
  for (const period of ['5day', 'intraday', 'toString', undefined] as unknown as Period[]) {
    assert.throws(() => barOpenTime(0, 'HK', period), /不支持/);
    assert.throws(() => signalConfirmationTime(0, 'HK', period), /不支持/);
    assert.throws(() => buildReview([], [], [], true, 'HK', period === undefined ? 'bad' as Period : period), /不支持/);
  }
  for (const period of PERIODS) {
    assert.throws(() => barOpenTime(NaN, 'HK', period), /Unix 秒/);
    assert.throws(() => signalConfirmationTime(Infinity, 'HK', period), /Unix 秒/);
    assert.throws(() => barOpenTime(0, '', period), /证券代码/);
    assert.throws(() => signalConfirmationTime(0, '', period), /证券代码/);
  }
});
