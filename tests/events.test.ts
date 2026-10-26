import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNews, normalizeCalendar, selectEvents } from '../server/events';
import { eventLink } from '../shared/events';

/** 新闻三种发布时间字段、公告附件与字符串大整数ID保持原意。 */
test('事件新闻与公告解析保留真实ID、发布时间和安全附件', () => {
  for (const field of ['published_at', 'publish_at', 'time']) {
    const [event] = normalizeNews([{ id: '9223372036854775807', title: '公开新闻', [field]: '2026-10-24T08:00:00+08:00', source_name: '媒体', excerpt: '摘要', url: 'https://example.com/news' }], 'news', 'NVDA.US');
    assert.equal(event.id, 'news:9223372036854775807');
    assert.equal(event.publishedAt, '2026-10-24T00:00:00.000Z');
    assert.equal(event.scheduledAt, null);
    assert.equal(event.symbol, 'NVDA.US');
    assert.equal(event.source, '媒体');
  }
  const [filing] = normalizeNews([{ id: 'filing-1', title: '季度公告', publish_at: '2026-10-23T10:00:00Z', file_urls: ['javascript:alert(1)', 'https://example.com/report.xml'] }], 'filing');
  assert.equal(filing.url, 'https://example.com/report.xml');
  assert.equal(filing.source, 'Longbridge');
});

/** 空值、无时区、溢出日期及不安全数值ID不能生成貌似有效的事件。 */
test('事件解析拒绝非法时间和危险链接', () => {
  for (const time of [null, '', false, 0, '2026-02-30T00:00:00Z', '2026-10-24T25:00:00Z', '2026-10-24T00:00:00', '2026-10-24']) {
    assert.deepEqual(normalizeNews([{ id: '1', title: '新闻', time }], 'news'), []);
  }
  assert.deepEqual(normalizeNews([{ id: Number.MAX_SAFE_INTEGER + 1, title: '新闻', time: '2026-10-24T00:00:00Z' }], 'news'), []);
  for (const link of ['javascript:alert(1)', 'data:text/html,hello', 'file:///C:/secret', 'https://name:password@example.com', '', null]) assert.equal(eventLink(link), null);
  assert.throws(() => normalizeNews([], 'macro'), /仅支持/);
  assert.throws(() => normalizeCalendar([], 'news'), /仅支持/);
});

/** 宏观日历展平infos并过滤低星条目；Unix秒不能误当毫秒。 */
test('宏观日历只保留有效三星事件并转换秒级时间', () => {
  const datetime = String(Date.parse('2026-10-28T18:00:00Z') / 1000);
  const events = normalizeCalendar({ list: [{ infos: [
    { id: 'large-id', content: '利率决议', star: '3', datetime, ext: { period: '十月', unit: '%' }, data_kv: [{ key: '预期', value: '4.5' }] },
    { id: 'low', content: '次要数据', star: 2, datetime },
    { id: 'missing', content: '未知级别', datetime },
    { id: 'empty', content: '缺少时间', star: 3, datetime: '' },
  ] }] }, 'macro');
  assert.equal(events.length, 1);
  assert.equal(events[0].scheduledAt, '2026-10-28T18:00:00.000Z');
  assert.equal(events[0].dateOnly, false);
  assert.match(events[0].summary!, /预期：4.5/);
});

/** 财报日期不能跨时区换日或把上游日历占位秒数显示成准确披露时刻。 */
test('财报保留当地日期和盘后信息，隔离其他证券', () => {
  const events = normalizeCalendar({ list: [{ infos: [
    { id: 'report', symbol: 'NVDA.US', content: '季度财报', datetime: '1793232000', date_type: '盘后', ext: { local_date: '2026-10-29', date_zone: '美东', financial_report: { market_time: 'after' } } },
    { id: 'other', symbol: 'AAPL.US', content: '其他证券', ext: { local_date: '2026-10-29' } },
    { id: 'placeholder', symbol: 'NVDA.US', content: '仅有占位时间', datetime: '1793232000' },
  ] }] }, 'earnings', 'NVDA.US');
  assert.equal(events.length, 1);
  assert.equal(events[0].scheduledAt, '2026-10-29');
  assert.equal(events[0].dateOnly, true);
  assert.match(events[0].summary!, /美东；盘后/);
});

/** 新闻按最近七天到当前时刻过滤，日历含窗口首尾；去重与数量控制在服务端执行。 */
test('事件本地过滤日期边界、去重并限制单源数量', () => {
  const now = Date.parse('2026-10-24T06:00:00Z');
  const news = normalizeNews(['2026-10-17T05:59:59Z', '2026-10-17T06:00:00Z', '2026-10-24T06:00:00Z', '2026-10-24T06:00:01Z'].map((time, index) => ({ id: String(index), title: '新闻', time })), 'news');
  assert.deepEqual(selectEvents([...news, news[1]], now, '2026-10-17', '2026-11-23').map(event => event.id), ['news:2', 'news:1']);
  const calendar = normalizeCalendar({ list: [{ infos: ['2026-10-16', '2026-10-17', '2026-11-23', '2026-11-24'].map((date, index) => ({ id: String(index), symbol: 'NVDA.US', content: '财报', ext: { local_date: date } })) }] }, 'earnings', 'NVDA.US');
  assert.deepEqual(selectEvents(calendar, now, '2026-10-17', '2026-11-23').map(event => event.id), ['earnings:1', 'earnings:2']);
  const many = Array.from({ length: 45 }, (_, index) => ({ ...news[2], id: `news:${index}` }));
  assert.equal(selectEvents(many, now, '2026-10-17', '2026-11-23').length, 30);
});
