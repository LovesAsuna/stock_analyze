import type { Candle, Period } from './types.js';
import { isPeriod } from './periods.js';

/** 经本机桥接标准化的行情；timestamp 为交易所行情时间，不是接收时间。 */
export interface RealtimeQuote {
  symbol: string;
  timestamp: number;
  price: number;
  previousClose: number | null;
  session: 'regular' | 'pre' | 'post' | 'overnight' | 'unknown';
}

/** 流状态始终与具体证券绑定，旧数据不会伪装成新推送。 */
export type StreamState = 'connecting' | 'connected' | 'reconnecting' | 'error';

/** 独立确认报价、K线和分时各自的同步方式。 */
export type SyncChannel = 'quote' | 'candles' | 'intraday';

/** event 表示桌面推送触发真实快照校正；仅 snapshot 声明轮询间隔，来源不能从文案推断。 */
export type SyncEvent = {
  type: 'sync';
  symbol: string;
  channel: SyncChannel;
  transport: 'desktop-ws' | 'desktop-http' | 'cli';
  state: StreamState;
  period?: Period;
  message?: string;
} & ({ mode: 'push' | 'event'; intervalMs?: never } | { mode: 'snapshot'; intervalMs: number });

/** 本机只读事件协议；同步元数据与行情独立传输，不从tick累加成交量。 */
export type MarketStreamEvent =
  | { type: 'status'; symbol: string; state: StreamState; message: string }
  | SyncEvent
  | { type: 'quote'; quote: RealtimeQuote }
  | { type: 'candles'; symbol: string; period: Period; candles: Candle[]; receivedAt: string };

/**
 * 校验独立同步元数据，拒绝含糊的来源、周期和刷新间隔。
 * @param event 解码后的同步事件。
 * @returns 校验成功无返回值，否则抛出明确错误。
 */
function validateSyncEvent(event: Record<string, unknown>): void {
  if (!['quote', 'candles', 'intraday'].includes(event.channel as string) ||
    !['desktop-ws', 'desktop-http', 'cli'].includes(event.transport as string) ||
    !['connecting', 'connected', 'reconnecting', 'error'].includes(event.state as string) ||
    ('period' in event && !isPeriod(event.period)) ||
    ('message' in event && typeof event.message !== 'string')) throw new Error('实时同步元数据字段无效。');
  if (event.mode === 'snapshot') {
    if (typeof event.intervalMs !== 'number' || !Number.isFinite(event.intervalMs) || event.intervalMs <= 0) {
      throw new Error('实时快照间隔必须为有限正数。');
    }
  } else if (!['push', 'event'].includes(event.mode as string) || 'intervalMs' in event) {
    throw new Error('实时同步方式无效，推送及事件触发更新不得携带快照间隔。');
  }
}

/**
 * 检查浏览器事件边界的基础结构，完整K线由后续合并函数验证。
 * @param value 本机事件流解码后的未知JSON。
 * @returns 合法的事件对象，否则抛出可显示错误。
 */
export function parseStreamEvent(value: unknown): MarketStreamEvent {
  if (!value || typeof value !== 'object') throw new Error('实时行情事件结构无效。');
  const event = value as Record<string, unknown>;
  if (event.type === 'quote') {
    const quote = event.quote as RealtimeQuote | undefined;
    if (!quote || typeof quote.symbol !== 'string' || !Number.isFinite(quote.timestamp) || quote.timestamp <= 0 ||
      !Number.isFinite(quote.price) || quote.price <= 0 ||
      (quote.previousClose !== null && (!Number.isFinite(quote.previousClose) || quote.previousClose <= 0)) ||
      !['regular', 'pre', 'post', 'overnight', 'unknown'].includes(quote.session)) throw new Error('实时报价字段无效。');
  } else {
    if (typeof event.symbol !== 'string' || !event.symbol.trim()) throw new Error('实时行情缺少证券代码。');
    if (event.type === 'sync') {
      validateSyncEvent(event);
    } else if (event.type === 'status') {
      if (!['connecting', 'connected', 'reconnecting', 'error'].includes(String(event.state)) || typeof event.message !== 'string') {
        throw new Error('实时连接状态无效。');
      }
    } else if (event.type === 'candles') {
      if (!isPeriod(event.period) || !Array.isArray(event.candles) || event.candles.length > 1000 ||
        typeof event.receivedAt !== 'string' || !Number.isFinite(Date.parse(event.receivedAt))) throw new Error('实时K线事件无效。');
    } else throw new Error('未知实时行情事件。');
  }
  return value as MarketStreamEvent;
}
