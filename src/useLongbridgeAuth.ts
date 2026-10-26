import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthStatus } from '../shared/auth';

export type AuthAction = 'start' | 'cancel' | 'logout';
const INITIAL: AuthStatus = { state: 'idle', message: '尚未登录网页行情会话。', expiresAt: null, revision: 0 };
const STATES = ['idle', 'creating', 'waiting', 'success', 'expired', 'error', 'cancelling'];

/** 校验浏览器认证响应边界。参数：未知JSON；返回：仅含公开字段的认证状态。 */
function parseStatus(value: unknown): AuthStatus {
  if (!value || typeof value !== 'object') throw new Error('登录接口返回了无效状态。');
  const record = value as Record<string, unknown>;
  if (!STATES.includes(String(record.state)) || typeof record.message !== 'string' || record.message.length > 1000 ||
      !Number.isSafeInteger(record.revision) || Number(record.revision) < 0 ||
      (record.expiresAt !== null && (typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt) || record.expiresAt < 0))) {
    throw new Error('登录接口返回的状态不完整，请重试。');
  }
  return { state: record.state as AuthStatus['state'], message: record.message, expiresAt: record.expiresAt as number | null, revision: Number(record.revision) };
}

/** 调用固定同源登录端点。参数：可选操作及取消信号；返回：公开状态，不接收凭据。 */
async function requestStatus(action?: AuthAction, signal?: AbortSignal): Promise<AuthStatus> {
  const response = await fetch(`/api/auth/${action ?? 'state'}`, {
    method: action ? 'POST' : 'GET', cache: 'no-store', credentials: 'same-origin',
    headers: action ? { 'Content-Type': 'application/json', 'X-Market-Lens': '1' } : undefined,
    body: action ? '{}' : undefined,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  }).catch((failure: unknown) => {
    if (signal?.aborted) throw failure;
    const timeout = failure instanceof DOMException && failure.name === 'TimeoutError';
    throw new Error(timeout ? '登录服务请求超时，请检查状态或关闭重试。' : '无法连接登录服务，请检查本机服务后重试。');
  });
  if (!response.ok) throw new Error(`登录服务请求失败（HTTP ${response.status}），请稍后重试。`);
  return parseStatus(await response.json());
}

/** 管理串行状态轮询与显式操作。参数：弹窗是否打开；返回：状态、错误与操作函数。 */
export function useLongbridgeAuth(open: boolean) {
  const [status, setStatus] = useState<AuthStatus>(INITIAL);
  const [ready, setReady] = useState(false);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [pending, setPending] = useState<AuthAction | null>(null);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const pendingRef = useRef<AuthAction | null>(null);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current += 1; }; }, []);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    /** 读取完成后才安排下一次，避免网络慢时堆积。参数：无；返回：Promise<void>。 */
    async function poll(): Promise<void> {
      const epoch = generation.current;
      try {
        if (!pendingRef.current) {
          const next = await requestStatus(undefined, controller.signal);
          if (!controller.signal.aborted && epoch === generation.current && !pendingRef.current) {
            setStatus(next); setReady(true); setReadError('');
          }
        }
      } catch (failure) {
        if (!controller.signal.aborted && epoch === generation.current) setReadError(failure instanceof Error ? failure.message : '无法读取登录状态。');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, open ? 1500 : 10_000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [open, refresh]);
  const act = useCallback(async (action: AuthAction): Promise<boolean> => {
    if (pendingRef.current && (action !== 'cancel' || pendingRef.current === 'cancel')) return false;
    const epoch = ++generation.current;
    pendingRef.current = action; setPending(action); setActionError('');
    try {
      const next = await requestStatus(action);
      if (!mounted.current || epoch !== generation.current) return false;
      setStatus(next); setReady(true); setReadError('');
      return next.state !== 'error';
    } catch (failure) {
      if (mounted.current && epoch === generation.current) setActionError(failure instanceof Error ? failure.message : '登录操作失败，请重试。');
      return false;
    } finally {
      if (mounted.current && epoch === generation.current) { pendingRef.current = null; setPending(null); setRefresh(value => value + 1); }
    }
  }, []);
  return { status, ready, pending, error: actionError || readError, act, refresh: () => { setActionError(''); setRefresh(value => value + 1); } };
}
