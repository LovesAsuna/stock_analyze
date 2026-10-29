'use strict';
const { normalizeNativeSymbol, parseNative, resolveCounter, withTimeout, authCodes, searchNativeSecurities, sameSessionGeneration } = require('./helpers.cjs');

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
    if (!sameSessionGeneration(worker, generation, epoch) || socket !== worker.socket || !worker.socket || !worker.authenticated) throw new Error('桌面行情会话已切换，忽略旧K线');
  };
}

/** 从真实期权链匹配counter，普通证券仍使用精确搜索。参数：worker会话、symbol代码；返回：唯一counter。 */
async function findCounter(worker, symbol) {
  symbol = normalizeNativeSymbol(symbol);
  const assertCurrent = sessionGuard(worker); assertCurrent();
  const identity = optionIdentity(symbol);
  const searchSymbol = identity ? `${identity.root}.US` : symbol;
  const raw = await searchNativeSecurities(worker.native, searchSymbol, 5000);
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
      // 不把不同补零形式或调整合约视为同一身份，保留完整合约代码。
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
      if (!worker.socket || socket !== worker.socket || !sameSessionGeneration(worker, generation, epoch)) finish(new Error('桌面行情连接已切换'));
      else if (worker.authenticated) finish();
    }, 50);
    const timer = setTimeout(() => finish(new Error('桌面行情协议尚未就绪，请稍后重试')), 8000);
  });
  assertCurrent(); return assertCurrent;
}

module.exports = { optionIdentity, findCounter, desktopGet, ready, sessionGuard };
