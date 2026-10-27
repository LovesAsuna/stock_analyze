import { nativeSession } from './native-feed.js';
import { normalizeCandles } from './longbridge.js';
import type { MarketStreamEvent, SyncEvent } from '../shared/realtime.js';
import type { Period } from '../shared/types.js';

/** 每个证券周期共享推送驱动读取，防止多个页面重复读取同一份原生柱。 */
const groups = new Map<string, { listeners: Set<(event: MarketStreamEvent) => void>; release: () => void }>();

/** 订阅报价变化并立即读取真实柱；在途更新合并为下一次读取，不固定等待。参数：证券、周期、消费者；返回：幂等退订函数。 */
export function subscribeLiveDesktopCandles(symbol: string, period: Period, listener: (event: MarketStreamEvent) => void): () => void {
  const key = `${symbol}:${period}`;
  let group = groups.get(key);
  if (!group) {
    const listeners = new Set<(event: MarketStreamEvent) => void>();
    let cancelled = false; let running = false; let dirty = false; let full = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let transport: SyncEvent['transport'] = 'desktop-ws';
    const publish = (event: MarketStreamEvent): void => {
      for (const callback of [...listeners]) {
        if (cancelled || !listeners.has(callback)) continue;
        try { callback(event); } catch { console.warn('[desktop-candles] K线消费者处理失败'); }
      }
    };
    const status = (state: SyncEvent['state']): void => publish({ type: 'sync', symbol, period, channel: 'candles', mode: 'event', transport, state });
    /** 逐次读取真实OHLCV，推送到达时立刻追赶。参数：无；返回：读取完成Promise。 */
    const read = async (): Promise<void> => {
      if (cancelled || running) return;
      running = true;
      try {
        do {
          dirty = false;
          const count = full ? 1000 : period === 'quarter' ? 12 : 3;
          const result = await nativeSession.candleCall({ symbol, period: period === 'quarter' ? 'month' : period, count, withTransport: true });
          if (cancelled) break;
          const candles = normalizeCandles(result.rows, symbol, period);
          if (!candles.length) throw new Error('桌面原生柱暂不可用');
          transport = result.transport; full = false;
          publish({ type: 'candles', symbol, period, candles, receivedAt: new Date().toISOString() });
          status('connected');
        } while (dirty && !cancelled);
      } catch {
        if (!cancelled) {
          full = true; status('error');
          console.warn('[desktop-candles] 推送触发的K线读取失败，保留已有数据并重试');
          retry = setTimeout(trigger, 15000); retry.unref?.();
        }
      } finally { running = false; }
    };
    /** 立即请求更新，清理失败重试并合并在途推送。参数：无；返回：无。 */
    const trigger = (): void => {
      if (cancelled) return;
      clearTimeout(retry); dirty = true;
      void read();
    };
    const cancelQuote = nativeSession.subscribe(symbol, event => {
      if (event.type === 'quote') trigger();
      else if (event.type === 'status') {
        if (event.state !== 'connected') full = true;
        status(event.state);
        if (event.state === 'connected') trigger();
      }
    });
    // 收盘后可能没有新推送，低频校正负责确认尾柱及补齐缺口，不延迟实时通知。
    const correction = setInterval(() => { full = true; trigger(); }, 60000); correction.unref?.();
    group = { listeners, release: () => { cancelled = true; clearTimeout(retry); clearInterval(correction); cancelQuote(); } };
    groups.set(key, group);
    // 注册首个消费者后再读取，且始终依靠真实快照提供首帧。
    void Promise.resolve().then(trigger);
  }
  const active = group;
  active.listeners.add(listener);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true; active.listeners.delete(listener);
    if (!active.listeners.size) { groups.delete(key); active.release(); }
  };
}
