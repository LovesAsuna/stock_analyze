import { nativeSession } from './native-feed.js';
import { subscribeLiveDesktopCandles } from './desktop-live-candles.js';
import { normalizeCandles } from './longbridge.js';
import type { Candle, Period } from '../shared/types.js';
import type { MarketStreamEvent } from '../shared/realtime.js';

type RawCandle = Record<string, unknown>;
/** 原生页读取器。参数：证券、原生周期、数量和可选秒游标；返回：原始OHLCV页。 */
export type ReadPage = (payload: { symbol: string; period: string; count: number; timestamp?: string }) => Promise<RawCandle[]>;
const requestPage: ReadPage = payload => nativeSession.candleCall(payload);

/** 判断规范证券是否为美股期权。参数：symbol证券；返回：是否使用桌面期权路径。 */
export function isOptionSymbol(symbol: string): boolean {
  return /^[A-Z][A-Z0-9.]*\d{6}[CP]\d+\.US$/.test(symbol);
}

/** 读取近期桌面原生柱，季度沿用月线聚合。参数：symbol、period、count和读取器；返回：校验后的柱。 */
export async function desktopCandles(symbol: string, period: Period, count = 1000, read = requestPage): Promise<Candle[]> {
  const rows = await read({ symbol, period: period === 'quarter' ? 'month' : period, count });
  if (!rows.length) throw new Error(isOptionSymbol(symbol) ? '桌面行情通道未返回该期权K线；请通过页面登录长桥后重试，并检查期权行情权限。' : '桌面行情通道未返回该证券K线；请检查登录、证券代码与行情权限。');
  return normalizeCandles(rows, symbol, period);
}

/** 通过时间游标向前补齐历史，触及有界分页时明确失败。参数：symbol、period、起始日、读取器；返回：完整窗口内原始柱。 */
export async function desktopHistory(symbol: string, period: Period, start: string, read = requestPage): Promise<RawCandle[]> {
  if (read === requestPage) return nativeSession.withCandleSession(() => desktopHistory(symbol, period, start, payload => requestPage(payload)));
  const first = Date.parse(`${start}T00:00:00Z`) / 1000;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !Number.isFinite(first) || new Date(first * 1000).toISOString().slice(0, 10) !== start) {
    throw new Error('证券历史起始日期无效，请使用真实的YYYY-MM-DD日期');
  }
  const result = new Map<number, RawCandle>();
  let cursor: string | undefined;
  for (let page = 0; page < 48; page++) {
    const values = await read({ symbol, period: period === 'quarter' ? 'month' : period, count: 1000, ...(cursor ? { timestamp: cursor } : {}) });
    if (values.length > 1000) throw new Error('桌面证券历史响应超过请求页大小');
    if (!values.length) {
      if (!result.size) throw new Error(isOptionSymbol(symbol) ? '桌面行情通道未返回该期权K线；请通过页面登录长桥后重试，并检查期权行情权限。' : '桌面行情通道未返回该证券K线；请检查登录、证券代码与行情权限。');
      break;
    }
    normalizeCandles(values, symbol, period);
    const times = values.map(row => {
      const time = Number(row.timestamp);
      if (!['number', 'string'].includes(typeof row.timestamp) || !Number.isSafeInteger(time) || time <= 0) {
        throw new Error('桌面证券历史时间必须为正整数Unix秒');
      }
      return time;
    });
    const earliest = Math.min(...times);
    if (cursor !== undefined && earliest > Number(cursor)) throw new Error('桌面证券历史游标未前进，无法确认历史完整性');
    // 重叠页保留较新请求的记录，避免旧页覆盖最新快照。
    values.forEach((row, index) => { if (!result.has(times[index])) result.set(times[index], row); });
    if (earliest <= first || values.length < 1000) break;
    if (page === 47) throw new Error('证券历史超过48页，无法保证完整，请缩短查询范围');
    // 已用真实股票验证秒游标向前取页；shortcut: 期权短页视为历史结束，需在获得非空期权数据后复核。
    cursor = String(earliest - 1);
  }
  return [...result.entries()].filter(([time]) => time >= first).sort(([left], [right]) => left - right).map(([, row]) => row);
}

interface CandleGroup { listeners: Set<(event: MarketStreamEvent) => void>; timer?: ReturnType<typeof setTimeout>; cancelled: boolean }
const readerGroups = new WeakMap<ReadPage, Map<string, CandleGroup>>();

/** 默认按推送触发真实柱读取；显式测试读取器保留快照轮询。参数：证券、周期、消费者及可选读取器；返回：幂等取消函数。 */
export function subscribeDesktopCandles(symbol: string, period: Period, listener: (event: MarketStreamEvent) => void, read: ReadPage = requestPage): () => void {
  if (read === requestPage) return subscribeLiveDesktopCandles(symbol, period, listener);
  let groups = readerGroups.get(read);
  if (!groups) { groups = new Map(); readerGroups.set(read, groups); }
  const key = `${symbol}:${period}`;
  let group = groups.get(key);
  if (!group) {
    group = { listeners: new Set(), cancelled: false };
    groups.set(key, group);
    const active = group;
    /** 单轮原生柱同步。参数：无；返回：完成Promise，失败保留已有行情。 */
    const poll = async (): Promise<void> => {
      if (active.cancelled) return;
      try {
        const candles = await desktopCandles(symbol, period, 1000, read);
        const event: MarketStreamEvent = { type: 'candles', symbol, period, candles, receivedAt: new Date().toISOString() };
        for (const callback of [...active.listeners]) {
          if (active.cancelled || !active.listeners.has(callback)) continue;
          try { callback(event); }
          catch { console.warn('[desktop-candles] K线消费者处理失败，继续通知其他消费者'); }
        }
      } catch {
        if (!active.cancelled) console.warn('[desktop-candles] 当前证券原生K线暂不可用，保留已有数据并稍后重试');
      } finally {
        if (!active.cancelled) { active.timer = setTimeout(() => { void poll(); }, 5000); active.timer.unref?.(); }
      }
    };
    // 延后一轮微任务，确保首次订阅者已注册。
    void Promise.resolve().then(poll);
  }
  const active = group;
  active.listeners.add(listener);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true; active.listeners.delete(listener);
    if (active.listeners.size) return;
    active.cancelled = true; clearTimeout(active.timer); groups.delete(key);
  };
}
