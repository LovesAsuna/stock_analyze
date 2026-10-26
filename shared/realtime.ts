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

/** 本机只读事件协议；行情逐笔推送，K线为原生快照同步，不从tick累加成交量。 */
export type MarketStreamEvent =
  | { type: 'status'; symbol: string; state: StreamState; message: string }
  | { type: 'quote'; quote: RealtimeQuote }
  | { type: 'candles'; symbol: string; period: Period; candles: Candle[]; receivedAt: string };

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
    if (typeof event.symbol !== 'string') throw new Error('实时行情缺少证券代码。');
    if (event.type === 'status') {
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
