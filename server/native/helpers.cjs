'use strict';

/** 验证美股、ETF、期权及港股代码。参数：value外部代码；返回：规范代码，非法时抛错。 */
function normalizeNativeSymbol(value) {
  if (typeof value !== 'string') throw new Error('原生行情证券代码必须为字符串');
  let symbol = value.trim().toUpperCase();
  if (symbol.length > 35 || !/^(?:[A-Z][A-Z0-9.-]*\.US|\d{1,5}\.HK)$/.test(symbol)) {
    throw new Error('原生行情仅支持最长35字符的美股、ETF、期权或港股代码');
  }
  if (symbol.endsWith('.HK')) {
    const code = Number(symbol.slice(0, -3));
    if (code <= 0) throw new Error('原生行情港股代码必须大于零');
    symbol = `${code}.HK`;
  }
  return symbol;
}

/** 严格解包引擎JSON。参数：value原始结果；返回：对象或数组，非法时抛错。 */
function parseNative(value) {
  const result = typeof value === 'string' ? JSON.parse(value) : value;
  if (!result || typeof result !== 'object') throw new Error('桌面原生WS返回了无效数据');
  return result;
}

/** 规范搜索用代码。参数：code结果代码、market市场；返回：比较用字符串。 */
function comparableCode(code, market) {
  if (typeof code !== 'string' || !/^[A-Z0-9.-]+$/i.test(code)) return null;
  if (market === 'HK') return /^\d{1,5}$/.test(code) ? String(Number(code)) : null;
  return code.toUpperCase();
}

/** 解包搜索列表。参数：value原生搜索结果；返回：证券记录数组。 */
function searchRows(value) {
  const parsed = parseNative(value);
  if (parsed.code !== undefined && ![0, '0'].includes(parsed.code)) throw new Error('桌面原生WS证券搜索失败');
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.data)) return parsed.data;
  throw new Error('桌面原生WS证券搜索返回了无法识别的列表');
}

/** 精确确认代码、市场与counter_id。参数：raw搜索结果、value目标代码；返回：唯一原生counter_id。 */
function resolveCounter(raw, value) {
  const symbol = normalizeNativeSymbol(value);
  const market = symbol.slice(-2);
  const code = symbol.slice(0, -3);
  const matches = new Set();
  for (const row of searchRows(raw)) {
    if (!row || typeof row !== 'object' || row.market !== market || comparableCode(row.code, market) !== code) continue;
    if (typeof row.counter_id !== 'string' || row.counter_id.length > 100) continue;
    const parts = row.counter_id.split('/');
    // 前缀仅使用搜索返回值；不通过股票/ETF/期权类别猜测counter_id。
    if (parts.length !== 3 || !/^[A-Z0-9_-]+$/i.test(parts[0]) || parts[1] !== market || comparableCode(parts[2], market) !== code) continue;
    matches.add(row.counter_id);
  }
  if (matches.size !== 1) throw new Error(matches.size ? '桌面原生WS证券搜索存在多个精确匹配' : '桌面原生WS未找到代码、市场及counter_id一致的证券');
  return [...matches][0];
}

/** 输出固定错误，避免原生异常泄漏响应或凭据。参数：error原始错误；返回：安全错误对象。 */
function publicError(error) {
  const code = error && typeof error === 'object' && Number.isSafeInteger(error.code) ? error.code : null;
  return { message: code === null ? '桌面原生WS匿名行情操作失败，请检查网络、桌面版本与行情权限' : `桌面原生WS匿名行情操作失败（${code}）` };
}

/** 限制原生只读请求等待时间。参数：promise原生请求、milliseconds上限；返回：结果Promise。 */
async function withTimeout(promise, milliseconds = 12000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('桌面原生WS返回超时，请检查网络或行情权限')), milliseconds);
      timer.unref?.();
    })]);
  } finally { clearTimeout(timer); }
}

/** 提取错误诊断白名单，不保留响应正文。参数：value原生结果或异常；返回：数字状态码字段。 */
function authCodes(value) {
  let parsed = value;
  if (typeof value === 'string' && value.length <= 65536) {
    try { parsed = JSON.parse(value); } catch { return {}; }
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const output = {};
  for (const key of ['status', 'status_code', 'statusCode', 'http_status', 'code']) {
    const raw = parsed[key];
    if (!['string', 'number'].includes(typeof raw) || !/^\d{1,9}$/.test(String(raw))) continue;
    const number = Number(raw);
    if (key === 'code') output.code = number;
    else if (number >= 100 && number <= 599) output.httpStatus = number;
  }
  return output;
}

module.exports = { normalizeNativeSymbol, parseNative, resolveCounter, publicError, withTimeout, authCodes };
