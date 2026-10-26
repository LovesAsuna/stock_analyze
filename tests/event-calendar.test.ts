import test from 'node:test';
import assert from 'node:assert/strict';
import { eventDay, monthDays, shiftMonth } from '../src/event-calendar';
import { demoEvents } from '../server/demo-events';

/** 北京时间跨日与当地日期财报必须使用各自展示口径。 */
test('月历日期匹配展示时区，财报不换日', () => {
  const base = demoEvents('global').events[0];
  assert.equal(eventDay({ ...base, scheduledAt: '2026-10-28T18:00:00Z' }), '2026-10-29');
  assert.equal(eventDay({ ...base, scheduledAt: '2026-10-29', dateOnly: true }), '2026-10-29');
  assert.equal(eventDay({ ...base, scheduledAt: null, publishedAt: '2026-10-24T23:00:00Z' }), '2026-10-25');
  assert.equal(eventDay({ ...base, scheduledAt: 'invalid' }), null);
});

/** 周一开头、闰年末日和跨年月份切换不能少一天或错列。 */
test('月历按周一排布并正确处理闰年与跨年', () => {
  const october = monthDays('2026-10');
  assert.deepEqual(october.slice(0, 4), [null, null, null, '2026-10-01']);
  assert.equal(october.filter(Boolean).length, 31);
  assert.equal(october.length % 7, 0);
  assert.ok(monthDays('2024-02').includes('2024-02-29'));
  assert.equal(monthDays('2025-02').filter(Boolean).length, 28);
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
});
