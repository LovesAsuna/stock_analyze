import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { demoMarket, demoWorkspace, demoIntraday } from './demo.js';
import { liveIntraday } from './intraday.js';
import { openIntradayStream, closeIntradayStreams } from './intraday-stream.js';
import { liveFundamentals } from './fundamentals.js';
import { demoFundamentals } from './demo-fundamentals.js';
import { liveEvents } from './events.js';
import { demoEvents } from './demo-events.js';
import { validateIntradaySelection, type IntradaySession } from '../shared/intraday.js';
import { isPeriod } from '../shared/periods.js';
import { liveMarket, liveWorkspace, normalizeSymbol } from './longbridge.js';
import { openMarketStream, closeMarketStreams, setNativeQuoteProvider } from './market-stream.js';
import { subscribeNativeQuote, closeNativeSession } from './native-feed.js';
import { handleAuthRequest } from './auth-routes.js';
import { handleChartLab } from './chart-lab.js';
import type { Period } from '../shared/types.js';

setNativeQuoteProvider(subscribeNativeQuote);
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT必须是1024至65535之间的整数');
const production = process.argv.includes('--production');
const dist = resolve('dist');
let active = 0;

/** 返回 JSON，不缓存账户数据；参数为响应、状态和序列化内容。 */
function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  response.end(JSON.stringify(payload));
}

/** 校验 ISO 日期，拒绝溢出日期。返回原始、已验证的日期字符串。 */
function dateParameter(url: URL, key: string): string {
  const value = url.searchParams.get(key) ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error(`${key} 必须为有效的 YYYY-MM-DD 日期。`);
  }
  return value;
}

/** 本机同源门禁：防止其他站点从浏览器读取本机账户信息，不提供 CORS。 */
function allowed(request: IncomingMessage): boolean {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1:5173', 'localhost:5173']);
  if (!hosts.has(request.headers.host ?? '')) return false;
  const origin = request.headers.origin;
  if (origin && !['http://127.0.0.1:5173', 'http://localhost:5173', `http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) return false;
  return !['cross-site'].includes(String(request.headers['sec-fetch-site']));
}

/** 处理只读请求，验证所有系统边界参数；不提供下单或任意 CLI 执行端点。 */
async function api(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  if (!allowed(request)) return json(response, 403, { error: '仅允许本机工作台访问。' });
  if (url.pathname.startsWith('/api/auth/')) return handleAuthRequest(request, response, url);
  if (request.method !== 'GET') return json(response, 405, { error: '接口仅支持读取。' });
  const source = url.searchParams.get('source') ?? 'demo';
  if (!['demo', 'longbridge'].includes(source)) return json(response, 400, { error: '无效数据源。' });
  if (url.pathname === '/api/intraday-stream') {
    try {
      if (source !== 'longbridge') throw new Error('实时分时仅适用于Longbridge数据源。');
      const symbol = normalizeSymbol(url.searchParams.get('symbol'));
      const session = url.searchParams.get('session') ?? 'regular';
      validateIntradaySelection(session, 1);
      openIntradayStream(request, response, symbol, session as IntradaySession);
    } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : '分时连接失败。' }); }
    return;
  }
  if (url.pathname === '/api/stream') {
    try {
      if (source !== 'longbridge') throw new Error('实时行情仅适用于Longbridge数据源。');
      const symbol = normalizeSymbol(url.searchParams.get('symbol'));
      const period = url.searchParams.get('period') as Period;
      if (!isPeriod(period)) throw new Error('不支持的 K 线周期。');
      openMarketStream(request, response, symbol, period);
    } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : '实时行情连接失败。' }); }
    return;
  }
  if (active >= 6) return json(response, 429, { error: '读取请求较多，请稍后重试。' });
  active += 1;
  try {
    if (url.pathname === '/api/workspace') {
      json(response, 200, source === 'demo' ? demoWorkspace() : await liveWorkspace());
    } else if (url.pathname === '/api/events') {
      const scope = url.searchParams.get('scope');
      if (scope !== 'global' && scope !== 'security') throw new Error('事件范围必须为 global 或 security。');
      const symbol = scope === 'security' ? normalizeSymbol(url.searchParams.get('symbol')) : undefined;
      json(response, 200, source === 'demo' ? demoEvents(scope, symbol) : await liveEvents(scope, symbol));
    } else if (url.pathname === '/api/fundamentals') {
      const symbol = normalizeSymbol(url.searchParams.get('symbol'));
      json(response, 200, source === 'demo' ? demoFundamentals(symbol) : await liveFundamentals(symbol));
    } else if (url.pathname === '/api/intraday') {
      const symbol = normalizeSymbol(url.searchParams.get('symbol'));
      const session = url.searchParams.get('session') ?? 'regular';
      const days = Number(url.searchParams.get('days') ?? '1');
      validateIntradaySelection(session, days);
      json(response, 200, source === 'demo' ? demoIntraday(symbol, session as IntradaySession, days as 1 | 5)
        : await liveIntraday(symbol, session as IntradaySession, days as 1 | 5));
    } else if (url.pathname === '/api/market') {
      const symbol = normalizeSymbol(url.searchParams.get('symbol'));
      const period = url.searchParams.get('period') as Period;
      if (!isPeriod(period)) throw new Error('不支持的 K 线周期。');
      const start = dateParameter(url, 'start');
      const end = dateParameter(url, 'end');
      const days = (Date.parse(end) - Date.parse(start)) / 86400000;
      if (days <= 0 || days > 93) throw new Error('复盘区间应大于 0 天且不超过 93 天。');
      if (Date.parse(end) > Date.now() + 8 * 86400000) throw new Error('复盘结束日期不能超过当前日期 8 天。');
      json(response, 200, source === 'demo' ? demoMarket(symbol, period, start, end) : await liveMarket(symbol, period, start, end));
    } else json(response, 404, { error: '未找到数据接口。' });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : '数据读取失败，请重试。' });
  } finally { active -= 1; }
}

/** 生产模式静态服务，限制路径在 dist 内，返回单页应用入口。 */
async function staticFile(response: ServerResponse, pathname: string): Promise<void> {
  try {
    let path = resolve(dist, `.${decodeURIComponent(pathname)}`);
    if (path !== dist && !path.startsWith(dist + sep)) return json(response, 403, { error: '路径不可访问。' });
    try { if (!(await stat(path)).isFile()) path = resolve(dist, 'index.html'); }
    catch { path = resolve(dist, 'index.html'); }
    const content = await readFile(path);
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
    response.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    response.end(content);
  } catch { json(response, 404, { error: '请先运行 bun run build。' }); }
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  const task = url.pathname.startsWith('/chart-lab/')
    ? request.method === 'GET' && (allowed(request) || (['/chart-lab/runtime.js', '/chart-lab/runtime.wasm'].includes(url.pathname)
      && ['127.0.0.1:5173', 'localhost:5173', `127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host ?? '')))
      ? handleChartLab(response, new URL(request.url ?? '/', `http://${request.headers.host}`), request.headers.referer)
      : Promise.resolve(json(response, 403, { error: '仅允许本机图表实验。' }))
    : url.pathname.startsWith('/api/') ? api(request, response, url)
    : production ? staticFile(response, url.pathname) : Promise.resolve(json(response, 404, { error: '请访问 http://127.0.0.1:5173' }));
  task.catch(() => { if (!response.headersSent) json(response, 500, { error: '服务端读取失败。' }); });
});
let closing: Promise<void> | null = null;
/** 服务停止时先关闭流并等待隔离登录会话退出。参数：无；返回：幂等清理Promise。 */
function shutdown(): Promise<void> {
  if (closing) return closing;
  closing = (async () => {
    closeMarketStreams(); closeIntradayStreams();
    server.close();
    server.closeAllConnections();
    try { await closeNativeSession(); }
    catch { console.error('隔离登录会话清理失败，请检查临时目录权限。'); process.exitCode = 1; }
  })();
  return closing;
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
server.on('close', () => void shutdown());
server.on('error', (error) => { console.error(`工作台服务启动失败：${error.message}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.info(`Market Lens API: http://127.0.0.1:${port}`));
