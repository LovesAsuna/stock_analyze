import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Candle, Period } from '../shared/types.js';
import { isPeriod } from '../shared/periods.js';
import type { MarketStreamEvent, RealtimeQuote, StreamState } from '../shared/realtime.js';
import { normalizeCandles, normalizeSymbol, rows } from './longbridge.js';
import { normalizeRealtimeQuote } from './realtime-normalize.js';

export type QuoteMethod = 'initialize' | 'quote.subscribe' | 'quote.unsubscribe' | 'quote.quote' | 'quote.candlesticks';
export type ProcessFactory = () => ChildProcessWithoutNullStreams;
type Listener = (event: MarketStreamEvent) => void;
type Row = Record<string, unknown>;
const METHODS = new Set<QuoteMethod>(['initialize', 'quote.subscribe', 'quote.unsubscribe', 'quote.quote', 'quote.candlesticks']);
const MAX_BYTES = 2 * 1024 * 1024;
const CANDLE_INTERVAL = 5_000;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 启动唯一需要的只读行情子进程，不使用 shell。
 * @returns 带标准输入输出管道的 Longbridge serve 进程。
 */
function startProcess(): ChildProcessWithoutNullStreams {
  return spawn('longbridge', ['serve'], { shell: false, windowsHide: true, stdio: 'pipe' });
}

/** JSONL RPC 传输：有界缓冲、乱序响应关联、统一脱敏错误与确定性关闭。 */
export class LongbridgeRpc {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private nextId = 0;
  private stopped = false;

  /**
   * 创建传输并安装进程监听。
   * @param factory 子进程工厂，测试可以注入 fake process。
   * @param notification 接收方法名和未知参数的通知回调。
   * @param disconnected 接收已脱敏终止错误的回调。
   * @param timeoutMs 每个 RPC 的超时时间。
   */
  constructor(
    factory: ProcessFactory = startProcess,
    private readonly notification: (method: string, params: unknown) => void = () => undefined,
    private readonly disconnected: (error: Error) => void = () => undefined,
    private readonly timeoutMs = 15_000,
  ) {
    this.process = factory();
    this.process.stdout.on('data', this.onData);
    this.process.stdout.on('end', this.onEnd);
    this.process.stdout.on('close', this.onEnd);
    this.process.stdout.on('error', this.onError);
    this.process.stdin.on('error', this.onError);
    // 消费 stderr 以免管道堵塞；绝不将原文或凭证写入日志。
    this.process.stderr.on('data', this.onStderr);
    this.process.stderr.on('error', this.onError);
    this.process.on('error', this.onError);
    this.process.on('exit', this.onEnd);
    this.process.on('close', this.onEnd);
  }

  /**
   * 发送白名单 RPC；请求数和 stdin 缓冲均设上限。
   * @param method 固定的行情只读方法，运行时仍会检查白名单。
   * @param params 方法参数，不通过 HTTP 暴露此入口。
   * @returns 按 id 对应的结果；超时、关闭、RPC 错误均拒绝。
   */
  request(method: QuoteMethod, params: Row = {}): Promise<unknown> {
    if (!METHODS.has(method)) return Promise.reject(new Error('不允许的行情 RPC 方法。'));
    if (this.stopped) return Promise.reject(new Error('Longbridge 行情连接已关闭。'));
    if (this.pending.size >= 128 || this.process.stdin.writableLength > 256 * 1024) {
      return Promise.reject(new Error('Longbridge 行情请求缓冲已满。'));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Longbridge ${method} 请求超时。`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
          if (error) this.fail(new Error('Longbridge 行情请求写入失败。'));
        });
      } catch {
        this.fail(new Error('Longbridge 行情请求写入失败。'));
      }
    });
  }

  /**
   * 主动结束传输，拒绝 pending 并释放全部自有监听和超时器。
   * @returns 无返回值；主动关闭不触发重连回调。
   */
  close(): void {
    this.dispose(new Error('Longbridge 行情连接已关闭。'));
  }

  /**
   * 消费任意分片 JSONL，以字节上限约束不完整行及完整行。
   * @param chunk stdout 的字节或文本块。
   * @returns 无返回值；协议错误会终止连接。
   */
  private readonly onData = (chunk: Buffer | string): void => {
    if (this.stopped) return;
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_BYTES) return this.fail(new Error('Longbridge 行情响应超出大小限制。'));
      if (line) {
        try { this.receive(JSON.parse(line)); }
        catch { return this.fail(new Error('Longbridge 行情协议解析失败。')); }
      }
      if (this.stopped) return;
    }
    if (Buffer.byteLength(this.buffer) > MAX_BYTES) this.fail(new Error('Longbridge 行情响应超出大小限制。'));
  };

  /**
   * 关联响应或分派通知，丢弃不认识的响应 id。
   * @param value 解码后的 JSON-RPC 消息。
   * @returns 无返回值；RPC 失败仅返回固定错误，不包含远端 message/data。
   */
  private receive(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('协议错误');
    const message = value as Row;
    if (message.jsonrpc !== '2.0') throw new Error('协议版本错误');
    if ('id' in message) {
      const pending = this.pending.get(message.id as number);
      if (!pending) return;
      this.pending.delete(message.id as number);
      clearTimeout(pending.timer);
      if ('error' in message) pending.reject(new Error('Longbridge 行情 RPC 返回错误，请检查登录和行情权限。'));
      else if ('result' in message) pending.resolve(message.result);
      else pending.reject(new Error('Longbridge 行情 RPC 响应结构无效。'));
    } else if (typeof message.method === 'string') {
      this.notification(message.method, message.params);
    }
  }

  /** @returns 无返回值；EOF、退出和流关闭共用一个幂等失败入口。 */
  private readonly onEnd = (): void => { this.fail(new Error('Longbridge 行情进程已断开。')); };
  /** @returns 无返回值；忽略可能含敏感数据的原始进程异常。 */
  private readonly onError = (): void => { this.fail(new Error('Longbridge 行情进程或管道错误。')); };
  /** @returns 无返回值；仅排空 stderr，不记录内容。 */
  private readonly onStderr = (): void => undefined;

  /**
   * 处理一次被动断开，避免 end/exit/close 导致重复重连。
   * @param error 固定、脱敏的错误。
   * @returns 无返回值。
   */
  private fail(error: Error): void {
    if (this.stopped) return;
    this.dispose(error);
    this.disconnected(error);
  }

  /**
   * 释放传输资源；错误内容由调用方保证不含外部凭证。
   * @param error 所有未完成请求的拒绝原因。
   * @returns 无返回值。
   */
  private dispose(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.buffer = '';
    this.process.stdout.off('data', this.onData);
    this.process.stdout.off('end', this.onEnd);
    this.process.stdout.off('close', this.onEnd);
    this.process.stdout.off('error', this.onError);
    this.process.stdin.off('error', this.onError);
    this.process.stderr.off('data', this.onStderr);
    this.process.stderr.off('error', this.onError);
    this.process.off('error', this.onError);
    this.process.off('exit', this.onEnd);
    this.process.off('close', this.onEnd);
    this.process.stdin.destroy();
    this.process.stdout.destroy();
    this.process.stderr.destroy();
    this.process.kill();
  }
}

interface CandleGroup {
  period: Period;
  listeners: Map<symbol, Listener>;
  candles: Candle[];
  receivedAt: string;
  full: boolean;
  lastStarted: number;
  flight?: Promise<void>;
  warning: boolean;
}
interface SymbolFeed {
  symbol: string;
  groups: Map<Period, CandleGroup>;
  subscribed: boolean;
  quote: RealtimeQuote | null;
  warning: boolean;
  syncing?: Promise<void>;
}
export interface QuoteBridgeOptions {
  processFactory?: ProcessFactory;
  requestTimeoutMs?: number;
}

/** 多客户端共享的行情桥：symbol 引用计数、原生 K 线去重同步及指数重连。 */
export class QuoteBridge {
  private readonly feeds = new Map<string, SymbolFeed>();
  private rpc: LongbridgeRpc | null = null;
  private ready = false;
  private generation = 0;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private candleTimer?: ReturnType<typeof setTimeout>;
  private state: StreamState = 'connecting';

  /**
   * 创建惰性行情桥，首次订阅时才启动进程。
   * @param options 进程工厂和 RPC 超时配置，供无真实账户测试注入。
   */
  constructor(private readonly options: QuoteBridgeOptions = {}) {}

  /**
   * 增加一个独立监听引用；相同回调重复注册也可各自清理。
   * @param symbol 港美股证券代码，将在边界重新验证。
   * @param period 受支持的 K 线周期；季度由原生月线聚合。
   * @param listener 接收统一事件的回调。
   * @returns 幂等的取消监听函数；最后一个引用释放全部进程和定时器。
   */
  subscribe(symbol: string, period: Period, listener: Listener): () => void {
    symbol = normalizeSymbol(symbol);
    if (!isPeriod(period)) throw new Error('不支持的 K 线周期。');
    let feed = this.feeds.get(symbol);
    if (!feed) {
      feed = { symbol, groups: new Map(), subscribed: false, quote: null, warning: false };
      this.feeds.set(symbol, feed);
    }
    let group = feed.groups.get(period);
    if (!group) {
      group = { period, listeners: new Map(), candles: [], receivedAt: '', full: true, lastStarted: 0, warning: false };
      feed.groups.set(period, group);
    }
    if (!group.listeners.size) group.full = true;
    const token = Symbol('listener');
    group.listeners.set(token, listener);
    this.deliver(listener, this.status(feed, group));
    if (feed.quote) this.deliver(listener, { type: 'quote', quote: feed.quote });
    if (group.candles.length) this.deliver(listener, this.candleEvent(feed, group));
    this.connect();
    if (this.ready) {
      this.synchronize(feed);
      if (feed.subscribed) void this.syncCandles(feed, group);
    }
    const ownedFeed = feed;
    const ownedGroup = group;
    return () => {
      if (!ownedGroup.listeners.delete(token)) return;
      if (!this.hasClients()) { this.close(); return; }
      if (this.ready) this.synchronize(ownedFeed);
      else if (!this.references(ownedFeed)) this.feeds.delete(ownedFeed.symbol);
    };
  }

  /**
   * 关闭桥并清除所有引用，可在后续新订阅时重新启动。
   * @returns 无返回值。
   */
  close(): void {
    this.generation += 1;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.candleTimer);
    this.reconnectTimer = undefined;
    this.candleTimer = undefined;
    const rpc = this.rpc;
    this.rpc = null;
    this.ready = false;
    this.reconnectAttempt = 0;
    this.state = 'connecting';
    for (const feed of this.feeds.values()) {
      for (const group of feed.groups.values()) group.listeners.clear();
    }
    this.feeds.clear();
    rpc?.close();
    console.info('[quote-bridge] 行情桥已释放');
  }

  /**
   * 统计证券引用，空组不构成订阅需求。
   * @param feed 证券共享状态。
   * @returns 此证券的客户端总数。
   */
  private references(feed: SymbolFeed): number {
    return [...feed.groups.values()].reduce((count, group) => count + group.listeners.size, 0);
  }

  /** @returns 桥是否仍有客户端。 */
  private hasClients(): boolean { return [...this.feeds.values()].some((feed) => this.references(feed) > 0); }

  /**
   * 隔离客户端回调错误，防止单个 SSE 客户端破坏共享传输。
   * @param listener 事件回调。
   * @param event 统一事件。
   * @returns 无返回值；只记录固定错误。
   */
  private deliver(listener: Listener, event: MarketStreamEvent): void {
    try { listener(event); }
    catch { console.warn('[quote-bridge] 行情客户端回调失败'); }
  }

  /**
   * 向指定周期或全部周期发送事件，复制监听集合以支持回调内退订。
   * @param feed 证券状态。
   * @param event 统一行情事件。
   * @param group 可选周期组。
   * @returns 无返回值。
   */
  private emit(feed: SymbolFeed, event: MarketStreamEvent, group?: CandleGroup): void {
    for (const target of group ? [group] : [...feed.groups.values()]) {
      for (const listener of [...target.listeners.values()]) this.deliver(listener, event);
    }
  }

  /**
   * 生成状态；只有订阅成功才能报告 connected。
   * @param feed 证券状态。
   * @param group 周期状态。
   * @returns 对应证券的状态事件。
   */
  private status(feed: SymbolFeed, group: CandleGroup): MarketStreamEvent {
    let state = this.state;
    let message = state === 'reconnecting' ? '行情连接已断开，正在重连。' : '正在连接实时行情。';
    if (this.ready && feed.subscribed) {
      state = feed.warning || group.warning ? 'error' : 'connected';
      message = group.warning ? '原生 K 线同步失败，将自动重试；报价继续推送。'
        : feed.warning ? '收到无效报价，已忽略并等待有效行情。' : '实时报价已订阅；原生 K 线每 5 秒同步。';
    }
    return { type: 'status', symbol: feed.symbol, state, message };
  }

  /**
   * 广播当前各周期状态。
   * @param feed 目标证券。
   * @returns 无返回值。
   */
  private emitStatus(feed: SymbolFeed): void {
    for (const group of feed.groups.values()) this.emit(feed, this.status(feed, group), group);
  }

  /** @returns 无返回值；建立一次传输和 initialize 握手。 */
  private connect(): void {
    if (this.rpc || this.reconnectTimer || !this.hasClients()) return;
    const generation = ++this.generation;
    console.info('[quote-bridge] 启动行情连接');
    try {
      const rpc = new LongbridgeRpc(this.options.processFactory,
        (method, params) => this.notification(generation, method, params),
        () => this.disconnected(generation), this.options.requestTimeoutMs);
      this.rpc = rpc;
      void rpc.request('initialize').then(() => {
        if (generation !== this.generation || this.rpc !== rpc) return;
        this.ready = true;
        for (const feed of this.feeds.values()) this.synchronize(feed);
        this.scheduleCandles();
      }).catch(() => this.disconnected(generation));
    } catch { this.disconnected(generation); }
  }

  /**
   * 被动断线后重置订阅和补缺标志，指数重连延迟最多 30 秒。
   * @param generation 失败传输的代数，过滤旧异步回调。
   * @returns 无返回值。
   */
  private disconnected(generation: number): void {
    if (generation !== this.generation) return;
    this.generation += 1;
    this.ready = false;
    const rpc = this.rpc;
    this.rpc = null;
    rpc?.close();
    clearTimeout(this.candleTimer);
    this.candleTimer = undefined;
    for (const feed of this.feeds.values()) {
      feed.subscribed = false;
      feed.syncing = undefined;
      feed.warning = false;
      for (const group of feed.groups.values()) {
        group.full = true;
        group.lastStarted = 0;
        group.flight = undefined;
        group.warning = false;
      }
    }
    if (!this.hasClients()) return;
    this.state = 'reconnecting';
    for (const feed of this.feeds.values()) this.emitStatus(feed);
    // 状态回调可能同步关闭最后一个客户端，此时不能重新遗留重连定时器。
    if (!this.hasClients()) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt++, 5));
    console.warn(`[quote-bridge] 行情断开，${delay}ms 后重连`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  /**
   * 串行协调同一证券的订阅/退订，处理 RPC 在途期间引用的增减。
   * @param feed 目标证券共享状态。
   * @returns 无返回值；失败通过统一重连恢复。
   */
  private synchronize(feed: SymbolFeed): void {
    if (feed.syncing || !this.rpc || !this.ready) return;
    const rpc = this.rpc;
    const generation = this.generation;
    const job = (async () => {
      while (generation === this.generation && Boolean(this.references(feed)) !== feed.subscribed) {
        const subscribe = this.references(feed) > 0;
        const result = await rpc.request(subscribe ? 'quote.subscribe' : 'quote.unsubscribe', {
          symbols: [feed.symbol], sub_types: ['quote'], ...(subscribe ? { is_first_push: true } : {}),
        });
        if (generation !== this.generation) return;
        feed.subscribed = subscribe;
        if (subscribe && this.references(feed)) {
          this.reconnectAttempt = 0;
          this.applySnapshots(feed, result);
          this.emitStatus(feed);
          for (const group of feed.groups.values()) void this.syncCandles(feed, group);
        }
      }
      if (generation === this.generation && !this.references(feed)) this.feeds.delete(feed.symbol);
    })();
    feed.syncing = job;
    void job.catch(() => this.disconnected(generation)).finally(() => {
      if (feed.syncing === job) feed.syncing = undefined;
      // 同步无等待完成时，调用方仍可能在同一轮事件内改变引用，结束后再对齐一次。
      if (generation === this.generation && this.feeds.get(feed.symbol) === feed &&
        Boolean(this.references(feed)) !== feed.subscribed) this.synchronize(feed);
    });
  }

  /**
   * 读取订阅初始快照；格式错误只告警，不输出外部响应。
   * @param feed 证券状态。
   * @param result 订阅响应，可能含 quotes 数组。
   * @returns 无返回值。
   */
  private applySnapshots(feed: SymbolFeed, result: unknown): void {
    const quotes = result && typeof result === 'object' ? (result as Row).quotes : undefined;
    if (quotes === undefined) return;
    try {
      for (const quote of rows(quotes)) this.applyQuote(feed, quote, true);
    } catch {
      feed.warning = true;
      console.warn('[quote-bridge] 订阅快照无效');
    }
  }

  /**
   * 分派指定代数的报价通知，忽略未知方法和未订阅证券。
   * @param generation 传输代数。
   * @param method 通知方法名。
   * @param params 未知外部参数。
   * @returns 无返回值。
   */
  private notification(generation: number, method: string, params: unknown): void {
    if (generation !== this.generation || method !== 'quote.updated' || !params || typeof params !== 'object') return;
    let symbol: string;
    try { symbol = normalizeSymbol((params as Row).symbol); }
    catch { console.warn('[quote-bridge] 忽略无效证券的行情通知'); return; }
    const feed = this.feeds.get(symbol);
    if (feed && this.references(feed)) this.applyQuote(feed, params, false);
  }

  /**
   * 校验并合并报价，旧报价不会回退当前快照。
   * @param feed 证券状态。
   * @param value 外部报价。
   * @param snapshot 是否为普通字段默认常规时段的快照。
   * @returns 无返回值。
   */
  private applyQuote(feed: SymbolFeed, value: unknown, snapshot: boolean): void {
    try {
      const quote = normalizeRealtimeQuote(value, feed.symbol, feed.quote, snapshot);
      if (!quote) return;
      feed.quote = quote;
      this.emit(feed, { type: 'quote', quote });
      if (feed.warning) { feed.warning = false; this.emitStatus(feed); }
    } catch {
      feed.warning = true;
      this.emitStatus(feed);
      console.warn('[quote-bridge] 忽略无效实时报价');
    }
  }

  /**
   * 构造原生 K 线事件，绝不由报价拼接或更新 OHLCV。
   * @param feed 证券状态。
   * @param group 周期状态。
   * @returns 标准 K 线事件。
   */
  private candleEvent(feed: SymbolFeed, group: CandleGroup): MarketStreamEvent {
    return { type: 'candles', symbol: feed.symbol, period: group.period, candles: group.candles, receivedAt: group.receivedAt };
  }

  /**
   * 同一证券和周期合并在途同步，每次尝试间隔至少 5 秒。
   * @param feed 证券状态。
   * @param group 周期状态。
   * @returns 当前同步完成的 Promise；不需要同步时立即完成。
   */
  private syncCandles(feed: SymbolFeed, group: CandleGroup): Promise<void> {
    if (group.flight) return group.flight;
    if (!this.rpc || !this.ready || !feed.subscribed || !group.listeners.size ||
      (group.lastStarted && Date.now() - group.lastStarted < CANDLE_INTERVAL)) return Promise.resolve();
    const rpc = this.rpc;
    const generation = this.generation;
    group.lastStarted = Date.now();
    const job = (async () => {
      try {
        // 季度输入必须覆盖季度首月；12 根月线包含完整近期季度，避免仅用尾月覆盖已有季度。
        const quarterly = group.period === 'quarter';
        const result = await rpc.request('quote.candlesticks', {
          symbol: feed.symbol, period: quarterly ? 'month' : group.period, count: group.full ? 1000 : quarterly ? 12 : 5,
          adjust_type: 'no_adjust', trade_sessions: 'intraday',
        });
        if (generation !== this.generation || !group.listeners.size) return;
        const candles = normalizeCandles(result, feed.symbol, group.period);
        if (!candles.length || candles.length > 1000) throw new Error('原生 K 线数量无效。');
        // 保留最多 1000 根供后加入的客户端补缺；已连接客户端仅发送本次原生增量。
        group.candles = [...new Map([...group.candles, ...candles].map((entry) => [entry.time, entry])).values()]
          .sort((left, right) => left.time - right.time).slice(-1000);
        group.receivedAt = new Date().toISOString();
        group.full = false;
        this.emit(feed, { type: 'candles', symbol: feed.symbol, period: group.period,
          candles, receivedAt: group.receivedAt }, group);
        if (group.warning) { group.warning = false; this.emit(feed, this.status(feed, group), group); }
      } catch {
        if (generation !== this.generation || !group.listeners.size) return;
        group.warning = true;
        group.full = true;
        this.emit(feed, this.status(feed, group), group);
        console.warn('[quote-bridge] 原生 K 线同步失败，等待下次重试');
      }
    })();
    group.flight = job;
    void job.finally(() => { if (group.flight === job) group.flight = undefined; });
    return job;
  }

  /** @returns 无返回值；仅有客户端时启动下一轮，上一轮全部完成才安排后续轮次。 */
  private scheduleCandles(): void {
    if (this.candleTimer || !this.ready || !this.hasClients()) return;
    const generation = this.generation;
    this.candleTimer = setTimeout(() => {
      this.candleTimer = undefined;
      const jobs: Promise<void>[] = [];
      for (const feed of this.feeds.values()) {
        for (const group of feed.groups.values()) jobs.push(this.syncCandles(feed, group));
      }
      void Promise.all(jobs).finally(() => {
        if (generation === this.generation) this.scheduleCandles();
      });
    }, CANDLE_INTERVAL);
  }
}

/** 默认共享实例，由 SSE 模块复用，导入时不会请求真实账户。 */
export const quoteBridge = new QuoteBridge();
