import { useEffect, useRef, useState } from 'react';
import type { IntradayData, IntradaySession } from '../shared/intraday';
import type { SourceMode } from '../shared/types';
import { parseStreamEvent, type SyncEvent } from '../shared/realtime';
import { mergeIntradayUpdate, parseIntradayUpdate } from '../shared/intraday-updates';

/** 校验分时数据边界，拒绝错证券、错时段和无效点。参数：未知JSON与请求上下文；返回：合法分时数据。 */
function validate(value: unknown, source: SourceMode, symbol: string, session: IntradaySession, days: 1 | 5): IntradayData {
  const data = value as IntradayData;
  if (!data || data.source !== source || data.symbol !== symbol || data.session !== session || data.days !== days ||
      !Array.isArray(data.points) || data.points.length > 20000 || !Array.isArray(data.warnings) || data.warnings.some(note => typeof note !== 'string') ||
      typeof data.fetchedAt !== 'string' || !Number.isFinite(Date.parse(data.fetchedAt))) throw new Error('分时数据上下文或结构无效。');
  let previousTime = 0;
  for (const point of data.points) {
    if (!Number.isFinite(point.time) || point.time <= previousTime || !Number.isFinite(point.price) || point.price <= 0 ||
        !Number.isFinite(point.volume) || point.volume < 0 ||
        (point.averagePrice !== null && (!Number.isFinite(point.averagePrice) || point.averagePrice <= 0)) ||
        !['overnight', 'pre', 'regular', 'post'].includes(point.session)) throw new Error('分时点位价格、时间或时段无效。');
    previousTime = point.time;
  }
  return data;
}

/** 串行刷新真实分时快照；切换条件即隔离旧响应。参数：来源、证券、时段、天数和启用开关；返回：快照与可见错误。 */
export function useIntraday(source: SourceMode, symbol: string, session: IntradaySession, days: 1 | 5, enabled: boolean, refreshKey = 0) {
  const key = `${source}:${symbol}:${session}:${days}`;
  const [state, setState] = useState<{ key: string; data: IntradayData | null; error: string; loading: boolean } | null>(null);
  const [revision, setRevision] = useState(0);
  const [syncState, setSyncState] = useState<{ key: string; sync: SyncEvent } | null>(null);
  const latestUpdate = useRef<{ key: string; points: IntradayData['points']; receivedAt: string } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    setState(previous => ({ key, data: previous?.key === key ? previous.data : null, loading: true, error: '' }));
    /** 当前请求完成后才计划下一次；错误保留同一上下文快照。参数：无；返回：完成Promise。 */
    async function load(): Promise<void> {
      try {
        const response = await fetch(`/api/intraday?${new URLSearchParams({ source, symbol, session, days: String(days) })}`, { signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? `分时读取失败（HTTP ${response.status}）。`);
        const data = validate(body, source, symbol, session, days);
        if (!controller.signal.aborted) {
          const update = latestUpdate.current;
          if (update?.key === key && Date.parse(update.receivedAt) >= Date.parse(data.fetchedAt)) {
            data.points = mergeIntradayUpdate(data.points, update.points, symbol, days); data.fetchedAt = update.receivedAt;
          }
          setState({ key, data, error: '', loading: false });
        }
      } catch (failure) {
        if (!controller.signal.aborted) setState(previous => ({ key, data: previous?.key === key ? previous.data : null, loading: false, error: failure instanceof Error ? failure.message : '分时读取失败。' }));
      } finally {
        // 长历史仅作低频校正；当前交易日由独立推送触发更新。
        if (!controller.signal.aborted && source === 'longbridge') timer = setTimeout(load, 60_000);
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [source, symbol, session, days, enabled, key, revision, refreshKey]);
  useEffect(() => {
    if (!enabled || source !== 'longbridge') return;
    let disposed = false;
    const events = new EventSource(`/api/intraday-stream?${new URLSearchParams({ source, symbol, session })}`);
    const pending = { points: [] as IntradayData['points'], receivedAt: '' };
    events.onmessage = message => {
      if (disposed) return;
      try {
        const value = JSON.parse(message.data);
        if (value.type === 'sync') {
          const event = parseStreamEvent(value);
          if (event.type === 'sync' && event.symbol === symbol && event.channel === 'intraday') setSyncState({ key, sync: event });
          return;
        }
        const update = parseIntradayUpdate(value, symbol, session);
        if (pending.receivedAt && Date.parse(update.receivedAt) < Date.parse(pending.receivedAt)) return;
        pending.points = update.points; pending.receivedAt = update.receivedAt;
        latestUpdate.current = { key, ...update };
        setState(previous => previous?.key === key && previous.data ? { ...previous, data: { ...previous.data,
          points: mergeIntradayUpdate(previous.data.points, update.points, symbol, days), fetchedAt: update.receivedAt } } : previous);
      } catch { setSyncState(previous => previous?.key === key ? { key, sync: { ...previous.sync, state: 'error' } } : null); }
    };
    events.onerror = () => {
      if (!disposed) setSyncState(previous => previous?.key === key ? { key, sync: { ...previous.sync, state: 'reconnecting' } } : null);
    };
    return () => { disposed = true; events.close(); };
  }, [enabled, source, symbol, session, days, key, revision]);
  return { data: enabled && state?.key === key ? state.data : null, error: enabled && state?.key === key ? state.error : '', loading: enabled && (state?.key !== key || state.loading), sync: enabled && syncState?.key === key ? syncState.sync : undefined, refresh: () => setRevision(value => value + 1) };
}
