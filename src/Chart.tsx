import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ChartTools } from './ChartTools';
import { useChartPreferences } from './chart-preferences';
import { useChartFullscreen } from './useChartFullscreen';
import { chartColor as color, applyChartPreferences, performChartAction } from './chart-runtime';
import { calculateChartStudies, type ChartStudyPoint } from './chart-study-data';
import { ChartReadouts } from './ChartReadouts';
import { bindChartWheel } from './chart-wheel';
import './chart-terminal.css';
import { createChart, CandlestickSeries, LineSeries, HistogramSeries, createSeriesMarkers, ColorType, LineStyle,
  type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type UTCTimestamp, type SeriesMarker, type Time } from 'lightweight-charts';
import type { Candle, Execution, IndicatorPoint, Period, Signal } from '../shared/types';
import { formatTime } from './format';
import type { ChartPreferences } from './chart-preferences';
import { barOpenTime, signalConfirmationTime } from '../shared/review';
import { isCalendarPeriod } from '../shared/periods';
import { isRegularTradingTime } from '../shared/calendar-bars';
import type { TradingPlan } from '../shared/strategy';
import type { BacktestResult } from '../shared/backtest';

export interface ChartLayers { ma: boolean; sar: boolean; boll: boolean; signals: boolean; fills: boolean }
export type Oscillator = 'macd' | 'rsi' | 'dmi';
interface Props {
  candles: Candle[]; indicators: IndicatorPoint[]; signals: Signal[]; executions: Execution[];
  symbol: string; period: Period; layers: ChartLayers; oscillator: Oscillator;
  selectedTime: number | null; costPrice?: number; onSelect: (time: number) => void;
  plan?: TradingPlan; backtest?: BacktestResult; pickingPrice?: boolean; onPickPrice?: (price: number) => void;
  footer?: ReactNode; controls?: ReactNode;
}
interface ChartState {
  chart: IChartApi; price: ISeriesApi<'Candlestick'>; volume: ISeriesApi<'Histogram'>;
  fast: ISeriesApi<'Line'>; slow: ISeriesApi<'Line'>; sar: ISeriesApi<'Line'>;
  upper: ISeriesApi<'Line'>; lower: ISeriesApi<'Line'>;
  first: ISeriesApi<'Line'>; second: ISeriesApi<'Line'>; third: ISeriesApi<'Histogram'>; adx: ISeriesApi<'Line'>;
  markers: ISeriesMarkersPluginApi<Time>;
  averages: ISeriesApi<'Line'>[];
}

/** 创建唯一图表实例与独立价格、成交量、振荡指标窗格，返回可更新的公开 API 引用。 */
function initialize(container: HTMLElement): ChartState {
  const chart = createChart(container, { autoSize: true,
    layout: { background: { type: ColorType.Solid, color: color('--color-chart') }, textColor: color('--color-muted'),
      fontFamily: getComputedStyle(document.body).fontFamily, attributionLogo: true, fontSize: 11 },
    grid: { vertLines: { visible: false }, horzLines: { color: color('--color-paper-3') } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.26, bottom: 0.08 } }, timeScale: { borderVisible: false, rightOffset: 8 },
    crosshair: { vertLine: { color: color('--color-rule-2'), style: LineStyle.Dashed }, horzLine: { color: color('--color-rule-2') } },
  });
  const price = chart.addSeries(CandlestickSeries, { upColor: color('--color-chart'), downColor: color('--color-chart-down'),
    wickUpColor: color('--color-chart-up'), wickDownColor: color('--color-chart-down'),
    borderUpColor: color('--color-chart-up'), borderDownColor: color('--color-chart-down'), borderVisible: true });
  const line = (token: string, pane = 0) => chart.addSeries(LineSeries, { color: color(token), lineWidth: 2,
    lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false }, pane);
  const averages = [1, 2, 3, 4].map((slot, index) => {
    const series = line(`--color-study-${slot}`);
    series.applyOptions({ lineWidth: 1, lineStyle: [LineStyle.Solid, LineStyle.Dashed, LineStyle.Dotted, LineStyle.LargeDashed][index] });
    return series;
  });
  const fast = line('--color-series-1'); const slow = line('--color-series-2');
  const sar = line('--color-series-3');
  sar.applyOptions({ lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 2 });
  const upper = line('--color-dim'); const lower = line('--color-dim');
  upper.applyOptions({ lineStyle: LineStyle.Dashed, lineWidth: 1 }); lower.applyOptions({ lineStyle: LineStyle.Dashed, lineWidth: 1 });
  const volume = chart.addSeries(HistogramSeries, { color: color('--color-dim'), priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }, 1);
  const first = line('--color-series-1', 2); const second = line('--color-series-2', 2);
  fast.applyOptions({ lineStyle: LineStyle.Solid }); slow.applyOptions({ lineStyle: LineStyle.Dashed });
  second.applyOptions({ lineStyle: LineStyle.Dashed });
  const adx = line('--color-series-3', 2); adx.applyOptions({ lineStyle: LineStyle.Dotted });
  const third = chart.addSeries(HistogramSeries, { lastValueVisible: false, priceLineVisible: false }, 2);
  chart.panes()[0].setStretchFactor(0.66); chart.panes()[1].setStretchFactor(0.14); chart.panes()[2].setStretchFactor(0.20);
  const markers = createSeriesMarkers(price, [], { autoScale: true });
  container.querySelectorAll('canvas').forEach((canvas) => canvas.setAttribute('aria-hidden', 'true'));
  return { chart, price, volume, fast, slow, sar, upper, lower, first, second, third, adx, markers, averages };
}

/** 将指标的有效值映射成图表点；预热期使用 whitespace，禁止把 null 画成 0。 */
function points(indicators: IndicatorPoint[], key: keyof IndicatorPoint) {
  return indicators.map((point) => typeof point[key] === 'number'
    ? { time: point.time as UTCTimestamp, value: point[key] as number }
    : { time: point.time as UTCTimestamp });
}

/** 绑定真实成交到包含它的图表 K 线；非本图时段的成交不会伪造柱。 */
function executionBar(execution: Execution, props: Props): Candle | undefined {
  if (!isRegularTradingTime(execution.time, props.symbol)) return undefined;
  return props.candles.find(candle => execution.time >= barOpenTime(candle.time, props.symbol, props.period) &&
    execution.time < signalConfirmationTime(candle.time, props.symbol, props.period));
}

/** 更新图表数据与图层，参数为现有实例和页面状态，无重建图表或隐式策略计算。 */
function updateChart(state: ChartState, props: Props, studies: ChartStudyPoint[], showAverages: boolean): void {
  const { candles, indicators, layers, oscillator } = props;
  (['ma5', 'ma10', 'ma20', 'ma50'] as const).forEach((key, index) => {
    state.averages[index].setData(studies.map(point => point[key] == null ? { time: point.time as UTCTimestamp }
      : { time: point.time as UTCTimestamp, value: point[key] }));
    state.averages[index].applyOptions({ visible: showAverages });
  });
  const upColor = color('--color-chart-up'); const downColor = color('--color-chart-down');
  state.price.setData(candles.map((candle) => ({ ...candle, time: candle.time as UTCTimestamp })));
  state.volume.setData(candles.map((candle) => ({ time: candle.time as UTCTimestamp, value: candle.volume,
    color: candle.close >= candle.open ? upColor : downColor })));
  state.fast.setData(points(indicators, 'fastMA')); state.slow.setData(points(indicators, 'slowMA'));
  state.sar.setData(points(indicators, 'sar')); state.upper.setData(points(indicators, 'bollUpper')); state.lower.setData(points(indicators, 'bollLower'));
  state.fast.applyOptions({ visible: layers.ma }); state.slow.applyOptions({ visible: layers.ma });
  state.sar.applyOptions({ visible: layers.sar }); state.upper.applyOptions({ visible: layers.boll }); state.lower.applyOptions({ visible: layers.boll });
  state.first.setData(points(indicators, oscillator === 'macd' ? 'macd' : oscillator === 'rsi' ? 'rsi' : 'plusDI'));
  state.second.setData(oscillator === 'rsi' ? [] : points(indicators, oscillator === 'macd' ? 'macdSignal' : 'minusDI'));
  state.third.setData(oscillator === 'macd' ? indicators.map((point) => point.histogram === null ? { time: point.time as UTCTimestamp }
    : { time: point.time as UTCTimestamp, value: point.histogram, color: point.histogram >= 0 ? upColor : downColor }) : []);
  state.adx.setData(oscillator === 'dmi' ? points(indicators, 'adx') : []);
  const markers: SeriesMarker<Time>[] = [];
  if (layers.signals) for (const signal of props.signals) markers.push({ time: signal.time as UTCTimestamp,
    position: signal.side === 'buy' ? 'belowBar' : 'aboveBar', shape: signal.side === 'buy' ? 'arrowUp' : 'arrowDown',
    color: color(signal.side === 'buy' ? '--color-series-1' : '--color-series-2'), text: signal.side === 'buy' ? '入场触发' : '离场触发', id: signal.id });
  if (layers.signals && props.backtest) for (const trade of [...props.backtest.trades, ...(props.backtest.openTrade ? [props.backtest.openTrade] : [])]) {
    const entry = candles[trade.entryIndex]; const exit = trade.exitIndex == null ? null : candles[trade.exitIndex];
    if (entry) markers.push({ time: entry.time as UTCTimestamp, position: 'belowBar', shape: 'square', color: color('--color-series-1'), text: '模拟买', id: `${trade.id}-entry` });
    if (exit) markers.push({ time: exit.time as UTCTimestamp, position: 'aboveBar', shape: 'square', color: color('--color-series-2'), text: '模拟卖', id: `${trade.id}-exit` });
  }
  if (layers.fills) for (const execution of props.executions) {
    const bar = executionBar(execution, props);
    if (bar) markers.push({ time: bar.time as UTCTimestamp, position: execution.side === 'buy' ? 'belowBar' : 'aboveBar', shape: 'circle',
      color: color('--color-ink'), text: execution.side === 'buy' ? '实买' : '实卖', id: execution.id });
  }
  state.markers.setMarkers(markers.sort((left, right) => Number(left.time) - Number(right.time)));
}

/** 同步主图展示偏好。参数：图表引用和偏好；返回：无，不改动数据或策略计算。 */
function useChartAppearance(state: RefObject<ChartState | null>, preferences: ChartPreferences): void {
  useEffect(() => {
    const current = state.current;
    if (!current) return;
    applyChartPreferences(current.chart, preferences);
    current.price.applyOptions({ upColor: color(preferences.hollowUp ? '--color-chart' : '--color-chart-up') });
  }, [state, preferences]);
}

/** TradingView 图表组件。实例只在挂载时创建；十字线与点击同步页面读数，卸载时释放监听。 */
export function StockChart(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const { preferences, setPreferences, error } = useChartPreferences();
  const screen = useChartFullscreen(host);
  const [indicatorsOpen, setIndicatorsOpen] = useState(false);
  const [showAverages, setShowAverages] = useState(true);
  const studies = useMemo(() => calculateChartStudies(props.candles), [props.candles]);
  const state = useRef<ChartState | null>(null);
  const latestProps = useRef(props); latestProps.current = props;
  const datasetKey = useRef('');
  const selectionKey = useRef('');
  const [hovered, setHovered] = useState<Candle | null>(null);
  useEffect(() => {
    if (!container.current) return;
    const current = initialize(container.current); state.current = current;
    const releaseWheel = bindChartWheel(container.current, current.chart);
    current.chart.subscribeCrosshairMove((event) => {
      setHovered(latestProps.current.candles.find((candle) => candle.time === event.time) ?? null);
    });
    current.chart.subscribeClick((event) => {
      const latest = latestProps.current;
      if (latest.pickingPrice && event.point && (event.paneIndex ?? 0) === 0) {
        const price = current.price.coordinateToPrice(event.point.y);
        if (price != null) latest.onPickPrice?.(price);
      } else if (typeof event.time === 'number') latest.onSelect(event.time);
    });
    return () => { releaseWheel(); current.chart.remove(); state.current = null; };
  }, []);
  useEffect(() => {
    if (!state.current) return;
    updateChart(state.current, props, studies, showAverages);
    // 实时追加K线不得把用户正在查看的历史位置强制跳回最新柱。
    const key = `${props.symbol}-${props.period}`;
    if (datasetKey.current !== key) {
      state.current.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, props.candles.length - 100), to: props.candles.length + 7 });
      datasetKey.current = key;
    }
  }, [props.candles, props.indicators, props.layers, props.oscillator, props.signals, props.executions, props.symbol, props.period, props.backtest, studies, showAverages]);
  useChartAppearance(state, preferences);
  useEffect(() => {
    if (!state.current) return;
    if (!props.selectedTime) { selectionKey.current = ''; return; }
    const key = `${props.symbol}-${props.period}-${props.selectedTime}`;
    if (selectionKey.current === key) return;
    const index = props.candles.findIndex((candle) => candle.time === props.selectedTime);
    if (index >= 0) {
      state.current.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, index - 35), to: index + 25 });
      selectionKey.current = key;
    }
  }, [props.selectedTime, props.candles, props.symbol, props.period]);
  useEffect(() => {
    if (!state.current || !props.costPrice) return;
    const current = state.current;
    const line = current.price.createPriceLine({ price: props.costPrice, color: color('--color-muted'), lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '持仓成本' });
    return () => { if (state.current === current) current.price.removePriceLine(line); };
  }, [props.costPrice]);
  useEffect(() => {
    state.current?.chart.applyOptions({ localization: { timeFormatter: (time: Time) => typeof time === 'number' ? formatTime(time, props.symbol, props.period) : String(time) },
      timeScale: { timeVisible: !isCalendarPeriod(props.period), tickMarkFormatter: (time: Time) => typeof time === 'number' ? formatTime(time, props.symbol, props.period) : String(time) } });
  }, [props.symbol, props.period]);
  useEffect(() => {
    const current = state.current;
    if (!current || !props.plan) return;
    const levels = [
      { price: props.plan.entryPrice, title: '观察入场价', token: '--color-series-1', style: LineStyle.Dashed },
      { price: props.plan.stopPrice ?? props.backtest?.openTrade?.stopPrice, title: '计划止损', token: '--color-series-2', style: LineStyle.Dotted },
      { price: props.plan.targetPrice ?? props.backtest?.openTrade?.targetPrice, title: '计划目标', token: '--color-series-3', style: LineStyle.Solid },
      { price: props.backtest?.openTrade?.trailPrice, title: '模拟持仓追踪线', token: '--color-dim', style: LineStyle.Dashed },
    ];
    const lines = levels.filter((level) => level.price != null).map((level) => current.price.createPriceLine({
      price: level.price!, title: level.title, color: color(level.token), lineWidth: 2, lineStyle: level.style, axisLabelVisible: true,
    }));
    return () => { if (state.current === current) lines.forEach((line) => current.price.removePriceLine(line)); };
  }, [props.plan, props.backtest]);
  const selected = props.candles.find((candle) => candle.time === (hovered?.time ?? props.selectedTime)) ?? props.candles.at(-1);
  const hoveredPoint = props.indicators.find((point) => point.time === selected?.time);
  return <div ref={host} className="chart-terminal">
    <ChartTools preferences={preferences} onPreferences={setPreferences} onAction={action => { if (state.current) performChartAction(state.current.chart, action); }}
      indicatorsOpen={indicatorsOpen} onIndicators={() => setIndicatorsOpen(value => !value)} fullscreen={screen.fullscreen} onFullscreen={screen.toggle} error={screen.error || error} />
    {indicatorsOpen && <div className="study-controls"><label><input type="checkbox" checked={showAverages} onChange={event => setShowAverages(event.target.checked)} />MA 5 / 10 / 20 / 50（图表）</label>{props.controls}</div>}
    <div className="chart-frame">
      <ChartReadouts selected={selected} previous={props.candles[props.candles.findIndex(candle => candle.time === selected?.time) - 1]} point={hoveredPoint}
        study={studies.find(point => point.time === selected?.time)} symbol={props.symbol} period={props.period} tooltip={Boolean(hovered)} showAverages={showAverages} />
      <div ref={container} className="stock-chart" aria-label="价格、成交量和技术指标图。可使用下方数据表和信号列表查看全部数值。" />
    </div>
    <div className="terminal-pane-legend"><span>VOL · 成交量（独立窗格）· 涨：橙／跌：青绿</span><span className="oscillator-caption">{props.oscillator === 'macd' ? 'MACD · DIF 实线 / DEA 虚线 / 柱' : props.oscillator === 'rsi' ? 'RSI · Wilder（策略参数）' : 'DMI · +DI 实线 / −DI 虚线 / ADX 点线'}</span><span>不复权</span></div>
    {props.footer}
  </div>;
}
