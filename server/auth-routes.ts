import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthStatus } from '../shared/auth.js';
import { nativeAuth } from './native-auth.js';

/** 写出不缓存的认证JSON。参数：response响应、code状态码、value公开对象；返回：无。 */
function json(response: ServerResponse, code: number, value: AuthStatus | { message: string }): void {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  response.end(JSON.stringify(value));
}

/** 验证认证POST请求及有界空体。参数：request请求；返回：验证完成Promise，非法时抛错。 */
async function validatePost(request: IncomingMessage): Promise<void> {
  if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] ?? '')) || request.headers['x-market-lens'] !== '1') {
    throw new Error('认证操作需要application/json及X-Market-Lens: 1。');
  }
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > 8192) throw new Error('认证请求体超过限制。');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 8192) throw new Error('认证请求体超过限制。');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return;
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('认证请求体必须为空对象。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new Error('认证请求体必须为空对象。');
}

/**
 * 处理同源认证路由；外层负责Host/Origin验证，本层不允许GET改变状态。
 * @param request HTTP请求，POST只接受空JSON和固定自定义头。
 * @param response HTTP响应，JSON永不包含令牌、二维码内容或账户标识。
 * @param url 已由外层解析的请求URL。
 * @returns 请求处理完成Promise。
 */
export async function handleAuthRequest(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;
  if (!['/api/auth/state', '/api/auth/qr', '/api/auth/start', '/api/auth/cancel', '/api/auth/logout'].includes(path)) {
    json(response, 404, { message: '认证接口不存在。' }); return;
  }
  if (path === '/api/auth/state') {
    if (request.method !== 'GET') { json(response, 405, { message: '此接口仅支持GET。' }); return; }
    json(response, 200, nativeAuth.getState()); return;
  }
  if (path === '/api/auth/qr') {
    if (request.method !== 'GET') { json(response, 405, { message: '此接口仅支持GET。' }); return; }
    const revision = url.searchParams.get('revision');
    const svg = revision && /^\d+$/.test(revision) ? nativeAuth.getQr(Number(revision)) : null;
    if (!svg) { json(response, 404, { message: '当前没有有效二维码，请重新生成。' }); return; }
    response.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin' });
    response.end(svg); return;
  }
  if (request.method !== 'POST') { json(response, 405, { message: '认证状态变更仅支持POST。' }); return; }
  try { await validatePost(request); }
  catch (error) { json(response, 400, { message: error instanceof Error ? error.message : '认证请求无效。' }); return; }
  try {
    const status = path === '/api/auth/start' ? await nativeAuth.start()
      : path === '/api/auth/cancel' ? await nativeAuth.cancel() : await nativeAuth.logout();
    json(response, 200, status);
  } catch {
    json(response, 409, { message: '认证操作正在处理，请稍后重试。' });
  }
}
