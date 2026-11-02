import { useEffect, useMemo, useRef, useState, type RefObject, type PointerEvent, type KeyboardEvent } from 'react';
import { useWaveDrag } from './useWaveDrag';
import type { IChartApi, Logical } from 'lightweight-charts';
import type { Candle, Period } from '../shared/types';
import { waveTime } from './ElliottWaves';
import { moveWaveBoundary, type WaveWindow } from './wave-window';
import './wave-window.css';

type Edge = 'from' | 'to';
interface Props {
  chartRef: RefObject<{ chart: IChartApi } | null>;
  container: RefObject<HTMLDivElement | null>;
  candles: Candle[]; window: WaveWindow; symbol: string; period: Period;
  onChange: (window: WaveWindow) => void;
}
interface Geometry { from: number; to: number; width: number; height: number }

/** 将时间窗口边界绑定到图表公开坐标；缩放、平移和容器变化时同步。参数：图表引用与窗口；返回：主价格区的覆盖层几何。 */
function useWindowGeometry({ chartRef, container }: Props): Geometry | null {
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  useEffect(() => {
    const current = chartRef.current; const host = container.current;
    if (!current || !host) return;
    const scale = current.chart.timeScale(); let frame = 0;
    const refresh = () => {
      frame = 0;
      const range = scale.getVisibleLogicalRange();
      if (!range) { setGeometry(null); return; }
      const next = { from: range.from, to: range.to, width: scale.width(), height: current.chart.panes()[0].getHeight() };
      setGeometry(previous => previous && Object.keys(next).every(key => previous[key as keyof Geometry] === next[key as keyof Geometry]) ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(refresh); };
    scale.subscribeVisibleLogicalRangeChange(schedule); scale.subscribeSizeChange(schedule);
    const observer = new ResizeObserver(schedule); observer.observe(host);
    globalThis.addEventListener('pointerup', schedule); schedule();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); globalThis.removeEventListener('pointerup', schedule);
      if (chartRef.current === current) {
        scale.unsubscribeVisibleLogicalRangeChange(schedule); scale.unsubscribeSizeChange(schedule);
      }
    };
  }, [chartRef, container]);
  return geometry;
}

/** 两条竖线和圆角矩形拖柄，吸附K线且不触发图表拖动。参数：图表、已选窗口和更新回调；返回：可键盘操作的范围覆盖层。 */
export function WaveWindowOverlay(props: Props) {
  const geometry = useWindowGeometry(props);
  const { candles, onChange } = props;
  const gesture = useWaveDrag(props.window, candles.length, onChange);
  const window = gesture.window;
  const hostLeft = useRef(0);
  if (!geometry || !candles.length) return null;
  const scale = props.chartRef.current?.chart.timeScale();
  const leftCoordinate = scale?.logicalToCoordinate(window.from as Logical);
  const rightCoordinate = scale?.logicalToCoordinate(window.to as Logical);
  if (leftCoordinate == null || rightCoordinate == null) return null;
  const move = (edge: Edge, index: number) => onChange(moveWaveBoundary(window, edge, index, candles.length));
  /** 捕获指针后的拖动按时间轴坐标吸附。参数：指针事件及边界；返回：无。 */
  const drag = (event: PointerEvent<HTMLButtonElement>, edge: Edge) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.preventDefault(); event.stopPropagation();
    const host = props.container.current; const chart = props.chartRef.current?.chart;
    if (!host || !chart) return;
    const origin = gesture.origin.current;
    if (!origin || Math.abs(event.clientX - origin.x) < 3) return;
    const scale = chart.timeScale();
    const logical = scale.coordinateToLogical(event.clientX - hostLeft.current);
    const initial = scale.coordinateToLogical(origin.x - hostLeft.current);
    if (logical !== null && initial !== null) gesture.move(edge, origin.index + logical - initial);
  };
  /** 键盘逐柱或十柱移动，Home/End定位允许的两端。参数：键盘事件及边界；返回：无。 */
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, edge: Edge) => {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10 };
    const limit = edge === 'from' ? [0, window.to] : [window.from, candles.length - 1];
    const index = event.key === 'Home' ? limit[0] : event.key === 'End' ? limit[1]
      : steps[event.key] !== undefined ? window[edge] + steps[event.key] : null;
    if (index === null) return;
    event.preventDefault(); event.stopPropagation(); move(edge, index);
  };
  const left = Math.max(0, Math.min(geometry.width, leftCoordinate));
  const right = Math.max(0, Math.min(geometry.width, rightCoordinate));
  return <div className="wave-window-overlay" style={{ width: geometry.width, height: geometry.height }} aria-label="波浪分析时间窗口">
    <div className="wave-window-shade" style={{ left: 0, width: left }} />
    <div className="wave-window-shade" style={{ left: right, width: geometry.width - right }} />
    {(['from', 'to'] as const).map(edge => {
      const coordinate = edge === 'from' ? leftCoordinate : rightCoordinate;
      if (coordinate < 0 || coordinate > geometry.width) return null;
      return <div key={edge} className={`wave-window-boundary wave-window-${edge}`} style={{ left: coordinate }}>
        <span className="wave-window-label" aria-hidden="true">{edge === 'from' ? '起' : '止'}</span>
        <button type="button" role="slider" className="wave-window-handle"
          style={{ left: Math.max(22, Math.min(geometry.width - 22, coordinate)) - coordinate,
            top: Math.abs(rightCoordinate - leftCoordinate) < 44 ? (edge === 'from' ? '40%' : '60%') : '50%' }}
          aria-label={edge === 'from' ? '波浪窗口起点' : '波浪窗口终点'}
          aria-orientation="horizontal" aria-valuemin={edge === 'from' ? 0 : window.from} aria-valuemax={edge === 'from' ? window.to : candles.length - 1}
          aria-valuenow={window[edge]} aria-valuetext={waveTime(candles[window[edge]].time, props.symbol, props.period)}
          onKeyDown={event => keyboard(event, edge)} onPointerDown={event => {
            if (event.button !== 0) return;
            event.preventDefault(); event.stopPropagation(); gesture.begin(event.clientX, edge);
            hostLeft.current = props.container.current?.getBoundingClientRect().left ?? 0;
            event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
          }} onPointerMove={event => drag(event, edge)} onPointerUp={event => {
            drag(event, edge); gesture.finish(true);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            event.stopPropagation();
          }} onPointerCancel={() => gesture.finish(false)} onLostPointerCapture={() => gesture.finish(false)} onClick={event => event.stopPropagation()}><span aria-hidden="true" /></button>
      </div>;
    })}
  </div>;
}

/** 提供不依赖拖动的起止柱选择和视野快捷操作。参数：真实柱、窗口与回调；返回：窗口工具条。 */
export function WaveWindowControls({ candles, window, symbol, period, onChange, onVisible }: {
  candles: Candle[]; window: WaveWindow; symbol: string; period: Period;
  onChange: (window: WaveWindow) => void; onVisible: () => void;
}) {
  const labels = useMemo(() => candles.map(candle => waveTime(candle.time, symbol, period)), [candles, symbol, period]);
  if (!candles.length) return null;
  return <div className="wave-window-controls" aria-label="波浪窗口设置">
    {(['from', 'to'] as const).map(edge => <label key={edge}>{edge === 'from' ? '分析起点' : '分析终点'}
      <select aria-label={edge === 'from' ? '波浪分析起点' : '波浪分析终点'} value={window[edge]}
        onChange={event => onChange(moveWaveBoundary(window, edge, Number(event.target.value), candles.length))}>
        {candles.map((candle, index) => <option key={candle.time} value={index}
          disabled={edge === 'from' ? index > window.to : index < window.from}>{labels[index]}</option>)}
      </select></label>)}
    <button type="button" className="button compact" onClick={onVisible}>使用当前可见区间</button>
    <span>已选 {window.to - window.from + 1} 根 · 拖动预览，松手更新波浪；方向键逐柱移动</span>
  </div>;
}
