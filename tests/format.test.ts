import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { formatNumber, formatTime } from '../src/format';
import { barOpenTime } from '../shared/review';
import { isCalendarPeriod, PERIODS } from '../shared/periods';

describe('显示格式规则复用', () => {
  /** 对照原地区格式；无参数，返回测试断言，空值、舍入和异常语义保持一致。 */
  test('数值在不同精度下保持舍入、千分位和缺失值语义', () => {
    for (const digits of [0, 1, 2, 3, 6]) {
      for (const value of [0, -0, 1234567.8912345, -123.4567, 1.005, 0.000001]) {
        assert.equal(formatNumber(value, digits), value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
      }
    }
    for (const value of [null, undefined, NaN, Infinity, -Infinity]) assert.equal(formatNumber(value), '—');
    assert.throws(() => formatNumber(1, -1), RangeError);
  });

  /** 对照港美股、北京时间与夏令时切换；无参数，返回所有周期的格式一致性断言。 */
  test('时区、周期和夏令时不能因共用格式器相互污染', () => {
    for (const symbol of ['NVDA.US', '700.HK']) {
      for (const period of PERIODS) {
        for (const china of [false, true]) {
          for (const iso of ['2026-03-06T15:30:00Z', '2026-03-09T13:30:00Z', '2026-11-02T15:30:00Z']) {
            const time = Date.parse(iso) / 1000; const calendar = isCalendarPeriod(period);
            const expected = new Intl.DateTimeFormat('zh-CN', {
              timeZone: china ? 'Asia/Shanghai' : symbol.endsWith('.HK') ? 'Asia/Hong_Kong' : 'America/New_York',
              ...(calendar && period !== 'day' ? { year: 'numeric' as const } : {}), month: '2-digit', day: '2-digit',
              ...(calendar && !china ? {} : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const }),
            }).format(new Date((calendar && !china ? barOpenTime(time, symbol, period) : time) * 1000));
            assert.equal(formatTime(time, symbol, period, china), expected);
          }
        }
      }
    }
    assert.throws(() => formatTime(NaN, 'NVDA.US', 'day'));
  });
});
