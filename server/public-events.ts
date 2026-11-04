import type { MarketEvent } from '../shared/events.js';
import { PUBLIC_EVENT_LABELS, PUBLIC_EVENT_URLS, parsePublicNews, parseFedCalendar, parseFecElection, type PublicProvider } from './public-event-parsers.js';

export interface EventReader { label: string; read: () => Promise<MarketEvent[]> }
const cache = new Map<string, { until: number; events?: MarketEvent[]; error?: Error }>();
const pending = new Map<string, Promise<MarketEvent[]>>();
const MAX_BYTES = 2 * 1024 * 1024;

/** 有限读取固定公开来源，超时涵盖响应正文；不携带用户Cookie、不跟随重定向。参数：URL、只读fetch及来源明确的编码；返回：最多2MiB文本。 */
export async function fetchEventText(url: string, request: typeof fetch = fetch, encoding: 'utf-8' | 'gb18030' = 'utf-8'): Promise<string> {
  const response = await request(url, { signal: AbortSignal.timeout(10_000), redirect: 'error',
    headers: { Accept: 'application/json,text/html', 'User-Agent': 'MarketLens/0.1' } });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 400 || response.status === 401 || response.status === 403
      ? `公开访问受限（HTTP ${response.status}），可能需要站点会话；未读取登录凭据。` : `公开来源响应失败（HTTP ${response.status}）。`);
  }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw new Error('公开来源响应过大。'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('公开来源未返回正文。');
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('公开来源响应过大。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder(encoding, { fatal: true }).decode(joined);
}

/** 按来源及证券隔离缓存并合并并发，不输出响应正文。参数：服务端生成的缓存键、读取器；返回：标准事件或安全错误。 */
export async function readEventSource(key: string, load: () => Promise<MarketEvent[]>): Promise<MarketEvent[]> {
  const saved = cache.get(key);
  if (saved && saved.until > Date.now()) {
    if (saved.error) throw saved.error;
    return saved.events!;
  }
  const existing = pending.get(key);
  if (existing) return existing;
  const job = (async () => {
    try {
      const events = await load();
      // 个股缓存键随证券增长，限制总量以免长期运行无限积累。
      if (cache.size >= 128) cache.delete(cache.keys().next().value!);
      cache.set(key, { until: Date.now() + 60_000, events });
      console.info(`[events] 公开来源=${key} 事件数=${events.length}`);
      return events;
    } catch (failure) {
      const known = failure instanceof Error && /^(公开|雪球|新浪|华尔街|东方财富|FOMC|FEC)/.test(failure.message);
      const redirected = failure instanceof Error && 'code' in failure && failure.code === 'UnexpectedRedirect';
      const error = new Error(known ? failure.message : redirected ? '公开来源要求重定向，未跟随跳转或读取登录凭据。'
        : '公开来源超时、网络不可达或响应格式变化。');
      if (cache.size >= 128) cache.delete(cache.keys().next().value!);
      cache.set(key, { until: Date.now() + 15_000, error });
      console.warn(`[events] 公开来源=${key} 读取失败：${error.message}`);
      throw error;
    }
  })();
  pending.set(key, job);
  try { return await job; } finally { pending.delete(key); }
}

/** 构造独立公开渠道读取器，每个来源单独失败。参数：无；返回：六个具名只读来源。 */
export function publicEventSources(): EventReader[] {
  return (Object.keys(PUBLIC_EVENT_LABELS) as PublicProvider[]).map(provider => ({
    label: PUBLIC_EVENT_LABELS[provider], read: () => readEventSource(provider, async () => {
      const body = await fetchEventText(PUBLIC_EVENT_URLS[provider]);
      return provider === 'fed' ? parseFedCalendar(body) : provider === 'fec' ? parseFecElection(body)
        : parsePublicNews(provider, JSON.parse(body));
    }),
  }));
}
