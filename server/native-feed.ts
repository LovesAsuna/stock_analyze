import { createRequire } from 'node:module';
import type { MarketStreamEvent, RealtimeQuote, StreamState } from '../shared/realtime.js';

const require = createRequire(import.meta.url);
const { EngineClient } = require('./native/engine-client.cjs') as { EngineClient: new () => NativeEngine };
const { normalizeNativeSymbol } = require('./native/helpers.cjs') as { normalizeNativeSymbol: (value: unknown) => string };
const { readStartupFailure, isStartupFailure } = require('./native/startup-errors.cjs') as {
  readStartupFailure: (value: unknown) => Error;
  isStartupFailure: (value: unknown) => boolean;
};
type Listener = (event: MarketStreamEvent) => void;
type NativeStatus = { symbol: string; state: StreamState; message: string; scope?: 'connection' | 'target' };
export interface NativeEngine {
  on(event: string, listener: (value: any) => void): unknown;
  call(method: 'connect' | 'subscribe' | 'unsubscribe' | 'qr-create' | 'qr-poll' | 'candles' | 'intraday', payload?: { symbol: string; period?: string; count?: number; timestamp?: string; session?: string; date?: string; withTransport?: boolean }): Promise<any>;
  stop(): Promise<void>;
}
interface Target {
  listeners: Map<number, Listener>;
  status: NativeStatus;
  quote: RealtimeQuote | null;
}

/** 一个匿名进程及其目标引用，包含连续故障最多三次的进程恢复。 */
export class NativeFeed {
  private readonly targets = new Map<string, Target>();
  private readonly submitted = new Set<string>();
  private nextId = 0;
  private operations = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private recovering = false;
  private pinned = false;
  private closed = false;
  private authEpoch = 0;
  private candleRequests = 0;
  private readonly resets = new Set<() => void>();

  /** 绑定唯一引擎。参数：engine隔离客户端；返回：新实例。 */
  constructor(private readonly engine: NativeEngine) {
    engine.on('status', (value: NativeStatus) => this.onStatus(value));
    engine.on('quote', (value: RealtimeQuote) => this.onQuote(value));
    // 协议认证恢复后，证券解析失败不能延续旧的连接级重启计时。
    engine.on('connection', (value: { state?: string }) => {
      if (value?.state === 'connected') this.cancelRecovery();
    });
    engine.on('state', (value: { state?: string } | undefined) => {
      // 主动stop已在开始时通过reset使旧任务失效；结束事件不能再次取消排队的新请求。
      if (value?.state === 'closed') return;
      this.invalidateAuth();
      if (!this.recovering) this.fail('隔离行情进程已停止');
    });
    engine.on('reset', () => this.invalidateAuth());
    engine.on('fatal', (value: unknown) => this.fail(readStartupFailure(value).message));
    engine.on('log', (value: { kind?: string; category?: string; message?: string }) => {
      if (typeof value?.message === 'string' && /^AUTH_(CREATE|POLL)_(RESPONSE|FAILED) \{(?:"(?:code|httpStatus)":\d{1,9},?)*\}$/.test(value.message)) {
        console.info(`[native-auth] ${value.message}`); return;
      }
      if (value?.kind === 'info' && value.category === 'ENDPOINT_SELECTED' && ['hk', 'bj'].includes(value.message ?? '')) {
        console.info(`[native-feed] 已自动选择桌面行情端点（${value.message}）`); return;
      }
      if (value?.kind !== 'error') return;
      const category = ['NODE_LOADER', 'MODULE_MISSING', 'NATIVE_ABI', 'NATIVE_RUNTIME', 'CHILD_STDERR'].includes(value.category ?? '')
        ? value.category : 'CLEANUP_OR_TRANSPORT';
      console.error(`[native-feed] 原生进程错误分类：${category}`);
    });
  }

  /** 隔离消费者异常。参数：listener消费者、event事件；返回：无。 */
  private notify(listener: Listener, event: MarketStreamEvent): void {
    try { listener(event); }
    catch { console.error('[native-feed] 实时事件消费者处理失败'); }
  }

  /** 广播目标事件。参数：target目标、event事件；返回：无。 */
  private publish(target: Target, event: MarketStreamEvent): void {
    for (const listener of target.listeners.values()) this.notify(listener, event);
  }

  /** 报告固定安全错误并安排恢复。参数：message说明；返回：无。 */
  private fail(message: string): void {
    if (!this.targets.size) return;
    console.error(`[native-feed] ${message}`);
    this.cancelStable();
    for (const [symbol, target] of this.targets) {
      target.status = { symbol, state: 'error', message: `桌面原生WS匿名：${message}` };
      target.quote = null;
      this.publish(target, { type: 'status', ...target.status });
    }
    this.scheduleRecovery();
  }

  /** 串行处理进程生命周期和目标变更。参数：job异步任务；返回：无。 */
  private enqueue(job: () => Promise<void>): void {
    this.operations = this.operations.then(job).catch(error => this.fail(isStartupFailure(error)
      ? readStartupFailure(error).message : '引擎操作失败，请检查桌面版本、网络和行情权限'));
  }

  /** 处理目标状态。参数：value原生安全状态；返回：无。 */
  private onStatus(value: NativeStatus): void {
    const target = this.targets.get(value?.symbol);
    if (!target || !['connecting', 'connected', 'reconnecting', 'error'].includes(value.state)) return;
    target.status = { symbol: value.symbol, state: value.state, message: value.message };
    if (value.state !== 'connected') { target.quote = null; this.cancelStable(); }
    // scope仅用于服务端恢复决策，不进入公共SSE协议。
    const { symbol, state, message } = value;
    this.publish(target, { type: 'status', symbol, state, message });
    if (value.state === 'connected' && [...this.targets.values()].every((entry) => entry.status.state === 'connected')) {
      this.cancelRecovery();
      if (!this.stableTimer) {
        this.stableTimer = setTimeout(() => { this.stableTimer = null; this.attempts = 0; }, 30000);
        this.stableTimer.unref?.();
      }
    } else if (value.scope !== 'target' && ['error', 'reconnecting'].includes(value.state) && !/未找到|多个精确匹配/.test(value.message)) {
      this.scheduleRecovery();
    }
  }

  /** 处理当前目标报价并拒旧。参数：quote标准报价；返回：无。 */
  private onQuote(quote: RealtimeQuote): void {
    const target = this.targets.get(quote?.symbol);
    if (!target || target.status.state !== 'connected' || !Number.isFinite(quote.timestamp) || quote.timestamp <= 0 ||
      !Number.isFinite(quote.price) || quote.price <= 0 || (target.quote && quote.timestamp < target.quote.timestamp)) return;
    target.quote = quote;
    this.publish(target, { type: 'quote', quote });
  }

  /** 取消稳定窗口，避免短暂确认无限重置恢复预算。参数：无；返回：无。 */
  private cancelStable(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }

  /** 取消待执行恢复。参数：无；返回：无。 */
  private cancelRecovery(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** 给原生后台重连留出时间，再做最多三次进程恢复。参数：无；返回：无。 */
  private scheduleRecovery(): void {
    if (this.closed || !this.targets.size || this.retryTimer || this.recovering || this.attempts >= 3) return;
    const delay = 4000 * (2 ** this.attempts);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.targets.size) return;
      this.attempts += 1;
      this.enqueue(() => this.recover());
    }, delay);
    this.retryTimer.unref?.();
  }

  /** 销毁故障会话并重放所有当前目标。参数：无；返回：Promise<void>。 */
  private async recover(): Promise<void> {
    if (this.closed || !this.targets.size) return;
    this.recovering = true; this.cancelStable();
    try {
      this.invalidateAuth();
      await this.engine.stop(); this.submitted.clear();
      for (const [symbol, target] of this.targets) {
        if (this.closed) break;
        target.status = { symbol, state: 'reconnecting', message: `桌面原生WS匿名：正在恢复隔离会话（${this.attempts}/3）` };
        target.quote = null; this.publish(target, { type: 'status', ...target.status });
        this.submitted.add(symbol); await this.engine.call('subscribe', { symbol });
      }
      if (this.targets.size && !this.closed) await this.engine.call('connect');
    } finally { this.recovering = false; }
  }

  /** 注册身份失效通知。参数：listener监听器；返回：解除函数。 */
  onReset(listener: () => void): () => void {
    this.resets.add(listener);
    return () => this.resets.delete(listener);
  }

  /** 引擎销毁即取消身份，避免显示假登录。参数：无；返回：无。 */
  private invalidateAuth(): void {
    this.pinned = false; this.authEpoch += 1;
    for (const listener of this.resets) listener();
  }

  /** 固定登录会话生命周期。参数：value是否保留；返回：无。 */
  pin(value: boolean): void { this.pinned = value; }

  /** 服务端认证专用IPC，仍使用共享引擎。参数：method认证操作；返回：安全响应。 */
  async authCall(method: 'qr-create' | 'qr-poll'): Promise<any> {
    const epoch = this.authEpoch;
    await this.operations;
    if (this.closed || epoch !== this.authEpoch || !this.pinned) throw new Error('原生认证会话已取消');
    return this.engine.call(method);
  }

  /** 执行一页原生K线。参数：payload代码、周期、数量及可选时间戳；返回：当前会话响应。 */
  async candleCall(payload: { symbol: string; period: string; count: number; timestamp?: string; withTransport?: boolean }): Promise<any> {
    return this.withCandleSession(() => this.engine.call('candles', payload));
  }

  /** 读取桌面分时并保留共享会话。参数：证券、时段及可选YYYYMMDD日期；返回：原始分时点。 */
  async intradayCall(payload: { symbol: string; session: string; date?: string; withTransport?: boolean }): Promise<any> {
    return this.withCandleSession(() => this.engine.call('intraday', payload));
  }

  /** 在完整分页期间持有共享会话，避免页间空隙回收。参数：read只读任务；返回：当前会话任务结果。 */
  async withCandleSession<Result>(read: () => Promise<Result>): Promise<Result> {
    const epoch = this.authEpoch;
    this.candleRequests += 1;
    try {
      await this.operations;
      if (this.closed || epoch !== this.authEpoch) throw new Error('原生K线会话已取消');
      const result = await read();
      if (this.closed || epoch !== this.authEpoch) throw new Error('原生K线会话已取消');
      return result;
    } finally {
      this.candleRequests -= 1;
      if (!this.closed && !this.targets.size && !this.pinned && !this.candleRequests) {
        this.enqueue(async () => {
          // 排队期间可能新增行情目标、登录固定或K线请求，执行时必须重新确认引用。
          if (!this.closed && !this.targets.size && !this.pinned && !this.candleRequests) {
            this.submitted.clear(); await this.engine.stop();
          }
        });
      }
    }
  }

  /** 销毁当前身份并在同一操作队列恢复匿名目标。参数：无；返回：Promise<void>。 */
  async resetSession(): Promise<void> {
    this.cancelRecovery(); this.cancelStable(); this.recovering = true; this.invalidateAuth();
    // 先打断可能仍在原生层执行的扫码轮询，不能等它自行返回后再销毁。
    const stopping = this.engine.stop();
    const reset = this.operations.then(async () => {
      this.recovering = true;
      try {
        await stopping; this.submitted.clear();
        if (!this.closed) for (const symbol of this.targets.keys()) {
          this.submitted.add(symbol); await this.engine.call('subscribe', { symbol });
        }
        if (this.targets.size && !this.closed) await this.engine.call('connect');
      } finally { this.recovering = false; }
    });
    this.operations = reset.catch(() => this.fail('会话重置失败，请重试退出登录'));
    return reset;
  }

  /** 关闭身份和行情生命周期，不再自动恢复。参数：无；返回：Promise<void>。 */
  async close(): Promise<void> {
    this.closed = true; this.cancelRecovery(); this.cancelStable(); this.invalidateAuth();
    await this.engine.stop(); await this.operations;
    this.targets.clear(); this.submitted.clear();
  }

  /** 验证目标并增加独立引用。参数：value代码、onEvent消费者；返回：幂等取消函数。 */
  subscribe(value: string, onEvent: Listener): () => void {
    if (this.closed) throw new Error('原生行情会话已关闭');
    const symbol = normalizeNativeSymbol(value);
    if (typeof onEvent !== 'function') throw new Error('原生行情订阅需要事件回调');
    let target = this.targets.get(symbol);
    if (!target) {
      target = { listeners: new Map(), quote: null,
        status: { symbol, state: 'connecting', message: '桌面原生WS匿名：正在建立隔离行情订阅' } };
      this.targets.set(symbol, target); this.cancelStable();
      const entry = target;
      this.enqueue(async () => {
        if (this.closed || this.targets.get(symbol) !== entry) return;
        console.info(`[native-feed] ${symbol} 建立匿名只读订阅`);
        this.submitted.add(symbol); await this.engine.call('subscribe', { symbol });
        await this.engine.call('connect');
      });
    }
    const id = ++this.nextId; const entry = target;
    entry.listeners.set(id, onEvent);
    this.notify(onEvent, { type: 'status', ...entry.status });
    if (entry.quote && entry.status.state === 'connected') this.notify(onEvent, { type: 'quote', quote: entry.quote });
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true; entry.listeners.delete(id);
      if (entry.listeners.size || this.targets.get(symbol) !== entry) return;
      this.targets.delete(symbol);
      if (!this.targets.size) { this.cancelRecovery(); this.cancelStable(); this.attempts = 0; }
      this.enqueue(async () => {
        // 旧取消排在新一代订阅之前，不能跳过原生目标的删除。
        try { if (this.submitted.delete(symbol)) await this.engine.call('unsubscribe', { symbol }); }
        finally { if (!this.targets.size && !this.pinned && !this.candleRequests) { this.submitted.clear(); await this.engine.stop(); } }
      });
    };
  }
}

/** 创建可注入假引擎的订阅器。参数：engine唯一客户端；返回：订阅函数。 */
export function createNativeFeed(engine: NativeEngine): (symbol: string, onEvent: Listener) => () => void {
  const feed = new NativeFeed(engine);
  return feed.subscribe.bind(feed);
}

/** 服务器认证专用能力，不暴露给浏览器或接收任意IPC方法。 */
export const nativeSession = new NativeFeed(new EngineClient());
const subscribeSharedNative = nativeSession.subscribe.bind(nativeSession);

/** 停止认证轮询和共享引擎。参数：无；返回：清理完成Promise。 */
export async function closeNativeSession(): Promise<void> { await nativeSession.close(); }

/**
 * 订阅桌面原生WS匿名行情，共享隔离进程并按代码引用计数。
 * @param symbol 最长35字符的US/HK代码，支持股票、ETF及美股期权。
 * @param onEvent 接收status/quote事件的消费者。
 * @returns 幂等取消函数，最后一个目标取消后清理进程和自有目录。
 */
export function subscribeNativeQuote(symbol: string, onEvent: (event: MarketStreamEvent) => void): () => void {
  return subscribeSharedNative(symbol, onEvent);
}
