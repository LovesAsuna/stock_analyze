import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePublicNews, parseFedCalendar, parseFecElection } from '../server/public-event-parsers';
import { collectEventSources } from '../server/events';
import { fetchEventText } from '../server/public-events';

/** 生成官方页面结构的精简样本。参数：年份；返回：八场不同会议的HTML，不冒充实时来源。 */
function fedFixture(year = 2026): string {
  return `<h4>${year} FOMC Meetings</h4>` + ['January', 'March', 'April', 'June', 'July', 'September', 'October', 'December'].map(month =>
    `<div class="fomc-meeting__month col-xs-5"><strong>${month}</strong></div><div class="fomc-meeting__date col-xs-4">27-28*</div>`).join('');
}

test('三家公开快讯保持源内ID、来源、原文链接及正确时区，不将新闻当未来日程', () => {
  const sina = parsePublicNews('sina', { result: { status: { code: 0 }, data: { feed: { list: [
    { id: 1, rich_text: '<b>美国选举进展</b><script>bad()</script>', create_time: '2026-11-03 23:00:00', docurl: 'https://finance.sina.cn/news/1' },
  ] } } } });
  assert.equal(sina[0].id, 'news:sina:1'); assert.equal(sina[0].title, '美国选举进展');
  assert.equal(sina[0].publishedAt, '2026-11-03T15:00:00.000Z'); assert.equal(sina[0].scheduledAt, null);
  assert.equal(sina[0].url, 'https://finance.sina.cn/news/1');
  const wall = parsePublicNews('wallstreetcn', { code: 20000, data: { items: [
    { id: 1, title: '美联储新闻', content_text: '会后声明', display_time: 1793718000, uri: 'javascript:alert(1)' },
  ] } });
  assert.equal(wall[0].id, 'news:wallstreetcn:1'); assert.equal(wall[0].publishedAt, '2026-11-03T15:00:00.000Z');
  assert.equal(wall[0].url, 'https://wallstreetcn.com/livenews/1');
  const east = parsePublicNews('eastmoney', { code: '1', data: { fastNewsList: [
    { code: '202611031234', title: '议息进展', summary: '摘要', showTime: '2026-11-03 23:00:00' },
  ] } });
  assert.equal(east[0].source, '东方财富 7×24'); assert.equal(east[0].publishedAt, sina[0].publishedAt);
  assert.equal(east[0].summary, '摘要');
});

test('公开渠道拒绝错误状态、登录受限和结构变化，过滤无效时间及不安全ID', () => {
  assert.throws(() => parsePublicNews('xueqiu', { error_code: '400016', error_description: '重新登录' }), /匿名接口受限/);
  assert.throws(() => parsePublicNews('sina', { result: { status: { code: 1 } } }), /错误状态/);
  assert.throws(() => parsePublicNews('wallstreetcn', { code: 20000, data: {} }), /结构变化/);
  assert.throws(() => parsePublicNews('eastmoney', { code: 0, data: null }), /错误状态/);
  const invalid = [{ id: 1, create_time: '2026-02-30 10:00:00', rich_text: '日期错误' },
    { id: Number.MAX_SAFE_INTEGER + 1, create_time: '2026-11-03 10:00:00', rich_text: 'ID失真' }];
  assert.deepEqual(parsePublicNews('sina', { result: { status: { code: 0 }, data: { feed: { list: invalid } } } }), []);
});

test('FOMC和选举仅保留官方自然日、会议区间及来源，不伪造决议时刻', () => {
  const fed = parseFedCalendar(fedFixture() + fedFixture(2027));
  assert.equal(fed.length, 16); assert.equal(fed[0].scheduledAt, '2026-01-28'); assert.equal(fed[0].dateOnly, true);
  assert.match(fed[0].summary!, /2026-01-27 至 2026-01-28/); assert.match(fed[0].summary!, /经济预测/);
  assert.equal(fed[8].scheduledAt, '2027-01-28');
  const crossMonth = parseFedCalendar(fedFixture().replace(
    '<strong>March</strong></div><div class="fomc-meeting__date col-xs-4">27-28*',
    '<strong>Jan/Feb</strong></div><div class="fomc-meeting__date col-xs-4">31-1*'));
  assert.equal(crossMonth[1].scheduledAt, '2026-02-01'); assert.match(crossMonth[1].summary!, /2026-01-31 至 2026-02-01/);
  assert.throws(() => parseFedCalendar(fedFixture() + '<h4>2027 FOMC Meetings</h4>'), /2027年会议日期不完整/);
  assert.throws(() => parseFedCalendar('<h4>2026 FOMC Meetings</h4>'), /不完整/);
  const election = parseFecElection('<p><b>Tuesday, November 3, 2026</b>, is the next regularly scheduled federal General Election date.</p>');
  assert.equal(election[0].scheduledAt, '2026-11-03'); assert.equal(election[0].dateOnly, true);
  assert.match(election[0].title, /中期选举/); assert.match(election[0].url!, /fec.gov/);
  assert.throws(() => parseFecElection('Tuesday, February 30, 2026, is the next regularly scheduled federal General Election date.'), /日期无效/);
  assert.throws(() => parseFecElection('页面暂不可用'), /未提供/);
});

test('CLI或雪球失败不影响公开新闻和官方日程，不把同题跨渠道合并丢掉来源', async () => {
  const now = Date.parse('2026-11-03T16:00:00Z');
  const election = parseFecElection('Tuesday, November 3, 2026, is the next regularly scheduled federal General Election date.');
  const first = { ...election[0], id: 'news:sina:1', kind: 'news' as const, title: '同题新闻', scheduledAt: null, dateOnly: false, publishedAt: '2026-11-03T15:00:00Z', source: '新浪' };
  const result = await collectEventSources([
    { label: 'CLI', read: async () => { throw new Error('未安装'); } },
    { label: '雪球', read: async () => { throw new Error('受限'); } },
    { label: '新浪', read: async () => [first, first] },
    { label: '见闻', read: async () => [{ ...first, id: 'news:wallstreetcn:1', source: '见闻' }] },
    { label: 'FEC', read: async () => election },
    { label: '空渠道', read: async () => [] },
  ], now, '2026-10-27', '2026-12-03');
  assert.equal(result.events.length, 3); assert.equal(result.events[0].id, election[0].id);
  assert.equal(result.warnings.length, 2); assert.equal(result.sources[0].state, 'error');
  assert.deepEqual(result.sources.at(-1), { label: '空渠道', state: 'ok', count: 0 });
  await assert.rejects(collectEventSources([{ label: '失败', read: async () => { throw new Error('失败'); } }], now, '2026-10-27', '2026-12-03'), /全部读取失败/);
});

test('多渠道限量不让早期来源挤掉其他来源，每源最多30条，总计最多300条', async () => {
  const base = parseFecElection('Tuesday, November 3, 2026, is the next regularly scheduled federal General Election date.')[0];
  const readers = Array.from({ length: 10 }, (_, provider) => ({ label: `渠道${provider}`, read: async () =>
    Array.from({ length: 50 }, (_, index) => ({ ...base, id: `${provider}:${index}` })) }));
  const result = await collectEventSources(readers, Date.parse('2026-11-03T16:00:00Z'), '2026-10-27', '2026-12-03');
  assert.equal(result.events.length, 300); assert.ok(result.sources.every(source => source.count === 30));
});

test('公开读取有大小上限、超时和HTTP检查，不携带Cookie且不跟随登录重定向', async () => {
  const fake = ((url: string, options: RequestInit) => {
    assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    assert.equal(new Headers(options.headers).has('cookie'), false);
    return Promise.resolve(new Response('公开正文'));
  }) as typeof fetch;
  assert.equal(await fetchEventText('https://example.com', fake), '公开正文');
  await assert.rejects(fetchEventText('https://example.com', (async () => new Response('拒绝访问', { status: 403 })) as typeof fetch), /访问受限/);
  await assert.rejects(fetchEventText('https://example.com', (async () => new Response('x', { headers: { 'content-length': String(3 * 1024 * 1024) } })) as typeof fetch), /响应过大/);
  await assert.rejects(fetchEventText('https://example.com', (async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))) as typeof fetch), /响应过大/);
});
