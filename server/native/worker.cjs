'use strict';
/** 独立桌面行情及扫码会话子进程；凭据不离开进程，不提供交易或账户查询接口。 */
const { normalizeNativeSymbol, parseNative, resolveCounter, publicError, withTimeout, searchNativeSecurities, sameSessionGeneration } = require('./helpers.cjs');
const { normalizeNativeQuote, mergeNativeQuoteSnapshot } = require('./quote.cjs');
const { optionIdentity, findCounter, desktopGet } = require('./market-access.cjs');
const { readCandles } = require('./candles.cjs');
const { readIntraday } = require('./intraday.cjs');
const { validateDesktopEndpoint } = require('./desktop-endpoints.cjs');
const { NativeAuthSession } = require('./auth-session.cjs');
const { initializeNative } = require('./bootstrap.cjs');

class NativeQuoteWorker {
  /** 创建可测试的只读桥接。参数：native原生导出、send事件回调、endpoints自动识别的配套端点；返回：新实例。 */
  constructor(native, send, endpoints) {
    this.native = native; this.send = send;
    this.endpoints = endpoints ? { api: validateDesktopEndpoint(endpoints.api, 'https:'),
      quoteGateway: validateDesktopEndpoint(endpoints.quoteGateway, 'wss:'), lbGatewayWS: validateDesktopEndpoint(endpoints.lbGatewayWS, 'wss:') } : null;
    this.targets = new Map(); this.socket = null;
    this.generation = 0; this.subscriptionGeneration = 0; this.authenticated = false;
    this.deadline = null; this.httpClient = null;
    this.auth = new NativeAuthSession(this); this.loggedIn = false;
  }

  /** 发送某证券状态。参数：symbol代码、state状态、message安全说明、scope恢复范围；返回：无。 */
  status(symbol, state, message, scope = 'connection') {
    this.send('status', { symbol, state, scope, message: `桌面原生WS${this.loggedIn ? '本地登录会话' : '匿名'}：${message}` });
  }

  /** 广播目标状态。参数：state状态、message说明；返回：无。 */
  allStatus(state, message) {
    for (const symbol of this.targets.keys()) this.status(symbol, state, message);
  }

  /** 检查异步操作仍属于当前目标与连接。参数：entry目标、generation连接代、epoch订阅代；返回：布尔。 */
  current(entry, generation, epoch) {
    return this.targets.get(entry.symbol) === entry && sameSessionGeneration(this, generation, epoch) && this.authenticated && Boolean(this.socket);
  }

  /** 连接原生双通道。参数：无；返回：连接提交状态。 */
  connect() {
    if (this.socket) return { authenticated: this.authenticated };
    if (!this.endpoints) throw new Error('桌面生产端点尚未自动识别，已拒绝连接');
    const generation = ++this.generation;
    this.authenticated = false;
    this.allStatus('connecting', '正在连接行情双通道');
    this.socket = this.native.wsClient(this.endpoints.quoteGateway, this.endpoints.lbGatewayWS,
      (event, data) => {
        if (generation !== this.generation) return;
        try { this.onEvent(event, data); }
        catch { this.allStatus('error', '无法解析行情通道事件'); }
      }, JSON.stringify({ client_features: { usop_extend: '1' } }));
    this.armDeadline();
    return { authenticated: false };
  }

  /** 设置认证超时。参数：无；返回：无。 */
  armDeadline() {
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => {
      if (!this.authenticated) this.allStatus('error', '30秒内未完成行情协议认证');
    }, 30000);
    this.deadline.unref?.();
  }

  /** 接收原生传输事件。参数：event名称、data载荷；返回：无。 */
  onEvent(event, data) {
    if (event === 'message') {
      const parsed = parseNative(data);
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) this.onMessage(message);
    } else if (['reconnecting', 'closed', 'error'].includes(event)) {
      this.resetSubscriptions();
      this.allStatus(event === 'error' ? 'error' : 'reconnecting', event === 'error' ? '行情连接失败' : '等待原生连接恢复并重新订阅');
      this.armDeadline();
    }
  }

  /** 使旧异步任务失效并取消目标重试。参数：无；返回：无。 */
  resetSubscriptions() {
    this.authenticated = false; this.subscriptionGeneration += 1;
    for (const entry of this.targets.values()) {
      clearTimeout(entry.retryTimer); entry.retryTimer = null; entry.retryAttempts = 0;
      entry.pending = false; entry.confirmed = false; entry.counter = null;
    }
  }

  /** 接收认证与行情消息。参数：message已解码消息；返回：无。 */
  onMessage(message) {
    if (message.type === 'authenticated') {
      clearTimeout(this.deadline); this.authenticated = true;
      this.send('connection', { state: 'connected' });
      for (const entry of this.targets.values()) this.activate(entry);
    } else if (message.type === 'rejected') {
      this.resetSubscriptions();
      this.allStatus('error', '行情协议认证被拒绝，请检查行情权限');
      this.armDeadline();
    } else if (this.authenticated && /^quote\/(detail|list)$/.test(message.type)) {
      for (const entry of this.targets.values()) {
        if (!entry.counter || message.counter_id !== entry.counter) continue;
        this.deliver(entry, message.data);
      }
    }
  }

  /** 发布有效报价并确认订阅。参数：entry目标、data原生data；返回：是否发布。 */
  deliver(entry, data) {
    const next = normalizeNativeQuote(data, entry.symbol, entry.latest);
    if (!next) return false;
    entry.latest = next;
    this.confirm(entry);
    this.send('quote', next.quote);
    return true;
  }

  /** 确认目标并取消局部退避。参数：entry当前目标；返回：无。 */
  confirm(entry) {
    clearTimeout(entry.retryTimer); entry.retryTimer = null; entry.retryAttempts = 0;
    if (!entry.confirmed) {
      entry.confirmed = true;
      this.status(entry.symbol, 'connected', '行情认证及目标订阅已确认');
    }
  }

  /** 仅重试当前证券，最多三次，不销毁共享连接。参数：entry目标；返回：无。 */
  retryTarget(entry) {
    if (entry.retryTimer || entry.retryAttempts >= 3) return;
    const generation = this.generation; const epoch = this.subscriptionGeneration;
    const delay = 4000 * (2 ** entry.retryAttempts++);
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      if (this.current(entry, generation, epoch)) this.activate(entry);
    }, delay);
    entry.retryTimer.unref?.();
  }

  /** 异步查找并订阅证券。参数：entry当前目标；返回：无，失败以状态事件报告。 */
  activate(entry) {
    if (!this.authenticated || entry.pending || entry.confirmed) return;
    entry.pending = true;
    const generation = this.generation; const epoch = this.subscriptionGeneration;
    this.activateAsync(entry, generation, epoch).catch(error => {
      if (!this.current(entry, generation, epoch)) return;
      entry.pending = false;
      // 有效推送已证明订阅可用，快照失败不能覆盖此确认。
      if (entry.confirmed) {
        this.send('log', { kind: 'info', message: '目标已由推送确认，已忽略快照失败' });
        return;
      }
      const known = error instanceof Error && /^桌面原生WS(?:未找到|证券搜索|返回)/.test(error.message);
      this.status(entry.symbol, 'error', known ? error.message : publicError(error).message, 'target');
      this.retryTarget(entry);
    });
  }

  /** 执行受代数保护的搜索、订阅、快照。参数：entry目标、generation连接代、epoch订阅代；返回：Promise<void>。 */
  async activateAsync(entry, generation, epoch) {
    const option = optionIdentity(entry.symbol);
    const raw = await searchNativeSecurities(this.native, entry.symbol, 12000);
    let counter;
    try { counter = resolveCounter(raw, entry.symbol); }
    catch (error) {
      if (!option) throw error;
      if (!this.current(entry, generation, epoch)) return;
      counter = await findCounter(this, entry.symbol);
    }
    if (!this.current(entry, generation, epoch)) return;
    const activeSocket = this.socket;
    entry.counter = counter;
    this.native.wsSubscribeV2.call(activeSocket, JSON.stringify([{ counter_id: counter, subtypes: 2 }]));
    const quoteBeforeSnapshot = entry.latest;
    const response = await this.quoteSnapshot(entry, activeSocket, counter);
    if (!this.current(entry, generation, epoch)) return;
    entry.pending = false;
    this.applySnapshot(entry, counter, response, quoteBeforeSnapshot);
  }

  /** 核验并发布当前目标快照，报价合并规则由quote模块负责。参数：entry目标、counter精确身份、response快照、previous读取前状态；返回：无。 */
  applySnapshot(entry, counter, response, previous) {
    if (response.code !== undefined && ![0, '0'].includes(response.code)) throw new Error('桌面原生WS返回失败的行情快照');
    const data = response.data ?? response;
    if (data.counter_id !== counter) throw new Error('桌面原生WS返回不匹配的行情快照');
    entry.latest = mergeNativeQuoteSnapshot(data, entry.symbol, entry.latest, entry.latest !== previous);
    this.confirm(entry);
    this.send('quote', entry.latest.quote);
  }

  /** 读取目标快照，期权WS失败使用桌面同版HTTP。参数：entry目标、socket当前连接、counter身份；返回：快照包装。 */
  async quoteSnapshot(entry, socket, counter) {
    const generation = this.generation; const epoch = this.subscriptionGeneration;
    try {
      const response = parseNative(await withTimeout(this.native.quoteDetail.call(socket, JSON.stringify({ counter_id: counter }))));
      if (response.code !== undefined && ![0, '0'].includes(response.code)) throw new Error('桌面原生WS返回失败的行情快照');
      return response;
    } catch (error) {
      if (!this.httpClient || entry.confirmed || !this.current(entry, generation, epoch)) throw error;
      this.send('log', { kind: 'info', message: '报价WS请求失败，使用桌面HTTP回退' });
      return { data: await desktopGet(this, optionIdentity(entry.symbol) ? '/v2/quote/option/detail' : '/v3/quote/stock/detail', { counter_id: counter }) };
    }
  }

  /** 添加目标，仅精确代码进入搜索。参数：value证券代码；返回：排队状态。 */
  subscribe(value) {
    const symbol = normalizeNativeSymbol(value);
    let entry = this.targets.get(symbol);
    if (!entry) {
      entry = { symbol, counter: null, latest: null, pending: false, confirmed: false, retryTimer: null, retryAttempts: 0 };
      this.targets.set(symbol, entry);
      this.status(symbol, 'connecting', '等待认证与证券精确匹配');
    }
    this.activate(entry);
    return { queued: true };
  }

  /** 移除目标并取消原生订阅。参数：value代码；返回：取消状态。 */
  unsubscribe(value) {
    const symbol = normalizeNativeSymbol(value); const entry = this.targets.get(symbol);
    this.targets.delete(symbol);
    clearTimeout(entry?.retryTimer);
    if (entry?.counter && this.socket) this.native.wsUnsubscribeV2.call(this.socket, JSON.stringify([{ counter_id: entry.counter, subtypes: 2 }]));
    return { removed: true };
  }

  /** 委托隔离扫码会话创建二维码。参数：无；返回：不含令牌的SVG和有效期。 */
  createQr() { return this.auth.createQr(); }

  /** 轮询扫码，成功后切换报价身份并保持现有目标。参数：无；返回：waiting/success安全状态。 */
  async pollQr() {
    const generation = this.auth.generation;
    const result = await this.auth.pollQr();
    this.auth.assertGeneration(generation);
    if (result.state === 'success') { this.loggedIn = true; this.reconnectSession(); }
    return result;
  }

  /** 用新身份重连并保持所有目标。参数：无；返回：连接提交状态。 */
  reconnectSession() {
    this.close(); this.subscriptionGeneration += 1;
    for (const entry of this.targets.values()) entry.latest = null;
    return this.connect();
  }

  /** 关闭子进程自有连接。参数：无；返回：无。 */
  close() {
    clearTimeout(this.deadline); this.generation += 1; this.resetSubscriptions();
    this.auth.cancel();
    const socket = this.socket; this.socket = null;
    if (socket) this.native.wsClose.call(socket);
  }
}

/** 派发受限原生操作，不接受任意方法名或交易操作。参数：worker会话、method操作、payload参数；返回：操作结果或Promise。 */
function dispatchRequest(worker, method, payload) {
  switch (method) {
    case 'connect': return worker.connect();
    case 'subscribe': return worker.subscribe(payload?.symbol);
    case 'unsubscribe': return worker.unsubscribe(payload?.symbol);
    case 'candles': return readCandles(worker, payload);
    case 'intraday': return readIntraday(worker, payload);
    case 'qr-create': return worker.createQr();
    case 'qr-poll': return worker.pollQr();
    default: throw new Error('不支持的原生行情请求');
  }
}

/** 校验IPC请求并构建脱敏响应信封。参数：worker会话、message请求、reply回复函数；返回：请求处理完成Promise。 */
async function handleRequest(worker, message, reply) {
  if (!message || !Number.isSafeInteger(message.id)) return;
  try { reply({ id: message.id, result: await dispatchRequest(worker, message.method, message.payload) }); }
  catch (error) { reply({ id: message.id, error: publicError(error) }); }
}

/** 启动受限IPC循环，仅负责绑定消息与进程生命周期。参数：无；返回：完成绑定Promise。 */
async function main() {
  const { native, client, endpoints } = await initializeNative();
  const send = (event, data) => { if (process.connected) process.send({ event, data }); };
  const worker = new NativeQuoteWorker(native, send, endpoints);
  worker.httpClient = client;
  send('log', { kind: 'info', category: 'ENDPOINT_SELECTED', message: endpoints.region });
  const reply = message => { if (process.connected) process.send(message); };
  process.on('message', message => handleRequest(worker, message, reply));
  process.on('disconnect', () => { try { worker.close(); } finally { process.exit(0); } });
  send('ready', { isolated: true });
}

if (require.main === module) main().catch(error => {
  const diagnostic = require('./startup-errors.cjs').readStartupFailure(error);
  if (process.connected) process.send({ event: 'fatal', data: { code: diagnostic.code } }, () => process.exit(1));
  else process.exit(1);
});
module.exports = { NativeQuoteWorker, dispatchRequest, handleRequest };
