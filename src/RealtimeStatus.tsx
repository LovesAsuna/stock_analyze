import { formatTime } from './format';
import type { Period } from '../shared/types';
import type { useRealtimeMarket } from './useRealtimeMarket';

/**
 * 显示实时连接、行情时间与K线同步口径，休市不凭无tick断言连接失败。
 * @param props 当前流与证券周期，不包含凭证或账户明细。
 * @returns 可读连接状态和同步错误。
 */
export function RealtimeStatus({ live, symbol, period, error, intraday = false }: {
  live: ReturnType<typeof useRealtimeMarket>; symbol: string; period: Period; error: string; intraday?: boolean;
}) {
  const labels = { connecting: '连接中', connected: '已订阅', reconnecting: '重连中', error: '同步异常' };
  return <div className="realtime-status" role="status">
    <strong>实时行情 · {live ? labels[live.state] : '连接中'}</strong>
    <span>{error || live?.message || '正在连接本机只读行情桥接…'}</span>
    <span>{live?.quote ? `行情时间（中国）：${formatTime(live.quote.timestamp, symbol, period, true)}` : '尚未收到报价'} · {intraday ? '分时曲线每15秒读取快照，与实时报价独立更新' : '原生K线每5秒同步，收盘确认保留60秒缓冲'}</span>
  </div>;
}
