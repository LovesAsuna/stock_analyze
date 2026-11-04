import { eventLink, type MarketEvent } from '../shared/events.js';
import { object, text, dateLabel, isoTime, originalId } from './event-values.js';

export type PublicProvider = 'sina' | 'wallstreetcn' | 'eastmoney' | 'xueqiu' | 'fed' | 'fec';
export const PUBLIC_EVENT_URLS: Record<PublicProvider, string> = {
  sina: 'https://zhibo.sina.com.cn/api/zhibo/feed?zhibo_id=152&page=1&page_size=30',
  wallstreetcn: 'https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=30',
  eastmoney: 'https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=30&req_trace=market-lens',
  xueqiu: 'https://xueqiu.com/statuses/livenews/list.json?since_id=-1&max_id=-1&count=30',
  fed: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  fec: 'https://www.fec.gov/introduction-campaign-finance/election-results-and-voting-information/',
};
export const PUBLIC_EVENT_LABELS: Record<PublicProvider, string> = {
  sina: '新浪财经 7×24', wallstreetcn: '华尔街见闻 7×24', eastmoney: '东方财富 7×24',
  xueqiu: '雪球快讯', fed: '美联储 FOMC 官方日程', fec: '美国 FEC 官方选举日期',
};

/** 移除上游HTML，仅保留文本，不执行脚本。参数：未知文本；返回：最多4000字的纯文本。 */
export function plain(value: unknown): string {
  return (text(value) ?? '').slice(0, 24_000).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39);/g, entity =>
      ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" })[entity] ?? ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 4000);
}

/** 明确北京时间的两家快讯时间转换。参数：上游本地时间；返回：带时区ISO或null，不猜测其他格式。 */
export function chinaTime(value: unknown): string | null {
  const local = text(value);
  return local && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(local) ? isoTime(`${local.replace(' ', 'T')}+08:00`) : null;
}

/** 校验公开JSON协议及列表形状，错误和验证码不能伪装成空新闻。参数：来源及响应；返回：原始记录列表。 */
function newsRows(provider: PublicProvider, value: unknown): unknown[] {
  const root = object(value); const data = object(root.data);
  let list: unknown;
  if (provider === 'sina') {
    const result = object(root.result);
    if (object(result.status).code !== 0) throw new Error('新浪快讯返回错误状态。');
    list = object(object(result.data).feed).list;
  } else if (provider === 'wallstreetcn') {
    if (root.code !== 20000) throw new Error('华尔街见闻快讯返回错误状态。');
    list = data.items;
  } else if (provider === 'eastmoney') {
    if (String(root.code) !== '1') throw new Error('东方财富快讯返回错误状态。');
    list = data.fastNewsList;
  } else {
    if (root.error_code || root.error_description) throw new Error('雪球匿名接口受限，需要站点会话；当前未接入登录凭据。');
    list = root.items;
  }
  if (!Array.isArray(list)) throw new Error('公开快讯响应结构变化，未返回有效列表。');
  return list.slice(0, 100);
}

/** 将四家公开快讯映射为新闻，绝不从标题推导未来日程。参数：来源、JSON；返回：带源内ID与真实发布时间的事件。 */
export function parsePublicNews(provider: PublicProvider, value: unknown): MarketEvent[] {
  const result: MarketEvent[] = [];
  for (const record of newsRows(provider, value)) {
    const row = object(record);
    const id = originalId(provider === 'eastmoney' ? row.code : row.id);
    const content = plain(row.content_text ?? row.rich_text ?? row.text ?? row.summary ?? row.content);
    const title = plain(row.title) || content.slice(0, 140);
    const publishedAt = provider === 'sina' ? chinaTime(row.create_time) : provider === 'eastmoney' ? chinaTime(row.showTime)
      : provider === 'wallstreetcn' ? isoTime(row.display_time)
      : typeof row.created_at === 'number' ? isoTime(row.created_at / 1000) : null;
    if (!id || !title || !publishedAt) continue;
    const safeId = encodeURIComponent(id);
    const fallback = provider === 'sina' ? 'https://finance.sina.com.cn/7x24/'
      : provider === 'wallstreetcn' ? `https://wallstreetcn.com/livenews/${safeId}`
      : provider === 'eastmoney' ? `https://finance.eastmoney.com/a/${safeId}.html` : 'https://xueqiu.com/livenews';
    result.push({ id: `news:${provider}:${id}`, kind: 'news', title, summary: content && content !== title ? content : null,
      source: PUBLIC_EVENT_LABELS[provider], url: eventLink(row.docurl ?? row.uri ?? row.url) ?? fallback,
      publishedAt, scheduledAt: null, dateOnly: false, symbol: null });
  }
  return result;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 解析英文官方日期。参数：年份、月份名、日；返回：校验后的自然日，不设置虚构的会议时刻。 */
function officialDate(year: string, month: string, day: string): string | null {
  const index = MONTHS.findIndex(name => name.toLowerCase() === month.toLowerCase()
    || (month.length === 3 && name.slice(0, 3).toLowerCase() === month.toLowerCase()));
  return index < 0 ? null : dateLabel(`${year}-${String(index + 1).padStart(2, '0')}-${day.padStart(2, '0')}`);
}

/** 解析美联储原始HTML中的年份和会议区间。参数：官方页面；返回：按会议结束日归属的日期事件，起止日保留在摘要。 */
export function parseFedCalendar(html: string): MarketEvent[] {
  const headings = [...html.matchAll(/(\d{4}) FOMC Meetings/g)];
  const events: MarketEvent[] = [];
  for (const [index, heading] of headings.entries()) {
    const section = html.slice(heading.index, headings[index + 1]?.index ?? html.length);
    const meetings = [...section.matchAll(/class="[^"]*fomc-meeting__month[^\"]*"[^>]*>([\s\S]*?)<\/div>\s*<div\b[^>]*class="[^"]*fomc-meeting__date[^\"]*"[^>]*>([\s\S]*?)<\/div>/g)];
    const before = events.length;
    for (const meeting of meetings) {
      const months = plain(meeting[1]).split('/'); const dates = plain(meeting[2]);
      const days = dates.match(/^(\d{1,2})(?:-(\d{1,2}))?(\*)?$/);
      // shortcut: 仅纳入常规会议；notation vote等非标准条目需另行适配，不猜测其会议性质。
      if (!days || months.length > 2) continue;
      const start = officialDate(heading[1], months[0], days[1]);
      const end = officialDate(heading[1], months.at(-1)!, days[2] ?? days[1]);
      if (!start || !end || start > end) continue;
      events.push({ id: `macro:fed:${end}`, title: '美联储 FOMC 议息会议', kind: 'macro', source: PUBLIC_EVENT_LABELS.fed,
        url: PUBLIC_EVENT_URLS.fed, publishedAt: null, scheduledAt: end, dateOnly: true, symbol: null,
        summary: `美国当地会议日期：${start} 至 ${end}，按结束日列入日历；官方本页未提供决议发布时刻。${days[3] ? '含经济预测摘要。' : ''}日期可能调整，以官方更新为准。` });
    }
    if (events.length - before < 8) throw new Error(`FOMC官方${heading[1]}年会议日期不完整。`);
  }
  if (!events.length) throw new Error('FOMC官方日程结构变化或会议日期不完整。');
  return events;
}

/** 只读取FEC明确公布的选举日期，不推算投票关闭或结果时间。参数：官方页面；返回：日期粒度的联邦选举日程。 */
export function parseFecElection(html: string): MarketEvent[] {
  // FEC页面可能长于正文截断上限，因此只截取目标句附近再清理。
  const match = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s*,?\s*is the next regularly scheduled federal General Election date/i);
  if (!match) throw new Error('FEC官方页面未提供可识别的联邦选举日期。');
  const date = officialDate(match[3], match[1], match[2]);
  if (!date) throw new Error('FEC官方选举日期无效。');
  return [{ id: `macro:fec:${date}`, title: Number(match[3]) % 4 === 2 ? '美国中期选举（联邦大选日）' : '美国联邦大选日',
    kind: 'macro', source: PUBLIC_EVENT_LABELS.fec, url: PUBLIC_EVENT_URLS.fec, publishedAt: null, scheduledAt: date, dateOnly: true,
    summary: '美国当地日期；各州投票时间不同，此日期不代表统一的投票截止或结果公布时刻。', symbol: null }];
}
