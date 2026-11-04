import type { IChartApi } from 'lightweight-charts';
import type { Candle, Period } from '../shared/types';
import { loadViewport, saveViewport, type ViewportRange } from './chart-viewport';

/** 绑定用户视野保存。参数：图表、容器、安全错误回调；返回：数据更新前后入口、工具捕获与释放函数。 */
export function bindViewportPersistence(chart: IChartApi, container: HTMLElement, onError: (error: string) => void) {
  let context: { key: string; candles: Candle[] } | null = null;
  let pending: { key: string; candles: Candle[]; range: ViewportRange } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastRange = ''; let dragging = false; let wheelUntil = 0; let changing = false; let changedDataset = false;
  /** 提交已捕获的最后一次视野。参数：无；返回：无，不读取后续数据集。 */
  const flush = () => {
    clearTimeout(timer);
    if (pending) { const saved = pending; pending = null; onError(saveViewport(saved.key, saved.candles, saved.range)); }
  };
  /** 捕获用户缩放或平移，连续操作合并为一次写入。参数：无；返回：无。 */
  const capture = () => {
    if (!context || changing) return;
    const range = chart.timeScale().getVisibleLogicalRange();
    if (!range || `${range.from}:${range.to}` === lastRange) return;
    lastRange = `${range.from}:${range.to}`;
    pending = { ...context, range: { from: range.from, to: range.to } };
    clearTimeout(timer); timer = setTimeout(flush, 200);
  };
  /** 范围通知仅响应实际交互，报价及setData触发的范围变化不落盘。参数：无；返回：无。 */
  const rangeChanged = () => { if (dragging || Date.now() < wheelUntil) capture(); };
  /** 标记鼠标或触摸操作开始。参数：无；返回：无。 */
  const pointerDown = () => { dragging = true; };
  /** 松手时捕获最终位置。参数：无；返回：无。 */
  const pointerUp = () => { if (dragging) { wheelUntil = Date.now() + 100; capture(); } dragging = false; };
  /** 滚轮事件先于图表处理执行，容纳图表下一帧的范围通知。参数：无；返回：无。 */
  const wheel = () => { wheelUntil = Date.now() + 400; };
  chart.timeScale().subscribeVisibleLogicalRangeChange(rangeChanged);
  container.addEventListener('pointerdown', pointerDown, true);
  container.addEventListener('wheel', wheel, { capture: true, passive: true });
  window.addEventListener('pointerup', pointerUp); window.addEventListener('pointercancel', pointerUp);
  window.addEventListener('pagehide', flush);
  return {
    /** 更新数据前切换隔离上下文。参数：来源证券周期键及实际柱；返回：无。 */
    beforeUpdate(key: string, candles: Candle[]) {
      changing = true; changedDataset = context?.key !== key;
      if (changedDataset) { flush(); dragging = false; wheelUntil = 0; }
      context = { key, candles };
    },
    /** 更新数据后恢复视野；无记录时使用日线近一个月。参数：周期；返回：无。 */
    afterUpdate(period: Period) {
      if (changedDataset && context) {
        const visibleBars = period === 'day' ? 20 : 100; const rightMargin = period === 'day' ? 1 : 7;
        const range = loadViewport(context.key, context.candles) ?? {
          from: Math.max(0, context.candles.length - visibleBars), to: context.candles.length + rightMargin,
        };
        chart.timeScale().setVisibleLogicalRange(range);
        lastRange = `${range.from}:${range.to}`;
      }
      changing = false;
    },
    /** 工具动作可能下一帧才更新逻辑范围，保留短暂的用户交互标记。参数：无；返回：无。 */
    capture() { wheelUntil = Date.now() + 400; capture(); },
    /** 卸载时提交最后调整并释放监听。参数：无；返回：无，必须先于chart.remove调用。 */
    destroy() {
      flush(); chart.timeScale().unsubscribeVisibleLogicalRangeChange(rangeChanged);
      container.removeEventListener('pointerdown', pointerDown, true); container.removeEventListener('wheel', wheel, true);
      window.removeEventListener('pointerup', pointerUp); window.removeEventListener('pointercancel', pointerUp);
      window.removeEventListener('pagehide', flush);
    },
  };
}
