import { useEffect, useRef, useState } from 'react';
import { moveWaveBoundary, type WaveWindow } from './wave-window';

type Edge = 'from' | 'to';

/** 拖动只按帧更新局部预览，松手一次提交昂贵的分析。参数：已提交窗口、柱数、提交回调；返回：预览与拖动生命周期操作。 */
export function useWaveDrag(window: WaveWindow, length: number, onChange: (window: WaveWindow) => void) {
  const [preview, setPreview] = useState<WaveWindow | null>(null);
  const pending = useRef<WaveWindow | null>(null);
  const frame = useRef(0);
  const origin = useRef<{ x: number; index: number; window: WaveWindow } | null>(null);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  /** 开始一次拖动，保存原窗口供取消还原。参数：横坐标、边界；返回：无。 */
  const begin = (x: number, edge: Edge) => { origin.current = { x, index: window[edge], window }; pending.current = null; };
  /** 合并同帧输入，未跨柱则不触发渲染。参数：边界、索引；返回：无。 */
  const move = (edge: Edge, index: number) => {
    if (!origin.current) return;
    const next = moveWaveBoundary(origin.current.window, edge, index, length);
    const previous = pending.current ?? origin.current.window;
    if (next.from === previous.from && next.to === previous.to) return;
    pending.current = next;
    if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; setPreview(pending.current); });
  };
  /** 结束或取消拖动并清理待处理帧。参数：是否提交；返回：无。 */
  const finish = (commit: boolean) => {
    cancelAnimationFrame(frame.current); frame.current = 0;
    if (commit && pending.current) onChange(pending.current);
    origin.current = null; pending.current = null; setPreview(null);
  };
  return { window: preview ?? window, origin, begin, move, finish };
}
