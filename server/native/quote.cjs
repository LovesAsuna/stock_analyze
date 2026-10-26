'use strict';
const { normalizeNativeSymbol } = require('./helpers.cjs');

/** 解析原生有限数字；拒绝隐式布尔/空白转换。参数：value字段；返回：数字或null。 */
function numeric(value) {
  if (!['string', 'number'].includes(typeof value) || !/^-?\d+(?:\.\d+)?$/.test(String(value))) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 识别已验证的桌面交易状态。参数：value trade_status；返回：公共时段枚举。 */
function tradeSession(value) {
  const status = numeric(value);
  if (status === 206) return 'pre';
  if (status === 207) return 'post';
  // 202已由QQQ开盘PushPrice实测；其它状态不按时间或市场猜测。
  return status === 202 ? 'regular' : 'unknown';
}

/**
 * 将桌面报价增量合并为共享实时报价，保留原生字段供下次增量使用。
 * 参数：value原生data、symbol目标代码、previous先前内部状态；返回：新内部状态或null。
 * 复用原quote.cjs的last_done/market_price与prev_close规则；不处理amount，避免单笔量伪装累计量。
 */
function normalizeNativeQuote(value, symbol, previous = null) {
  symbol = normalizeNativeSymbol(symbol);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value.quote && typeof value.quote === 'object' ? value.quote : value;
  const old = previous?.quote?.symbol === symbol ? previous : null;
  const fields = { ...(old?.fields || {}) };
  const session = source.trade_status === undefined ? old?.quote.session ?? 'unknown' : tradeSession(source.trade_status);
  // 快照盘前/盘后使用market_timestamp；实际推送timestamp本身就是事件时间。
  const timeValue = source.sequence === undefined && ['pre', 'post'].includes(session) && numeric(source.market_timestamp) > 0
    ? source.market_timestamp : source.timestamp;
  const timestamp = numeric(timeValue);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > 8640000000000) return null;
  if (old && timestamp < old.quote.timestamp) return null;
  for (const key of ['last_done', 'market_price', 'prev_close']) {
    const number = numeric(source[key]);
    if (number !== null && number > 0) fields[key] = number;
  }
  if (source.market_price === '') delete fields.market_price;
  const extended = ['pre', 'post'].includes(session);
  // 切换到盘前/盘后时不能借用常规收盘价伪装该时段现价。
  const price = extended ? fields.market_price : fields.last_done;
  if (!(price > 0)) return null;
  return { fields, quote: { symbol, timestamp, price, previousClose: fields.prev_close ?? null, session } };
}

module.exports = { normalizeNativeQuote, tradeSession, numeric };
