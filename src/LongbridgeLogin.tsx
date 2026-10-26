import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, LogIn, QrCode, ShieldCheck, Smartphone, TriangleAlert, X } from 'lucide-react';
import type { AuthStatus } from '../shared/auth';
import { useLongbridgeAuth } from './useLongbridgeAuth';
import './auth.css';

const TITLES: Record<AuthStatus['state'], string> = {
  idle: '用长桥 App 扫码登录', creating: '正在生成二维码', waiting: '等待扫码与手机确认',
  success: '网页行情会话已登录', expired: '二维码已过期', error: '暂时无法登录', cancelling: '正在结束扫码会话',
};

/** 二维码展示与真实有效期倒计时。参数：公开状态；返回：二维码或明确的加载失败状态。 */
function LoginQr({ status }: { status: AuthStatus }) {
  const [now, setNow] = useState(Date.now());
  const [failedRevision, setFailedRevision] = useState<number | null>(null);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.ceil(((status.expiresAt ?? now) - now) / 1000));
  const failed = failedRevision === status.revision;
  return <div className="auth-qr-block">
    <div className="auth-qr-paper">{failed || seconds === 0
      ? <div className="auth-qr-unavailable"><TriangleAlert size={28} aria-hidden="true" /><span>{failed ? '二维码读取失败' : '二维码已过期'}</span><small>请重新生成</small></div>
      : <img key={status.revision} src={`/api/auth/qr?revision=${status.revision}`} width="280" height="280" alt="使用长桥 App 扫描此登录二维码" onError={() => setFailedRevision(status.revision)} />}</div>
    <p className="auth-countdown">{seconds > 0 ? <>有效时间 <strong>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</strong></> : '等待服务端更新状态…'}</p>
  </div>;
}

/** 根据认证状态显示唯一主视觉。参数：当前公开状态；返回：二维码、处理中或结果说明。 */
function LoginVisual({ status }: { status: AuthStatus }) {
  if (status.state === 'waiting') return <LoginQr status={status} />;
  const processing = status.state === 'creating' || status.state === 'cancelling';
  const Icon = processing ? LoaderCircle : status.state === 'success' ? Check : ['error', 'expired'].includes(status.state) ? TriangleAlert : QrCode;
  return <div className="auth-visual" data-state={status.state}>
    <Icon size={40} strokeWidth={1.5} className={processing ? 'spinner' : ''} aria-hidden="true" />
    <strong>{status.state === 'success' ? '已连接本次网页会话' : status.state === 'idle' ? '在手机上完成授权' : processing ? '请稍候…' : '可以重新生成二维码'}</strong>
    <span>{status.state === 'success' ? '实时行情将使用当前登录身份重新订阅。' : status.state === 'idle' ? '生成二维码后，打开长桥 App 扫一扫。' : status.state === 'expired' ? '过期二维码无法继续使用。' : status.state === 'error' ? '检查网络和本机 Longbridge Pro 安装。' : '正在与长桥认证服务通信。'}</span>
  </div>;
}

/** 工作台登录入口。参数：无；返回：同源扫码弹窗，关闭未完成流程前等待服务端取消。 */
export function LongbridgeLogin() {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const started = useRef(false);
  const { status, ready, pending, error, act, refresh } = useLongbridgeAuth(open);
  const busy = Boolean(pending) || ['creating', 'cancelling'].includes(status.state);
  const loggedIn = status.state === 'success';
  const display: AuthStatus = pending ? { ...status, state: pending === 'start' ? 'creating' : 'cancelling' } : status;
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  /** 先回收可能写入凭据的扫码请求，再关闭弹窗。参数：无；返回：Promise<void>。 */
  async function close(): Promise<void> {
    if (pending === 'logout' || pending === 'cancel') return;
    if ((started.current && !loggedIn) || pending === 'start' || ['creating', 'waiting', 'cancelling'].includes(status.state)) {
      if (!await act('cancel')) return;
    }
    started.current = false;
    setOpen(false);
  }
  return <>
    <button className="auth-button auth-entry" data-state={loggedIn ? 'success' : error ? 'error' : busy ? 'loading' : 'default'} aria-haspopup="dialog" onClick={() => { setOpen(true); refresh(); }}>
      {loggedIn ? <ShieldCheck size={16} aria-hidden="true" /> : <LogIn size={16} aria-hidden="true" />}<span>{loggedIn ? '长桥已登录' : '登录长桥'}</span>
    </button>
    <dialog className="auth-dialog" ref={dialog} aria-labelledby="auth-title" aria-describedby="auth-description" onCancel={event => { event.preventDefault(); void close(); }} onClick={event => { if (event.target === dialog.current) void close(); }}>
      <div className="auth-header"><div><p className="auth-kicker">Longbridge · 网页行情</p><h2 id="auth-title">登录长桥</h2></div><button autoFocus className="auth-button auth-close" aria-label="关闭登录" disabled={pending === 'logout' || pending === 'cancel'} onClick={() => void close()}><X size={20} aria-hidden="true" /></button></div>
      <p id="auth-description" className="auth-intro">用长桥 App 扫码，在手机上确认本次登录。</p>
      <div className="auth-session" data-state={display.state} aria-busy={busy}>
        <LoginVisual status={display} />
        <div className="auth-progress" role="status" aria-live="polite"><h3>{TITLES[display.state]}</h3><p>{pending ? '正在更新登录会话，请稍候。' : status.message}</p></div>
      </div>
      <div className="auth-error-slot">{error && <p role="alert">{error}<button className="auth-text-button" onClick={refresh}>检查状态</button></p>}</div>
      <div className="auth-actions">
        {loggedIn ? <><button className="auth-button" disabled={busy} onClick={() => void act('logout')}>退出本次登录</button><button className="auth-button auth-primary" disabled={busy} onClick={() => void close()}>返回工作台</button></>
          : <><button className="auth-button" disabled={pending === 'cancel'} onClick={() => void close()}>{busy ? '取消登录' : '关闭'}</button><button className="auth-button auth-primary" disabled={busy || !ready} data-state={busy ? 'loading' : error ? 'error' : 'default'} onClick={() => { started.current = true; void act('start'); }}>{pending === 'start' && <LoaderCircle size={16} className="spinner" aria-hidden="true" />}{status.state === 'idle' ? '生成登录二维码' : '重新生成'}</button></>}
      </div>
      <div className="auth-boundary"><Smartphone size={16} aria-hidden="true" /><p>此登录用于网页实时行情，服务重启后需重新扫码。持仓与成交流水仍使用本机 CLI 的登录账户，请确认两处账户一致。</p></div>
    </dialog>
  </>;
}
