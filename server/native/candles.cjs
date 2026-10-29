'use strict';
const { normalizeNativeSymbol, parseNative, resolveCounter, withTimeout } = require('./helpers.cjs');
const { optionIdentity, findCounter, desktopGet, ready } = require('./market-access.cjs');
const LINE_TYPES = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, day: 1000, week: 2000, month: 3000, year: 4000 };

/** 校验K线查询边界，在连接前拒绝无效参数。参数：payload外部请求；返回：规范证券代码。 */
function validateCandleQuery(payload) {
  const symbol = normalizeNativeSymbol(payload?.symbol);
  optionIdentity(symbol);
  if (typeof payload.period !== 'string' || !Object.hasOwn(LINE_TYPES, payload.period) || !Number.isInteger(payload.count) || payload.count < 1 || payload.count > 1000 || (payload.timestamp !== undefined && (typeof payload.timestamp !== 'string' || !/^\d{1,12}$/.test(payload.timestamp)))) throw new Error('桌面K线参数无效');
  return symbol;
}

/** 核验目标缓存，失败时从真实搜索或期权链解析。参数：worker会话、symbol规范代码；返回：精确counter。 */
async function candleCounter(worker, symbol) {
  const cached = worker.targets.get(symbol)?.counter;
  let counter;
  if (cached) {
    try { counter = resolveCounter({ data: [{ code: cached.split('/')[2], market: symbol.slice(-2), counter_id: cached }] }, symbol); }
    catch { worker.send('log', { kind: 'info', message: '忽略不匹配的证券缓存，重新精确搜索' }); }
    if (optionIdentity(symbol) && counter !== `OP/US/${symbol.slice(0, -3)}`) counter = undefined;
  }
  return counter ?? await findCounter(worker, symbol);
}

/** 解析K线数字文法，保留trim、符号及科学计数法，避免重复Number转换。参数：value原生字段、key字段名；返回：有限数字。 */
function candleNumber(value, key) {
  if (!['string', 'number'].includes(typeof value) || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/i.test(String(value).trim())) throw new Error(`桌面K线${key}字段无效`);
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`桌面K线${key}字段无效`);
  return result;
}

/** 校验单根真实OHLCV，不接受空值或从报价拼柱。参数：row原生柱；返回：规范原始柱。 */
function candleRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('桌面K线柱结构无效');
  const fields = { timestamp: row.timestamp, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume ?? row.amount };
  const result = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, candleNumber(value, key)]));
  const { timestamp, open, high, low, close, volume } = result;
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || low <= 0 || high < Math.max(open, close) || low > Math.min(open, close) || volume < 0) throw new Error('桌面K线价格或时间无效');
  return result;
}

/** 校验响应数量及证券身份。参数：data原生结果、count上限、counter可选目标；返回：完整规范原始柱数组。 */
function candleRows(data, count, counter) {
  if (!Number.isInteger(count) || count < 1 || count > 1000 || !Array.isArray(data?.klines) || data.klines.length > count) throw new Error('桌面K线响应数量无效');
  if (counter !== undefined && data.counter_id !== undefined && data.counter_id !== counter) throw new Error('桌面K线合约身份不匹配');
  return Array.from(data.klines, candleRow);
}

/** 查询桌面原生证券K线，失败走同版HTTP回退。参数：worker会话、payload周期数量游标；返回：原始OHLCV或附带传输来源的结果。 */
async function readCandles(worker, payload) {
  const symbol = validateCandleQuery(payload);
  const assertCurrent = await ready(worker); assertCurrent();
  const counter = await candleCounter(worker, symbol); assertCurrent();
  const params = { counter_id: counter, line_type: LINE_TYPES[payload.period], line_num: payload.count, adjust_type: 0, kline_session: 0, timestamp: payload.timestamp ?? '', direction: 0, include_turnover_rate: true };
  let rows; let transport = 'desktop-ws';
  try {
    const response = parseNative(await withTimeout(worker.native.quoteKline.call(worker.socket, JSON.stringify(params)), 5000));
    assertCurrent();
    if (response.code !== undefined && ![0, '0'].includes(response.code)) throw new Error('桌面WS K线请求被拒绝');
    rows = candleRows(response.data === undefined ? response : response.data, payload.count, counter);
  } catch {
    assertCurrent();
    worker.send('log', { kind: 'info', message: 'K线WS请求失败，使用桌面HTTP回退' });
    const data = await desktopGet(worker, '/v3/quote/kline', { ...params, new_version_kline: true });
    assertCurrent();
    rows = candleRows(data, payload.count, counter); transport = 'desktop-http';
  }
  assertCurrent();
  return payload.withTransport ? { rows, transport } : rows;
}

module.exports = { readCandles, candleRows };
