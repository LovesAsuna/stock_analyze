import type { RealtimeQuote } from '../shared/realtime.js';
import { normalizeSymbol, timestamp } from './longbridge.js';

type Row = Record<string, unknown>;
type Session = RealtimeQuote['session'];

/**
 * 验证外部对象，拒绝数组及空值。
 * @param value 外部 JSON 字段。
 * @returns 可访问的对象；结构错误时抛出不含原始响应的异常。
 */
function record(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('实时报价结构无效。');
  return value as Row;
}

/**
 * 校验严格正数，避免布尔值、空白字符串被隐式转成价格。
 * @param value 外部价格字段。
 * @returns 有限正数；无效时抛出固定错误。
 */
function price(value: unknown): number {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') throw new Error('实时报价价格无效。');
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new Error('实时报价价格无效。');
  return result;
}

/**
 * 验证带时区的时间或 Unix 时间，复用历史行情时间工具。
 * @param value 外部行情时间。
 * @returns 有效的 Unix 秒；无效时抛出固定错误。
 */
function quoteTime(value: unknown): number {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') throw new Error('实时报价时间无效。');
  const result = timestamp(value);
  if (!Number.isFinite(result) || result <= 0 || !Number.isFinite(new Date(result * 1000).getTime())) {
    throw new Error('实时报价时间无效。');
  }
  return result;
}

/**
 * 识别明确的交易时段，未知值不猜测为常规交易。
 * @param value 通知的 trade_session，支持数字枚举及对应字符串。
 * @returns 标准交易时段。
 */
export function normalizeTradeSession(value: unknown): Session {
  const sessions: Record<string, Session> = {
    '0': 'regular', '1': 'pre', '2': 'post', '3': 'overnight',
    intraday: 'regular', pre: 'pre', post: 'post', overnight: 'overnight',
  };
  return typeof value === 'number' || typeof value === 'string'
    ? sessions[String(value).toLowerCase()] ?? 'unknown' : 'unknown';
}

/**
 * 合并报价增量或订阅快照；快照普通字段属于常规时段，扩展报价按时间择新。
 * @param value 外部报价对象。
 * @param symbol 已验证的订阅证券代码。
 * @param previous 上次有效报价，用于补全增量价格和保留昨收价。
 * @param snapshot 是否为订阅/查询快照，默认按通知处理。
 * @returns 新报价；旧通知或不足以确定价格时间的增量返回 null。
 */
export function normalizeRealtimeQuote(
  value: unknown, symbol: string, previous: RealtimeQuote | null = null, snapshot = false,
): RealtimeQuote | null {
  const source = record(value);
  if (source.symbol === undefined || normalizeSymbol(source.symbol) !== symbol) throw new Error('实时报价证券代码不匹配。');
  const previousClose = source.prev_close === undefined || source.prev_close === null
    ? previous?.previousClose ?? null : price(source.prev_close);
  let candidate: RealtimeQuote | null = null;
  if (snapshot) {
    const candidates: [unknown, Session][] = [
      [source, 'regular'], [source.pre_market_quote, 'pre'],
      [source.post_market_quote, 'post'], [source.overnight_quote, 'overnight'],
    ];
    for (const [entry, session] of candidates) {
      if (entry === undefined || entry === null) continue;
      const quote = record(entry);
      if (quote.last_done === undefined || quote.timestamp === undefined) continue;
      const current = { symbol, price: price(quote.last_done), timestamp: quoteTime(quote.timestamp), previousClose, session };
      if (!candidate || current.timestamp > candidate.timestamp) candidate = current;
    }
  } else {
    if (source.timestamp === undefined) return null;
    const time = quoteTime(source.timestamp);
    // 先检查时间，旧增量的其它字段也不得改写最新状态。
    if (previous && time < previous.timestamp) return null;
    const session = normalizeTradeSession(source.trade_session);
    const currentPrice = source.last_done === undefined
      ? previous && previous.session === session ? previous.price : null : price(source.last_done);
    if (currentPrice === null) return null;
    candidate = { symbol, timestamp: time, price: currentPrice, previousClose, session };
  }
  if (!candidate) return null;
  if (previous && candidate.timestamp < previous.timestamp) {
    // 首推可能先于订阅响应；旧快照仅补充昨收价，不回退价格、时间和时段。
    return snapshot && previousClose !== previous.previousClose ? { ...previous, previousClose } : null;
  }
  return candidate;
}
