import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Period } from '../shared/types';
import { PERIOD_LABELS } from '../shared/periods';
import type { IntradaySession } from '../shared/intraday';
import './timeframes.css';

export type ChartView = 'candles' | 'intraday' | 'five-day';
export const SESSION_LABELS: Record<IntradaySession, string> = { overnight: '夜盘分时', pre: '盘前分时', regular: '盘中分时', post: '盘后分时', all: '全部分时' };
const SESSION_OPTIONS: Record<IntradaySession, string> = { overnight: '夜盘', pre: '盘前', regular: '盘中', post: '盘后', all: '全部' };
const BUTTON_LABELS: Record<Period, string> = { ...PERIOD_LABELS, '1m': '1 分钟', '5m': '5 分钟', '15m': '15 分钟', '30m': '30 分钟', '1h': '1 小时' };
const VISIBLE_LABELS: Record<Period, string> = { day: '日 K', week: '周 K', month: '月 K', quarter: '季 K', year: '年 K', '1m': '1分', '5m': '5分', '15m': '15分', '30m': '30分', '1h': '1小时' };
const ORDER: Period[] = ['day', 'week', 'month', 'quarter', 'year', '1m', '5m', '15m', '30m', '1h'];

/** 管理分时菜单的开关与焦点。参数：无；返回：菜单状态、元素引用及键盘处理器。 */
function useSessionMenu() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // 上拉菜单已在触发按钮附近可见；聚焦时不滚动页面，避免移动中的菜单丢失点击。
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
    /** 点击组件外部关闭菜单；参数：指针事件；返回：无。 */
    const handleOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) setOpen(false);
    };
    /** Escape 关闭并归还焦点；参数：键盘事件；返回：无。 */
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', handleOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handleOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  /** 菜单内用方向键循环、Home/End 跳转。参数：键盘事件；返回：无。 */
  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    if (!items.length || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[nextIndex]?.focus();
  };
  return { open, setOpen, containerRef, triggerRef, menuRef, handleMenuKeyDown };
}

/** 图表时间维度选择。参数：独立分时视图、时段、K线周期及变更回调；返回：可换行的胶囊时间栏。 */
export function MarketTimeframes({ view, session, period, onView, onSession, onPeriod }: {
  view: ChartView; session: IntradaySession; period: Period;
  onView: (view: ChartView) => void; onSession: (session: IntradaySession) => void; onPeriod: (period: Period) => void;
}) {
  const menu = useSessionMenu();
  const menuId = useId();
  /** 校验并切换时段。参数：唯一分时菜单选择的时段值；返回：无。 */
  const selectSession = (value: string) => {
    if (!Object.hasOwn(SESSION_LABELS, value)) return;
    onSession(value as IntradaySession);
    onView('intraday');
    menu.setOpen(false);
  };

  return <div className="timeframe-controls">
    <div className="intraday-selector" ref={menu.containerRef} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) menu.setOpen(false);
    }}>
      <button type="button" className={view === 'intraday' ? 'active' : ''} aria-pressed={view === 'intraday'} onClick={() => onView('intraday')}>{SESSION_LABELS[session]}</button>
      <button type="button" className="session-menu-trigger" ref={menu.triggerRef} aria-label="展开分时时段菜单" aria-haspopup="menu" aria-expanded={menu.open} aria-controls={menuId}
        onClick={() => menu.setOpen(!menu.open)} onKeyDown={event => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); menu.setOpen(true); }
        }}><span className="session-menu-chevron" aria-hidden="true" /></button>
      {menu.open && <div id={menuId} ref={menu.menuRef} className="session-menu" role="menu" aria-label="分时时段菜单" onKeyDown={menu.handleMenuKeyDown}>
        {Object.entries(SESSION_OPTIONS).map(([value, label]) => <button type="button" key={value} role="menuitemradio" aria-checked={session === value} tabIndex={-1}
          onClick={() => { selectSession(value); menu.triggerRef.current?.focus(); }}>{label}</button>)}
      </div>}
    </div>
    <div className="period-tabs timeframe-tabs" role="group" aria-label="K线周期">
      <button type="button" className={view === 'five-day' ? 'active' : ''} aria-label="5 日" aria-pressed={view === 'five-day'} onClick={() => onView('five-day')}>5日</button>
      {ORDER.map(value => <button type="button" key={value} aria-label={BUTTON_LABELS[value]} className={view === 'candles' && period === value ? 'active' : ''} aria-pressed={view === 'candles' && period === value}
        onClick={() => { onPeriod(value); onView('candles'); }}>{VISIBLE_LABELS[value]}</button>)}
    </div>
  </div>;
}
