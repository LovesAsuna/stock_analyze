import { useEffect, useMemo, useState } from 'react';
import { mergeLiveCandles } from '../shared/live-candles';
import { parseStreamEvent, type RealtimeQuote, type StreamState } from '../shared/realtime';
import type { Candle, MarketData, Period, SourceMode } from '../shared/types';

interface LiveState {
  key: string;
  state: StreamState;
  message: string;
  quote: RealtimeQuote | null;
  candles: Candle[];
  receivedAt: string | null;
}

/**
 * 连接同源只读事件流，上游由本机CLI维护WebSocket与登录。
 * @param source 数据源，演示模式不连接真实行情。
 * @param symbol 当前证券。
 * @param period 图表周期。
 * @returns 连接状态、原生K线与最新报价；切证券时同步隔离旧状态。
 */
export function useRealtimeMarket(source: SourceMode, symbol: string, period: Period) {
  const key = `${source}:${symbol}:${period}`;
  const [live, setLive] = useState<LiveState | null>(null);
  useEffect(() => {
    if (source !== 'longbridge') { setLive(null); return; }
    let disposed = false;
    const initial: LiveState = { key, state: 'connecting', message: '正在连接Longbridge实时行情…', quote: null, candles: [], receivedAt: null };
    setLive(initial);
    const events = new EventSource(`/api/stream?${new URLSearchParams({ source, symbol, period })}`);
    events.onmessage = (message) => {
      if (disposed) return;
      try {
        const event = parseStreamEvent(JSON.parse(message.data));
        if ((event.type === 'quote' ? event.quote.symbol : event.symbol) !== symbol) return;
        setLive((previous) => {
          const current = previous?.key === key ? previous : initial;
          if (event.type === 'status') return { ...current, state: event.state, message: event.message };
          if (event.type === 'quote') {
            if (current.quote && current.quote.timestamp > event.quote.timestamp) return current;
            return { ...current, quote: event.quote };
          }
          if (event.period !== period || (current.receivedAt && Date.parse(current.receivedAt) > Date.parse(event.receivedAt))) return current;
          try {
            const candles = mergeLiveCandles(current.candles, event.candles, symbol, period).slice(-1000);
            return { ...current, candles, receivedAt: event.receivedAt };
          } catch {
            return { ...current, state: 'error', message: '实时K线校验失败，保留已知历史并等待重新同步。' };
          }
        });
      } catch { setLive((current) => current?.key === key ? { ...current, state: 'error', message: '实时事件格式无效，等待重新同步。' } : current); }
    };
    events.onerror = () => {
      if (!disposed) setLive((current) => current?.key === key ? { ...current, state: 'reconnecting', message: '本机推送连接中断，正在自动重连；当前价格可能已过时。' } : current);
    };
    return () => { disposed = true; events.close(); };
  }, [source, symbol, period, key]);
  return source === 'longbridge' && live?.key === key ? live : null;
}

/**
 * 将实时原生K线叠加到长历史，保留成交区间和完整性，不改写快照更新时间。
 * @param data 当前HTTP历史基线，缺失时不能用短快照冒充完整历史。
 * @param live 同一证券周期的实时状态。
 * @returns 同口径行情及可见的同步错误。
 */
export function useLiveMarketData(data: MarketData | null, live: ReturnType<typeof useRealtimeMarket>) {
  return useMemo(() => {
    if (!data || data.source !== 'longbridge' || !live?.candles.length || live.key !== `longbridge:${data.symbol}:${data.period}`) {
      return { data, error: '' };
    }
    try { return { data: { ...data, candles: mergeLiveCandles(data.candles, live.candles, data.symbol, data.period) }, error: '' }; }
    catch { return { data, error: '实时K线与历史数据尚未对齐，保留历史快照并等待同步。' }; }
  }, [data, live?.candles, live?.key]);
}
