import { useMemo, useState, type FormEvent } from 'react';
import type { MarketData, Signal } from '../shared/types';
import { buildExecutionReview, type ExecutionReviewResult, type LedgerEntry, type OpeningPosition } from '../shared/execution-review';
import { barOpenTime, signalConfirmationTime } from '../shared/review';
import { formatNumber, formatPercent, formatTime } from './format';

/** 组件公开契约：全部信号由父传入，定位回调使用原始 K 线 UTC 秒。 */
export interface ExecutionReviewProps {
  data: MarketData;
  signals: Signal[];
  onSelect: (time: number) => void;
}

const ACTION_LABELS: Record<LedgerEntry['action'], string> = {
  open: '建仓', add: '加仓', reduce: '减仓', close: '清仓', anomaly: '超出可用量异常', unknown: '未知',
};
const SIGNAL_LABELS = {
  matched: '下一柱成交对应', 'delayed-candidate': '延后成交候选', unmatched: '下一柱未匹配', pending: '等待窗口', unknown: '未知',
};

/**
 * 导出单证券逐笔执行复盘，来源、标的、周期或区间变化立即销毁旧表单与期初快照。
 * @param props 行情、父组件全部信号及原始 K 线时间定位回调。
 * @returns 可折叠期初表单与仓位/信号核查界面；不读写持久存储或账户接口。
 */
export function ExecutionReview({ data, signals, onSelect }: ExecutionReviewProps) {
  const scope = JSON.stringify([data.source, data.symbol, data.period, data.executionRange?.start, data.executionRange?.end]);
  return <ExecutionReviewContent key={scope} data={data} signals={signals} onSelect={onSelect} />;
}

/**
 * 校验手工输入的非负数量或正单位成本，空成本允许 null，空数量不能暗示空仓。
 * @param raw 输入框文本。
 * @param cost 是否为可空正成本。
 * @returns 有限数值或空成本 null；无效时抛出可显示的中文错误。
 */
function parseOpeningNumber(raw: string, cost: boolean): number | null {
  const value = raw.trim();
  if (cost && value === '') return null;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) throw new Error(cost ? '单位成本必须为正数或留空。' : '请明确输入期初数量，空仓请输入 0。');
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (cost ? parsed <= 0 : parsed < 0)) throw new Error(cost ? '单位成本必须大于 0 且为有限数值。' : '期初数量必须大于等于 0 且为有限数值。');
  return parsed;
}

/**
 * 将成交定位到实际所属 K 线；无对应柱时不给出误导性定位。
 * @param time 成交 UTC 秒。
 * @param data 当前行情。
 * @returns 原始 K 线时间或 null。
 */
function candleTimeForFill(time: number, data: MarketData): number | null {
  const candle = data.candles.find((item) => time >= barOpenTime(item.time, data.symbol, data.period) &&
    time < signalConfirmationTime(item.time, data.symbol, data.period));
  return candle?.time ?? null;
}

/**
 * 在计算边界捕获校验错误，日志只记录固定提示，不包含数量、成本或成交记录。
 * @param data 行情快照。
 * @param signals 全部父传信号。
 * @param openingPosition 可空的手工期初。
 * @returns 可显示的结果或明确错误。
 */
function calculateReview(data: MarketData, signals: Signal[], openingPosition: OpeningPosition | null):
  { result: ExecutionReviewResult | null; error: string } {
  try {
    return { result: buildExecutionReview({ data, signals, openingPosition }), error: '' };
  } catch (error) {
    console.error('执行复盘输入校验失败；请检查数据结构与查询范围。');
    return { result: null, error: error instanceof Error ? error.message : '执行复盘输入无效，请检查数据。' };
  }
}

/**
 * 管理当前范围内的临时期初表单，应用时才参与计算；范围变化由外层 key 重置。
 * @param props 公开组件契约。
 * @returns 带错误处理的复盘面板。
 */
function ExecutionReviewContent({ data, signals, onSelect }: ExecutionReviewProps) {
  const [quantity, setQuantity] = useState('');
  const [cost, setCost] = useState('');
  const [opening, setOpening] = useState<OpeningPosition | null>(null);
  const [formError, setFormError] = useState('');
  const { result, error } = useMemo(() => calculateReview(data, signals, opening), [data, signals, opening]);
  /**
   * 将明确输入作为手工快照应用，不从任何账户或当前持仓补全字段。
   * @param event 表单提交事件。
   * @returns 无返回值；校验失败保留已应用快照并显示错误。
   */
  function applyOpening(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    try {
      const next = { quantity: parseOpeningNumber(quantity, false)!, costPrice: parseOpeningNumber(cost, true) };
      setOpening(next); setFormError('');
      console.info('执行复盘已应用用户手工期初快照，仅在当前面板内存中使用。');
    } catch (failure) {
      setFormError(failure instanceof Error ? failure.message : '期初快照输入无效。');
      console.warn('执行复盘手工期初校验失败，请检查输入。');
    }
  }
  /** 清除期初数量、成本与已应用快照；无参数，无返回值，不保存账户隐私。 */
  function clearOpening(): void {
    setOpening(null); setQuantity(''); setCost(''); setFormError('');
    console.info('执行复盘已清除当前面板的手工期初快照。');
  }
  return <section className="review-panel execution-ledger">
    <div className="section-header"><div><h2>单证券仓位流水与执行核查</h2>
      <p>{data.symbol} · {data.source === 'demo' ? '显式演示数据' : '逐笔成交快照'} · 成交区间（闭开）：{data.executionRange?.start} 至 {data.executionRange?.end}</p>
      <p>只采用用户手工期初快照和本区间完整逐笔成交，不从当前持仓反推历史。</p></div></div>
    <details><summary>设置期初仓位</summary>
      <p className="method-note">这是用户手工声明的区间起点快照，时点为成交区间起点、第一笔区间成交之前。数量必须明确填写，空仓请输入 0；单位成本可留空。</p>
      <form onSubmit={applyOpening} autoComplete="off">
        <div className="settings-grid">
          <label>手工期初数量<input type="number" min="0" step="any" required autoComplete="off" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
          <label>手工期初单位成本（可选）<input type="number" min="0" step="any" autoComplete="off" value={cost} onChange={(event) => setCost(event.target.value)} /></label>
        </div>
        <p className="form-error" role={formError ? 'alert' : undefined}>{formError}</p>
        <div className="dialog-actions"><button className="button" type="button" onClick={clearOpening}>清除期初快照</button><button className="button" type="submit">应用手工期初快照</button></div>
      </form>
      <p className="method-note">仅在当前组件内存中使用，不保存、上传或导出数量和成本。来源、标的、周期、区间变化及组件卸载会清除全部输入。</p>
    </details>
    <p className="method-note">{opening ? `已应用用户手工期初快照：数量 ${formatNumber(opening.quantity, 6)}，单位成本 ${formatNumber(opening.costPrice, 6)}。` : '未提供手工期初快照：仓位和操作分类未知，不能判定遗漏。'}</p>
    {error && <p className="form-error" role="alert">无法生成执行复盘：{error}</p>}
    {result && <>
      <p className="method-note" role="status">{result.status === 'known' ? '仓位流水可按手工期初及完整逐笔成交重放。' : '仓位状态未知：请核对期初快照、逐笔完整性或流水异常。'}{!data.executionsComplete && ' 成交缺失或不完整，执行情况未知。'}</p>
      <LedgerTable result={result} data={data} onSelect={onSelect} />
      <SignalTable result={result} data={data} onSelect={onSelect} />
      <SellBuyTable result={result} data={data} />
      {result.notes.map((note) => <p className="method-note" key={note}>{note}</p>)}
    </>}
  </section>;
}

/**
 * 展示完整逐笔流水，包括没有策略信号的操作；数量保留小数避免零股被舍去。
 * @param props 复盘结果、行情及定位回调。
 * @returns 有表头与空状态的流水表。
 */
function LedgerTable({ result, data, onSelect }: { result: ExecutionReviewResult; data: MarketData; onSelect: (time: number) => void }) {
  return <div className="table-scroll"><table><caption>逐笔仓位流水</caption>
    <thead><tr><th>成交时间（中国）</th><th>方向 / 数量 / 价格</th><th>操作分类</th><th>数量（前 → 后）</th><th>成交后单位成本</th><th>卖出成本价差金额（未扣费）</th><th>核查说明</th></tr></thead>
    <tbody>{result.ledger.length ? result.ledger.map((entry) => {
      const fill = entry.execution;
      const candleTime = candleTimeForFill(fill.time, data);
      return <tr key={fill.id}>
        <td>{formatTime(fill.time, data.symbol, data.period, true)}{candleTime !== null && <button type="button" className="text-button day-locate" onClick={() => onSelect(candleTime)}>定位成交柱</button>}</td>
        <td>{fill.side === 'buy' ? '买入' : '卖出'} {formatNumber(fill.quantity, 6)} @ {formatNumber(fill.price, 6)}</td>
        <td>{ACTION_LABELS[entry.action]}</td><td>{formatNumber(entry.quantityBefore, 6)} → {formatNumber(entry.quantityAfter, 6)}</td>
        <td>{formatNumber(entry.averageCostAfter, 6)}</td><td>{formatNumber(entry.grossPriceDifference)}<small>不代表已实现净利</small></td>
        <td className="review-note">{entry.note}</td>
      </tr>;
    }) : <tr><td colSpan={7}>{data.executionsComplete && Array.isArray(data.executions) ? '本证券区间内无成交。' : '逐笔成交缺失或不完整，仓位及执行情况未知。'}</td></tr>}</tbody>
  </table></div>;
}

/**
 * 展示父组件传入的全部信号及一次性时间匹配，延迟和价差不表达归因。
 * @param props 复盘结果、行情及定位回调。
 * @returns 信号核查表。
 */
function SignalTable({ result, data, onSelect }: { result: ExecutionReviewResult; data: MarketData; onSelect: (time: number) => void }) {
  return <div className="table-scroll"><table><caption>信号与成交时间对应（全部父传信号）</caption>
    <thead><tr><th>信号 / 确认时间（中国）</th><th>核查状态</th><th>对应成交（中国）</th><th>确认 → 成交延迟</th><th>下一柱 open / 实际价</th><th>实际价 − 下一柱 open</th><th>说明</th></tr></thead>
    <tbody>{result.signalReviews.length ? result.signalReviews.map((item) => <tr key={item.signal.id}>
      <td><button type="button" className="text-button" onClick={() => onSelect(item.signal.time)}>{item.signal.side === 'buy' ? '买入' : '卖出'} · {item.signal.title}</button><small>{formatTime(item.confirmationTime, data.symbol, data.period, true)}</small></td>
      <td>{SIGNAL_LABELS[item.state]}</td><td>{item.execution ? <>{formatTime(item.execution.time, data.symbol, data.period, true)}<small>数量 {formatNumber(item.execution.quantity, 6)}</small></> : '—'}</td>
      <td>{item.delaySeconds === null ? '—' : `${formatNumber(item.delaySeconds, 3)} 秒`}</td>
      <td>{formatNumber(item.nextOpenPrice, 6)} / {formatNumber(item.execution?.price, 6)}</td>
      <td>{formatNumber(item.priceDeviation, 6)}<small>{formatPercent(item.priceDeviationPercent)} · 原始价格偏差，非盈亏</small></td>
      <td className="review-note">{item.note}</td>
    </tr>) : <tr><td colSpan={7}>父组件未传入信号；无信号不表示遗漏操作。</td></tr>}</tbody>
  </table></div>;
}

/**
 * 仅展示先卖后买的数量匹配与原始价差，不标反 T 或盈利。
 * @param props 复盘结果及当前行情。
 * @returns 卖后买回候选表与必要解释。
 */
function SellBuyTable({ result, data }: { result: ExecutionReviewResult; data: MarketData }) {
  return <div className="table-scroll"><table><caption>卖出后买回候选（不推定意图）</caption>
    <thead><tr><th>候选</th><th>卖出 / 买回时间（中国）</th><th>匹配数量</th><th>卖价 / 买价</th><th>卖价 − 买价</th><th>价差 × 匹配数量（未扣费）</th></tr></thead>
    <tbody>{result.sellBuyCandidates.length ? result.sellBuyCandidates.map((candidate) => <tr key={`${candidate.sell.id}-${candidate.buy.id}`}>
      <td>{candidate.label}</td><td>{formatTime(candidate.sell.time, data.symbol, data.period, true)}<small>{formatTime(candidate.buy.time, data.symbol, data.period, true)}</small></td>
      <td>{formatNumber(candidate.matchedQuantity, 6)}</td><td>{formatNumber(candidate.sell.price, 6)} / {formatNumber(candidate.buy.price, 6)}</td>
      <td>{formatNumber(candidate.priceDifference, 6)}</td><td>{formatNumber(candidate.priceDifferenceAmount)}<small>不是净盈利，不推定反 T 意图</small></td>
    </tr>) : <tr><td colSpan={6}>{result.status === 'unknown' ? '仓位或成交信息不足，未生成可核查的卖后买回候选。' : '未发现可匹配数量的先卖后买成交。'}</td></tr>}</tbody>
  </table></div>;
}
