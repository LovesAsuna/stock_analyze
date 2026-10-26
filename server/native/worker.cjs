'use strict';
/** 独立桌面行情及扫码会话子进程；凭据不离开进程，不提供交易或账户查询接口。 */
const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { normalizeNativeSymbol, parseNative, resolveCounter, publicError, withTimeout, authCodes } = require('./helpers.cjs');
const { normalizeNativeQuote } = require('./quote.cjs');

class NativeQuoteWorker {
  /** 创建可测试的只读桥接。参数：native原生导出、send事件回调；返回：新实例。 */
  constructor(native, send) {
    this.native = native; this.send = send;
    this.targets = new Map(); this.socket = null;
    this.generation = 0; this.subscriptionGeneration = 0; this.authenticated = false;
    this.deadline = null; this.httpClient = null;
    this.qrToken = null; this.authGeneration = 0; this.loggedIn = false; this.qrExpiresAt = null;
  }

  /** 发送某证券状态。参数：symbol代码、state状态、message安全说明；返回：无。 */
  status(symbol, state, message) {
    this.send('status', { symbol, state, message: `桌面原生WS${this.loggedIn ? '本地登录会话' : '匿名'}：${message}` });
  }

  /** 广播目标状态。参数：state状态、message说明；返回：无。 */
  allStatus(state, message) {
    for (const symbol of this.targets.keys()) this.status(symbol, state, message);
  }

  /** 检查异步操作仍属于当前目标与连接。参数：entry目标、generation连接代、epoch订阅代；返回：布尔。 */
  current(entry, generation, epoch) {
    return this.targets.get(entry.symbol) === entry && this.generation === generation &&
      this.subscriptionGeneration === epoch && this.authenticated && Boolean(this.socket);
  }

  /** 连接原生双通道。参数：无；返回：连接提交状态。 */
  connect() {
    if (this.socket) return { authenticated: this.authenticated };
    const generation = ++this.generation;
    this.authenticated = false;
    this.allStatus('connecting', '正在连接行情双通道');
    this.socket = this.native.wsClient('wss://quote-gl.lbkrs.com', 'wss://ws-gl.lbkrs.com/v1',
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
      this.authenticated = false; this.subscriptionGeneration += 1;
      for (const entry of this.targets.values()) { entry.pending = false; entry.confirmed = false; entry.counter = null; }
      this.allStatus(event === 'error' ? 'error' : 'reconnecting', event === 'error' ? '行情连接失败' : '等待原生连接恢复并重新订阅');
      this.armDeadline();
    }
  }

  /** 接收认证与行情消息。参数：message已解码消息；返回：无。 */
  onMessage(message) {
    if (message.type === 'authenticated') {
      clearTimeout(this.deadline); this.authenticated = true;
      for (const entry of this.targets.values()) this.activate(entry);
    } else if (message.type === 'rejected') {
      this.authenticated = false; this.subscriptionGeneration += 1;
      this.allStatus('error', '行情协议认证被拒绝，请检查行情权限');
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
    if (!entry.confirmed) { entry.confirmed = true; this.status(entry.symbol, 'connected', '行情认证及目标订阅已确认'); }
    this.send('quote', next.quote);
    return true;
  }

  /** 异步查找并订阅证券。参数：entry当前目标；返回：无，失败以状态事件报告。 */
  activate(entry) {
    if (!this.authenticated || entry.pending || entry.confirmed) return;
    entry.pending = true;
    const generation = this.generation; const epoch = this.subscriptionGeneration;
    this.activateAsync(entry, generation, epoch).catch(error => {
      if (!this.current(entry, generation, epoch)) return;
      entry.pending = false;
      const known = error instanceof Error && /^桌面原生WS(?:未找到|证券搜索|返回)/.test(error.message);
      this.status(entry.symbol, 'error', known ? error.message : publicError(error).message);
    });
  }

  /** 执行受代数保护的搜索、订阅、快照。参数：entry目标、generation连接代、epoch订阅代；返回：Promise<void>。 */
  async activateAsync(entry, generation, epoch) {
    const market = entry.symbol.slice(-2); const code = entry.symbol.slice(0, -3);
    // 原生搜索要求products字段；空数组覆盖全产品，避免按目标名称猜测股票/ETF/期权。
    const raw = await withTimeout(this.native.searchSecurities(JSON.stringify({ term: code, markets: [market], is_code_exact_match: true, products: [], limit: 100 })));
    if (!this.current(entry, generation, epoch)) return;
    const counter = resolveCounter(raw, entry.symbol);
    const activeSocket = this.socket;
    entry.counter = counter;
    this.native.wsSubscribeV2.call(activeSocket, JSON.stringify([{ counter_id: counter, subtypes: 2 }]));
    const quoteBeforeSnapshot = entry.latest;
    const response = parseNative(await withTimeout(this.native.quoteDetail.call(activeSocket, JSON.stringify({ counter_id: counter }))));
    if (!this.current(entry, generation, epoch)) return;
    entry.pending = false;
    if (response.code !== undefined && ![0, '0'].includes(response.code)) throw new Error('桌面原生WS返回失败的行情快照');
    const data = response.data ?? response;
    if (data.counter_id !== counter) throw new Error('桌面原生WS返回不匹配的行情快照');
    // 推送可能先于快照；旧快照只补全缺失昨收，不能覆盖价格、时段或时间。
    if (entry.latest !== quoteBeforeSnapshot || (entry.latest && Number(data.timestamp) < entry.latest.quote.timestamp)) {
      const previousClose = Number(data.prev_close);
      if (entry.latest && entry.latest.quote.previousClose === null && previousClose > 0 && Number.isFinite(previousClose)) {
        entry.latest.fields.prev_close = previousClose; entry.latest.quote.previousClose = previousClose;
        this.send('quote', entry.latest.quote);
      }
      return;
    }
    if (!this.deliver(entry, data)) throw new Error('桌面原生WS返回无法确认订阅的行情快照');
  }

  /** 添加目标，仅精确代码进入搜索。参数：value证券代码；返回：排队状态。 */
  subscribe(value) {
    const symbol = normalizeNativeSymbol(value);
    let entry = this.targets.get(symbol);
    if (!entry) {
      entry = { symbol, counter: null, latest: null, pending: false, confirmed: false };
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
    if (entry?.counter && this.socket) this.native.wsUnsubscribeV2.call(this.socket, JSON.stringify([{ counter_id: entry.counter, subtypes: 2 }]));
    return { removed: true };
  }

  /** 发送固定认证请求。参数：path已知路径、payload内部参数；返回：已解包响应。 */
  async authRequest(path, payload = {}) {
    if (!this.httpClient) throw new Error('认证HTTP客户端未初始化');
    const stage = path === '/v1/auth/request_scan_login' ? 'AUTH_CREATE' : 'AUTH_POLL';
    try {
      const raw = await withTimeout(this.native.httpRequest.call(this.httpClient, 'POST', path, JSON.stringify(payload), '{}'), 10000);
      const response = parseNative(raw);
      const result = parseNative(response.body ?? response);
      const codes = { ...authCodes(response), ...authCodes(result) };
      this.send('log', { kind: 'info', message: `${stage}_RESPONSE ${JSON.stringify(codes)}` });
      if (result.code !== undefined && ![0, '0'].includes(result.code)) throw Object.assign(new Error('扫码认证服务返回错误'), { code: codes.code });
      return result;
    } catch (error) {
      const codes = authCodes(error);
      this.send('log', { kind: 'error', message: `${stage}_FAILED ${JSON.stringify(codes)}` });
      throw error;
    }
  }

  /** 创建二维码，仅将本地生成SVG回传服务器。参数：无；返回：SVG和有效期，不含令牌。 */
  async createQr() {
    const generation = ++this.authGeneration;
    this.qrToken = null;
    const result = await this.authRequest('/v1/auth/request_scan_login');
    if (generation !== this.authGeneration) throw new Error('扫码请求已取消');
    const token = result.data?.token;
    if (typeof token !== 'string' || !token || token.length > 4096) throw new Error('扫码服务未返回有效二维码');
    const seconds = Number(result.data.expires_in);
    const expiresIn = Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.min(seconds, 600)) : 180;
    const expiresAt = Date.now() + expiresIn * 1000;
    const QRCode = require('qrcode');
    const svg = await QRCode.toString(`lb://page_flutter/web_login/submit?token=${encodeURIComponent(token)}`, { type: 'svg', width: 280, margin: 4, errorCorrectionLevel: 'M' });
    if (generation !== this.authGeneration) throw new Error('扫码请求已取消');
    this.qrToken = token; this.qrExpiresAt = expiresAt;
    return { svg, expiresIn, expiresAt };
  }

  /** 轮询扫码并只在本代请求写入隔离session。参数：无；返回：waiting/success安全状态。 */
  async pollQr() {
    if (!this.qrToken || (this.qrExpiresAt !== null && Date.now() >= this.qrExpiresAt)) throw new Error('无有效扫码会话');
    const generation = this.authGeneration; const token = this.qrToken;
    const result = await this.authRequest('/v1/auth/scan_login', { token });
    if (generation !== this.authGeneration || token !== this.qrToken || (this.qrExpiresAt !== null && Date.now() >= this.qrExpiresAt)) throw new Error('扫码请求已取消或过期');
    const credentials = result.data?.credentials;
    if (!credentials) return { state: 'waiting' };
    if (typeof credentials.token !== 'string' || !credentials.token || credentials.token.length > 8192) throw new Error('扫码登录返回无效凭据');
    await this.native.httpSetSession.call(this.httpClient, 'token', credentials.token);
    if (generation !== this.authGeneration) throw new Error('扫码请求已取消');
    if (typeof credentials.refresh_token === 'string' && credentials.refresh_token) {
      await this.native.httpSetSession.call(this.httpClient, 'refresh_token', credentials.refresh_token);
    }
    if (generation !== this.authGeneration) throw new Error('扫码请求已取消');
    this.qrToken = null; this.loggedIn = true;
    this.reconnectSession();
    return { state: 'success' };
  }

  /** 用新身份重连并保持所有目标。参数：无；返回：连接提交状态。 */
  reconnectSession() {
    this.close(); this.subscriptionGeneration += 1;
    for (const entry of this.targets.values()) { entry.counter = null; entry.pending = false; entry.confirmed = false; entry.latest = null; }
    return this.connect();
  }

  /** 关闭子进程自有连接。参数：无；返回：无。 */
  close() {
    clearTimeout(this.deadline); this.generation += 1; this.authenticated = false;
    this.authGeneration += 1; this.qrToken = null; this.qrExpiresAt = null;
    const socket = this.socket; this.socket = null;
    if (socket) this.native.wsClose.call(socket);
  }
}

/** 仅在独立启动入口加载已安装引擎。参数：无；返回：初始化后的原生导出。 */
async function initializeNative() {
  const isolation = process.env.LB_ENGINE_ISOLATION;
  if (!isolation || resolve(process.env.APPDATA || '') !== resolve(join(isolation, 'AppData', 'Roaming'))) throw new Error('原生行情必须使用隔离目录');
  const installRoot = process.env.LONGBRIDGE_INSTALL_DIR || 'C:/Program Files (x86)/Longbridge Pro';
  const addonPath = join(installRoot, 'resources/app.asar.unpacked/node_modules/@lb-public/engine-neon/addons/win/x64/engine_neon.node');
  if (!existsSync(addonPath)) throw new Error('未找到本机Longbridge Pro x64引擎');
  const native = require(addonPath);
  require('./native-compat-timestamp.cjs').installDesktopTimestamp(native);
  native.initEngine(JSON.stringify({ app_id: 'global.longbridge.app.desktop', env: 'prod', version: '2.38.18', build: 'c51f69d8', language: 'zh-CN', enable_sentry: false, beacon: { type: 'noop' } }));
  const client = native.httpNew(JSON.stringify({ base_url: 'https://api-gl.lbkrs.com', headers: {}, http2: false, doh: false }));
  let hasSession = false;
  try { hasSession = Boolean(await native.httpGetSession.call(client, 'token')); }
  catch (error) { if (String(error) !== 'not found') throw new Error('无法检查隔离会话'); }
  if (hasSession) throw new Error('匿名行情隔离会话含有登录态，已拒绝连接');
  return { native, client };
}

/** 启动受限IPC循环。参数：无；返回：Promise<void>。 */
async function main() {
  const { native, client } = await initializeNative();
  const send = (event, data) => { if (process.connected) process.send({ event, data }); };
  const worker = new NativeQuoteWorker(native, send);
  worker.httpClient = client;
  process.on('message', async message => {
    if (!message || !Number.isSafeInteger(message.id)) return;
    try {
      let result;
      if (message.method === 'connect') result = worker.connect();
      else if (message.method === 'subscribe') result = worker.subscribe(message.payload?.symbol);
      else if (message.method === 'unsubscribe') result = worker.unsubscribe(message.payload?.symbol);
      else if (message.method === 'qr-create') result = await worker.createQr();
      else if (message.method === 'qr-poll') result = await worker.pollQr();
      else throw new Error('不支持的原生行情请求');
      if (process.connected) process.send({ id: message.id, result });
    } catch (error) {
      if (process.connected) process.send({ id: message.id, error: publicError(error) });
    }
  });
  process.on('disconnect', () => { try { worker.close(); } finally { process.exit(0); } });
  send('ready', { isolated: true });
}

if (require.main === module) main().catch(() => {
  if (process.connected) process.send({ event: 'fatal', data: { message: '桌面原生WS匿名引擎初始化失败，请检查安装目录与版本' } });
  process.exit(1);
});
module.exports = { NativeQuoteWorker };
