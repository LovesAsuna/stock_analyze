import { eventLink } from '../shared/events.js';
import type { EventData, EventKind, EventScope, MarketEvent } from '../shared/events.js';
import { cli, normalizeSymbol, rows } from './longbridge.js';

type Row = Record<string, unknown>;
type EventSource = { label: string; args: string[]; kind: EventKind; calendar: boolean };
const DAY_MS = 86_400_000;
const SOURCE_LIMIT = 30;
const TOTAL_LIMIT = 120;

/** 安全读取对象。参数：未知上游值；返回：字段对象，非对象返回空对象。 */
function object(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

/** 提取非空文本。参数：未知字段；返回：去除首尾空白的文本或 null。 */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** 校验自然日。参数：未知日期；返回：真实 YYYY-MM-DD 日期或 null，拒绝日期自动进位。 */
function dateLabel(value: unknown): string | null {
  const label = text(value);
  if (!label || !/^\d{4}-\d{2}-\d{2}$/.test(label)) return null;
  const milliseconds = Date.parse(`${label}T00:00:00Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === label ? label : null;
}

/** 严格解析时间。参数：带时区 ISO 或正 Unix 秒；返回：有效 ISO，拒绝空值、布尔值和无时区文本。 */
function isoTime(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  let milliseconds: number;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    milliseconds = Number(raw) * 1000;
    if (milliseconds <= 0) return null;
  } else {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)
      || !dateLabel(raw.slice(0, 10)) || Number(raw.slice(11, 13)) > 23
      || Number(raw.slice(14, 16)) > 59 || Number(raw.slice(17, 19)) > 59) return null;
    milliseconds = Date.parse(raw);
  }
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1970 && date.getUTCFullYear() <= 9999
    ? date.toISOString() : null;
}

/** 提取稳定原 ID。参数：上游 ID；返回：非空字符串或 null，禁止生成与标题相关的伪 ID。 */
function originalId(value: unknown): string | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : text(value);
}

/** 规范化新闻及公告。参数：响应、news/filing 类型及可选证券；返回：有真实 ID、标题和发布时间的事件。 */
export function normalizeNews(value: unknown, kind: EventKind, symbol?: string): MarketEvent[] {
  if (kind !== 'news' && kind !== 'filing') throw new Error('新闻规范化仅支持 news 或 filing。');
  const security = symbol === undefined ? null : normalizeSymbol(symbol);
  return rows(value, ['news', 'filings']).flatMap((record): MarketEvent[] => {
    const id = originalId(record.id);
    const title = text(record.title);
    const publishedAt = isoTime(record.published_at ?? record.publish_at ?? record.time);
    if (!id || !title || !publishedAt) return [];
    const fileUrls = Array.isArray(record.file_urls) ? record.file_urls : [];
    const url = eventLink(record.url) ?? fileUrls.map(eventLink).find((link) => link !== null) ?? null;
    return [{ id: `${kind}:${id}`, title, kind, source: text(record.source_name) ?? 'Longbridge', url,
      publishedAt, scheduledAt: null, dateOnly: false,
      summary: text(record.excerpt) ?? text(record.description), symbol: security }];
  });
}

/** 保留上游披露信息。参数：日历记录及类型；返回：市场时区、盘前盘后、指标值组成的摘要或 null。 */
function calendarSummary(record: Row, kind: EventKind): string | null {
  const ext = object(record.ext);
  const report = object(ext.financial_report);
  const parts = kind === 'earnings'
    ? [text(ext.date_zone), text(record.date_type), text(record.financial_market_time), text(report.market_time)]
    : [text(ext.period), text(ext.unit), `重要性：${Number(record.star)}星`];
  if (Array.isArray(record.data_kv)) {
    for (const entry of record.data_kv) {
      const field = object(entry);
      const label = text(field.key) ?? text(field.type);
      const value = text(field.value_raw) ?? text(field.value);
      if (label && value) parts.push(`${label}：${value}`);
    }
  }
  return [...new Set(parts.filter((part): part is string => Boolean(part)))].join('；') || null;
}

/** 规范化日历。参数：list[].infos 响应、macro/earnings 类型及可选证券；返回：三星宏观或保留日期粒度的财报事件。 */
export function normalizeCalendar(value: unknown, kind: EventKind, symbol?: string): MarketEvent[] {
  if (kind !== 'macro' && kind !== 'earnings') throw new Error('日历规范化仅支持 macro 或 earnings。');
  const security = symbol === undefined ? null : normalizeSymbol(symbol);
  const result: MarketEvent[] = [];
  for (const group of rows(value)) {
    for (const record of rows(group.infos)) {
      const id = originalId(record.id);
      const title = text(record.content);
      const star = typeof record.star === 'number' || typeof record.star === 'string' ? Number(record.star) : NaN;
      if (!id || !title || (kind === 'macro' && (!Number.isFinite(star) || star < 3))) continue;
      const recordSymbol = text(record.symbol);
      if (security && recordSymbol !== security) continue;
      const ext = object(record.ext);
      const localDate = kind === 'earnings' ? dateLabel(ext.local_date) ?? dateLabel(group.date) : null;
      // 财报的 datetime 可能只是日历占位时间；没有当地披露日期时跳过，避免误报精确时刻。
      const scheduledAt = kind === 'earnings' ? localDate : isoTime(record.datetime);
      if (!scheduledAt) continue;
      result.push({ id: `${kind}:${id}`, title, kind, source: 'Longbridge', url: eventLink(record.url),
        publishedAt: null, scheduledAt, dateOnly: localDate !== null,
        summary: calendarSummary(record, kind), symbol: security ?? recordSymbol });
    }
  }
  return result;
}

/** 构造固定只读数据源。参数：范围、已校验证券及 UTC 日期窗口；返回：不涉及账户的 CLI 参数数组。 */
function eventSources(scope: EventScope, symbol: string | null, start: string, end: string): EventSource[] {
  const calendarFlags = ['--start', start, '--end', end, '--count', String(SOURCE_LIMIT), '--lang', 'zh-CN'];
  const newsFlags = ['--count', String(SOURCE_LIMIT), '--lang', 'zh-CN'];
  if (scope === 'global') return [
    { label: '美国三星经济日历', args: ['finance-calendar', 'macrodata', '--market', 'US', '--star', '3', ...calendarFlags], kind: 'macro', calendar: true },
    { label: '香港三星经济日历', args: ['finance-calendar', 'macrodata', '--market', 'HK', '--star', '3', ...calendarFlags], kind: 'macro', calendar: true },
    { label: '宏观关键词新闻', args: ['news', 'search', '美联储 利率 通胀', ...newsFlags], kind: 'news', calendar: false },
    { label: '地缘关键词新闻', args: ['news', 'search', '战争 地缘', ...newsFlags], kind: 'news', calendar: false },
  ];
  return [
    { label: '个股新闻', args: ['news', symbol!, ...newsFlags], kind: 'news', calendar: false },
    { label: '公司公告', args: ['filing', symbol!, ...newsFlags], kind: 'filing', calendar: false },
    { label: '财报日历', args: ['finance-calendar', 'report', '--symbol', symbol!, ...calendarFlags], kind: 'earnings', calendar: true },
  ];
}

/** 筛选实际窗口。参数：事件、查询时刻及含首尾自然日的窗口；返回：新闻近七天且非未来，日历在日期范围内。 */
function withinWindow(event: MarketEvent, now: number, start: string, end: string): boolean {
  if (event.kind === 'news' || event.kind === 'filing') {
    const published = event.publishedAt ? Date.parse(event.publishedAt) : NaN;
    return Number.isFinite(published) && published >= now - 7 * DAY_MS && published <= now;
  }
  const day = event.scheduledAt?.slice(0, 10);
  return Boolean(day && day >= start && day <= end);
}

/** 排序事件。参数：两个已规范化事件；返回：计划事件按发生时间升序，新闻公告按发布时间降序。 */
function compareEvents(left: MarketEvent, right: MarketEvent): number {
  if (Boolean(left.scheduledAt) !== Boolean(right.scheduledAt)) return left.scheduledAt ? -1 : 1;
  const order = left.scheduledAt && right.scheduledAt
    ? left.scheduledAt.localeCompare(right.scheduledAt)
    : (right.publishedAt ?? '').localeCompare(left.publishedAt ?? '');
  return order || left.id.localeCompare(right.id);
}

/** 筛选并限量单个来源。参数：规范化事件、当前毫秒和日期窗口；返回：窗口内去重排序的最多30条事件。 */
export function selectEvents(events: MarketEvent[], now: number, start: string, end: string): MarketEvent[] {
  const matching = events.filter((event) => withinWindow(event, now, start, end)).sort(compareEvents);
  return [...new Map(matching.map((event) => [event.id, event])).values()].slice(0, SOURCE_LIMIT);
}

/** 读取真实事件。参数：全局/个股范围及个股代码；返回：60秒缓存的真实聚合数据和部分失败警告，全部源失败时抛错。 */
export async function liveEvents(scope: EventScope, symbol?: string): Promise<EventData> {
  if (scope !== 'global' && scope !== 'security') throw new Error('事件范围必须为 global 或 security。');
  const security = scope === 'security' ? normalizeSymbol(symbol) : null;
  const now = Date.now();
  const start = new Date(now - 7 * DAY_MS).toISOString().slice(0, 10);
  const end = new Date(now + 30 * DAY_MS).toISOString().slice(0, 10);
  const sources = eventSources(scope, security, start, end);
  const warnings = ['资讯和日历条目不保证属于重大事件，不代表完整事件覆盖；缺少有效日期或宏观星级的条目不展示。'];
  if (scope === 'global') warnings.push('新闻来自“美联储 利率 通胀”和“战争 地缘”主题检索，覆盖范围有限；议息会议和地缘事件可能存在遗漏。');
  warnings.push('新闻与公告查看近7天，日历查看近7天至未来30天；每个来源最多30条，合计最多120条。');
  const settled = await Promise.allSettled(sources.map(async (source) => {
    const value = await cli(source.args, 60_000);
    const events = source.calendar
      ? normalizeCalendar(value, source.kind, security ?? undefined)
      : normalizeNews(value, source.kind, security ?? undefined);
    return selectEvents(events, now, start, end);
  }));
  const unique = new Map<string, MarketEvent>();
  let successful = 0;
  settled.forEach((result, index) => {
    if (result.status === 'rejected') {
      warnings.push(`${sources[index].label}读取或响应解析失败，请稍后重试。`);
    } else {
      successful += 1;
      for (const event of result.value) unique.set(event.id, event);
    }
  });
  console.info(`[events] 成功源数=${successful} 失败源数=${sources.length - successful} 事件数=${unique.size}`);
  if (!successful) throw new Error('Longbridge 事件数据源全部读取失败，请检查服务端 CLI 连接后重试。');
  return { source: 'longbridge', scope, symbol: security, fetchedAt: new Date(now).toISOString(),
    window: { start, end }, events: [...unique.values()].sort(compareEvents).slice(0, TOTAL_LIMIT), warnings };
}
