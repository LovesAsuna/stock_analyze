import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/600.css';
import './styles.css';
import App from './App';
import './workspace-theme.css';

/** 渲染错误边界，图表异常仍提供明确提示及刷新入口。 */
class ErrorBoundary extends React.Component<React.PropsWithChildren, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  componentDidCatch(error: Error) { console.error('工作台渲染失败：', error.message); }
  render() {
    return this.state.error ? <main className="fatal-error"><h1>工作台渲染失败</h1><p>请刷新页面重试。若持续发生，请检查浏览器控制台。</p><button className="button" onClick={() => window.location.reload()}>重新加载</button></main> : this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>);
