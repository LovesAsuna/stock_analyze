import { useState } from 'react';
import { PERIOD_LABELS } from '../shared/periods';
import { Bell, Download, Pencil, Plus, Target } from 'lucide-react';
import { conditionLabel, evaluateGroup, type TradingPlan } from '../shared/strategy';
import type { BacktestResult } from '../shared/backtest';
import type { Candle, IndicatorPoint } from '../shared/types';
import type { PlanAlert } from './useTradingPlan';
import { PathExplorer } from './PathExplorer';
import { downloadText, formatNumber, formatPercent, formatTime } from './format';

export type PlanLevel = 'entryPrice' | 'stopPrice' | 'targetPrice';
interface Props {
  plan: TradingPlan; saved: boolean; result: BacktestResult; candles: Candle[]; points: IndicatorPoint[];
  history: TradingPlan[]; alerts: PlanAlert[]; monitoring: boolean; monitorError: string;
  onEdit: () => void; onMonitor: () => void; onSelect: (time: number) => void;
}

/**
 * 图表上方的计划工具条，选择图上取价目标。
 * @param props 已保存状态、当前计划、取价字段及回调。
 * @returns 计划版本与三种价格选择入口。
 */
export function PlanToolbar(props: { plan: TradingPlan; saved: boolean; picking: PlanLevel | null; onPick: (level: PlanLevel | null) => void; onEdit: () => void }) {
  return <div className="plan-toolbar"><div><Target size={16} /><strong>{props.plan.name}</strong><span>{props.saved ? `v${props.plan.revision} · 已保存` : '未保存模板 · 历史研究'}</span></div>
    <div className="plan-toolbar-actions">{([['entryPrice', '取观察价'], ['stopPrice', '取止损价'], ['targetPrice', '取目标价']] as const).map(([key, label]) => <button key={key} className="button compact" aria-pressed={props.picking === key} onClick={() => props.onPick(props.picking === key ? null : key)}>{label}</button>)}<button className="button compact" onClick={props.onEdit}><Pencil size={13} />编辑计划</button></div>
    {props.picking && <p role="status">点击价格主图选择{props.picking === 'entryPrice' ? '观察入场价' : props.picking === 'stopPrice' ? '固定止损价' : '目标价'}，随后在编辑器中保存。<button className="text-button" onClick={() => props.onPick(null)}>取消取价</button></p>}
  </div>;
}

/**
 * 展示共用规则、模拟结果及真实监控证据。
 * @param props 同一版本计划及引擎输出。
 * @returns 可编辑、可导出且能定位图表的策略工作区。
 */
export function StrategyWorkbench(props: Props) {
  const [tab, setTab] = useState<'results' | 'paths' | 'rules' | 'alerts'>('results');
  const { plan, result } = props;
  return <section className="strategy-workbench" id="strategy">
    <div className="section-header"><div><h2>交易计划与历史验证</h2><p>{plan.symbol} · {PERIOD_LABELS[plan.period]} · {props.saved ? `计划 v${plan.revision}` : '未保存的趋势跟随模板'}</p></div><div className="plan-toolbar-actions"><button className="button" onClick={props.onEdit}>{props.saved ? <Pencil size={14} /> : <Plus size={14} />}{props.saved ? '修改计划' : '建立交易计划'}</button><button className="button" disabled={!props.saved || !props.candles.length} aria-pressed={props.monitoring} onClick={props.onMonitor}><Bell size={14} />{props.monitoring ? '停止本页监控' : '开启本页监控'}</button><button className="button" onClick={() => exportBacktest(plan, result)}><Download size={14} />导出回测</button></div></div>
    <p className="method-note backtest-range">实际历史验证区间（中国）：{result.researchRange.start == null ? '无有效研究数据' : `${new Date(result.researchRange.start * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} — ${new Date(result.researchRange.end! * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`}。使用已加载历史预热后的有效数据，与下方成交复盘区间分别显示。初始资金 {formatNumber(plan.initialCapital)} {plan.symbol.endsWith('.HK') ? 'HKD' : 'USD'}。</p>
    <div className="strategy-tabs" aria-label="策略工作区">{([['results', '回测交易'], ['paths', '价格路径'], ['rules', '规则检查'], ['alerts', `监控证据 ${props.alerts.length}`]] as const).map(([value, label]) => <button key={value} className={tab === value ? 'active' : ''} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</button>)}</div>
    {tab === 'results' && <><div className="backtest-metrics">{[['已平仓', `${result.metrics.closedTrades} 笔`], ['胜率', formatPercent(result.metrics.winRate)], ['账户变化', formatPercent(result.metrics.totalReturn)], ['最大回撤', formatPercent(result.metrics.maxDrawdown)], ['盈亏比因子', formatNumber(result.metrics.profitFactor)], ['持仓时间', formatPercent(result.metrics.exposurePct)]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><TradeTable result={result} plan={plan} candles={props.candles} onSelect={props.onSelect} /></>}
    {tab === 'paths' && <PathExplorer points={result.paths} />}
    {tab === 'rules' && <RuleChecklist plan={plan} candles={props.candles} points={props.points} history={props.history} />}
    {tab === 'alerts' && <AlertEvidence {...props} />}
    {result.warnings.length > 0 && <details className="backtest-warnings"><summary>回测数据与执行提示（{result.warnings.length}）</summary>{result.warnings.map((warning) => <p className="method-note" key={warning}>{warning}</p>)}</details>}
    <p className="method-note">历史研究 · 至少 200 根预热 · 单证券多头、固定数量、现金约束 · 收盘触发后下一柱开盘执行。风险条件也按收盘检查，非盘中触价保护单。费用 {plan.feeBps} bps、滑点 {plan.slippageBps} bps 均为单边；未平仓按最后已确认收盘估值。保存计划不证明历史上已有该计划。</p>
  </section>;
}

/**
 * 输出已平仓与未平仓交易，保留确认时间和模拟成交的区别。
 * @param props 回测结果及定位入口。
 * @returns 模拟成交数据表。
 */
function TradeTable({ result, plan, candles, onSelect }: { result: BacktestResult; plan: TradingPlan; candles: Candle[]; onSelect: (time: number) => void }) {
  const trades = [...result.trades, ...(result.openTrade ? [result.openTrade] : [])];
  return <div className="table-scroll"><table><thead><tr>{['模拟入场（中国）', '入场价 / 数量', '模拟离场（中国）', '离场依据', '净盈亏 / 收益', '持有 / 最大浮亏'].map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{trades.map((trade) => <tr key={trade.id}><td><button className="text-button" onClick={() => onSelect(candles[trade.entryIndex].time)}>{formatTime(trade.entryTime, plan.symbol, plan.period, true)}</button></td><td>{formatNumber(trade.entryPrice)}<small>{trade.quantity} 股</small></td><td>{trade.exitTime == null ? '未平仓' : <button className="text-button" onClick={() => onSelect(candles[trade.exitIndex!].time)}>{formatTime(trade.exitTime, plan.symbol, plan.period, true)}</button>}</td><td>{trade.exitReason ?? '等待离场条件'}</td><td>{formatNumber(trade.pnl)}<small>{formatPercent(trade.returnPct)}</small></td><td>{trade.barsHeld} 根<small>{formatPercent(trade.maePct)}</small></td></tr>)}</tbody></table>{!trades.length && <div className="empty-state">当前有效区间没有可执行的模拟交易。编辑计划检查入场条件和数据预热。</div>}</div>;
}

/**
 * 显示最新已确认柱的逐条条件，未预热显示未知。
 * @param props 计划、指标与版本记录。
 * @returns 入场与离场检查表。
 */
function RuleChecklist({ plan, candles, points, history }: { plan: TradingPlan; candles: Candle[]; points: IndicatorPoint[]; history: TradingPlan[] }) {
  const reversed = [...candles].reverse().findIndex((candle) => candle.confirmed);
  const index = reversed < 0 ? -1 : candles.length - 1 - reversed;
  return <div className="rule-checklist"><p>检查对象：最新已确认 K 线。条件成立不等于当前可买卖；模拟仓位、有效期、预热及资金约束仍需满足。</p><div className="rule-columns">{(['entry', 'exit'] as const).map((key) => {
    const evaluation = index < 0 ? null : evaluateGroup(plan[key], candles, points, index);
    return <div key={key}><h3>{key === 'entry' ? '入场条件' : '离场条件'} · {plan[key].mode === 'all' ? '全部成立' : '任一成立'}</h3><ul>{plan[key].conditions.map((condition, conditionIndex) => { const check = evaluation?.checks[conditionIndex]; return <li key={condition.id}><span>{check?.available ? check.matched ? '满足' : '未满足' : '未知'}</span>{conditionLabel(condition)}</li>; })}</ul></div>;
  })}</div><dl className="plan-level-values"><div><dt>收盘观察价下限</dt><dd>{formatNumber(plan.entryPrice)}</dd></div><div><dt>固定止损 / 目标</dt><dd>{formatNumber(plan.stopPrice)} / {formatNumber(plan.targetPrice)}</dd></div><div><dt>止损 / 止盈 / 追踪</dt><dd>{plan.stopLossPct}% / {plan.takeProfitPct}% / {plan.trailingStopPct}%</dd></div><div><dt>有效期（中国）</dt><dd>{new Date(plan.validFrom).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 至 {new Date(plan.validUntil).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</dd></div></dl><p>版本记录：{history.length ? history.map((item) => `v${item.revision}（${new Date(item.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）`).join('；') : '模板尚未保存'}</p></div>;
}

/**
 * 展示当前页面监控范围及不可变规则快照。
 * @param props 监控状态和证据。
 * @returns 提醒列表；无历史补发、无后台运行承诺。
 */
function AlertEvidence(props: Props) {
  return <div className="alert-evidence"><p role="status">{props.monitoring ? '本页监控已开启，接收行情更新并每 75 秒补查当前证券。' : '本页监控已关闭。保存计划后可开启。'} 浏览器关闭、休眠、切换计划或研究范围后不会持续监控；重新打开需要手动开启。按回测模拟仓位检查，与真实账户持仓独立。行情受 60 秒缓存和数据权限影响。</p>{props.monitorError && <p className="form-error" role="alert">{props.monitorError}</p>}
    {!props.alerts.length ? <p className="empty-state">尚无启用后出现的新信号。历史回测结果不会补发为提醒。</p> : props.alerts.map((event) => <details key={event.id}><summary>{event.side === 'buy' ? '入场' : '离场'} · {formatTime(event.confirmedAt, event.symbol, event.period, true)} 中国时间 · v{event.revision}</summary><p>发现时间：{new Date(event.detectedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · 收盘 {formatNumber(event.close)}</p><ul>{event.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><button className="button" onClick={() => downloadText(`${event.symbol}-signal-evidence.json`, JSON.stringify(event, null, 2))}>导出触发快照</button></details>)}
  </div>;
}

/**
 * 导出完整规则版本及模拟成交，保留可复算口径。
 * @param plan 运行计划。
 * @param result 回测结果。
 * @returns 触发本机下载，无上传。
 */
function exportBacktest(plan: TradingPlan, result: BacktestResult): void {
  const content = { generatedAt: new Date().toISOString(), source: plan.source, plan,
    executionModel: 'close-confirmed-next-open; long-only; fixed-quantity; cash-constrained', ...result };
  downloadText(`${plan.symbol}-v${plan.revision}-backtest.json`, JSON.stringify(content, null, 2));
}
