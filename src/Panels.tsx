import { ArrowDownRight, ArrowUpRight, Check, CircleHelp, Download, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { DEFAULT_CONFIG, type Candle, type IndicatorConfig, type IndicatorPoint, type MarketData, type Period, type Position, type ReviewItem, type Security, type Signal } from '../shared/types';
import { signalConfirmationTime } from '../shared/review';
import type { TradingPlan } from '../shared/strategy';
import { downloadText, formatNumber, formatPercent, formatTime } from './format';

interface SignalProps { signal: Signal | null; point: IndicatorPoint | undefined; position: Position | undefined; symbol: string; period: Period; intraday?: boolean }

/**
 * 展示选中 K 线的指标、信号依据与当前持仓边界，不推算分值或概率。
 * @param props 信号、指标点、当前持仓、证券、周期及分时视图状态。
 * @returns 按状态、指标证据和持仓语境分节的信号解读侧栏。
 */
export function SignalPanel({ signal, point, position, symbol, period, intraday = false }: SignalProps) {
  const trend = point?.fastMA != null && point.slowMA != null ? point.fastMA > point.slowMA ? '短期均线在上' : '短期均线在下' : '等待预热';
  const items = [
    ['均线趋势', trend], ['SAR 方向', point?.sar != null ? `${point.sarBull ? '多头' : '空头'} · ${formatNumber(point.sar)}` : '—'],
    ['MACD 柱', formatNumber(point?.histogram, 3)], ['DMI / ADX', `${formatNumber(point?.plusDI, 1)} / ${formatNumber(point?.minusDI, 1)} / ${formatNumber(point?.adx, 1)}`],
    ['RSI', formatNumber(point?.rsi, 1)], ['量比（含当前20根）', point?.volumeRatio != null ? `${formatNumber(point.volumeRatio)}×` : '—'],
    ['布林带 上 / 中 / 下', `${formatNumber(point?.bollUpper)} / ${formatNumber(point?.bollMiddle)} / ${formatNumber(point?.bollLower)}`],
  ];
  return <aside className="evidence-panel signal-panel bg-surface text-foreground border-border">
    <div className="panel-title signal-panel-title">
      <div className="sidebar-title-copy"><span className="sidebar-eyebrow text-muted-foreground">指标与依据</span><h2>信号解读</h2></div>
      <CircleHelp size={16} aria-hidden="true" />
    </div>
    {intraday ? <div className="evidence-copy signal-reading-card bg-elevated rounded-xl border border-border">
      <h3>当前为分时视图</h3><p>价格、均价和成交量用于查看所选时段。切换任一 K 线周期，可查看交易计划、指标证据与买卖点。</p>
    </div> : <>
      <div className={`signal-heading signal-status-card bg-brand/10 rounded-xl ${signal?.side ?? 'neutral'}`}>
        {signal?.side === 'buy' ? <ArrowUpRight size={26} aria-hidden="true" /> : signal ? <ArrowDownRight size={26} aria-hidden="true" /> : <SlidersHorizontal size={24} aria-hidden="true" />}
        <div className="signal-status-copy min-w-0"><strong>{signal?.title ?? '观察指标组合'}</strong><span>{signal ? `${formatTime(signalConfirmationTime(signal.time, symbol, period), symbol, period, true)} 中国时间确认` : '点击图表或下方信号查看当时证据'}</span></div>
      </div>
      <section className="signal-indicators" aria-label="指标证据">
        <div className="signal-section-heading"><h3>指标证据</h3><span className="text-muted-foreground">所选 K 线</span></div>
        {/* 多值指标跨列展示，避免窄侧栏把完整读数挤出面板。 */}
        <dl className="indicator-values signal-indicator-grid grid grid-cols-2 gap-2">
          {items.map(([label, value]) => <div className={`signal-indicator-card min-w-0 rounded-lg border border-border bg-elevated ${label === 'DMI / ADX' || label === '布林带 上 / 中 / 下' ? 'signal-indicator-wide col-span-2' : ''}`} key={label}>
            <dt className="text-muted-foreground">{label}</dt><dd className="text-foreground tabular-nums wrap-anywhere">{value}</dd>
          </div>)}
        </dl>
      </section>
      <div className="evidence-copy signal-reading-card bg-elevated rounded-xl border border-border">
        <h3>{signal ? '触发依据' : '如何阅读'}</h3>
        {signal ? <ul>{signal.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          : <p>把趋势、动量与成交量一起看。ADX 衡量趋势强度，方向由 +DI / −DI 判断。指标冲突时继续观察。</p>}
      </div>
    </>}
    <div className="position-context signal-position-card bg-canvas rounded-xl border border-border"><span>当前持仓语境</span>
      <strong>{position ? `${formatNumber(position.quantity, 0)} 股 · 成本 ${formatNumber(position.costPrice)}` : '此证券暂无可用持仓'}</strong>
      <p>当前持仓不能证明信号出现时的仓位。卖出信号先用于检查已有风险敞口。</p>
    </div>
  </aside>;
}

interface ReviewProps { items: ReviewItem[]; data: MarketData; security: Security; start: string; end: string; onSelect: (time: number) => void; plan?: TradingPlan; saved?: boolean }

/** 将信号复盘导出为本机 Markdown，保留基准、完整性和事后观察的边界。 */
function exportReview(props: ReviewProps): void {
  const { data, security, items } = props;
  const lines = [`# ${security.symbol} 交易复盘`, '', `来源：${data.source === 'demo' ? '合成演示数据' : 'Longbridge'}；更新时间：${data.fetchedAt}`,
    `中国时间区间：[${props.start} 00:00, ${props.end} 00:00)。仅当前证券和当前周期。`, '',
    '信号收盘确认。后5根变化以信号之后第一根开盘至第5根收盘比较，不含费用、滑点，也不代表可实现收益。',
    '未见成交只表示匹配窗口内没有对应方向成交；无法重建历史仓位、资金、挂单与交易意图。', '',
    '|确认时间（中国）|信号|执行核对|后5根价格变化|依据|', '|---|---|---|---|---|',
    ...items.map((item) => `|${formatTime(signalConfirmationTime(item.signal.time, security.symbol, data.period), security.symbol, data.period, true)}|${item.signal.title}|${item.note}|${formatPercent(item.signal.nextFiveReturn)}|${item.signal.reasons.join('；')}|`),
    '', '## 区间内全部成交', '', '|中国时间|方向|数量|价格|', '|---|---|---|---|',
    ...data.executions.map((fill) => `|${formatTime(fill.time, security.symbol, data.period, true)}|${fill.side === 'buy' ? '买' : '卖'}|${fill.quantity}|${fill.price}|`),
    '', `计划：${props.plan ? `${props.plan.name} v${props.plan.revision}` : '无'}；${props.saved ? '本机保存版本' : '未保存研究模板'}。历史重算不证明当时已有该计划。`,
    '已保存计划快照：', '```json', JSON.stringify(props.plan ?? null, null, 2), '```', '', ...data.warnings.map((warning) => `- ${warning}`)];
  downloadText(`${security.symbol}-${props.start}-review.md`, lines.join('\n'));
}

/** 按已选中国时间范围对照信号与成交，列出潜在遗漏及其后续价格路径。 */
export function ReviewPanel(props: ReviewProps) {
  const counts = { matched: 0, unmatched: 0, unknown: 0, pending: 0 };
  props.items.forEach((item) => counts[item.state]++);
  return <section className="review-panel" id="review">
    <div className="section-header"><div><h2>计划信号与执行复盘</h2><p>{props.start} 至 {props.end}（结束日不含）· 中国时间 · {props.plan?.name ?? '当前规则'} {props.saved ? `v${props.plan?.revision}` : '研究模板'}</p></div>
      <button className="button" onClick={() => exportReview(props)}><Download size={14} />导出复盘</button></div>
    <div className="review-summary"><span><Check size={14} />已对应 <b>{counts.matched}</b></span><span>未见成交 <b>{counts.unmatched}</b></span>
      <span>待确认 / 未知 <b>{counts.pending + counts.unknown}</b></span><span className="summary-note">参考区间：下一根开盘 → 后第 5 根收盘</span></div>
    <div className="table-scroll"><table><thead><tr><th>中国时间确认</th><th>策略信号</th><th>执行核对</th><th>后 5 根价格变化</th><th>复盘意见</th></tr></thead>
      <tbody>{props.items.map((item) => <tr key={item.signal.id}>
        <td><button className="text-button" onClick={() => props.onSelect(item.signal.time)}>{formatTime(signalConfirmationTime(item.signal.time, props.security.symbol, props.data.period), props.security.symbol, props.data.period, true)}</button></td>
        <td><span className={`signal-tag ${item.signal.side}`}>{item.signal.side === 'buy' ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}{item.signal.title}</span></td>
        <td><span className={`execution-state state-${item.state}`}>{item.state === 'matched' ? '已对应成交' : item.state === 'unmatched' ? '未见同向成交' : item.state === 'pending' ? '等待可交易柱' : '执行状态未知'}</span>
          {item.execution && <small>{formatNumber(item.execution.quantity, 0)} 股 @ {formatNumber(item.execution.price)}</small>}</td>
        <td className="numeric">{formatPercent(item.signal.nextFiveReturn)}<small>{item.signal.referencePrice == null ? '数据待齐' : `基准 ${formatNumber(item.signal.referencePrice)}`}</small></td>
        <td className="review-note">{item.note}</td>
      </tr>)}</tbody></table>
      {props.items.length === 0 && <div className="empty-state">该区间没有符合当前规则的已确认信号。可切换“近 30 天”或调整策略参数。</div>}
    </div>
    <p className="method-note">“未见同向成交”是待复核的遗漏候选，需结合当时仓位、可用资金和交易计划判断。后续价格变化为事后统计，不计费用与滑点，不直接作为遗漏损失。</p>
  </section>;
}

/** 用表格提供无需鼠标悬浮的完整 OHLCV 和指标读取路径。 */
export function DataTable({ candles, points, symbol, period }: { candles: Candle[]; points: IndicatorPoint[]; symbol: string; period: Period }) {
  return <details className="data-details"><summary>行情与指标数据表（最近 60 根）</summary><div className="table-scroll"><table>
    <thead><tr>{['交易所时间', '开', '高', '低', '收', '量', 'MACD柱', 'RSI', 'ADX', 'SAR'].map((title) => <th key={title}>{title}</th>)}</tr></thead>
    <tbody>{candles.slice(-60).reverse().map((candle) => { const point = points.find((item) => item.time === candle.time); return <tr key={candle.time}>
      <td>{formatTime(candle.time, symbol, period)}</td>{[candle.open, candle.high, candle.low, candle.close, candle.volume, point?.histogram, point?.rsi, point?.adx, point?.sar].map((value, index) => <td key={index}>{formatNumber(value, index === 4 ? 0 : 2)}</td>)}
    </tr>; })}</tbody>
  </table></div></details>;
}

interface SettingsProps { open: boolean; onClose: () => void; config: IndicatorConfig; onSave: (config: IndicatorConfig) => void }

/** 策略参数对话框，原生表单约束与跨字段检查成功后才更新运行参数。 */
export function SettingsDialog({ open, onClose, config, onSave }: SettingsProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  const fields: { key: keyof IndicatorConfig; label: string; min: number; max: number; step: number }[] = [
    { key: 'fastMA', label: '短期均线', min: 2, max: 50, step: 1 }, { key: 'slowMA', label: '长期均线', min: 3, max: 120, step: 1 },
    { key: 'rsiPeriod', label: 'RSI 周期', min: 2, max: 50, step: 1 }, { key: 'adxThreshold', label: 'ADX 趋势门槛', min: 5, max: 60, step: 1 },
    { key: 'volumeRatio', label: '买入量比下限', min: 0.5, max: 5, step: 0.1 },
    { key: 'sarStart', label: 'SAR 开始', min: 0.001, max: 0.2, step: 0.001 }, { key: 'sarStep', label: 'SAR 增量', min: 0.001, max: 0.2, step: 0.001 },
    { key: 'sarMax', label: 'SAR 最大', min: 0.02, max: 1, step: 0.01 },
  ];
  return <dialog ref={dialog} onCancel={onClose} onClick={(event) => { if (event.target === dialog.current) onClose(); }}>
    <form onSubmit={(event) => {
      event.preventDefault(); const form = event.currentTarget;
      const values = Object.fromEntries(new FormData(form)) as Record<string, string>;
      const next = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Number(value)])) as unknown as IndicatorConfig;
      if (next.fastMA >= next.slowMA || next.sarStart > next.sarMax || next.sarStep > next.sarMax) {
        form.querySelector<HTMLOutputElement>('output')!.textContent = '短期均线须小于长期均线，SAR 开始与增量不能超过最大值。'; return;
      }
      try { onSave(next); onClose(); }
      catch (failure) { form.querySelector<HTMLOutputElement>('output')!.textContent = failure instanceof Error ? failure.message : '参数保存失败，请重试。'; }
    }}>
      <div className="section-header"><div><h2>策略参数</h2><p>参数立即重算图表信号，不改变账户。</p></div><button type="button" className="icon-button" aria-label="关闭参数" onClick={onClose}><X size={18} /></button></div>
      <div className="settings-grid">{fields.map((field) => <label key={`${field.key}-${config[field.key]}-${open}`}>{field.label}<input name={field.key} type="number" min={field.min} max={field.max} step={field.step} defaultValue={config[field.key]} required /></label>)}</div>
      <p className="method-note">SAR 以长历史计算；初始化和 K 线复权方式仍可能导致与交易软件读数不同，请以你软件的读数校准。MACD 固定 12/26/9，布林带 20/2，DMI 14。</p>
      <output role="alert" className="form-error" />
      <div className="dialog-actions"><button type="button" className="button" onClick={(event) => { try { onSave(DEFAULT_CONFIG); } catch (failure) { event.currentTarget.closest('form')!.querySelector('output')!.textContent = failure instanceof Error ? failure.message : '恢复默认参数失败。'; } }}>恢复默认</button><button type="submit" className="button primary">应用参数</button></div>
    </form>
  </dialog>;
}
