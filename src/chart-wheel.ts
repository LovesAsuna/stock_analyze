import type { IChartApi } from 'lightweight-charts';

export interface WheelMotion { kind: 'pan' | 'zoom'; amount: number }

/**
 * 按已观察的长桥桥接规则解释滚轮；每事件缩放限幅，横向手势优先。
 * @param deltaX 浏览器提供的水平增量，与原版一样不按 deltaMode 换算。
 * @param deltaY 浏览器提供的垂直增量。
 * @returns 平移像素或缩放倍率；低于原版阈值时为 null。
 */
export function chartWheelMotion(deltaX: number, deltaY: number): WheelMotion | null {
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return null;
  if (Math.abs(deltaX) >= 4 && Math.abs(deltaX) >= Math.abs(deltaY)) return { kind: 'pan', amount: deltaX };
  if (Math.abs(deltaY) < 2) return null;
  return { kind: 'zoom', amount: Math.max(0.9, Math.min(1.1, Math.exp(-0.01 * deltaY))) };
}

/**
 * 安装恢复的滚轮分流逻辑，使用图表公开 API 转换到时间轴，保持鼠标下的数据锚点。
 * @param container 已创建图表的 DOM 容器。
 * @param chart 唯一存活的图表实例。
 * @returns 卸载监听器的清理函数，须先于 chart.remove 调用。
 */
export function bindChartWheel(container: HTMLElement, chart: IChartApi): () => void {
  chart.applyOptions({ handleScroll: { mouseWheel: false }, handleScale: { mouseWheel: false } });
  /** 处理单次滚轮；参数为原始事件，返回无。 */
  function onWheel(event: WheelEvent): void {
    const motion = chartWheelMotion(event.deltaX, event.deltaY);
    try {
      const scale = chart.timeScale(); const range = scale.getVisibleLogicalRange();
      if (!range) return;
      if (event.cancelable) event.preventDefault();
      if (!motion) return;
      const width = scale.width();
      if (width <= 0) return;
      const pixelsPerBar = scale.options().barSpacing;
      if (!Number.isFinite(pixelsPerBar) || pixelsPerBar <= 0) return;
      if (motion.kind === 'pan') {
        const shift = motion.amount / pixelsPerBar;
        scale.setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
        return;
      }
      const horizontal = Math.max(0, Math.min(width, event.clientX - container.getBoundingClientRect().left));
      const anchor = scale.coordinateToLogical(horizontal);
      if (anchor === null) return;
      const oldSpan = range.to - range.from;
      if (oldSpan <= 0) return;
      const newSpan = Math.max(8, Math.min(100_000, oldSpan / motion.amount));
      const fraction = (anchor - range.from) / oldSpan;
      scale.setVisibleLogicalRange({ from: anchor - fraction * newSpan, to: anchor + (1 - fraction) * newSpan });
    } catch {
      console.warn('图表滚轮操作失败：时间轴暂不可用，可使用工具栏调整视野。');
    }
  }
  container.addEventListener('wheel', onWheel, { passive: false, capture: true });
  return () => container.removeEventListener('wheel', onWheel, { capture: true });
}
