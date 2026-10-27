import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseStreamEvent, type MarketStreamEvent } from '../shared/realtime.js';
import type { Period } from '../shared/types.js';
import { isPeriod } from '../shared/periods.js';
import { normalizeSymbol } from './longbridge.js';
import { quoteBridge, type QuoteBridge } from './quote-bridge.js';
import { subscribeDesktopCandles } from './desktop-candles.js';

export type NativeQuoteProvider = (symbol: string, onEvent: (event: MarketStreamEvent) => void) => () => void;
interface StreamOptions {
  bridge?: Pick<QuoteBridge, 'subscribe' | 'close'>;
  nativeQuoteProvider?: NativeQuoteProvider;
  desktopCandleProvider?: typeof subscribeDesktopCandles;
}
interface Client {
  close: () => void;
}
const MAX_CLIENTS = 12;
const MAX_BUFFER_BYTES = 256 * 1024;
const HEARTBEAT_MS = 15_000;
type StatusEvent = Extract<MarketStreamEvent, { type: 'status' }>;
type QuoteEvent = Extract<MarketStreamEvent, { type: 'quote' }>;

/**
 * 协调桌面原生报价与独立K线；原生报价失败时才启用CLI备用报价。
 * @param symbol 当前连接证券。
 * @param send 统一事件发送函数，负责跨通道拒绝旧时间。
 * @param desktopCandles 是否由桌面通道同步证券柱。
 * @returns 两路独立回调；状态从可用通道计算，外部异常仅产生固定提示。
 */
function createEventRouter(symbol: string, send: (event: MarketStreamEvent) => void, desktopCandles = false): {
  onBridge: (event: MarketStreamEvent) => void; onNative: (event: MarketStreamEvent) => void;
} {
  let nativeConnected = false;
  let bridgeStatus: StatusEvent | undefined;
  let bridgeQuote: QuoteEvent | undefined;
  let nativeMessage = '';
  const fallback = (event: StatusEvent): void => {
    send({ ...event, state: bridgeStatus?.state ?? event.state,
      message: `${nativeMessage} CLI 备用通道：${bridgeStatus?.message ?? '正在建立行情订阅。'}` });
    if (bridgeQuote) send(bridgeQuote);
  };
  return {
    onBridge: (event): void => {
      if (event.type === 'status' && !nativeConnected) send({ type: 'sync', symbol, channel: 'quote', mode: 'push', transport: 'cli', state: event.state });
      if (event.type === 'quote') {
        bridgeQuote = event;
        if (!nativeConnected) send(event);
      } else if (event.type === 'status') {
        bridgeStatus = event;
        if (nativeConnected) {
          send({ ...event, state: 'connected', message: event.state === 'connected'
            ? desktopCandles ? '原生报价已连接；K线由桌面通道独立同步。' : '原生报价已连接；CLI 原生 K 线同步已连接。'
            : `原生报价已连接；CLI 通道提示：${event.message}` });
        } else send({ ...event, message: `${nativeMessage} CLI 行情通道：${event.message}` });
      } else send(event);
    },
    onNative: (event): void => {
      try {
        parseStreamEvent(event);
        if ((event.type === 'quote' ? event.quote.symbol : event.symbol) !== symbol || event.type === 'candles') return;
        if (event.type === 'sync') { send(event); return; }
        if (event.type === 'status') {
          if (event.state === 'connected' || !bridgeStatus || bridgeStatus.state !== 'connected') {
            send({ type: 'sync', symbol, channel: 'quote', mode: 'push', transport: 'desktop-ws', state: event.state });
          }
          nativeConnected = event.state === 'connected';
          nativeMessage = nativeConnected ? '原生报价已连接。' : '原生报价暂不可用，已启用 CLI 备用报价。';
          if (nativeConnected) {
            send({ ...event, message: bridgeStatus?.state === 'error' ? `${nativeMessage} CLI 通道提示：${bridgeStatus.message}`
              : `原生报价通道：${event.message}` });
          } else if (event.state === 'connecting' && !bridgeStatus) {
            send({ ...event, message: `原生报价通道：${event.message}` });
          } else fallback(event);
        } else if (nativeConnected) send(event);
      } catch {
        nativeConnected = false;
        nativeMessage = '原生报价无效，已启用 CLI 备用报价。';
        fallback({ type: 'status', symbol, state: 'error', message: nativeMessage });
      }
    },
  };
}

/** 管理 SSE 的响应生命周期，与可注入的共享行情桥解耦。 */
export class MarketStreamHub {
  private readonly clients = new Set<Client>();
  private readonly bridge: Pick<QuoteBridge, 'subscribe' | 'close'>;
  private nativeQuoteProvider?: NativeQuoteProvider;
  private readonly desktopCandleProvider: typeof subscribeDesktopCandles;

  /**
   * 创建 SSE 管理器，不立即启动任何行情连接。
   * @param options 可注入行情桥和可选原生报价通道，供集成与测试使用。
   */
  constructor(options: StreamOptions = {}) {
    this.bridge = options.bridge ?? quoteBridge;
    this.nativeQuoteProvider = options.nativeQuoteProvider;
    this.desktopCandleProvider = options.desktopCandleProvider ?? subscribeDesktopCandles;
  }

  /**
   * 配置后续连接使用的原生报价通道；现有连接保留自己的资源所有权。
   * @param provider 原生订阅函数；undefined 表示仅使用 CLI。
   * @returns 无返回值。
   */
  setNativeQuoteProvider(provider: NativeQuoteProvider | undefined): void {
    this.nativeQuoteProvider = provider;
  }

  /**
   * 打开只读 SSE；同源/身份门禁由挂载此函数的路由负责。
   * @param request HTTP GET 请求，仅监听 aborted，避免正常 request.close 提前终止流。
   * @param response SSE 响应；背压或超限时关闭慢客户端。
   * @param symbol 港美股代码，在本边界再次验证。
   * @param period 原生 K 线周期 day、1h、15m。
   * @returns 无返回值；清理由响应 close/error/finish 或 shutdown 触发。
   */
  open(request: IncomingMessage, response: ServerResponse, symbol: string, period: Period): void {
    if (request.method !== 'GET') return this.reject(response, 405, '行情流仅支持 GET 请求。');
    try {
      symbol = normalizeSymbol(symbol);
      if (!isPeriod(period)) throw new Error('周期无效');
    } catch { return this.reject(response, 400, '证券代码或周期无效。'); }
    if (this.clients.size >= MAX_CLIENTS) return this.reject(response, 429, '实时行情连接已达 12 个，请关闭多余连接。');
    if (request.aborted || response.destroyed || response.writableEnded) return;
    const client = this.createClient(request, response, symbol, period);
    this.clients.add(client);
    client.start();
  }

  /**
   * 关闭本管理器所有 SSE 及行情桥，用于服务 shutdown。
   * @returns 无返回值。
   */
  close(): void {
    for (const client of [...this.clients]) client.close();
    this.bridge.close();
  }

  /**
   * 返回固定错误，避免输出异常原文。
   * @param response HTTP 响应。
   * @param code HTTP 错误码。
   * @param message 固定的可显示消息。
   * @returns 无返回值。
   */
  private reject(response: ServerResponse, code: number, message: string): void {
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error: message }));
  }

  /**
   * 构造单连接所有权与资源清理函数，允许订阅回调内同步关闭。
   * @param request HTTP 请求。
   * @param response SSE 响应。
   * @param symbol 已验证证券代码。
   * @param period 已验证周期。
   * @returns 可启动与幂等关闭的客户端。
   */
  private createClient(request: IncomingMessage, response: ServerResponse, symbol: string, period: Period): Client & { start: () => void } {
    let closed = false;
    let releaseBridge: (() => void) | undefined;
    let releaseNative: (() => void) | undefined;
    let releaseCandles: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let latestQuoteTime = 0;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      request.off('aborted', abort);
      response.off('close', cleanup);
      response.off('finish', cleanup);
      response.off('error', abort);
      this.clients.delete(client);
      this.release(releaseCandles);
      this.release(releaseNative);
      this.release(releaseBridge);
    };
    const abort = (): void => { cleanup(); response.destroy(); };
    const close = (): void => { cleanup(); response.end(); };
    const write = (text: string): void => {
      if (closed) return;
      if (response.destroyed || response.writableEnded) { cleanup(); return; }
      if (Buffer.byteLength(text) + response.writableLength > MAX_BUFFER_BYTES) { abort(); return; }
      // write(false) 仍表示帧已接受，正常的大快照也可能触发背压。
      // 不创建应用队列；后续帧继续受 writableLength 的硬上限约束。
      try { response.write(text); }
      catch { abort(); }
    };
    const send = (event: MarketStreamEvent): void => {
      if (event.type === 'quote') {
        if (event.quote.timestamp < latestQuoteTime) return;
        latestQuoteTime = event.quote.timestamp;
      }
      write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const desktop = Boolean(this.nativeQuoteProvider);
    const router = createEventRouter(symbol, send, desktop);
    const onNative = router.onNative;
    const onBridge = (event: MarketStreamEvent): void => {
      if (desktop && event.type === 'candles') return;
      router.onBridge(desktop && event.type === 'status' ? { ...event, message: `${event.message} K线通过桌面原生通道独立同步。` } : event);
    };
    const client = { close, start: (): void => this.startClient({
      request, response, symbol, period, cleanup, abort, write, onBridge, onNative, desktopCandles: desktop,
      setHeartbeat: (timer) => { heartbeat = timer; },
      setBridge: (release) => { releaseBridge = release; if (closed) this.release(release); },
      setNative: (release) => {
        releaseNative = release;
        if (closed) this.release(release);
        else if (desktop) {
          const cancel = this.desktopCandleProvider(symbol, period, send);
          releaseCandles = cancel;
          if (closed) this.release(cancel);
        }
      },
      isClosed: () => closed,
    }) };
    return client;
  }

  /**
   * 安全释放外部适配器资源，异常不会阻断其余连接清理。
   * @param release 适配器取消函数。
   * @returns 无返回值；仅记录不含凭证的固定消息。
   */
  private release(release: (() => void) | undefined): void {
    try { release?.(); }
    catch { console.warn('[market-stream] 行情监听清理失败'); }
  }

  /**
   * 安装关闭监听、发送 SSE 头并启动两路行情与心跳。
   * @param context 客户端生命周期回调和已验证请求参数。
   * @returns 无返回值；异常会清理并关闭当前客户端。
   */
  private startClient(context: {
    request: IncomingMessage; response: ServerResponse; symbol: string; period: Period; desktopCandles: boolean;
    cleanup: () => void; abort: () => void; write: (text: string) => void;
    onBridge: (event: MarketStreamEvent) => void; onNative: (event: MarketStreamEvent) => void;
    setHeartbeat: (timer: ReturnType<typeof setInterval>) => void;
    setBridge: (release: () => void) => void; setNative: (release: () => void) => void; isClosed: () => boolean;
  }): void {
    const { request, response } = context;
    request.once('aborted', context.abort);
    response.once('close', context.cleanup);
    response.once('finish', context.cleanup);
    response.once('error', context.abort);
    try {
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
      response.flushHeaders();
      context.write(': connected\n\n');
      if (context.isClosed()) return;
      let bridgeStarted = false;
      const startBridge = (): void => {
        if (bridgeStarted || context.isClosed()) return;
        bridgeStarted = true;
        context.setBridge(this.bridge.subscribe(context.symbol, context.period, context.onBridge, !context.desktopCandles));
      };
      const onNative = (event: MarketStreamEvent): void => {
        context.onNative(event);
        if (event.type === 'status' && ['error', 'reconnecting'].includes(event.state)) startBridge();
      };
      if (this.nativeQuoteProvider) {
        try { context.setNative(this.nativeQuoteProvider(context.symbol, onNative)); }
        catch { onNative({ type: 'status', symbol: context.symbol, state: 'error', message: '原生通道启动失败。' }); }
      } else startBridge();
      if (!context.isClosed()) context.setHeartbeat(setInterval(() => context.write(': heartbeat\n\n'), HEARTBEAT_MS));
    } catch {
      console.warn('[market-stream] SSE 连接初始化失败');
      context.abort();
    }
  }
}

const marketStreams = new MarketStreamHub();

/**
 * 为后续 SSE 注册可选原生报价通道；不发起真实连接。
 * @param provider 与统一事件协议兼容的订阅适配器。
 * @returns 无返回值。
 */
export function setNativeQuoteProvider(provider: NativeQuoteProvider | undefined): void {
  marketStreams.setNativeQuoteProvider(provider);
}

/**
 * 路由可直接挂载的共享行情 SSE 入口；调用方负责同源和身份验证。
 * @param request 已通过路由门禁的 GET 请求。
 * @param response 待写入的 SSE 响应。
 * @param symbol 港美股证券代码。
 * @param period 原生 K 线周期。
 * @returns 无返回值。
 */
export function openMarketStream(request: IncomingMessage, response: ServerResponse, symbol: string, period: Period): void {
  marketStreams.open(request, response, symbol, period);
}

/** @returns 无返回值；供服务 shutdown 释放全部流、进程及定时器。 */
export function closeMarketStreams(): void { marketStreams.close(); }
