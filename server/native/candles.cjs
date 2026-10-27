'use strict';
const { normalizeNativeSymbol, parseNative, resolveCounter, withTimeout, authCodes } = require('./helpers.cjs');

const LINE_TYPES = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, day: 1000, week: 2000, month: 3000, year: 4000 };

/** 解析美股期权身份，保留代码原值。参数：symbol公开代码；返回：身份或null。 */
function optionIdentity(symbol) {
  if (typeof symbol !== 'string' || symbol.length > 35) return null;
  const match = /^([A-Z][A-Z0-9.]*?)(\d{2})(\d{2})(\d{2})([CP])(\d+)\.US$/.exec(symbol);
  if (!match) return null;
  const date = `20${match[2]}-${match[3]}-${match[4]}`;
  const strike = Number(match[6]);
  if (!Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || !Number.isSafeInteger(strike) || strike <= 0) throw new Error('期权到期日或行权价无效');
  return { root: match[1], date: date.replaceAll('-', ''), direction: match[5], strike };
}

/** 固定桌面只读GET，解包原生HTTP结构。参数：worker会话、path白名单路径、params参数；返回：数据对象。 */
async function desktopGet(worker, path, params) {
  if (!['/v4/gemini/optionchain-date-list', '/v4/gemini/option-list', '/v3/quote/kline', '/v2/quote/option/detail', '/v3/quote/stock/detail', '/v5/quote/stock/timeshares', '/v1/quote/stock/history_timeshares'].includes(path)) throw new Error('不支持的桌面行情路径');
  if (!worker.httpClient) throw new Error('桌面行情HTTP客户端未初始化');
  const raw = parseNative(await withTimeout(worker.native.httpRequest.call(worker.httpClient, 'GET', path, JSON.stringify(params), '{}'), 5000));
  const response = raw.body === undefined ? raw : parseNative(raw.body);
  for (const envelope of [raw, response]) {
    if (authCodes(envelope).httpStatus >= 300 || (envelope.code !== undefined && ![0, '0'].includes(envelope.code))) throw new Error('桌面行情请求被拒绝');
  }
  return parseNative(response.data === undefined ? response : response.data);
}

/** 固定当前连接及订阅代，阻止旧任务跨会话继续请求。参数：worker会话；返回：会话校验函数。 */
function sessionGuard(worker) {
  const generation = worker.generation; const epoch = worker.subscriptionGeneration; const socket = worker.socket;
  return () => {
    if (generation !== worker.generation || epoch !== worker.subscriptionGeneration || socket !== worker.socket || !worker.socket || !worker.authenticated) throw new Error('桌面行情会话已切换，忽略旧K线');
  };
}

/** 从真实期权链匹配counter，普通证券仍使用精确搜索。参数：worker会话、symbol代码；返回：唯一counter。 */
async function findCounter(worker, symbol) {
  symbol = normalizeNativeSymbol(symbol);
  const assertCurrent = sessionGuard(worker); assertCurrent();
  const identity = optionIdentity(symbol);
  const searchSymbol = identity ? `${identity.root}.US` : symbol;
  const raw = await withTimeout(worker.native.searchSecurities(JSON.stringify({ term: searchSymbol.slice(0, -3), markets: [searchSymbol.slice(-2)], products: [], is_code_exact_match: true, limit: 100 })), 5000);
  assertCurrent();
  const underlying = resolveCounter(raw, searchSymbol);
  if (!identity) return underlying;
  const dates = await desktopGet(worker, '/v4/gemini/optionchain-date-list', { underlying_counter_id: underlying });
  assertCurrent();
  if (!Array.isArray(dates.expire_date_list)) throw new Error('桌面期权到期日列表结构无效');
  const attributes = [...new Set(dates.expire_date_list.filter(entry => entry && entry.expire_date === identity.date && typeof entry.standard_attr === 'string' && /^[A-Z0-9_-]{1,16}$/.test(entry.standard_attr)).map(entry => entry.standard_attr))];
  if (!attributes.length || attributes.length > 4) throw new Error('桌面期权链未找到可核验的到期日');
  const counters = new Set();
  for (const standard_attr of attributes) {
    const chain = await desktopGet(worker, '/v4/gemini/option-list', { underlying_counter_id: underlying, expire_date: identity.date, standard_attr });
    assertCurrent();
    if (!Array.isArray(chain.strike_price)) throw new Error('桌面期权链结构无效');
    for (const row of chain.strike_price) {
      const counter = row?.[identity.direction === 'C' ? 'call_counter_id' : 'put_counter_id'];
      // 保留完整合约代码，不能把不同补零形式或调整合约视为同一身份。
      if (counter !== `OP/US/${symbol.slice(0, -3)}`) continue;
      if (['string', 'number'].includes(typeof row.price) && String(row.price).trim() !== '' && Number(row.price) === identity.strike / 1000) counters.add(counter);
    }
  }
  if (counters.size !== 1) throw new Error('桌面期权链未找到唯一精确合约');
  return [...counters][0];
}

/** 等待当前原生协议认证，保留共享连接。参数：worker会话；返回：当前会话校验函数。 */
async function ready(worker) {
  worker.connect();
  const assertCurrent = sessionGuard(worker);
  if (worker.authenticated) { assertCurrent(); return assertCurrent; }
  const generation = worker.generation; const epoch = worker.subscriptionGeneration; const socket = worker.socket;
  await new Promise((resolve, reject) => {
    const finish = error => { clearInterval(interval); clearTimeout(timer); error ? reject(error) : resolve(); };
    const interval = setInterval(() => {
      if (!worker.socket || socket !== worker.socket || generation !== worker.generation || epoch !== worker.subscriptionGeneration) finish(new Error('桌面行情连接已切换'));
      else if (worker.authenticated) finish();
    }, 50);
    const timer = setTimeout(() => finish(new Error('桌面行情协议尚未就绪，请稍后重试')), 8000);
  });
  assertCurrent(); return assertCurrent;
}

/** 验证原生柱字段，不接受空值或用报价拼柱。参数：data原生结果、count上限、counter可选目标；返回：规范原始柱数组。 */
function candleRows(data, count, counter) {
  if (!Number.isInteger(count) || count < 1 || count > 1000 || !Array.isArray(data?.klines) || data.klines.length > count) throw new Error('桌面K线响应数量无效');
  if (counter !== undefined && data.counter_id !== undefined && data.counter_id !== counter) throw new Error('桌面K线合约身份不匹配');
  return Array.from(data.klines, row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('桌面K线柱结构无效');
    const fields = { timestamp: row.timestamp, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume ?? row.amount };
    for (const [key, value] of Object.entries(fields)) if (!['string', 'number'].includes(typeof value) || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/i.test(String(value).trim()) || !Number.isFinite(Number(value))) throw new Error(`桌面K线${key}字段无效`);
    const { timestamp, open, high, low, close, volume } = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, Number(value)]));
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || low <= 0 || high < Math.max(open, close) || low > Math.min(open, close) || volume < 0) throw new Error('桌面K线价格或时间无效');
    return { timestamp, open, high, low, close, volume };
  });
}

/** 查询桌面原生证券K线，失败走同版HTTP回退。参数：worker会话、payload周期数量游标；返回：原始OHLCV。 */
async function readCandles(worker, payload) {
  const symbol = normalizeNativeSymbol(payload?.symbol);
  optionIdentity(symbol); // 若形似期权，继续严格核验到期日和行权价。
  if (typeof payload.period !== 'string' || !Object.hasOwn(LINE_TYPES, payload.period) || !Number.isInteger(payload.count) || payload.count < 1 || payload.count > 1000 || (payload.timestamp !== undefined && (typeof payload.timestamp !== 'string' || !/^\d{1,12}$/.test(payload.timestamp)))) throw new Error('桌面K线参数无效');
  const assertCurrent = await ready(worker); assertCurrent();
  const cached = worker.targets.get(symbol)?.counter;
  let counter;
  if (cached) {
    try { counter = resolveCounter({ data: [{ code: cached.split('/')[2], market: symbol.slice(-2), counter_id: cached }] }, symbol); }
    catch { worker.send('log', { kind: 'info', message: '忽略不匹配的证券缓存，重新精确搜索' }); }
    if (optionIdentity(symbol) && counter !== `OP/US/${symbol.slice(0, -3)}`) counter = undefined;
  }
  counter ??= await findCounter(worker, symbol);
  assertCurrent();
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

module.exports = { optionIdentity, findCounter, desktopGet, readCandles, candleRows, ready, sessionGuard };
