'use strict';
const { parseNative, withTimeout, authCodes } = require('./helpers.cjs');

/** 隔离子进程内的扫码认证；不拥有报价目标、连接恢复或父进程引用。 */
class NativeAuthSession {
  /** 绑定现有HTTP传输。参数：worker包含native/httpClient/send的会话；返回：新扫码状态。 */
  constructor(worker) {
    this.worker = worker;
    this.generation = 0; this.qrToken = null; this.expiresAt = null;
  }

  /** 使在途扫码失效并删除本地令牌。参数：无；返回：无。 */
  cancel() { this.generation += 1; this.qrToken = null; this.expiresAt = null; }

  /** 检查凭据操作仍属于当前扫码代。参数：generation捕获代；返回：无，旧代抛错。 */
  assertGeneration(generation) {
    if (generation !== this.generation) throw new Error('扫码请求已取消');
  }

  /** 检查当前令牌和有效期。参数：无；返回：无，缺失或过期时抛错。 */
  assertActive() {
    if (!this.qrToken || (this.expiresAt !== null && Date.now() >= this.expiresAt)) throw new Error('无有效扫码会话');
  }

  /** 发送固定认证请求，只记录数字诊断而不记录凭据。参数：path认证路径、payload内部参数；返回：完整业务信封。 */
  async request(path, payload = {}) {
    const { native, httpClient } = this.worker;
    if (!httpClient) throw new Error('认证HTTP客户端未初始化');
    const stage = path === '/v1/auth/request_scan_login' ? 'AUTH_CREATE' : 'AUTH_POLL';
    try {
      const raw = await withTimeout(native.httpRequest.call(httpClient, 'POST', path, JSON.stringify(payload), '{}'), 10000);
      const response = parseNative(raw);
      const result = parseNative(response.body ?? response);
      const codes = { ...authCodes(response), ...authCodes(result) };
      this.worker.send('log', { kind: 'info', message: `${stage}_RESPONSE ${JSON.stringify(codes)}` });
      if (result.code !== undefined && ![0, '0'].includes(result.code)) throw Object.assign(new Error('扫码认证服务返回错误'), { code: codes.code });
      return result;
    } catch (error) {
      this.worker.send('log', { kind: 'error', message: `${stage}_FAILED ${JSON.stringify(authCodes(error))}` });
      throw error;
    }
  }

  /** 创建二维码，只回传SVG和有效期。参数：无；返回：不含令牌的二维码结果。 */
  async createQr() {
    const generation = ++this.generation;
    this.qrToken = null;
    const result = await this.request('/v1/auth/request_scan_login');
    this.assertGeneration(generation);
    const token = result.data?.token;
    if (typeof token !== 'string' || !token || token.length > 4096) throw new Error('扫码服务未返回有效二维码');
    const seconds = Number(result.data.expires_in);
    const expiresIn = Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.min(seconds, 600)) : 180;
    const expiresAt = Date.now() + expiresIn * 1000;
    const QRCode = require('qrcode');
    const svg = await QRCode.toString(`lb://page_flutter/web_login/submit?token=${encodeURIComponent(token)}`, { type: 'svg', width: 280, margin: 4, errorCorrectionLevel: 'M' });
    this.assertGeneration(generation);
    this.qrToken = token; this.expiresAt = expiresAt;
    return { svg, expiresIn, expiresAt };
  }

  /** 逐步写入隔离HTTP session，每次异步写入后重新确认代数。参数：credentials认证凭据、generation捕获代；返回：写入完成Promise。 */
  async writeCredentials(credentials, generation) {
    const { native, httpClient } = this.worker;
    if (typeof credentials.token !== 'string' || !credentials.token || credentials.token.length > 8192) throw new Error('扫码登录返回无效凭据');
    await native.httpSetSession.call(httpClient, 'token', credentials.token);
    this.assertGeneration(generation);
    if (typeof credentials.refresh_token === 'string' && credentials.refresh_token) {
      await native.httpSetSession.call(httpClient, 'refresh_token', credentials.refresh_token);
    }
    this.assertGeneration(generation);
  }

  /** 轮询扫码并仅为当前请求写入凭据，不处理报价重连。参数：无；返回：waiting/success安全状态。 */
  async pollQr() {
    this.assertActive();
    const generation = this.generation; const token = this.qrToken;
    const result = await this.request('/v1/auth/scan_login', { token });
    if (generation !== this.generation || token !== this.qrToken || (this.expiresAt !== null && Date.now() >= this.expiresAt)) throw new Error('扫码请求已取消或过期');
    const credentials = result.data?.credentials;
    if (!credentials) return { state: 'waiting' };
    await this.writeCredentials(credentials, generation);
    this.assertGeneration(generation);
    this.qrToken = null;
    return { state: 'success' };
  }
}

module.exports = { NativeAuthSession };
