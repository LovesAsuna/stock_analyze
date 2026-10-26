import { lazy, Suspense, type ReactNode } from 'react';
import './intraday-terminal.css';
import { useIntraday } from './useIntraday';
import type { IntradaySession } from '../shared/intraday';
import type { SourceMode } from '../shared/types';
import { SESSION_LABELS } from './MarketTimeframes';
const Chart = lazy(() => import('./IntradayChart').then(module => ({ default: module.IntradayChart })));

/** 分时视图独立请求与错误展示。参数：来源、证券、时段、1或5交易日及可选周期栏；返回：图表、紧贴下方的周期栏与数据口径。 */
export function IntradayView({ source, symbol, session, days, footer }: {
  source: SourceMode; symbol: string; session: IntradaySession; days: 1 | 5; footer?: ReactNode;
}) {
  const { data, error, loading, refresh } = useIntraday(source, symbol, session, days, true);
  return <section aria-label={days === 5 ? '5日分时' : SESSION_LABELS[session]} aria-busy={loading}>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button className="button" onClick={refresh}>重试分时</button></div>}
    {data?.points.length ? <Suspense fallback={<><div className="chart-placeholder">加载分时图…</div>{footer && <div className="intraday-terminal-footer">{footer}</div>}</>}>
      <Chart data={data} footer={footer} /></Suspense>
      : <><div className="intraday-empty"><strong>{loading ? '正在读取分时数据…' : '所选时段暂无分时数据'}</strong><span>{days === 5 ? '最近 5 个可用交易日' : SESSION_LABELS[session]} · 不以其他时段替代</span></div>
        {footer && <div className="intraday-terminal-footer">{footer}</div>}</>}
    <div className="intraday-notes"><p>分时价格与成交量独立展示，{source === 'demo' ? '当前为合成示例。' : '每 15 秒刷新上游分时快照，实时性取决于账户权限。'}此视图不生成 K 线策略信号或回测交易。</p>
      {data?.warnings.map(note => <p key={note}>{note}</p>)}
      <span>{data ? `${data.points.length} 个分时点 · ${new Date(data.fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（中国时间）` : '等待分时快照'}</span></div>
  </section>;
}
