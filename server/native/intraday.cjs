'use strict';
const { normalizeNativeSymbol, parseNative, withTimeout } = require('./helpers.cjs');
const { desktopGet, findCounter, ready } = require('./market-access.cjs');

// 安装版 TimesharesType（menu-8d4ea620.js:116050），并经隔离股票分时验证。
const SESSIONS = { regular: 0, pre: 2, post: 3, overnight: 4, all: 100 };
const LABELS = { 0: 'regular', 2: 'pre', 3: 'post', 4: 'overnight' };

/** 严格解析非负原生数字。参数：value外部字段、name字段名；返回：有限数字。 */
function numeric(value, name) {
  if (!['number', 'string'].includes(typeof value) || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(String(value)) || !Number.isFinite(Number(value))) throw new Error(`桌面分时${name}字段无效`);
  return Number(value);
}

/** 校验历史查询日期。参数：value外部日期；返回：合法YYYYMMDD，否则抛错。 */
function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) throw new Error('桌面分时日期必须为YYYYMMDD');
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const parsed = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== iso) throw new Error('桌面分时日期无效');
  return value;
}

/** 将分组日历转为交易所日期。参数：seconds分组秒时间、symbol代码；返回：YYYYMMDD。 */
function tradingDate(seconds, symbol) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: symbol.endsWith('.HK') ? 'Asia/Hong_Kong' : 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(seconds * 1000)).replaceAll('-', '');
}

/** 校验桌面真实分钟点。参数：row原生点、session分组时段；返回：归一化层可读原始点。 */
function minuteRow(row, session) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('桌面分时分钟结构无效');
  const timestamp = numeric(row.timestamp, 'timestamp');
  const price = numeric(row.price, 'price');
  // 股票WS amount为成交量；同版HTTP明确提供等值volume，balance才是成交额。
  const volume = numeric(row.volume === undefined ? row.amount : row.volume, 'volume');
  if (row.amount !== undefined && numeric(row.amount, 'amount') !== volume) throw new Error('桌面分时amount与volume不一致');
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > 253402300799 || price <= 0) throw new Error('桌面分时价格或秒时间无效');
  const avg_price = row.avg_price === undefined || row.avg_price === null || row.avg_price === '' ? null : numeric(row.avg_price, 'avg_price');
  return { timestamp, price, volume, avg_price, trade_session: session };
}

/** 校验并展开分组响应，绝不把其他时段替代目标。参数：data响应、payload查询、counter精确身份；返回：原始点数组。 */
function intradayRows(data, payload, counter) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.timeshares) || data.timeshares.length > 8) throw new Error('桌面分时分组结构无效');
  if (data.counter_id !== undefined && data.counter_id !== counter) throw new Error('桌面分时证券身份不匹配');
  const points = [];
  let count = 0;
  for (const group of data.timeshares) {
    if (!group || typeof group !== 'object' || !Array.isArray(group.minutes) || !Object.hasOwn(LABELS, group.trade_session)) throw new Error('桌面分时时段结构无效');
    const date = numeric(group.date, 'date');
    if (!Number.isSafeInteger(date) || date <= 0 || date > 253402300799) throw new Error('桌面分时交易日无效');
    if (payload.date && tradingDate(date, payload.symbol) !== payload.date) throw new Error('桌面历史分时返回了其他日期');
    count += group.minutes.length;
    if (count > 6000) throw new Error('桌面分时分钟数量超限');
    const session = LABELS[group.trade_session];
    for (const row of group.minutes) {
      const point = minuteRow(row, session);
      // 美股夜盘从交易日前一日20:00开始；保留绝对秒，不能按自然日截掉夜盘。
      if (point.timestamp < date - 14400 || point.timestamp >= date + 90000) throw new Error('桌面分时时间不属于响应交易日');
      if (payload.symbol.endsWith('.HK') && session !== 'regular') continue;
      if (payload.session === 'all' || payload.session === session) points.push(point);
    }
  }
  return points;
}

/** 读取真实桌面分时，当前WS优先、HTTP回退，历史仅HTTP。参数：worker会话、payload代码时段日期；返回：原始分钟点数组。 */
async function readIntraday(worker, payload) {
  const symbol = normalizeNativeSymbol(payload?.symbol);
  if (typeof payload.session !== 'string' || !Object.hasOwn(SESSIONS, payload.session)) throw new Error('桌面分时时段无效');
  const date = payload.date === undefined ? undefined : validateDate(payload.date);
  if (symbol.endsWith('.HK') && !['regular', 'all'].includes(payload.session)) return payload.withTransport ? { rows: [], transport: 'desktop-ws' } : [];
  const assertCurrent = await ready(worker); assertCurrent();
  const counter = await findCounter(worker, symbol); assertCurrent();
  const selection = { symbol, session: payload.session, date };
  // 历史接口实测忽略2/3/4而返回常规，100才返回完整分组，必须按响应时段筛选。
  const params = { counter_id: counter, trade_session: date ? 100 : SESSIONS[payload.session], adjust_type: 0, avg_price: 1 };
  if (date) {
    const data = await desktopGet(worker, '/v1/quote/stock/history_timeshares', { ...params, date });
    assertCurrent();
    const rows = intradayRows(data, selection, counter);
    return payload.withTransport ? { rows, transport: 'desktop-http' } : rows;
  }
  try {
    const response = parseNative(await withTimeout(worker.native.quoteMinute.call(worker.socket, JSON.stringify(params)), 5000));
    assertCurrent();
    if (response.code !== undefined && ![0, '0'].includes(response.code)) throw new Error('桌面WS分时请求被拒绝');
    const rows = intradayRows(response.data === undefined ? response : response.data, selection, counter);
    return payload.withTransport ? { rows, transport: 'desktop-ws' } : rows;
  } catch {
    assertCurrent();
    worker.send('log', { kind: 'info', message: '分时WS请求失败，使用桌面HTTP回退' });
    const data = await desktopGet(worker, '/v5/quote/stock/timeshares', params);
    assertCurrent();
    const rows = intradayRows(data, selection, counter);
    return payload.withTransport ? { rows, transport: 'desktop-http' } : rows;
  }
}

module.exports = { readIntraday, intradayRows };
