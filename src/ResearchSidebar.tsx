import { useState, type ComponentProps } from 'react';
import { SignalPanel } from './Panels';
import { FundamentalsPanel } from './FundamentalsPanel';
import type { SourceMode } from '../shared/types';
import './fundamentals.css';

/**
 * 在现有右侧位置切换技术与基本面，未打开时不请求财报数据。
 * @param props 原技术侧栏属性、数据来源和刷新序号。
 * @returns 不改变主图尺寸的可切换研究侧栏。
 */
export function ResearchSidebar({ source, refresh, ...signalProps }: ComponentProps<typeof SignalPanel> & { source: SourceMode; refresh: number }) {
  const [view, setView] = useState<'technical' | 'fundamentals'>('technical');
  return <div className="research-sidebar flex min-w-0 flex-col">
    <div className="research-sidebar-switch" role="group" aria-label="研究栏目">
      <button type="button" aria-pressed={view === 'technical'} onClick={() => setView('technical')}>技术信号</button>
      <button type="button" aria-pressed={view === 'fundamentals'} onClick={() => setView('fundamentals')}>基本面估值</button>
    </div>
    {view === 'technical' ? <SignalPanel {...signalProps} />
      : <FundamentalsPanel source={source} symbol={signalProps.symbol} refresh={refresh} />}
  </div>;
}
