import { useState } from 'react';
import { ListFilter, Search } from 'lucide-react';
import type { Security, Workspace } from '../shared/types';
import { formatNumber } from './format';

/**
 * 展示自选与持仓合并列表，证券数量仅取自当前快照。
 * @param props 快照、当前证券、加载与演示状态，以及搜索和选择回调。
 * @returns 标题与底栏固定、证券列表随主图等高并独立滚动的侧栏。
 */
export function WatchlistPanel({ workspace, selected, loading, demo, onSearch, onSelect }: {
  workspace: Workspace | null; selected: string; loading: boolean; demo: boolean; onSearch: () => void; onSelect: (security: Security) => void;
}) {
  const [market, setMarket] = useState('all');
  const securities = workspace?.securities ?? [];
  const visibleSecurities = securities.filter(item => market === 'all' || item.market === market);
  return <aside className="watchlist-panel bg-surface text-foreground border-border">
    <div className="panel-title watchlist-title">
      <div className="sidebar-title-copy"><span className="sidebar-eyebrow text-muted-foreground">关注与持仓</span><h2>证券列表</h2></div>
      <button className="icon-button bg-elevated text-muted-foreground hover:text-brand" aria-label="搜索并添加证券" onClick={onSearch}><Search size={16} aria-hidden="true" /></button>
    </div>
    <div className="market-tabs watchlist-market-tabs bg-canvas" aria-label="证券市场">{[['all', '全部'], ['HK', '港股'], ['US', '美股']].map(([value, label]) =>
      <button key={value} aria-pressed={market === value} className={market === value ? 'active bg-elevated text-foreground' : 'text-muted-foreground'} onClick={() => setMarket(value)}>{label}</button>)}
    </div>
    <div className="watchlist-inventory text-muted-foreground"><span>当前列表</span><span>{visibleSecurities.length} 只证券</span></div>
    <div className="watchlist-columns"><span>代码 / 名称</span><span>持仓</span></div>
    {/* 必须保持为 aside 的直系子节点，让等高布局仅在证券区域内滚动。 */}
    <div className="watchlist-scroll" role="region" aria-label="自选与持仓证券" tabIndex={0}>
      {visibleSecurities.map(item => {
        const position = workspace?.positions.find(holding => holding.symbol === item.symbol);
        const symbolLabel = item.symbol.replace(/\.(HK|US)$/, '');
        return <button className={`security-row ${selected === item.symbol ? 'selected bg-brand/10' : 'hover:bg-elevated'}`} key={item.symbol} aria-pressed={selected === item.symbol} onClick={() => onSelect(item)}>
          <span className="security-row-identity watchlist-identity flex min-w-0 items-center gap-2">
            <span className="watchlist-avatar flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand" aria-hidden="true">{symbolLabel.slice(0, 1).toUpperCase()}</span>
            <span className="watchlist-security-copy min-w-0">
              <strong className="wrap-anywhere text-foreground">{symbolLabel}</strong>
              <span className="security-row-details"><small className="market-badge">{item.market}</small><small>{item.name}</small></span>
            </span>
          </span>
          <span className="security-row-quantity tabular-nums text-foreground">{position ? formatNumber(position.quantity, 0) : '—'}</span>
        </button>;
      })}
      {!securities.length && <p className="sidebar-empty">{loading ? '读取自选与持仓中…' : '暂无可用列表。可通过搜索输入证券代码。'}</p>}
    </div>
    <div className="watchlist-bottom bg-canvas"><ListFilter size={15} aria-hidden="true" /><p>自选 + 持仓合并<br /><span>{demo ? '合成示例' : 'Longbridge 账户'}</span></p></div>
  </aside>;
}
