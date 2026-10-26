import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronsUpDown, LoaderCircle, RefreshCw, Search, Settings2, X } from 'lucide-react';
import { SecurityOverview, WorkspaceHeader, WorkspaceRail, WorkspaceTitle } from './WorkspaceChrome';
import { validateConfig } from '../shared/indicators';
import { useStrategyWorkspace } from './useStrategyWorkspace';
import { useLiveMarketData, useRealtimeMarket } from './useRealtimeMarket';
import { RealtimeStatus } from './RealtimeStatus';
import { LongbridgeLogin } from './LongbridgeLogin';
import { OriginalChartLab } from './OriginalChartLab';
import { MarketTimeframes, type ChartView } from './MarketTimeframes';
import { IntradayView } from './IntradayView';
import { WatchlistPanel } from './WatchlistPanel';
import type { IntradaySession } from '../shared/intraday';
import { PlanToolbar, StrategyWorkbench } from './StrategyWorkbench';
import { PERIOD_LABELS } from '../shared/periods';
import { ExecutionReview } from './ExecutionReview';
import './plans.css';
import './strategy.css';
import { DailyReview } from './DailyReview';
import { buildReview, getChinaWeekRange } from '../shared/review';
import { DEFAULT_CONFIG, type IndicatorConfig, type MarketData, type Period, type Security, type SourceMode, type Workspace } from '../shared/types';
import { fetchMarket, fetchWorkspace } from './api';
import type { ChartLayers, Oscillator } from './Chart';
import { DataTable, ReviewPanel, SettingsDialog } from './Panels';
import { ResearchSidebar } from './ResearchSidebar';
import { EventCenter } from './EventCenter';

const StockChart = lazy(() => import('./Chart').then((module) => ({ default: module.StockChart })));
const PlanEditor = lazy(() => import('./PlanEditor').then((module) => ({ default: module.PlanEditor })));
const INITIAL_SECURITY: Security = { symbol: 'NVDA.US', name: '英伟达', market: 'US', currency: 'USD' };

/** 获取默认周区间；演示固定到标注的历史周，真实模式依据当前中国时间。 */
function weekRange(source: SourceMode) {
  const range = getChinaWeekRange(source === 'demo' ? new Date('2026-10-16T08:00:00Z') : new Date());
  return { start: range.start.slice(0, 10), end: range.end.slice(0, 10) };
}

/** 页面级异步读取：取消过时响应；错误保留真实来源状态，绝不自动混入演示数据。 */
function useWorkspace(source: SourceMode, refresh: number) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setWorkspace(null); setError(''); setLoading(true);
    fetchWorkspace(source, controller.signal).then(setWorkspace).catch((failure) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '工作区读取失败。');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [source, refresh]);
  return { workspace: workspace?.source === source ? workspace : null, error, loading };
}

/** 保存本机配置的读取边界：仅接受完整有效数字，否则恢复默认。 */
function readConfig(): IndicatorConfig {
  try {
    const value = JSON.parse(localStorage.getItem('market-lens-config') ?? 'null');
    if (!value || Object.keys(DEFAULT_CONFIG).some((key) => !Number.isFinite(value[key]))) return DEFAULT_CONFIG;
    if (value.fastMA < 2 || value.fastMA >= value.slowMA || value.slowMA > 120 || value.sarStart <= 0 || value.sarMax < value.sarStart || value.sarMax > 1) return DEFAULT_CONFIG;
    validateConfig(value);
    return value;
  } catch { console.warn('指标参数读取失败，已恢复默认配置。'); return DEFAULT_CONFIG; }
}

/** 顶层工作台：共享证券、周期和中国时间复盘范围，统一驱动图表与执行对照。 */
export default function App() {
  const [source, setSource] = useState<SourceMode>('demo');
  const [security, setSecurity] = useState<Security>(INITIAL_SECURITY);
  const [period, setPeriod] = useState<Period>('day');
  const [view, setView] = useState<ChartView>('candles'); const [session, setSession] = useState<IntradaySession>('regular');
  const [range, setRange] = useState(() => weekRange('demo'));
  const [preset, setPreset] = useState('week');
  const [refresh, setRefresh] = useState(0);
  const [config, setConfig] = useState<IndicatorConfig>(readConfig);
  const [layers, setLayers] = useState<ChartLayers>({ ma: false, sar: false, boll: false, signals: true, fills: true });
  const [oscillator, setOscillator] = useState<Oscillator>('macd');
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const [settings, setSettings] = useState(false);
  const [search, setSearch] = useState(false);
  const workspaceState = useWorkspace(source, refresh);
  const { data: snapshot, error, loading } = useMarket(source, security.symbol, period, range, refresh);
  const live = useRealtimeMarket(source, security.symbol, period);
  const { data, error: syncError } = useLiveMarketData(snapshot, live);
  const refreshMarket = useCallback(() => setRefresh((value) => value + 1), []);
  const strategy = useStrategyWorkspace({ data: view === 'candles' ? data : null, symbol: security.symbol, source, period, config, range, loading, refresh: refreshMarket });
  const { indicators, allSignals, signals } = strategy;
  const chartConfig = strategy.plan.indicatorConfig;
  const review = useMemo(() => buildReview(signals, data?.executions ?? [], data?.candles ?? [], data?.executionsComplete ?? false, security.symbol, period, data?.executionRange), [signals, data, security.symbol, period]);
  const selectedSignal = allSignals.find((signal) => signal.time === selectedTime) ?? (selectedTime ? null : signals.at(-1) ?? null);
  const selectedPoint = indicators.find((point) => point.time === (selectedTime ?? selectedSignal?.time)) ?? indicators.at(-1);
  const position = workspaceState.workspace?.positions.find((item) => item.symbol === security.symbol);
  const latest = data?.candles.at(-1);
  const previous = data?.candles.at(-2);
  const liveQuote = live?.quote;
  const change = liveQuote ? liveQuote.previousClose ? (liveQuote.price / liveQuote.previousClose - 1) * 100 : null : latest && previous ? (latest.close / previous.close - 1) * 100 : null;
  const onSelect = useCallback((time: number) => setSelectedTime(time), []);
  const changeSource = (next: SourceMode) => { setSource(next); setRange(weekRange(next)); setPreset('week'); setSelectedTime(null); };
  const chooseSecurity = (next: Security) => { setSecurity(next); setSelectedTime(null); setSearch(false); };
  const securities = workspaceState.workspace?.securities ?? [];
  const warnings = [...new Set([...(workspaceState.workspace?.warnings ?? []), ...(data?.warnings ?? [])])];
  const timeframes = <MarketTimeframes view={view} session={session} period={period} onView={next => { setView(next); setSelectedTime(null); }} onSession={setSession} onPeriod={setPeriod} />;
  const chartControls = <div className="layer-controls">{([['ma', `策略 MA ${chartConfig.fastMA} / ${chartConfig.slowMA}`], ['sar', 'SAR'], ['boll', 'BOLL'], ['signals', '策略信号'], ['fills', '实际成交']] as [keyof ChartLayers, string][]).map(([key, label]) => <label key={key}><input type="checkbox" checked={layers[key]} onChange={() => setLayers(current => ({ ...current, [key]: !current[key] }))} />{label}</label>)}
    <label className="oscillator-select">副图<select aria-label="技术指标副图" value={oscillator} onChange={event => setOscillator(event.target.value as Oscillator)}><option value="macd">MACD</option><option value="rsi">RSI</option><option value="dmi">DMI</option></select></label></div>;
  return <div className="app-shell">
    <a className="skip-link" href="#analysis">跳转到行情图表</a>
    <WorkspaceRail onSettings={() => setSettings(true)} />
    <div className="app-content">
      <WorkspaceHeader source={source} onSearch={() => setSearch(true)} onSettings={() => setSettings(true)} />
      <main>
        <WorkspaceTitle source={source} onSource={changeSource}><LongbridgeLogin /></WorkspaceTitle>
        {source === 'demo' && <div className="demo-banner"><span className="status-dot" /><strong>演示工作区</strong><span>行情、持仓与成交均为合成数据，不代表你的账户。切换数据源可读取本机 Longbridge。</span></div>}
        {(error || workspaceState.error || strategy.error) && <div className="error-banner" role="alert"><strong>读取状态</strong><span>{error || workspaceState.error || strategy.error}</span><button className="button" onClick={refreshMarket}>重试</button></div>}
        <div className="workspace-grid">
          <WatchlistPanel workspace={workspaceState.workspace} selected={security.symbol} loading={workspaceState.loading} demo={source === 'demo'} onSearch={() => setSearch(true)} onSelect={chooseSecurity} />
          <section className="analysis-panel" id="analysis" tabIndex={-1} aria-busy={loading}>
            <SecurityOverview security={security} description={`${security.market === 'HK' ? '香港市场 · HKD' : '美国市场 · USD'} · ${view === 'candles' ? `${PERIOD_LABELS[period]} · 常规交易时段 · 不复权` : '分时价格 · 所选交易时段'}`} price={liveQuote?.price ?? latest?.close} change={change} changeLabel={liveQuote ? liveQuote.previousClose ? '较昨收' : '昨收待同步' : '较上一根'} sessionLabel={liveQuote ? ({ regular: '常规时段', pre: '盘前', post: '盘后', overnight: '夜盘', unknown: '时段待确认' })[liveQuote.session] : undefined} candle={view === 'candles' ? latest : undefined} />
            <div className="chart-toolbar"><span className="chart-context">{view === 'candles' ? 'K 线 · 常规时段' : view === 'five-day' ? '5 日分时' : '分时行情'}</span>
              <EventCenter source={source} scope="security" symbol={security.symbol} /><OriginalChartLab /><button className="button compact" onClick={() => setSettings(true)}><Settings2 size={14} />策略参数</button><button className="icon-button" aria-label="刷新行情" disabled={loading || workspaceState.loading} onClick={() => setRefresh((value) => value + 1)}>{loading ? <LoaderCircle size={16} className="spinner" /> : <RefreshCw size={16} />}</button></div>
            {source === 'longbridge' && <RealtimeStatus live={live} symbol={security.symbol} period={period} error={syncError} intraday={view !== 'candles'} />}
            {view !== 'candles' ? <IntradayView key={`${source}:${security.symbol}:${session}:${view}:${refresh}`} source={source} symbol={security.symbol} session={session} days={view === 'five-day' ? 5 : 1} footer={timeframes} /> : <>
            <RangeControls range={range} preset={preset} onChange={(next, nextPreset) => { setRange(next); setPreset(nextPreset); setSelectedTime(null); }} source={source} />
            <PlanToolbar plan={strategy.plan} saved={Boolean(strategy.saved)} picking={strategy.picking} onPick={strategy.setPicking} onEdit={strategy.edit} />
            {data ? <div className={loading ? 'chart-loading' : ''}><Suspense fallback={<div className="chart-placeholder">加载交互图表…</div>}><StockChart candles={data.candles} indicators={indicators} signals={signals} executions={data.executions} symbol={security.symbol} period={period} layers={layers} oscillator={oscillator} selectedTime={selectedTime} costPrice={position?.costPrice} onSelect={onSelect} plan={strategy.plan} backtest={strategy.result} pickingPrice={Boolean(strategy.picking)} onPickPrice={strategy.pickPrice} footer={timeframes} controls={chartControls} /></Suspense></div>
              : <><div className="chart-placeholder">{loading ? '正在读取行情与历史成交…' : '选择数据源并刷新以加载图表。'}</div>{timeframes}</>}
            <div className="chart-legend"><span>主图 MA 5 / 10 / 20 / 50 · 策略均线在指标栏单独开启</span><span>↑↓ 收盘触发</span><span>■ 模拟成交</span><span>● 实际成交</span></div>
            <div className="chart-status"><span>{data ? `${data.candles.length} 根 · ${source === 'demo' ? '合成快照' : 'Longbridge 快照'}` : '等待数据'}</span><span>横轴：交易所时间 · 复盘：北京时间</span></div></>}
          </section>
          <ResearchSidebar source={source} refresh={refresh} signal={selectedSignal} point={selectedPoint} position={position} symbol={security.symbol} period={period} intraday={view !== 'candles'} />
        </div>
        {view === 'candles' && data && <StrategyWorkbench plan={strategy.plan} saved={Boolean(strategy.saved)} result={strategy.result} candles={data.candles} points={indicators} history={strategy.history} alerts={strategy.monitor.events} monitoring={strategy.monitor.enabled} monitorError={strategy.monitor.error} onEdit={strategy.edit} onMonitor={strategy.monitor.toggle} onSelect={onSelect} />}
        {view === 'candles' && data && <ReviewPanel items={review} data={data} security={security} start={range.start} end={range.end} onSelect={onSelect} plan={strategy.plan} saved={Boolean(strategy.saved)} />}
        {view === 'candles' && data && <ExecutionReview key={`${source}-${security.symbol}-${period}-${range.start}-${range.end}`} data={data} signals={signals} onSelect={onSelect} />}
        {view === 'candles' && data && <DailyReview data={data} indicators={indicators} review={review} start={range.start} end={range.end} onSelect={onSelect} />}
        {view === 'candles' && data && <DataTable candles={data.candles} points={indicators} symbol={security.symbol} period={period} />}
        <details className="method-details"><summary>数据状态与策略说明</summary><div><p>图表、历史验证与成交核对统一使用当前交易计划的规则及指标参数。未保存时显示趋势跟随模板；回测箭头是历史模拟，不证明当时应当交易。计划保存在本机浏览器，按来源、标的和周期隔离。</p><p>日线在标准收盘后确认；半日市可能延迟确认。SAR 使用长历史，软件初始化不同仍可能有偏差。期权希腊值、时间价值和跨证券历史仓位重建尚未纳入。</p>{warnings.map((warning) => <p key={warning}>{warning}</p>)}<p>数据更新时间：{data?.fetchedAt ? new Date(data.fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—'}（中国时间）。历史及成交快照刷新遵循服务端 60 秒缓存；实时价格由上游 WebSocket 推送，K线图使用每5秒同步的原生常规时段K线，未收盘柱不触发已确认策略信号；分时图每15秒读取独立快照。</p></div></details>
      </main>
      <footer className="footer"><span>观势 Market Lens <span className="footer-divider">/</span> 从信号到执行</span><span>数据：Longbridge · 图表：<a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView Lightweight Charts™</a></span></footer>
    </div>
    <SettingsDialog open={settings} onClose={() => setSettings(false)} config={chartConfig} onSave={(next) => {
      strategy.saveConfig(next); setConfig(next); try { localStorage.setItem('market-lens-config', JSON.stringify(next)); } catch { console.warn('浏览器禁止本地存储，本次参数仅在当前页面有效。'); }
    }} />
    {strategy.editing && <Suspense fallback={<p className="editor-loading" role="status">加载计划编辑器…</p>}><PlanEditor plan={strategy.editing} onSave={strategy.save} onClose={() => strategy.setEditing(null)} /></Suspense>}
    <SearchDialog open={search} onOpen={() => setSearch(true)} onClose={() => setSearch(false)} securities={securities} onSelect={chooseSecurity} />
  </div>;
}

/** 隔离行情读取生命周期，证券或数据源改变时清空旧数据，重试时保留当前图表。 */
function useMarket(source: SourceMode, symbol: string, period: Period, range: { start: string; end: string }, refresh: number) {
  const [data, setData] = useState<MarketData | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  const identity = `${source}-${symbol}-${period}`;
  const previousIdentity = useRef(identity);
  useEffect(() => {
    const controller = new AbortController(); setError(''); setLoading(true);
    if (previousIdentity.current !== identity) setData(null);
    previousIdentity.current = identity;
    fetchMarket(source, symbol, period, range.start, range.end, controller.signal).then(setData).catch((failure) => {
      if (!controller.signal.aborted) { setError(failure instanceof Error ? failure.message : '行情读取失败。'); setData(null); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [source, symbol, period, range.start, range.end, refresh, identity]);
  return { data: data?.source === source && data.symbol === symbol && data.period === period ? data : null, error, loading };
}

/** 日期控件：预设自然周或近30天，自定义结束日明确为不含，错误阻止范围应用。 */
function RangeControls({ range, preset, onChange, source }: { range: { start: string; end: string }; preset: string; onChange: (range: { start: string; end: string }, preset: string) => void; source: SourceMode }) {
  const [custom, setCustom] = useState(false); const [error, setError] = useState('');
  return <div className="range-controls"><span>复盘范围</span><select aria-label="复盘时间范围" value={preset} onChange={(event) => {
    const value = event.target.value;
    if (value === 'custom') { setCustom(true); return; }
    const week = weekRange(source);
    onChange(value === 'week' ? week : { start: new Date(Date.parse(week.end) - 30 * 86400000).toISOString().slice(0, 10), end: week.end }, value);
  }}><option value="week">本周（中国时间）</option><option value="month">近 30 天</option><option value="custom">自定义区间</option></select><span className="range-label">{range.start.slice(5)} — {range.end.slice(5)} 不含</span>
    {custom && <form className="custom-range" onSubmit={(event) => {
      event.preventDefault(); const values = new FormData(event.currentTarget); const start = String(values.get('start')); const end = String(values.get('end'));
      const days = (Date.parse(end) - Date.parse(start)) / 86400000;
      if (days <= 0 || days > 93) { setError('区间须为 1 至 93 天，结束日不含。'); return; }
      onChange({ start, end }, 'custom'); setCustom(false); setError('');
    }}><label>开始<input type="date" name="start" defaultValue={range.start} required /></label><label>结束（不含）<input type="date" name="end" defaultValue={range.end} required /></label><button className="button" type="submit">应用</button><button className="icon-button" type="button" aria-label="关闭自定义范围" onClick={() => setCustom(false)}><X size={16} /></button>{error && <output className="form-error">{error}</output>}</form>}
  </div>;
}

/** 原生模态证券搜索，支持 Ctrl/Cmd K、方向键和手动代码，拒绝任意命令内容。 */
function SearchDialog({ open, onOpen, onClose, securities, onSelect }: { open: boolean; onOpen: () => void; onClose: () => void; securities: Security[]; onSelect: (security: Security) => void }) {
  const dialog = useRef<HTMLDialogElement>(null); const [query, setQuery] = useState(''); const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  useEffect(() => { const listener = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (open) onClose(); else onOpen(); } }; window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener); }, [open, onClose, onOpen]);
  const matching = securities.filter((security) => `${security.symbol} ${security.name}`.toLowerCase().includes(query.toLowerCase()));
  const normalized = query.trim().toUpperCase().replace(/^0+(\d+\.HK)$/, '$1');
  const manual: Security | null = /^(?:[A-Z][A-Z0-9.-]{0,35}\.US|\d{1,5}\.HK)$/.test(normalized) && !matching.some((security) => security.symbol === normalized)
    ? { symbol: normalized, name: normalized, market: normalized.endsWith('.HK') ? 'HK' : 'US', currency: normalized.endsWith('.HK') ? 'HKD' : 'USD' } : null;
  const results = manual ? [...matching, manual] : matching;
  return <dialog ref={dialog} className="search-dialog" onCancel={onClose} onClick={(event) => { if (event.target === dialog.current) onClose(); }}><div className="section-header"><h2>搜索证券</h2><button className="icon-button" aria-label="关闭搜索" onClick={onClose}><X size={18} /></button></div>
    <label className="search-field">证券代码或名称<input autoFocus value={query} placeholder="NVDA.US / 700.HK" onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} onKeyDown={(event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((current) => Math.min(current + 1, results.length - 1)); }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((current) => Math.max(current - 1, 0)); }
      if (event.key === 'Enter' && results[activeIndex]) { event.preventDefault(); onSelect(results[activeIndex]); }
    }} /></label>
    <div className="search-results">{results.map((security, index) => <button key={security.symbol} className={index === activeIndex ? 'selected' : ''} onClick={() => onSelect(security)}><strong>{security.symbol}</strong><span>{security.name}</span><ChevronsUpDown size={14} /></button>)}</div>
    {!results.length && <p className="method-note">输入带市场后缀的代码，例如 NVDA.US 或 700.HK。</p>}<p className="method-note">↑ ↓ 选择 · Enter 打开 · Esc 关闭</p></dialog>;
}
