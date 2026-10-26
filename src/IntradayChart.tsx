import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  createChart, LineSeries, HistogramSeries, ColorType, LineStyle, LineType, PriceScaleMode,
  type IChartApi, type ISeriesApi, type LineData, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import type { IntradayData, IntradayPoint } from '../shared/intraday';
import { formatNumber, formatTime } from './format';
import { SESSION_LABELS } from './MarketTimeframes';
import { ChartTools, type ChartAction } from './ChartTools';
import { useChartPreferences, type ChartPreferences } from './chart-preferences';
import { applyChartPreferences, chartColor, performChartAction } from './chart-runtime';
import { useChartFullscreen } from './useChartFullscreen';
import { bindChartWheel } from './chart-wheel';
import { fitIntradayViewport, intradayVolumeData, lockIntradayViewport } from './intraday-viewport';
import { calculateIntradayStudies, splitIntradayLine, type IntradayStudyPoint } from './intraday-studies';
import './intraday-terminal.css';

interface ChartProps { data: IntradayData; footer?: ReactNode }
interface StudyVisibility { rsi: boolean; macd: boolean }
interface HoverPoint { time: number; x: number }
interface PaneLabel { key: 'price' | 'volume' | 'rsi' | 'macd'; top: number }
type StudyKey = Exclude<keyof IntradayStudyPoint, 'time'>;
interface LineGroup {
  series: ISeriesApi<'Line'>[];
  pane: number;
  title: string;
  token: string;
  style: LineStyle;
}
interface ChartRuntime {
  chart: IChartApi;
  price: LineGroup;
  average: LineGroup;
  volume: ISeriesApi<'Histogram'>;
  studyLines: Partial<Record<StudyKey, LineGroup>>;
  histogram: ISeriesApi<'Histogram'> | null;
  visibility: string;
  identity: string;
}
const STUDY_LABELS: Record<StudyKey, string> = { rsi6: 'RSI6', rsi12: 'RSI12', rsi24: 'RSI24', dif: 'DIF', dea: 'DEA', macd: 'MACD' };
const STUDY_KEYS: StudyKey[] = ['rsi6', 'rsi12', 'rsi24', 'dif', 'dea'];

/**
 * 创建线组描述；真实序列按连续分钟段创建，不跨缺失区间连接。
 * @param pane 目标窗格索引。
 * @param title 显示名称。
 * @param token 稳定的颜色令牌。
 * @param style 线型，默认实线。
 * @returns 尚未填充数据的线组。
 */
function lineGroup(pane: number, title: string, token: string, style = LineStyle.Solid): LineGroup {
  return { series: [], pane, title, token, style };
}

/**
 * 更新分段折线，复用既有序列；只有最新一段显示末值，孤立分钟以真实点呈现。
 * @param current 图表实例与序列组。
 * @param group 同一价格或指标的连续线组。
 * @param points 原始真实分时点。
 * @param select 读数选择器，null 表示缺失或预热不足。
 * @returns 无返回值。
 */
function updateLine(current: ChartRuntime, group: LineGroup, points: readonly IntradayPoint[], select: (point: IntradayPoint, index: number) => number | null): void {
  const segments = splitIntradayLine(points, select);
  const count = Math.max(1, segments.length);
  while (group.series.length > count) current.chart.removeSeries(group.series.pop()!);
  while (group.series.length < count) {
    group.series.push(current.chart.addSeries(LineSeries, {
      color: chartColor(group.token), lineWidth: group.pane === 0 ? 1 : 2, lineType: LineType.Simple,
      lineStyle: group.style, priceLineVisible: false,
      crosshairMarkerRadius: 4, crosshairMarkerBorderColor: chartColor('--color-chart'),
      priceFormat: { type: 'price', precision: 3, minMove: 0.001 },
    }, group.pane));
  }
  group.series.forEach((series, index) => {
    const segment = segments[index] ?? [];
    const reachesEnd = segment.at(-1)?.time === points.at(-1)?.time;
    series.applyOptions({ title: reachesEnd ? group.title : '', lastValueVisible: reachesEnd,
      pointMarkersVisible: segment.length === 1, pointMarkersRadius: 4 });
    series.setData(segment.map(point => ({ ...point, time: point.time as UTCTimestamp } satisfies LineData)));
  });
}

/**
 * 初始化同一时间轴下的价格和独立成交量窗格；只在组件挂载时调用。
 * @param container 自动随宿主调整大小的 DOM 容器。
 * @returns 可持续更新的图表运行时。
 */
function initialize(container: HTMLElement): ChartRuntime {
  const chart = createChart(container, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: chartColor('--color-chart') }, textColor: chartColor('--color-muted'),
      fontFamily: getComputedStyle(document.body).fontFamily, fontSize: 11, attributionLogo: true,
      panes: { enableResize: false, separatorColor: chartColor('--color-rule') } },
    grid: { vertLines: { visible: false }, horzLines: { color: chartColor('--color-chart-grid'), style: LineStyle.Solid } },
    timeScale: { timeVisible: true, borderVisible: false, shiftVisibleRangeOnNewBar: false,
      allowShiftVisibleRangeOnWhitespaceReplacement: false, rightOffset: 4 },
    rightPriceScale: { borderVisible: false, minimumWidth: 74 }, leftPriceScale: { visible: false },
  });
  const volume = chart.addSeries(HistogramSeries, { color: chartColor('--color-dim'), priceFormat: { type: 'volume' },
    priceLineVisible: false, lastValueVisible: false }, 1);
  chart.panes()[0].setPreserveEmptyPane(true);
  return { chart, volume, price: lineGroup(0, '价格', '--color-study-1'),
    average: lineGroup(0, '均价', '--color-study-2', LineStyle.Dashed), studyLines: {}, histogram: null, visibility: '', identity: '' };
}

/**
 * 从后向前清理指标窗格，并按选择重建；价格窗格和图表实例保持不变。
 * @param current 图表运行时。
 * @param shown RSI/MACD 的独立可见状态。
 * @returns 无返回值。
 */
function configureStudies(current: ChartRuntime, shown: StudyVisibility): void {
  const signature = `${shown.rsi}:${shown.macd}`;
  if (current.visibility === signature) return;
  if (current.histogram) current.chart.removeSeries(current.histogram);
  current.histogram = null;
  [...STUDY_KEYS].reverse().forEach(key => current.studyLines[key]?.series.forEach(series => current.chart.removeSeries(series)));
  current.studyLines = {};
  let pane = 2;
  if (shown.rsi) {
    // 先创建 RSI 窗格，避免库把尚不存在的 MACD 第三窗格夹取到 RSI 第二窗格。
    current.chart.addPane();
    current.studyLines.rsi6 = lineGroup(pane, 'RSI6', '--color-study-1');
    current.studyLines.rsi12 = lineGroup(pane, 'RSI12', '--color-study-2', LineStyle.Dashed);
    current.studyLines.rsi24 = lineGroup(pane, 'RSI24', '--color-study-3', LineStyle.Dotted);
    pane += 1;
  }
  if (shown.macd) {
    current.studyLines.dif = lineGroup(pane, 'DIF', '--color-study-1');
    current.studyLines.dea = lineGroup(pane, 'DEA', '--color-study-2', LineStyle.Dashed);
    current.histogram = current.chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false,
      priceFormat: { type: 'price', precision: 3, minMove: 0.001 } }, pane);
  }
  current.visibility = signature;
}

/**
 * 应用共享偏好后将非价格窗格恢复线性单位，避免百分比或对数污染成交量及负 MACD。
 * @param current 图表运行时。
 * @param preferences 由共享 Hook 校验的完整显示偏好。
 * @returns 无返回值。
 */
function applyPreferences(current: ChartRuntime, preferences: ChartPreferences): void {
  applyChartPreferences(current.chart, preferences);
  current.chart.panes().slice(1).forEach(pane => pane.priceScale('right').applyOptions({ mode: PriceScaleMode.Normal,
    autoScale: true, scaleMargins: { top: 0.28, bottom: 0.08 } }));
}

/**
 * 更新快照、指标和时间格式；单日固定完整时段，五日普通刷新保持用户视野。
 * @param current 图表运行时。
 * @param data 已验证的分时快照。
 * @param studies 与原始点等长的纯价格指标。
 * @param shown 独立指标可见状态。
 * @returns 无返回值。
 */
function updateChart(current: ChartRuntime, data: IntradayData, studies: readonly IntradayStudyPoint[], shown: StudyVisibility): void {
  const identity = `${data.source}:${data.symbol}:${data.session}:${data.days}`;
  const sameIdentity = current.identity === identity;
  const visibleRange = sameIdentity ? current.chart.timeScale().getVisibleLogicalRange() : null;
  configureStudies(current, shown);
  updateLine(current, current.price, data.points, point => point.price);
  updateLine(current, current.average, data.points, point => point.averagePrice);
  const up = chartColor('--color-chart-up'); const down = chartColor('--color-chart-down');
  current.volume.setData(intradayVolumeData(data, up, down));
  STUDY_KEYS.forEach(key => {
    const group = current.studyLines[key];
    if (group) updateLine(current, group, data.points, (_, index) => studies[index][key]);
  });
  current.histogram?.setData(studies.map(point => point.macd === null ? { time: point.time as UTCTimestamp }
    : { time: point.time as UTCTimestamp, value: point.macd, color: point.macd >= 0 ? up : down }));
  // RSI 与 MACD 都使用独立右轴，RSI 固定 0–100；不把价格换算成伪造 K 线。
  current.studyLines.rsi6?.series.forEach(series => series.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) }));
  const formatter = (time: Time) => typeof time === 'number' ? formatTime(time, data.symbol, '1m') : String(time);
  // 日期加时间超过默认的8字符估宽，显式预留空间以避免手机横轴标签相撞。
  current.chart.applyOptions({ localization: { timeFormatter: formatter },
    timeScale: { tickMarkFormatter: formatter, tickMarkMaxCharacterLength: 14 } });
  current.chart.panes().forEach((pane, index) => pane.setStretchFactor(index === 0 ? 4.5 : 1.15));
  if (data.days === 1) { fitIntradayViewport(current.chart, data); current.identity = identity; }
  else if (!sameIdentity) { current.chart.timeScale().fitContent(); current.identity = identity; }
  else if (visibleRange) current.chart.timeScale().setVisibleLogicalRange(visibleRange);
}

/**
 * 绘制带线型的读数项，文字使用主题文本色，不靠颜色单独识别序列。
 * @param props 标签、数值、令牌槽位和补充线型。
 * @returns 图例及可读数值。
 */
function Reading({ label, value, slot = 1, style = 'solid', digits = 3 }: {
  label: string; value: number | null | undefined; slot?: number; style?: 'solid' | 'dashed' | 'dotted' | 'bar'; digits?: number;
}) {
  return <span className="intraday-reading"><i aria-hidden="true" className={`intraday-swatch slot-${slot} ${style}`} />
    <span>{label}</span><b>{formatNumber(value, digits)}</b></span>;
}

/**
 * 显示各窗格内的同步读数；指标未预热时保留名称并显示空值。
 * @param props 窗格名、所选分时点和该分钟指标。
 * @returns 带名称及线型的图内图例。
 */
function PaneReading({ pane, point, study }: { pane: PaneLabel['key']; point?: IntradayPoint; study?: IntradayStudyPoint }) {
  if (pane === 'price') return <><strong>分时</strong><Reading label="价格" value={point?.price} />
    <Reading label="均价" value={point?.averagePrice} slot={2} style="dashed" /></>;
  if (pane === 'volume') return <><strong>VOL</strong><Reading label="成交量" value={point?.volume} digits={0} style="bar" />
    <small>柱色随相邻价格涨跌</small></>;
  if (pane === 'rsi') return <><strong>RSI (6, 12, 24)</strong><Reading label="RSI6" value={study?.rsi6} />
    <Reading label="RSI12" value={study?.rsi12} slot={2} style="dashed" /><Reading label="RSI24" value={study?.rsi24} slot={3} style="dotted" /></>;
  return <><strong>MACD (12, 26, 9)</strong><Reading label="DIF" value={study?.dif} />
    <Reading label="DEA" value={study?.dea} slot={2} style="dashed" /><Reading label="MACD" value={study?.macd} style="bar" />
    <small>柱 = 2 × (DIF − DEA)</small></>;
}

/**
 * 提供完整分时及衍生指标表格，键盘和辅助技术可读取所有分钟的真实数据。
 * @param props 已加载快照与对应计算指标。
 * @returns 可展开、可横向滚动的完整数据表。
 */
function IntradayTable({ data, studies }: { data: IntradayData; studies: readonly IntradayStudyPoint[] }) {
  const [open, setOpen] = useState(false);
  // 五日全时段可达数千行；折叠时不挂载表格行，避免阻塞首次Canvas绘制。
  return <details className="intraday-table" onToggle={event => setOpen(event.currentTarget.open)}><summary>分时数据表（{data.points.length} 点）</summary>
    <div className="table-scroll"><table><caption className="sr-only">真实分时数据及由分时价格计算的 RSI、MACD，— 表示缺失或预热不足</caption>
      <thead><tr>{['交易所时间', '时段', '价格', '均价', '成交量', 'RSI6', 'RSI12', 'RSI24', 'DIF', 'DEA', 'MACD'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
      <tbody>{open && data.points.map((point, index) => <tr key={point.time}>
        <td>{formatTime(point.time, data.symbol, '1m')}</td><td>{SESSION_LABELS[point.session]}</td>
        <td>{formatNumber(point.price, 3)}</td><td>{formatNumber(point.averagePrice, 3)}</td><td>{formatNumber(point.volume, 0)}</td>
        {[...STUDY_KEYS, 'macd' as const].map(key => <td key={key}>{formatNumber(studies[index]?.[key], 3)}</td>)}
      </tr>)}</tbody></table></div></details>;
}

/**
 * 管理单实例图表生命周期和 DOM 布局，所有失败均提供安全的中文提示。
 * @param container 图表画布宿主。
 * @param data 当前分时快照。
 * @param studies 预先计算的等长指标。
 * @param shown 可见指标窗格。
 * @param preferences 已验证显示偏好。
 * @returns 图表引用、十字线状态、窗格标签位置和错误信息。
 */
function useIntradayChart(container: React.RefObject<HTMLDivElement | null>, data: IntradayData,
  studies: readonly IntradayStudyPoint[], shown: StudyVisibility, preferences: ChartPreferences) {
  const runtime = useRef<ChartRuntime | null>(null);
  const [hovered, setHovered] = useState<HoverPoint | null>(null);
  const [panes, setPanes] = useState<PaneLabel[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!container.current) return;
    let current: ChartRuntime | null = null;
    let releaseWheel: (() => void) | undefined;
    try {
      current = initialize(container.current); runtime.current = current;
      if (data.days === 1) lockIntradayViewport(current.chart);
      else releaseWheel = bindChartWheel(container.current, current.chart);
      current.chart.subscribeCrosshairMove(event => setHovered(typeof event.time === 'number' && event.point
        ? { time: event.time, x: event.point.x } : null));
    } catch {
      console.warn('分时图初始化失败：无法创建图表画布。');
      releaseWheel?.(); current?.chart.remove(); runtime.current = null; setError('无法创建分时图，请刷新页面重试；下方完整数据表仍可查看。');
    }
    return () => { releaseWheel?.(); current?.chart.remove(); runtime.current = null; };
  }, [container, data.days]);
  useEffect(() => {
    if (!runtime.current || !container.current) return;
    const current = runtime.current;
    let frame = 0;
    /** 读取官方窗格尺寸生成覆盖图例。返回：无返回值。 */
    function measure(): void {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const keys: PaneLabel['key'][] = ['price', 'volume', ...(shown.rsi ? ['rsi' as const] : []), ...(shown.macd ? ['macd' as const] : [])];
        let top = 0;
        setPanes(current.chart.panes().map((pane, index) => { const label = { key: keys[index], top }; top += pane.getHeight() + 1; return label; }));
      });
    }
    try {
      updateChart(current, data, studies, shown); applyPreferences(current, preferences); setError(''); measure();
    } catch {
      console.warn('分时图更新失败：快照或图表状态不可用。');
      setError('分时图更新失败，请刷新重试；可展开下方数据表检查快照。');
    }
    /** 单日随宿主尺寸变化重新铺满完整交易时段，五日仍保持用户视野。 */
    const observer = new ResizeObserver(() => { if (data.days === 1) fitIntradayViewport(current.chart, data); measure(); }); observer.observe(container.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [container, data, studies, shown, preferences]);
  return { runtime, hovered, setHovered, panes, error };
}

/**
 * 长桥风格分时终端：真实工具栏、价格/均价、独立 VOL/RSI/MACD 和全屏周期栏。
 * @param props 已校验快照及位于图表正下方、全屏宿主内的可选周期栏。
 * @returns 图表、同步读数、键盘检查和完整表格，不生成 K 线或策略信号。
 */
export function IntradayChart({ data, footer }: ChartProps) {
  const host = useRef<HTMLDivElement>(null); const container = useRef<HTMLDivElement>(null);
  const { preferences, setPreferences, error: preferenceError } = useChartPreferences();
  const { fullscreen, toggle, error: fullscreenError } = useChartFullscreen(host);
  const [indicatorsOpen, setIndicatorsOpen] = useState(false);
  const [shown, setShown] = useState<StudyVisibility>({ rsi: true, macd: true });
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const [actionError, setActionError] = useState('');
  const calculated = useMemo(() => {
    try { return { studies: calculateIntradayStudies(data.points), error: '' }; }
    catch { console.warn('分时指标计算失败：分时快照未通过校验。'); return { studies: [] as IntradayStudyPoint[], error: '分时数据无效，无法计算指标，请刷新后重试。' }; }
  }, [data.points]);
  const { runtime, hovered, setHovered, panes, error } = useIntradayChart(container, data, calculated.studies, shown, preferences);
  const lookup = useMemo(() => new Map(data.points.map((point, index) => [point.time, index])), [data.points]);
  const selectedIndex = lookup.get(selectedTime ?? hovered?.time ?? -1) ?? data.points.length - 1;
  const point = data.points[selectedIndex]; const study = calculated.studies[selectedIndex];
  const tooltip = Boolean(selectedTime === null && hovered && lookup.has(hovered.time));
  useEffect(() => { setSelectedTime(null); setHovered(null); }, [data.source, data.symbol, data.session, data.days, setHovered]);
  /** 执行显式视口动作。参数：工具栏动作；返回：无返回值。 */
  function onAction(action: ChartAction): void {
    if (data.days === 1) return;
    try { if (runtime.current) performChartAction(runtime.current.chart, action); setActionError(''); }
    catch { console.warn('分时图视野操作失败：图表暂不可用。'); setActionError('无法调整图表视野，请刷新后重试。'); }
  }
  return <div className="intraday-panel intraday-terminal" ref={host} data-fullscreen={fullscreen}>
    <ChartTools fixedViewport={data.days === 1} preferences={preferences} onPreferences={setPreferences} onAction={onAction}
      indicatorsOpen={indicatorsOpen} onIndicators={() => setIndicatorsOpen(open => !open)} fullscreen={fullscreen}
      onFullscreen={() => { void toggle(); }} error={calculated.error || error || actionError || fullscreenError || preferenceError} />
    {indicatorsOpen && <div className="intraday-study-controls" role="group" aria-label="分时指标选择">
      <span>独立指标窗格</span>{(['rsi', 'macd'] as const).map(key => <label key={key}>
        <input type="checkbox" checked={shown[key]} onChange={event => setShown(previous => ({ ...previous, [key]: event.target.checked }))} />
        {key === 'rsi' ? 'RSI (6 / 12 / 24)' : 'MACD (12 / 26 / 9)'}</label>)}<small>仅以分时价格计算 · 缺失区间重新预热</small>
    </div>}
    <div className="intraday-terminal-readout" aria-live="off">
      <strong>{point ? formatTime(point.time, data.symbol, '1m') : '暂无分时点'}</strong>
      <span>{point ? SESSION_LABELS[point.session] : SESSION_LABELS[data.session]}</span>
      <span>{selectedTime !== null ? '键盘读数' : hovered ? '十字线读数' : '最新读数'}</span>
      <Reading label="价格" value={point?.price} /><Reading label="均价" value={point?.averagePrice} slot={2} style="dashed" />
      <Reading label="成交量" value={point?.volume} digits={0} style="bar" />
    </div>
    <div className="intraday-terminal-stage" onPointerMove={() => { if (selectedTime !== null) setSelectedTime(null); }} data-study-count={Number(shown.rsi) + Number(shown.macd)}>
      <div ref={container} className="intraday-chart" role="img" aria-label={`${data.days === 5 ? '5日' : SESSION_LABELS[data.session]}分时价格、均价、成交量${shown.rsi ? '、RSI' : ''}${shown.macd ? '、MACD' : ''}图；可通过下方键盘滑块和表格检查数值`} />
      {panes.map(pane => <div key={pane.key} className="intraday-pane-legend" style={{ top: pane.top + 8 }}>
        <PaneReading pane={pane.key} point={point} study={study} /></div>)}
      {tooltip && point && <div className={`intraday-tooltip ${hovered!.x < (container.current?.clientWidth ?? 0) / 2 ? 'align-right' : 'align-left'}`} role="tooltip">
        <strong>{formatTime(point.time, data.symbol, '1m')} · {SESSION_LABELS[point.session]}</strong>
        <PaneReading pane="price" point={point} study={study} /><Reading label="成交量" value={point.volume} digits={0} style="bar" />
        {shown.rsi && <PaneReading pane="rsi" point={point} study={study} />}{shown.macd && <PaneReading pane="macd" point={point} study={study} />}
      </div>}
    </div>
    {footer && <div className="intraday-terminal-footer">{footer}</div>}
    {data.points.length > 0 && <label className="intraday-keyboard">键盘检查分时点
      <input aria-label="检查分时点" type="range" min="0" max={data.points.length - 1} value={Math.max(0, selectedIndex)}
        aria-valuetext={point ? `${formatTime(point.time, data.symbol, '1m')} 价格 ${formatNumber(point.price, 3)}` : ''}
        onChange={event => { setHovered(null); setSelectedTime(data.points[Number(event.target.value)].time); }} />
      <span>{selectedIndex + 1} / {data.points.length}</span>
    </label>}
    <div className="intraday-accessible-studies" aria-live="off">
      {shown.rsi && <PaneReading pane="rsi" point={point} study={study} />}{shown.macd && <PaneReading pane="macd" point={point} study={study} />}
      <span>— 表示缺失或预热不足；价格实线、均价虚线；缺失分钟不连线。</span>
    </div>
    <IntradayTable data={data} studies={calculated.studies} />
  </div>;
}
