import { LineSeries, LineStyle, createSeriesMarkers, type IChartApi, type UTCTimestamp, type SeriesMarker, type Time } from 'lightweight-charts';
import type { ElliottAnalysis } from '../shared/elliott-wave';
import { chartColor } from './chart-runtime';
import { formatNumber } from './format';
import type { Candle, Period } from '../shared/types';
import { barOpenTime } from '../shared/review';
import { isCalendarPeriod } from '../shared/periods';
import './elliott-waves.css';

/** 创建同价轴波浪图层，不影响主图自动缩放。参数：现有图表；返回：仅持有固定两条折线及标签的图层。 */
export function createElliottOverlay(chart: IChartApi) {
  const options = { color: chartColor('--color-wave'), lineWidth: 2 as const, lastValueVisible: false,
    priceLineVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: () => null };
  const impulse = chart.addSeries(LineSeries, options);
  const correction = chart.addSeries(LineSeries, { ...options, lineStyle: LineStyle.Dashed });
  const markers = createSeriesMarkers(impulse, [], { autoScale: false });
  const correctionMarkers = createSeriesMarkers(correction, [], { autoScale: false });
  return { impulse, correction, markers, correctionMarkers };
}

/** 更新折线和编号；关闭时清空数据与标签，不覆盖交易标记或改变视野。参数：图层、分析或null；返回：无。 */
export function updateElliottOverlay(overlay: ReturnType<typeof createElliottOverlay>, analysis: ElliottAnalysis | null): void {
  const pattern = analysis?.pattern;
  const impulse = pattern?.impulse ?? [];
  const correction = pattern?.correction.length ? [impulse[5], ...pattern.correction] : [];
  const asMarkers = (points: typeof impulse): SeriesMarker<Time>[] => points.map(point => ({
    time: point.time as UTCTimestamp, price: point.price, position: point.kind === 'high' ? 'atPriceTop' : 'atPriceBottom',
    shape: 'circle', size: 0, color: chartColor('--color-ink'), text: point.label,
  }));
  overlay.impulse.setData(impulse.map(point => ({ time: point.time as UTCTimestamp, value: point.price })));
  overlay.correction.setData(correction.map(point => ({ time: point.time as UTCTimestamp, value: point.price })));
  overlay.markers.setMarkers(asMarkers(impulse));
  overlay.correctionMarkers.setMarkers(asMarkers(pattern?.correction ?? []));
}

// 格式器按市场及周期复用，避免每次拖动为数百个选项重复创建昂贵的Intl实例。
const waveFormatters = new Map<string, Intl.DateTimeFormat>();

/** 波浪日期始终带年份，避免跨年历史结构被误认成近期。参数：柱时间、证券、周期；返回：交易所本地日期及分钟周期时刻。 */
export function waveTime(time: number, symbol: string, period: Period): string {
  const calendar = isCalendarPeriod(period);
  const timeZone = symbol.endsWith('.HK') ? 'Asia/Hong_Kong' : 'America/New_York';
  const key = `${timeZone}-${calendar}`;
  let formatter = waveFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      ...(calendar ? {} : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const }) });
    waveFormatters.set(key, formatter);
  }
  return formatter.format(new Date((calendar ? barOpenTime(time, symbol, period) : time) * 1000));
}

/** 给数浪提供可读说明与可键盘展开的数据表。参数：分析、当前证券及周期；返回：候选结构说明与拐点明细。 */
export function ElliottWaveDetails({ analysis, symbol, period, candles }: { analysis: ElliottAnalysis; symbol: string; period: Period; candles: Candle[] }) {
  const pattern = analysis.pattern;
  return <div className="elliott-summary" aria-label="埃略特波浪识别结果">
    <p><span className="elliott-swatch" aria-hidden="true" /><strong>自动埃略特波浪</strong> · {pattern
      ? `最近${pattern.direction === 'up' ? '上涨' : '下跌'}推动浪候选 1–5${pattern.correction.length ? ' + A–B–C' : ''}`
      : '所选窗口内未找到符合规则的标准推动浪'} · 确认窗口 {analysis.radius} 根</p>
    <p>分析窗口：{candles.length ? `${waveTime(candles[0].time, symbol, period)} → ${waveTime(candles[candles.length - 1].time, symbol, period)} · ${candles.length} 根` : '暂无K线'}。{pattern
      ? `推动浪 ${waveTime(pattern.impulse[0].time, symbol, period)} → ${waveTime(pattern.impulse[5].time, symbol, period)}。`
      : '仅使用窗口内数据及确认柱，不向窗口外寻找旧浪。'}</p>
    <p>实线 1–5，虚线 A–B–C。拐点需后续 {analysis.radius} 根收盘 K 线确认，最新同类极值及候选编号可能重绘；历史标注不代表当时已知，不作为交易信号。</p>
    {pattern && <details><summary>查看波浪拐点与确认时间</summary><div className="table-scroll"><table>
      <caption>最近一组规则候选 · 实际价格，无未来预测</caption>
      <thead><tr><th>波浪</th><th>拐点时间（交易所）</th><th>价格</th><th>最早确认柱（交易所）</th></tr></thead>
      <tbody>{[...pattern.impulse, ...pattern.correction].map(point => <tr key={point.label}>
        <td>{point.label}</td><td>{waveTime(point.time, symbol, period)}</td><td>{formatNumber(point.price, 3)}</td><td>{waveTime(point.confirmedAt, symbol, period)}</td>
      </tr>)}</tbody></table></div></details>}
  </div>;
}
