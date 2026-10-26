import { useEffect, useRef, useState } from 'react';
import './original-chart-lab.css';

const periods = [
  ['day', '日 K'], ['week', '周 K'], ['month', '月 K'], ['quarter', '季 K'], ['year', '年 K'],
  ['1m', '1 分'], ['5m', '5 分'], ['15m', '15 分'], ['30m', '30 分'], ['60m', '1 小时'],
  ['intraday', '分时'], ['five-day', '5 日'],
] as const;

/** 原版合成图表实验入口；参数无，返回可关闭、无账户数据的隔离图表对话框。 */
export function OriginalChartLab() {
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const expectedPeriod = useRef('day');
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState('day');
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let timer: ReturnType<typeof setTimeout>;
    /** 只接收当前opaque-origin实验frame状态；参数为消息事件，返回无。 */
    function receive(event: MessageEvent): void {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return;
      const value = event.data;
      if (!value || value.type !== 'chart-lab' || !['ready', 'loading', 'error'].includes(value.state)) return;
      if (!periods.some(([key]) => key === value.period) || value.period !== expectedPeriod.current) return;
      clearTimeout(timer); setStatus(value.state); setPeriod(value.period);
      if (value.state === 'loading') timer = setTimeout(() => setStatus('error'), 20000);
    }
    window.addEventListener('message', receive);
    timer = setTimeout(() => setStatus('error'), 20000);
    return () => { clearTimeout(timer); window.removeEventListener('message', receive); };
  }, [open]);
  /** 打开原生模态框。参数无，返回无；失败给出可见错误。 */
  function launch(): void {
    try { dialog.current?.showModal(); expectedPeriod.current = 'day'; setOpen(true); setStatus('loading'); setPeriod('day'); setError(''); }
    catch { console.warn('原版图表实验窗口打开失败。'); setError('无法打开实验窗口，请刷新后重试。'); }
  }
  /** 关闭并卸载整个iframe，释放WASM和所有定时器。参数无，返回无。 */
  function close(): void { dialog.current?.close(); setOpen(false); }
  /** 向当前实验frame提交受限周期。参数为已列出的枚举，返回无。 */
  function change(next: string): void {
    if (!periods.some(([key]) => key === next)) return;
    expectedPeriod.current = next; setPeriod(next); setStatus('loading');
    // 每个周期使用新实例，避免旧可见区间被误判为新行情已完成。
    // 只通过固定URL和已验证枚举加载，不把账户或主图行情送入实验。
    if (frame.current) frame.current.src = `/chart-lab/frame?period=${next}#id=local-lab&debug=false&env=web&ConfigKey=WebMain&period=${next}`;
  }
  return <>
    <button type="button" className="button compact" onClick={launch}>原版图表实验</button>
    {error && <span role="alert">{error}</span>}
    <dialog ref={dialog} className="original-chart-lab" aria-labelledby="original-chart-lab-title" onCancel={close}>
      <header><div><h2 id="original-chart-lab-title">原版图表实验</h2><p>独立运行原版渲染器 · AAPL 合成行情 · 与当前证券及账户无关</p></div>
        <button className="button" type="button" onClick={close} autoFocus>关闭实验</button></header>
      <div className="original-chart-lab-controls">
        <label>实验周期<select aria-label="原版实验周期" value={period} disabled={!open} onChange={event => change(event.target.value)}>
          {periods.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <output aria-live="polite">{status === 'ready' ? '合成行情已绘制' : status === 'error' ? '实验加载失败，可关闭后重试' : '正在加载合成图表…'}</output>
      </div>
      {open && <iframe ref={frame} title="原版合成行情图表" sandbox="allow-scripts" referrerPolicy="origin"
        src="/chart-lab/frame#id=local-lab&debug=false&env=web&ConfigKey=WebMain" />}
      <p className="original-chart-lab-note">可移动十字线、拖动和滚轮缩放。图内买卖标记与成本线均为模拟；主工作台的策略信号、持仓和实时行情仍在主图中显示。</p>
    </dialog>
  </>;
}
