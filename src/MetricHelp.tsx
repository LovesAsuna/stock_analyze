import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp } from 'lucide-react';
import { FUNDAMENTAL_HELP } from './fundamental-help';

/**
 * 提供悬浮、键盘及点击可读的指标说明；浮层挂到 body，避免被滚动侧栏裁切。
 * @param props 与基本面指标一致的名称。
 * @returns 指标名称、具名帮助按钮及在视口内定位的说明浮层。
 */
export function MetricHelp({ label }: { label: string }) {
  const help = FUNDAMENTAL_HELP[label];
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  /** 取消离开延迟并显示说明；无参数，无返回值。 */
  const show = () => { if (timer.current) clearTimeout(timer.current); setOpen(true); };
  /** 指针可移入说明阅读，焦点仍在帮助按钮时继续显示；无参数，无返回值。 */
  const leave = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (document.activeElement !== trigger.current) setOpen(false);
    }, 140);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !tooltip.current) return;
    /** 随滚动更新锚点，焦点导致的自动滚动不会误关说明；无参数，无返回值。 */
    const reposition = () => {
      if (!trigger.current || !tooltip.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const box = tooltip.current.getBoundingClientRect();
      const left = Math.max(12, Math.min(anchor.right - box.width, innerWidth - box.width - 12));
      const desiredTop = anchor.bottom + 8 + box.height <= innerHeight - 12 ? anchor.bottom + 8 : anchor.top - box.height - 8;
      setPosition({ left, top: Math.max(12, Math.min(desiredTop, innerHeight - box.height - 12)) });
    };
    reposition();
    document.addEventListener('scroll', reposition, true);
    return () => document.removeEventListener('scroll', reposition, true);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    /** 外部点击或 Escape 关闭，保留按钮焦点；参数：DOM事件；返回：无。 */
    const dismiss = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event.type === 'pointerdown' && event.target instanceof Node
        && (trigger.current?.contains(event.target) || tooltip.current?.contains(event.target))) return;
      setOpen(false);
    };
    document.addEventListener('keydown', dismiss);
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('keydown', dismiss);
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', dismiss);
    };
  }, [open]);
  if (!help) return <span>{label}</span>;
  return <span className="fundamental-metric-label" onMouseEnter={show} onMouseLeave={leave}>
    <span>{label}</span><button ref={trigger} type="button" className="metric-help-trigger" aria-label={`${label}：含义与运用`}
      aria-describedby={open ? id : undefined} aria-expanded={open} onFocus={show} onBlur={leave} onClick={show}>
      <CircleHelp size={13} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={tooltip} id={id} role="tooltip" className="metric-help-tooltip" style={position}
      onMouseEnter={show} onMouseLeave={leave}>
      <strong>{label}</strong><dl><div><dt>指标含义</dt><dd>{help.meaning}</dd></div>
        <div><dt>如何运用</dt><dd>{help.usage}</dd></div><div><dt>注意事项</dt><dd>{help.caution}</dd></div></dl>
      <small>按 Esc 或点击其他区域关闭</small>
    </div>, document.body)}
  </span>;
}
