import type { IncomingMessage, ServerResponse } from 'node:http';
import { nativeSession } from './native-feed.js';
import { normalizeIntraday } from './intraday.js';
import type { IntradaySession } from '../shared/intraday.js';
import type { SyncEvent } from '../shared/realtime.js';

const clients = new Set<() => void>();

/** 打开只读分时增量流；收到报价即读取当前真实分时，历史基线由HTTP提供。参数：请求、响应、证券、时段；返回：无。 */
export function openIntradayStream(request: IncomingMessage, response: ServerResponse, symbol: string, session: IntradaySession): void {
  if (clients.size >= 12) { response.writeHead(429); response.end(); return; }
  let closed = false; let running = false; let dirty = false;
  let release: (() => void) | undefined; let retry: ReturnType<typeof setTimeout> | undefined;
  let transport: SyncEvent['transport'] = 'desktop-ws';
  /** 按本连接所有权释放资源。参数：无；返回：无。 */
  const close = (): void => {
    if (closed) return;
    closed = true; clearTimeout(retry); clearInterval(heartbeat); release?.(); clients.delete(close);
    request.off('aborted', close); response.off('close', close); response.off('error', close);
    response.end();
  };
  /** 有界发送，慢连接立即清理。参数：安全事件；返回：无。 */
  const send = (event: unknown): void => {
    if (closed) return;
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    if (Buffer.byteLength(frame) + response.writableLength > 512 * 1024) { close(); return; }
    try { response.write(frame); } catch { close(); }
  };
  const status = (state: SyncEvent['state']): void => send({ type: 'sync', symbol, channel: 'intraday', mode: 'event', transport, state });
  /** 串行读取，在途推送只追加一次追赶。参数：无；返回：完成Promise。 */
  const read = async (): Promise<void> => {
    if (closed || running) return;
    running = true;
    try {
      do {
        dirty = false;
        const result = await nativeSession.intradayCall({ symbol, session, withTransport: true });
        if (closed) break;
        const points = normalizeIntraday(result.rows, symbol).filter(point => session === 'all' || point.session === session);
        transport = result.transport;
        send({ type: 'points', symbol, session, points, receivedAt: new Date().toISOString() });
        status('connected');
      } while (dirty && !closed);
    } catch {
      if (!closed) {
        status('error'); console.warn('[intraday-stream] 当前分时更新失败，保留已有曲线');
        retry = setTimeout(trigger, 15000); retry.unref?.();
      }
    } finally { running = false; }
  };
  /** 推送到达即触发读取，无固定轮询等待。参数：无；返回：无。 */
  const trigger = (): void => { if (!closed) { clearTimeout(retry); dirty = true; void read(); } };
  const heartbeat = setInterval(() => {
    if (!closed) { try { response.write(': heartbeat\n\n'); } catch { close(); } }
  }, 15000);
  heartbeat.unref?.();
  clients.add(close); request.once('aborted', close); response.once('close', close); response.once('error', close);
  try {
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    response.flushHeaders();
    release = nativeSession.subscribe(symbol, event => {
      if (event.type === 'quote') trigger();
      else if (event.type === 'status') status(event.state);
    });
    if (closed) release(); else trigger();
  } catch { close(); }
}

/** 关闭所有本模块拥有的分时流。参数：无；返回：无。 */
export function closeIntradayStreams(): void { for (const close of [...clients]) close(); }
