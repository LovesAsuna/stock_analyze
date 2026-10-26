/** 独立扫码登录的公开状态，不包含二维码内容、令牌或账户标识。 */
export type AuthState = 'idle' | 'creating' | 'waiting' | 'success' | 'expired' | 'error' | 'cancelling';

/** 浏览器可读取的登录状态；revision用于拒绝旧请求和刷新二维码图片缓存。 */
export interface AuthStatus {
  state: AuthState;
  message: string;
  expiresAt: number | null;
  revision: number;
}
