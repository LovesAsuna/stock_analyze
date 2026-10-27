import type { SyncEvent } from '../shared/realtime';
import type { Period } from '../shared/types';
import type { useRealtimeMarket } from './useRealtimeMarket';

const stateLabels = { connecting: '连接中', connected: '已连接', reconnecting: '恢复中', error: '同步异常' };
const transportLabels = { 'desktop-ws': '桌面WS', 'desktop-http': '桌面HTTP', cli: 'CLI' };
const quoteTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/**
 * 根据当前频道明确声明的元数据显示同步口径，缺失时不猜测来源。
 * @param sync 当前频道的同步元数据。
 * @param symbol 当前证券，用于隔离旧订阅。
 * @param period 当前周期，用于隔离指定周期的元数据。
 * @returns 来源、更新方式及尚未就绪的状态说明。
 */
function describeSync(sync: SyncEvent | undefined, symbol: string, period: Period): string {
  if (!sync || sync.symbol !== symbol || (sync.period !== undefined && sync.period !== period)) return '等待确认';
  const method = sync.mode === 'snapshot' ? `每${sync.intervalMs / 1000}秒快照` : sync.mode === 'event'
    ? `${sync.transport === 'cli' ? '' : '桌面'}推送触发更新（真实快照校正）` : '实时推送';
  const state = sync.state === 'connected' ? '' : ` · ${stateLabels[sync.state]}`;
  return `${transportLabels[sync.transport]} · ${method}${state}`;
}

/**
 * 分别说明报价与当前图表的同步口径，仅连接状态进入礼貌播报区。
 * @param props 当前流、证券、周期、同步错误及是否显示分时图。
 * @returns 连接状态、行情秒级时间、同步方式和折叠诊断信息。
 */
export function RealtimeStatus({ live, symbol, period, error, intraday = false, intradaySync }: {
  live: ReturnType<typeof useRealtimeMarket>; symbol: string; period: Period; error: string; intraday?: boolean; intradaySync?: SyncEvent;
}) {
  const candidate = intraday ? live?.sync.intraday ?? intradaySync : live?.sync.candles;
  const chartSync = candidate?.symbol === symbol && (candidate.period === undefined || candidate.period === period) ? candidate : undefined;
  const visibleErrors = [...new Set([
    error,
    live && (live.state === 'error' || live.state === 'reconnecting') ? live.message : '',
    ...[live?.sync.quote, chartSync].map(sync => sync?.state === 'error' || sync?.state === 'reconnecting' ? sync.message : ''),
  ].filter(Boolean))];
  const diagnostics = [...new Set([live?.message, live?.sync.quote?.message, chartSync?.message].filter(Boolean))];
  return <div className="realtime-status">
    <div className="realtime-connection" role="status" aria-atomic="true">
      <strong>实时行情 · {live ? stateLabels[live.state] : '连接中'}</strong>
      {visibleErrors.map(message => <span className="realtime-error" key={message}>{message}</span>)}
    </div>
    <span>报价：{describeSync(live?.sync.quote, symbol, period)}</span>
    <span>{intraday ? '分时图' : 'K线'}：{describeSync(chartSync, symbol, period)}</span>
    <span className="realtime-quote-time">{live?.quote ? `行情时间（中国）：${quoteTimeFormat.format(new Date(live.quote.timestamp * 1000))}` : '尚未收到报价'}</span>
    {diagnostics.length > 0 && <details className="realtime-diagnostics">
      <summary>连接诊断</summary>
      {diagnostics.map(message => <p key={message}>{message}</p>)}
    </details>}
  </div>;
}
