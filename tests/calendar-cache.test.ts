import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarBarWindow } from '../shared/calendar-bars';
import type { Period } from '../shared/types';

/** 缓存必须复用相同市场规则、保留DST并隔离周期与可变返回值；无参数，返回断言。 */
test('日历窗口缓存隔离市场与周期，保留夏令时且不共享可变结果', () => {
  const before = Date.parse('2011-03-11T00:00:00Z') / 1000;
  const after = Date.parse('2011-03-14T00:00:00Z') / 1000;
  const winter = calendarBarWindow(before, 'NVDA.US', 'day');
  const summer = calendarBarWindow(after, 'NVDA.US', 'day');
  assert.equal(new Date(winter.start * 1000).toISOString(), '2011-03-11T14:30:00.000Z');
  assert.equal(new Date(summer.start * 1000).toISOString(), '2011-03-14T13:30:00.000Z');
  assert.equal(new Date(summer.end * 1000).toISOString(), '2011-03-14T20:00:00.000Z');
  const reused = calendarBarWindow(after, 'AAPL.US', 'day');
  assert.deepEqual(reused, summer); assert.notEqual(reused, summer);
  reused.start = 0; reused.end = 0;
  assert.deepEqual(calendarBarWindow(after, 'NVDA.US', 'day'), summer);
  assert.equal(new Date(calendarBarWindow(after, '700.HK', 'day').start * 1000).toISOString(), '2011-03-14T01:30:00.000Z');
  assert.equal(new Date(calendarBarWindow(after, 'NVDA.US', 'week').end * 1000).toISOString(), '2011-03-18T20:00:00.000Z');
  assert.throws(() => calendarBarWindow(NaN, 'NVDA.US', 'day'));
  assert.throws(() => calendarBarWindow(after, '', 'day'));
  assert.throws(() => calendarBarWindow(after, 'NVDA.US', '1m'));
  assert.throws(() => calendarBarWindow(after, 'NVDA.US', { toString: () => 'day' } as unknown as Period));
});

/** 重复历史窗口不再换算时区，超过容量后旧项重新计算；无参数，返回缓存命中和淘汰断言。 */
test('日历窗口命中跳过时区换算，并按容量淘汰旧项', () => {
  const original = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0;
  Intl.DateTimeFormat.prototype.formatToParts = function (date) { calls++; return original.call(this, date); };
  try {
    const first = Date.parse('2050-02-07T00:00:00Z') / 1000;
    const expected = calendarBarWindow(first, 'NVDA.US', 'day');
    const initialCalls = calls; assert.ok(initialCalls > 0);
    assert.deepEqual(calendarBarWindow(first, 'AAPL.US', 'day'), expected);
    assert.equal(calls, initialCalls);
    for (let index = 1; index <= 4096; index++) calendarBarWindow(first + index * 86400, 'NVDA.US', 'day');
    const afterEviction = calls;
    assert.deepEqual(calendarBarWindow(first, 'NVDA.US', 'day'), expected);
    assert.ok(calls > afterEviction);
  } finally { Intl.DateTimeFormat.prototype.formatToParts = original; }
});
