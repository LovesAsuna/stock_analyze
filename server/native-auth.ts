import type { AuthStatus, AuthState } from '../shared/auth.js';
import { nativeSession } from './native-feed.js';

interface AuthSession {
  authCall(method: 'qr-create' | 'qr-poll'): Promise<any>;
  pin(value: boolean): void;
  resetSession(): Promise<void>;
  onReset(listener: () => void): () => void;
}

/** 扫码生命周期控制器：不持有令牌，SVG仅保留于服务器内存。 */
export class NativeAuthController {
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private svg: string | null = null;
  private busy = false;
  private resetting = false;
  private cancellation: Promise<AuthStatus> | null = null;
  private resetCount = 0;
  private status: AuthStatus = { state: 'idle', message: '尚未登录，可用长桥手机App扫码登录本地会话。', expiresAt: null, revision: 0 };

  /** 绑定共享会话及故障失效通知。参数：session共享能力；返回：新实例。 */
  constructor(private readonly session: AuthSession) {
    session.onReset(() => {
      if (this.resetting) return;
      this.clear(); this.revision += 1;
      this.set('idle', '本地会话已结束，登录状态已清除。');
    });
  }

  /** 清理内存图片和轮询。参数：无；返回：无。 */
  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.svg = null;
  }

  /** 更新公开状态。参数：state枚举、message说明、expiresAt到期毫秒；返回：状态副本。 */
  private set(state: AuthState, message: string, expiresAt: number | null = null): AuthStatus {
    if (state !== this.status.state) {
      // 仅记录有限状态，不输出二维码、认证响应、凭据或账户信息。
      if (state === 'error') console.error('[native-auth] state=error');
      else console.info(`[native-auth] state=${state}`);
    }
    this.status = { state, message, expiresAt, revision: this.revision };
    return this.getState();
  }

  /** 返回仅含公开字段的状态。参数：无；返回：状态副本。 */
  getState(): AuthStatus { return { ...this.status }; }

  /** 读取本代二维码图片。参数：revision缓存标识；返回：SVG或null。 */
  getQr(revision: number): string | null {
    if (this.status.state !== 'waiting' || revision !== this.revision || Date.now() >= (this.status.expiresAt ?? 0)) return null;
    return this.svg;
  }

  /** 销毁身份并恢复匿名订阅。参数：无；返回：Promise<void>。 */
  private async reset(): Promise<void> {
    this.resetCount += 1; this.resetting = true;
    try { await this.session.resetSession(); }
    finally { this.resetCount -= 1; this.resetting = this.resetCount > 0; }
  }

  /** 创建新二维码，先销毁旧身份以防迟到写入。参数：无；返回：公开状态。 */
  async start(): Promise<AuthStatus> {
    if (this.status.state === 'success') throw new Error('当前本地会话已登录，请先明确退出登录。');
    if (this.busy || this.cancellation) throw new Error('扫码请求正在处理，请稍后重试。');
    this.busy = true; this.clear(); const generation = ++this.revision;
    this.set('creating', '正在生成本地登录二维码。');
    let stage = 'RESET';
    try {
      await this.reset();
      if (generation !== this.revision) return this.getState();
      this.session.pin(true); stage = 'CREATE_RPC';
      const result = await this.session.authCall('qr-create');
      if (generation !== this.revision) return this.getState();
      stage = 'CREATE_SHAPE';
      if (typeof result?.svg !== 'string' || !result.svg.includes('<svg') || result.svg.length > 1024 * 1024) throw new Error('无效二维码');
      this.svg = result.svg;
      const seconds = Number(result.expiresIn);
      const fallbackExpiry = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.min(seconds, 600)) : 180) * 1000;
      const expiresAt = Number.isFinite(result.expiresAt) ? Math.min(result.expiresAt, Date.now() + 600000) : fallbackExpiry;
      this.set('waiting', '请用长桥手机App扫码并确认；确认结果尚未收到。', expiresAt);
      this.schedule(generation);
      return this.getState();
    } catch {
      console.error(`[native-auth] CREATE_FAILED stage=${stage}`);
      if (generation === this.revision) await this.finish('error', '二维码创建失败，请检查网络或重试。');
      return this.getState();
    } finally { this.busy = false; }
  }

  /** 安排串行轮询，到期先于下一次请求。参数：generation当前代；返回：无。 */
  private schedule(generation: number): void {
    const remaining = (this.status.expiresAt ?? 0) - Date.now();
    this.timer = setTimeout(() => { void this.poll(generation); }, Math.max(0, Math.min(1500, remaining)));
    this.timer.unref?.();
  }

  /** 轮询仅返回安全状态，未知状态继续等待确认。参数：generation当前代；返回：Promise<void>。 */
  private async poll(generation: number): Promise<void> {
    if (generation !== this.revision || this.status.state !== 'waiting') return;
    if (Date.now() >= (this.status.expiresAt ?? 0)) { await this.finish('expired', '二维码已过期，请重新生成。'); return; }
    try {
      const result = await this.session.authCall('qr-poll');
      if (generation !== this.revision) return;
      if (Date.now() >= (this.status.expiresAt ?? 0)) { await this.finish('expired', '二维码已过期，请重新生成。'); return; }
      if (result?.state === 'success') {
        this.clear(); this.session.pin(true);
        this.set('success', '本地会话已登录，行情连接正在应用登录状态。');
      } else this.schedule(generation);
    } catch {
      if (generation === this.revision) await this.finish('error', '扫码确认请求失败，本地会话已清除，请重试。');
    }
  }

  /** 到期或异常必须销毁可能迟到写入的进程。参数：state结果、message说明；返回：Promise<void>。 */
  private async finish(state: 'error' | 'expired', message: string): Promise<void> {
    this.clear(); const generation = ++this.revision;
    try { await this.reset(); }
    catch { message = '隔离会话清理失败，请重试退出登录。'; state = 'error'; }
    if (generation === this.revision) this.set(state, message);
  }

  /** 取消待确认扫码，成功登录需明确logout。参数：无；返回：状态Promise。 */
  cancel(): Promise<AuthStatus> {
    if (this.status.state === 'success') return Promise.resolve(this.getState());
    return this.logout();
  }

  /** 清除独立登录会话并恢复匿名行情。参数：无；返回：状态Promise。 */
  logout(): Promise<AuthStatus> {
    if (this.cancellation) return this.cancellation;
    this.clear(); const generation = ++this.revision;
    this.set('cancelling', '正在清除本地隔离会话。');
    this.cancellation = this.reset().then(() => {
      if (generation === this.revision) this.set('idle', '本地登录已退出，行情可继续匿名连接。');
      return this.getState();
    }).catch(() => this.set('error', '隔离会话清理失败，请重试退出登录。'))
      .finally(() => { this.cancellation = null; });
    return this.cancellation;
  }
}

export const nativeAuth = new NativeAuthController(nativeSession);
