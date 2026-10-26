import { Activity, ArrowDownRight, ArrowUpRight, CandlestickChart, ChevronRight, Command, Database, LayoutDashboard, Search, Settings2, ShieldCheck, Target } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Candle, Security, SourceMode } from '../shared/types';
import { formatNumber, formatPercent } from './format';
import { EventCenter } from './EventCenter';

interface HeaderProps { onSearch: () => void; onSettings: () => void; source: SourceMode }

/** 品牌与全局入口。参数：搜索、设置回调；返回：可键盘操作的工作台顶栏。 */
export function WorkspaceHeader({ onSearch, onSettings, source }: HeaderProps) {
  return <header className="topbar">
    <a className="wordmark" href="#"><span className="brand-mark"><Activity size={21} aria-hidden="true" /></span><span className="brand-name">观势<span>MARKET LENS</span></span></a>
    <span className="topbar-divider" aria-hidden="true" />
    <span className="workspace-label">个人投资工作台</span>
    <button className="search-pill" aria-label="搜索港股、美股 Ctrl K" onClick={onSearch}><Search size={16} aria-hidden="true" /><span>搜索证券名称或代码</span><kbd><Command size={11} aria-hidden="true" /> K</kbd></button>
    <div className="topbar-right"><EventCenter source={source} scope="global" /><span className="readonly"><ShieldCheck size={14} aria-hidden="true" />只读分析</span><button className="icon-button" aria-label="策略参数" onClick={onSettings}><Settings2 size={18} aria-hidden="true" /></button><span className="workspace-avatar" aria-label="本机个人工作区">ML</span></div>
  </header>;
}

/** 页内导航。参数：设置回调；返回：分析、计划与复盘的真实锚点入口。 */
export function WorkspaceRail({ onSettings }: { onSettings: () => void }) {
  return <nav className="rail" aria-label="工作台导航">
    <a href="#" className="rail-brand" aria-label="观势首页"><Activity size={25} aria-hidden="true" /></a>
    <span className="rail-caption">工作空间</span>
    <a className="rail-link active" href="#analysis" aria-label="行情分析"><CandlestickChart size={21} aria-hidden="true" /><span>分析</span></a>
    <a className="rail-link" href="#strategy" aria-label="交易计划"><Target size={20} aria-hidden="true" /><span>计划</span></a>
    <a className="rail-link" href="#review" aria-label="执行复盘"><LayoutDashboard size={20} aria-hidden="true" /><span>复盘</span></a>
    <button className="rail-link rail-bottom" onClick={onSettings} aria-label="策略设置"><Settings2 size={21} aria-hidden="true" /><span>设置</span></button>
  </nav>;
}

interface TitleProps { source: SourceMode; onSource: (source: SourceMode) => void; children: ReactNode }

/** 页面标题与数据连接入口。参数：当前来源、切换回调和登录组件；返回：响应式标题区域。 */
export function WorkspaceTitle({ source, onSource, children }: TitleProps) {
  return <div className="page-title">
    <div className="min-w-0"><span className="breadcrumb">工作空间 <ChevronRight size={12} aria-hidden="true" /> 行情分析</span><div className="title-line"><h1>交易研究台</h1><span className="workspace-tag">港股 / 美股</span></div><p className="page-description">发现信号，验证计划，复盘每一次执行。</p></div>
    <div className="source-actions"><div className="source-control"><Database size={14} aria-hidden="true" /><label htmlFor="source">数据源</label><select id="source" value={source} onChange={event => onSource(event.target.value as SourceMode)}><option value="demo">演示数据</option><option value="longbridge">Longbridge 本机</option></select></div>{children}</div>
  </div>;
}

interface QuoteProps {
  security: Security; description: string; price: number | undefined; change: number | null;
  changeLabel: string; sessionLabel?: string; candle: Candle | undefined;
}

/** 证券报价和最近K线摘要。参数：当前证券、报价口径及已有K线；返回：不混淆实时报价与柱数据的证券头部。 */
export function SecurityOverview({ security, description, price, change, changeLabel, sessionLabel, candle }: QuoteProps) {
  const decimals = security.symbol === '2228.HK' ? 3 : 2;
  return <div className="security-overview">
    <div className="security-heading">
      <div className="security-identity"><span className="security-avatar">{security.symbol.slice(0, 1)}</span><div><h2>{security.name}<span>{security.symbol}</span></h2><p>{description}</p></div></div>
      <div className="quote"><strong>{formatNumber(price, decimals)}</strong><span className={(change ?? 0) >= 0 ? 'up' : 'down'}>{(change ?? 0) >= 0 ? <ArrowUpRight size={15} aria-hidden="true" /> : <ArrowDownRight size={15} aria-hidden="true" />}{formatPercent(change)}<small>{changeLabel}</small></span>{sessionLabel && <small>{sessionLabel}</small>}</div>
    </div>
    <dl className="quote-facts" aria-label="最近一根K线摘要"><div className="quote-facts-caption"><dt>柱数据</dt><dd>最近 K 线</dd></div>{([['开盘', candle?.open], ['最高', candle?.high], ['最低', candle?.low], ['成交量', candle?.volume]] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{formatNumber(value, label === '成交量' ? 0 : decimals)}</dd></div>)}</dl>
  </div>;
}
