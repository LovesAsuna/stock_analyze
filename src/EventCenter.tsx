import { useEffect, useId, useRef, useState } from 'react';
import { CalendarDays, ExternalLink, Globe2, Newspaper, RefreshCw, X } from 'lucide-react';
import type { EventData, EventKind, EventScope, MarketEvent } from '../shared/events';
import { eventLink } from '../shared/events';
import type { SourceMode } from '../shared/types';
import { fetchEvents } from './api';
import './events.css';
import { EventCalendar } from './EventCalendar';
import { eventDay } from './event-calendar';

const KIND_LABELS: Record<EventKind, string> = { macro: '宏观日历', earnings: '财报', filing: '公告', news: '新闻' };

/** 保留日期精度，明确使用北京时间展示有时刻的事件。参数：ISO时间与日期标志；返回：可读时间。 */
function eventTime(value: string | null, dateOnly = false): string {
  if (!value) return '时间未提供';
  if (dateOnly) return `${value.slice(0, 10)} · 时刻未提供`;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} 北京时间` : '时间未提供';
}

/** 单事件保留来源、发表/计划时间及原文入口，不渲染上游HTML。参数：标准事件；返回：具名卡片。 */
function EventCard({ item }: { item: MarketEvent }) {
  const url = eventLink(item.url);
  return <article className="market-event-card">
    <div className="market-event-meta"><span className={`market-event-kind kind-${item.kind}`}>{KIND_LABELS[item.kind]}</span><span>{item.source}</span></div>
    <h3>{url ? <a href={url} target="_blank" rel="noreferrer noopener">{item.title}<ExternalLink size={13} aria-hidden="true" /></a> : item.title}</h3>
    <p className="market-event-time">{item.scheduledAt ? '计划发生：' : '发布：'}{eventTime(item.scheduledAt ?? item.publishedAt, item.dateOnly)}</p>
    {item.summary && <p className="market-event-summary">{item.summary}</p>}
    {!url && <small className="market-event-no-link">来源未提供可用原文链接</small>}
  </article>;
}

/** 请求随作用域与证券隔离，关闭后取消浏览器读取。参数：来源、范围、证券和重试序号；返回：快照/状态。 */
function useEvents(source: SourceMode, scope: EventScope, symbol: string | undefined, refresh: number) {
  const [data, setData] = useState<EventData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError(''); setLoading(true);
    fetchEvents(source, scope, symbol, controller.signal).then(result => {
      if (!controller.signal.aborted) setData(result);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '事件读取失败。');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [source, scope, symbol, refresh]);
  return { data: data?.source === source && data.scope === scope && (scope === 'global' || data.symbol === symbol) ? data : null, error, loading };
}

/** 将计划日历和已发布信息分节；参数：快照和分类；返回：带数量与空状态的内容。 */
function EventList({ data, filter, selected }: { data: EventData; filter: 'all' | EventKind; selected: string | null }) {
  const items = data.events.filter(item => (filter === 'all' || item.kind === filter) && (!selected || eventDay(item) === selected));
  const planned = items.filter(item => item.scheduledAt !== null);
  const published = items.filter(item => item.scheduledAt === null);
  // 全局事件在各自时间口径内倒序；个股财报保留原有的计划日期顺序。
  if (data.scope === 'global') planned.sort((left, right) => right.scheduledAt!.localeCompare(left.scheduledAt!));
  published.sort((left, right) => (right.publishedAt ?? '').localeCompare(left.publishedAt ?? ''));
  return <>
    {planned.length > 0 && <section className="market-event-group"><h3>日历与计划事件 <span>{planned.length}</span></h3>
      <p className="event-center-note">{data.scope === 'global' ? '按计划日期倒序' : '按计划日期排列'}，实际发生时间及结果以来源后续更新为准。</p>{planned.map(item => <EventCard key={item.id} item={item} />)}</section>}
    {published.length > 0 && <section className="market-event-group"><h3>近期发布 <span>{published.length}</span></h3>{published.map(item => <EventCard key={item.id} item={item} />)}</section>}
    {!items.length && <div className="event-center-empty"><Newspaper size={28} aria-hidden="true" /><p>当前范围没有可展示的事件</p><span>不代表期间没有重大事件，请查看数据提示或稍后刷新。</span></div>}
  </>;
}

/** 事件抽屉内容独立挂载以取消请求；参数：来源、范围及证券；返回：过滤、重试及事件列表。 */
function EventContent({ source, scope, symbol }: { source: SourceMode; scope: EventScope; symbol?: string }) {
  const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState<'all' | EventKind>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const { data, error, loading } = useEvents(source, scope, symbol, refresh);
  const kinds: ('all' | EventKind)[] = scope === 'global' ? ['all', 'macro', 'news'] : ['all', 'earnings', 'filing', 'news'];
  return <div className="event-center-content" aria-busy={loading}>
    <div className="event-center-toolbar"><div role="group" aria-label="事件分类">{kinds.map(kind => <button key={kind} type="button" aria-pressed={filter === kind} onClick={() => setFilter(kind)}>{kind === 'all' ? '全部' : KIND_LABELS[kind]}</button>)}</div>
      <button className="icon-button" type="button" aria-label="刷新事件" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} aria-hidden="true" /></button></div>
    {loading && <p className="event-center-state" role="status">正在读取{scope === 'global' ? '宏观日历和财经新闻' : '财报、公告和证券新闻'}…</p>}
    {error && <div className="event-center-state" role="alert"><p>{error}</p><button className="button" onClick={() => setRefresh(value => value + 1)}>重试事件</button></div>}
    {data && <>
      <p className="event-center-window">{data.source === 'demo' ? '合成演示 · 非真实事件' : 'Longbridge 公开资讯'} · {data.window.start} 至 {data.window.end}<br />获取于 {eventTime(data.fetchedAt)}</p>
      <EventCalendar data={data} filter={filter} selected={selected} onSelect={setSelected} />
      {data.warnings.length > 0 && <details className="event-center-warnings" open><summary>数据范围与提示（{data.warnings.length}）</summary><ul>{data.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details>}
      <EventList data={data} filter={filter} selected={selected} />
    </>}
  </div>;
}

/**
 * 分开提供全局/个股事件入口，复用浏览器dialog的模态、Escape与焦点返回。
 * @param props 数据来源、事件范围及个股证券代码。
 * @returns 入口按钮与按需加载的右侧事件抽屉。
 */
export function EventCenter({ source, scope, symbol }: { source: SourceMode; scope: EventScope; symbol?: string }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const label = scope === 'global' ? '全局事件' : '个股事件';
  const Icon = scope === 'global' ? Globe2 : CalendarDays;
  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
    else if (!open) dialog.current?.close();
  }, [open]);
  return <>
    <button type="button" className={`event-entry event-entry-${scope}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><Icon size={16} aria-hidden="true" /><span>{label}</span></button>
    <dialog className="event-center-dialog" ref={dialog} aria-labelledby={titleId} onCancel={() => setOpen(false)} onClose={() => setOpen(false)}
      onClick={event => { if (event.target === dialog.current && event.clientX < dialog.current.getBoundingClientRect().left) setOpen(false); }}>
      <header className="event-center-header"><div><span>{scope === 'global' ? '宏观与市场动态' : '当前证券催化与披露'}</span><h2 id={titleId}><Icon size={21} aria-hidden="true" />{label}</h2>
        <p>{scope === 'global' ? '宏观政策、经济日历与重要财经资讯' : `${symbol} · 财报、公司公告与相关新闻`}</p></div>
        <button autoFocus type="button" className="icon-button" aria-label={`关闭${label}`} onClick={() => setOpen(false)}><X size={20} aria-hidden="true" /></button></header>
      {open && <EventContent key={`${source}:${scope}:${symbol ?? ''}`} source={source} scope={scope} symbol={symbol} />}
    </dialog>
  </>;
}
