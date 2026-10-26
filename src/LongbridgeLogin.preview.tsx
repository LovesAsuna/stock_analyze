import { Check, LoaderCircle, LogIn, TriangleAlert } from 'lucide-react';
import './auth.css';

/** Hallmark组件八状态演示；不接入生产入口、不发起认证请求。参数：无；返回：带标签的状态样本。 */
export function LongbridgeLoginPreview() {
  return <section className="auth-preview" aria-label="登录入口八状态预览">
    <div><span>默认</span><button className="auth-button"><LogIn size={16} aria-hidden="true" />登录长桥</button></div>
    <div><span>悬停</span><button className="auth-button is-hover">登录长桥</button></div>
    <div><span>键盘焦点</span><button className="auth-button is-focus">登录长桥</button></div>
    <div><span>按下</span><button className="auth-button is-active">登录长桥</button></div>
    <div><span>禁用</span><button className="auth-button" disabled>登录长桥</button></div>
    <div><span>加载</span><button className="auth-button" disabled data-state="loading"><LoaderCircle size={16} className="spinner" aria-hidden="true" />正在生成</button></div>
    <div><span>错误</span><button className="auth-button" data-state="error"><TriangleAlert size={16} aria-hidden="true" />重试登录</button></div>
    <div><span>成功</span><button className="auth-button" data-state="success"><Check size={16} aria-hidden="true" />长桥已登录</button></div>
  </section>;
}
