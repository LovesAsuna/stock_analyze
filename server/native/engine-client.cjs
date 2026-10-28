/** 父进程行情客户端：独立会话目录、限时 IPC 与进程退出屏障。 */
'use strict';
const { EventEmitter } = require('node:events');
const { fork } = require('node:child_process');
const { mkdtemp, mkdir, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { readStartupFailure } = require('./startup-errors.cjs');

/** 移除继承的行情凭据环境。参数：无；返回：独立匿名子进程环境。 */
function anonymousEnvironment() {
  // Windows 环境变量名不区分大小写；清除两种运行时的预加载选项及待覆盖的隔离目录。
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|APPDATA|LOCALAPPDATA|USERPROFILE|HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME)$/i.test(key)
    && !/(?:LONG(?:BRIDGE|PORT)|^LB_).*(?:TOKEN|SECRET|KEY|SESSION|AUTH)/i.test(key)));
}

class EngineClient extends EventEmitter {
  /** 初始化客户端。参数：无；返回：新实例。 */
  constructor() {
    super();
    this.child = null;
    this.starting = null;
    this.stopping = null;
    this.run = null;
    this.directory = null;
    this.pending = new Map();
    this.nextId = 0;
  }

  /** 启动独立引擎。参数：无；返回：就绪Promise，退出期间拒绝新请求。 */
  async start() {
    if (this.stopping) throw new Error('行情会话正在退出，请稍候');
    if (this.starting) return this.starting;
    const run = { child: null, directory: null, cancelled: false, exited: false };
    this.run = run;
    const starting = this.launch(run).catch(error => {
      if (this.starting === starting) this.starting = null;
      throw error;
    });
    this.starting = starting;
    return starting;
  }

  /** 创建隔离目录并等待子进程就绪。参数：run本次启动；返回：Promise<void>。 */
  async launch(run) {
    try {
      run.directory = await mkdtemp(join(tmpdir(), 'market-lens-native-'));
      this.directory = run.directory;
      const roaming = join(run.directory, 'AppData', 'Roaming');
      const local = join(run.directory, 'AppData', 'Local');
      const config = join(run.directory, '.config');
      const data = join(run.directory, '.local', 'share');
      const cache = join(run.directory, '.cache');
      const applicationSupport = join(run.directory, 'Library', 'Application Support');
      await Promise.all([roaming, local, config, data, cache, applicationSupport].map(directory => mkdir(directory, { recursive: true })));
      if (run.cancelled) throw new Error('行情引擎启动已取消');
      const child = fork(join(__dirname, 'worker.cjs'), [], {
        cwd: run.directory,
        // 明确沿用 Bun 宿主；本机已验证原生 addon 的初始化、IPC 与退出清理。
        execPath: process.execPath,
        execArgv: [],
        env: { ...anonymousEnvironment(), LB_ENGINE_ISOLATION: run.directory, APPDATA: roaming, LOCALAPPDATA: local, USERPROFILE: run.directory,
          HOME: run.directory, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_CACHE_HOME: cache },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      run.child = child; this.child = child;
      this.observeStderr(run);
      await this.waitReady(run);
    } catch (error) {
      run.cancelled = true;
      await this.cleanup(run);
      throw error;
    }
  }

  /** 只分类stderr，不保存或输出原文。参数：run本代进程；返回：无。 */
  observeStderr(run) {
    const reported = new Set();
    run.child.stderr?.on('data', chunk => {
      const text = String(chunk).slice(0, 8192);
      const category = /ERR_INPUT_TYPE_NOT_ALLOWED|ERR_UNKNOWN_FILE_EXTENSION|tsx|--input-type/.test(text) ? 'NODE_LOADER'
        : /MODULE_NOT_FOUND|Cannot find module/.test(text) ? 'MODULE_MISSING'
        : /NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|not a valid Win32/.test(text) ? 'NATIVE_ABI'
        : /panic|failed to downcast|neon/.test(text) ? 'NATIVE_RUNTIME' : 'CHILD_STDERR';
      if (reported.has(category)) return;
      reported.add(category);
      this.emit('log', { kind: 'error', category, message: `隔离行情进程错误分类：${category}` });
    });
  }

  /** 监听一次启动与本代进程退出。参数：run本次启动；返回：就绪Promise。 */
  waitReady(run) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('行情引擎初始化超时')), 10000);
      run.cancelStart = () => { clearTimeout(timer); reject(new Error('行情引擎启动已取消')); };
      run.child.on('message', message => {
        if (this.run !== run || run.cancelled || !message || typeof message !== 'object') return;
        if (message.event === 'ready') { clearTimeout(timer); resolve(); }
        if (message.event === 'fatal') {
          clearTimeout(timer);
          const error = readStartupFailure(message.data);
          run.startupError = error;
          reject(error);
        }
        this.receive(message);
      });
      run.child.once('error', () => { clearTimeout(timer); reject(new Error('无法启动行情引擎子进程')); });
      run.child.once('exit', () => {
        run.exited = true;
        clearTimeout(timer);
        reject(new Error('行情引擎提前退出'));
        if (this.run !== run) return;
        this.child = null;

        this.rejectPending('行情引擎已停止，请重试或检查桌面应用版本');
        if (!run.cancelled) {
          if (!run.startupError) this.emit('state', { state: 'error', authenticated: false, message: '隔离行情进程已停止' });
          this.stopping = this.cleanup(run).catch(() => this.emit('log', { kind: 'error', message: '隔离会话目录清理失败，请检查临时目录权限' })).finally(() => { this.starting = null; this.stopping = null; });
        }
      });
    });
  }

  /** 分发引擎消息。参数：message消息；返回：无。 */
  receive(message) {
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    } else if (message.event) this.emit(message.event, message.data);
  }

  /** 拒绝所有尚未完成的请求。参数：message固定错误；返回：无。 */
  rejectPending(message) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear();
  }

  /** 执行受限RPC。参数：method操作、payload参数；返回：结果Promise。 */
  async call(method, payload = {}) {
    if (!['connect', 'subscribe', 'unsubscribe', 'qr-create', 'qr-poll', 'candles', 'intraday'].includes(method)) throw new Error('不支持的隔离行情会话操作');
    if (method === 'unsubscribe' && !this.child?.connected) return { removed: true };
    await this.start();
    const child = this.child;
    if (this.stopping || !child?.connected || this.run?.cancelled) throw new Error('行情引擎已停止');
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      // 只读K线和分时超时仅拒绝该请求；订阅/认证超时需销毁本代会话，阻止迟到操作。
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (['candles', 'intraday'].includes(method)) { reject(new Error('当前桌面行情请求超时，请稍后重试')); return; }
        reject(new Error('行情引擎请求超时，隔离会话已停止'));
        this.stop().catch(() => this.emit('log', { kind: 'error', message: '超时会话清理失败，请检查临时目录权限' }));
      }, ['candles', 'intraday'].includes(method) ? 45000 : 12000);
      this.pending.set(id, { resolve, reject, timer });
      const failed = () => {
        clearTimeout(timer); this.pending.delete(id); reject(new Error('无法向行情进程发送请求'));
      };
      try { child.send({ id, method, payload }, error => { if (error) failed(); }); }
      catch { failed(); }
    });
  }

  /** 终止本代子进程并确认退出。参数：run本次启动；返回：Promise<void>。 */
  async terminate(run) {
    const child = run.child;
    if (!child || run.exited) return;
    await new Promise((resolve, reject) => {
      let forced;
      const done = () => { clearTimeout(grace); clearTimeout(forced); resolve(); };
      const grace = setTimeout(() => {
        try { child.kill(); }
        catch { child.removeListener('exit', done); reject(new Error('无法终止隔离行情进程')); return; }
        forced = setTimeout(() => {
          child.removeListener('exit', done);
          reject(new Error('隔离行情进程未退出，会话目录暂未删除'));
        }, 2000);
      }, 2000);
      child.once('exit', done);
      try { if (child.connected) child.disconnect(); else child.kill(); }
      catch { child.kill(); }
    });
  }

  /** 只清理本代目录，且必须先确认进程退出。参数：run本次启动；返回：Promise<void>。 */
  cleanup(run) {
    if (run.cleaning) return run.cleaning;
    run.cleaning = (async () => {
      await this.terminate(run);
      if (run.directory) await rm(run.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      if (this.run === run) {
        this.run = null; this.directory = null; this.child = null;
      }
    })().catch(error => { run.cleaning = null; throw error; });
    return run.cleaning;
  }

  /** 结束进程并删除自有会话，等待尚未完成的启动。参数：无；返回：Promise<void>。 */
  stop() {
    if (this.stopping) return this.stopping;
    const run = this.run;
    if (!run) return Promise.resolve();
    this.emit('reset', { reason: 'session-stopped' });
    run.cancelled = true;
    run.cancelStart?.();
    this.rejectPending('行情会话已取消');
    const starting = this.starting;
    this.stopping = (async () => {
      if (starting) await starting.catch(() => {
        // 启动负责回收其失败路径；只记录固定文案，随后继续重试清理。
        this.emit('log', { kind: 'info', message: '已回收未完成的引擎启动' });
      });
      await this.cleanup(run);
      this.starting = null;
      this.emit('state', { state: 'closed', authenticated: false, message: '隔离行情会话已停止' });
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }
}
module.exports = { EngineClient };
