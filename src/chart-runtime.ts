import { CrosshairMode, LineStyle, PriceScaleMode, type IChartApi } from 'lightweight-charts';
import type { ChartPreferences } from './chart-preferences';
import type { ChartAction } from './ChartTools';

/** 读取锁定颜色令牌并转换为Canvas兼容色。参数：CSS令牌名；返回：sRGB颜色。 */
export function chartColor(token: string): string {
  const probe = document.createElement('span');
  probe.style.color = `var(${token})`; document.body.appendChild(probe);
  try {
    const canvas = document.createElement('canvas'); const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法创建图表颜色画布。');
    context.fillStyle = getComputedStyle(probe).color; context.fillRect(0, 0, 1, 1);
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
    return `rgba(${red},${green},${blue},${alpha / 255})`;
  } finally { probe.remove(); }
}

/** 应用图表通用显示偏好。参数：实例及已校验偏好；返回：无，价格数据保持原值。 */
export function applyChartPreferences(chart: IChartApi, preferences: ChartPreferences): void {
  chart.applyOptions({ crosshair: { mode: preferences.crosshair === 'magnet' ? CrosshairMode.Magnet : CrosshairMode.Normal },
    grid: { vertLines: { visible: preferences.grid, color: chartColor('--color-chart-grid'), style: LineStyle.Solid },
      horzLines: { visible: preferences.grid, color: chartColor('--color-chart-grid'), style: LineStyle.Solid } } });
  // 只改变主价格窗格；成交量、RSI及MACD仍使用自己的线性单位。
  chart.panes()[0]?.priceScale('right').applyOptions({ mode: preferences.priceScale === 'log' ? PriceScaleMode.Logarithmic
    : preferences.priceScale === 'percent' ? PriceScaleMode.Percentage : PriceScaleMode.Normal });
}

/** 执行视野控制，缩放以当前可见中心为锚点。参数：实例与动作；返回：无。 */
export function performChartAction(chart: IChartApi, action: ChartAction): void {
  const scale = chart.timeScale();
  if (action === 'fit') { scale.fitContent(); return; }
  if (action === 'latest') { scale.scrollToRealTime(); return; }
  const range = scale.getVisibleLogicalRange();
  if (!range) return;
  const center = (range.from + range.to) / 2;
  const width = Math.min(100_000, Math.max(8, (range.to - range.from) * (action === 'zoom-in' ? 0.75 : 4 / 3)));
  scale.setVisibleLogicalRange({ from: center - width / 2, to: center + width / 2 });
}
