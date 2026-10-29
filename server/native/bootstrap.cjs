'use strict';
const { join, resolve } = require('node:path');
const { resolveDesktopInstallation } = require('./desktop-installation.cjs');
const { readDesktopMain } = require('./desktop-resources.cjs');
const { installDesktopTimestampFromSource } = require('./native-compat-timestamp.cjs');
const { parseDesktopEndpoints, selectDesktopEndpoints } = require('./desktop-endpoints.cjs');
const { startupFailure } = require('./startup-errors.cjs');

/** 验证子进程只使用自有用户目录。参数：environment子进程环境，默认当前环境；返回：无，隔离条件不符时抛错。 */
function assertIsolation(environment = process.env) {
  const isolation = environment.LB_ENGINE_ISOLATION;
  if (!isolation || resolve(environment.APPDATA || '') !== resolve(join(isolation, 'AppData', 'Roaming')) || resolve(environment.HOME || '') !== resolve(isolation)) throw new Error('原生行情必须使用隔离目录');
}

/** 检查新建HTTP session不含桌面登录态。参数：native原生导出、client隔离HTTP客户端；返回：无，检查失败或发现登录态时抛错。 */
async function assertAnonymousSession(native, client) {
  let hasSession = false;
  try { hasSession = Boolean(await native.httpGetSession.call(client, 'token')); }
  catch (error) { if (String(error) !== 'not found') throw new Error('无法检查隔离会话'); }
  if (hasSession) throw new Error('匿名行情隔离会话含有登录态，已拒绝连接');
}

/** 按兼容性阶段初始化独立引擎；源码只读取一次且不进入长期回调。参数：无；返回：原生导出、HTTP客户端及同区域端点。 */
async function initializeNative() {
  let stage = 'ISOLATION';
  try {
    assertIsolation();
    stage = 'INSTALL_MISSING';
    const installation = resolveDesktopInstallation();
    stage = 'NATIVE_LOAD';
    const native = require(installation.addonPath);
    stage = 'TIMESTAMP_COMPAT';
    let source = readDesktopMain(installation.asarPath);
    installDesktopTimestampFromSource(native, source);
    stage = 'ENGINE_INIT';
    native.initEngine(JSON.stringify({ app_id: 'global.longbridge.app.desktop', env: 'prod', version: '2.38.18', build: 'c51f69d8', language: 'zh-CN', enable_sentry: false, beacon: { type: 'noop' } }));
    stage = 'ENDPOINT_CONFIG';
    const candidates = parseDesktopEndpoints(source);
    source = null;
    stage = 'ENDPOINT_UNAVAILABLE';
    const endpoints = await selectDesktopEndpoints(candidates);
    stage = 'HTTP_INIT';
    const client = native.httpNew(JSON.stringify({ base_url: endpoints.api, headers: {}, http2: false, doh: false }));
    stage = 'SESSION_CHECK';
    await assertAnonymousSession(native, client);
    return { native, client, endpoints };
  } catch (error) { throw startupFailure(stage, error); }
}

module.exports = { initializeNative, assertIsolation, assertAnonymousSession };
