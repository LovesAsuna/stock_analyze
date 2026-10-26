import type { Candle, Execution, MarketData, Signal } from './types';
import { validateCandles } from './indicators';
import { isCalendarPeriod, isPeriod } from './periods';
import { isRegularTradingTime } from './calendar-bars';
import { barOpenTime, inChinaRange, signalConfirmationTime } from './review';

/** 用户手工声明的区间起点快照；costPrice 为单位成本，null 表示未提供。 */
export interface OpeningPosition { quantity: number; costPrice: number | null }

/** 单笔成交后的仓位；unknown 不等于空仓，anomaly 不产生负仓位。 */
export interface LedgerEntry {
  execution: Execution;
  action: 'open' | 'add' | 'reduce' | 'close' | 'anomaly' | 'unknown';
  quantityBefore: number | null;
  quantityAfter: number | null;
  averageCostAfter: number | null;
  /** 仅卖出价减移动平均单位成本后乘数量，未扣费用，不是已实现净利。 */
  grossPriceDifference: number | null;
  note: string;
}

/** 时间对应关系仅供核查，不表示信号导致成交或未成交造成损失。 */
export interface ExecutionSignalReview {
  signal: Signal;
  state: 'matched' | 'delayed-candidate' | 'unmatched' | 'pending' | 'unknown';
  execution: Execution | null;
  confirmationTime: number;
  nextOpenPrice: number | null;
  delaySeconds: number | null;
  /** 实际成交价减下一柱 open，买卖方向均使用同一原始符号。 */
  priceDeviation: number | null;
  priceDeviationPercent: number | null;
  note: string;
}

/** 按时间先卖后买、FIFO 分配数量的候选；每一单位买卖量只分配一次。 */
export interface SellBuyCandidate {
  label: '卖出后买回候选';
  sell: Execution;
  buy: Execution;
  matchedQuantity: number;
  priceDifference: number;
  /** (卖价 - 买价) × 匹配数量；不代表净盈利，也不推定反 T 意图。 */
  priceDifferenceAmount: number;
}

/** 共享入口只接收行情、父组件传入的全部信号和显式期初，不接收当前持仓。 */
export interface ExecutionReviewInput {
  data: MarketData;
  signals: Signal[];
  openingPosition?: OpeningPosition | null;
}

export interface ExecutionReviewResult {
  status: 'known' | 'unknown';
  ledger: LedgerEntry[];
  signalReviews: ExecutionSignalReview[];
  sellBuyCandidates: SellBuyCandidate[];
  notes: string[];
}

interface Context {
  data: MarketData;
  fills: Execution[];
  complete: boolean;
  start: number;
  end: number;
}
interface Window { start: number; end: number; candle: Candle }
interface PositionState { quantity: number | null; cost: number | null }

/**
 * 校验有限数值和业务下界，防止字符串、NaN、无穷大及计算溢出。
 * @param value 待校验数值。
 * @param label 中文字段名。
 * @param positive 是否必须严格大于零。
 * @returns 验证后的数值；非法时抛出明确错误。
 */
function numberValue(value: number, label: string, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
    throw new Error(`${label}必须是${positive ? '大于零' : '非负'}的有限数值`);
  }
  return value;
}

/**
 * 拒绝数值运算溢出，不把不可表示的结果显示为有效统计。
 * @param value 运算结果。
 * @returns 有限结果，否则抛错。
 */
function finiteResult(value: number): number {
  if (!Number.isFinite(value)) throw new Error('仓位或价差计算超出有限数值范围');
  return value;
}

/**
 * 校验 UTC Unix 秒；成交、信号与 K 线均不接受毫秒时间。
 * @param time 待校验 UTC 秒。
 * @returns 无返回值；越界时抛错。
 */
function validateTime(time: number): void {
  if (typeof time !== 'number' || !Number.isFinite(time) || Math.abs(time) >= 100_000_000_000 ||
      !Number.isFinite(new Date(time * 1000).getTime())) throw new Error('时间必须是有效的 UTC Unix 秒，不能使用毫秒');
}

/**
 * 标准化证券和标识字符串，不允许空白或控制字符。
 * @param value 原始字符串。
 * @param label 中文字段名。
 * @returns 去除两端空白的字符串。
 */
function textValue(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label}必须是非空文本且不含控制字符`);
  }
  return value.trim();
}

/**
 * 校验用户明确输入的期初快照；数量为零时成本不会被用于后续建仓。
 * @param opening 用户手工快照，null/undefined 表示未提供。
 * @returns 无返回值；非法输入抛错。
 */
function validateOpening(opening: OpeningPosition | null | undefined): void {
  if (opening == null) return;
  if (typeof opening !== 'object') throw new Error('期初快照必须包含数量及可空单位成本');
  numberValue(opening.quantity, '期初数量');
  if (opening.costPrice !== null) numberValue(opening.costPrice, '期初单位成本', true);
}

/**
 * 严格检查 ISO 边界语法；日期有效性和闭开顺序复用现有 review 校验。
 * @param value 日期或显式带时区的 ISO 时间。
 * @returns UTC 秒；日期按中国午夜解释。
 */
function boundary(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00)))?$/.test(value)) {
    throw new Error('成交区间必须为有效 ISO 日期或包含明确时区的时间');
  }
  return Date.parse(value.length === 10 ? `${value}T00:00:00+08:00` : value) / 1000;
}

/**
 * 校验逐笔成交全部字段和唯一 ID，包括随后会被证券/区间过滤的记录。
 * @param fills 原始成交数组。
 * @returns 无返回值；非法记录抛错，不伪装为无成交。
 */
function validateFills(fills: Execution[]): void {
  const ids = new Set<string>();
  for (const fill of fills) {
    if (!fill || typeof fill !== 'object') throw new Error('逐笔成交必须是有效对象');
    const id = textValue(fill.id, '成交 ID');
    if (ids.has(id)) throw new Error('成交 ID 必须唯一');
    ids.add(id);
    textValue(fill.symbol, '成交证券');
    if (fill.side !== 'buy' && fill.side !== 'sell') throw new Error('成交方向必须为 buy 或 sell');
    validateTime(fill.time);
    numberValue(fill.price, '成交价格', true);
    numberValue(fill.quantity, '成交数量', true);
  }
}

/**
 * 建立单证券闭开区间上下文；缺失成交数组或完整性声明按未知处理。
 * @param data 父组件传入的行情快照。
 * @returns 已校验且按时间、ID 排序的区间内同证券成交。
 */
function makeContext(data: MarketData): Context {
  if (!data || typeof data !== 'object') throw new Error('行情数据必须是对象');
  if (data.source !== 'demo' && data.source !== 'longbridge') throw new Error('行情来源无效');
  const symbol = textValue(data.symbol, '行情证券').toUpperCase();
  if (symbol === 'HK' || symbol === 'US') throw new Error('必须指定单个证券，不能只提供市场');
  if (!isPeriod(data.period)) throw new Error('不支持的 K 线周期');
  if (data.adjustment !== 'none') throw new Error('仓位流水只接受不复权行情');
  if (!Array.isArray(data.candles) || data.candles.some((candle) => !candle || typeof candle !== 'object')) {
    throw new Error('K 线必须是有效对象数组');
  }
  validateCandles(data.candles);
  data.candles.forEach((candle) => validateTime(candle.time));
  if (!data.executionRange || typeof data.executionRange !== 'object') throw new Error('缺少成交查询区间');
  const start = boundary(data.executionRange.start);
  const end = boundary(data.executionRange.end);
  inChinaRange(0, data.executionRange.start, data.executionRange.end);
  if (data.executions != null && !Array.isArray(data.executions)) throw new Error('逐笔成交必须为数组或缺失');
  if (data.executionsComplete != null && typeof data.executionsComplete !== 'boolean') {
    throw new Error('成交完整性必须是布尔值');
  }
  const fills = data.executions ?? [];
  validateFills(fills);
  return { data, start, end, complete: Array.isArray(data.executions) && data.executionsComplete === true,
    fills: fills.filter((fill) => fill.symbol.trim().toUpperCase() === symbol && fill.time >= start && fill.time < end)
      .sort((left, right) => left.time - right.time || left.id.localeCompare(right.id)) };
}

/**
 * 校验父组件传入的全部信号，不在此重新筛选日期或依赖事后参考字段匹配。
 * @param signals 全部待复盘信号。
 * @param candles 对应完整行情。
 * @returns 无返回值；错位、重复 ID 或非法字段抛错。
 */
function validateSignals(signals: Signal[], candles: Candle[]): void {
  if (!Array.isArray(signals)) throw new Error('信号必须是数组');
  const ids = new Set<string>();
  for (const signal of signals) {
    if (!signal || typeof signal !== 'object') throw new Error('信号必须是有效对象');
    const id = textValue(signal.id, '信号 ID');
    if (ids.has(id)) throw new Error('信号 ID 必须唯一');
    ids.add(id);
    validateTime(signal.time);
    const candle = candles[signal.index];
    if (!Number.isInteger(signal.index) || !candle || candle.time !== signal.time || candle.close !== signal.close) {
      throw new Error(`信号 ${id} 与行情索引、时间或收盘价不一致`);
    }
    if (!['buy', 'sell'].includes(signal.side) || typeof signal.confirmed !== 'boolean') throw new Error('信号方向或确认标志无效');
    textValue(signal.title, '信号标题');
    if (!Array.isArray(signal.reasons) || signal.reasons.some((reason) => typeof reason !== 'string')) throw new Error('信号理由必须是文本数组');
    if (signal.eligibleTime !== null) validateTime(signal.eligibleTime);
    if (signal.referencePrice !== null) numberValue(signal.referencePrice, '信号参考价格', true);
    if (signal.nextFiveReturn !== null && (typeof signal.nextFiveReturn !== 'number' || !Number.isFinite(signal.nextFiveReturn))) {
      throw new Error('五柱统计必须是有限数值或 null');
    }
  }
}

/**
 * 构造未知仓位行，保留可观察成交，但不推断仓位或遗漏。
 * @param execution 原始成交。
 * @param note 未知原因。
 * @returns 无数量和成本推断的流水行。
 */
function unknownEntry(execution: Execution, note: string): LedgerEntry {
  return { execution, action: 'unknown', quantityBefore: null, quantityAfter: null,
    averageCostAfter: null, grossPriceDifference: null, note };
}

/**
 * 应用一笔成交；使用移动平均成本，卖超后停止推算后续仓位。
 * @param fill 当前成交。
 * @param state 当前可知仓位，原地更新。
 * @returns 该笔流水；卖超为异常且不生成负数量。
 */
function applyFill(fill: Execution, state: PositionState): LedgerEntry {
  const before = state.quantity!;
  // 仅消除浮点运算在数量相等附近的舍入误差，不容忍实际超卖。
  const tolerance = Number.EPSILON * 8 * Math.max(before, fill.quantity);
  if (fill.side === 'sell' && fill.quantity - before > tolerance) {
    state.quantity = null; state.cost = null;
    return { ...unknownEntry(fill, '卖出数量超出流水可用量；不假设融券、负仓或缺失期初，后续仓位未知。'),
      action: 'anomaly', quantityBefore: before };
  }
  let grossPriceDifference: number | null = null;
  if (fill.side === 'buy') {
    state.quantity = finiteResult(before + fill.quantity);
    state.cost = before === 0 ? fill.price : state.cost === null ? null :
      finiteResult(state.cost * (before / state.quantity) + fill.price * (fill.quantity / state.quantity));
  } else {
    grossPriceDifference = state.cost === null ? null : finiteResult((fill.price - state.cost) * fill.quantity);
    state.quantity = Math.abs(before - fill.quantity) <= tolerance ? 0 : finiteResult(before - fill.quantity);
    if (state.quantity === 0) state.cost = null;
  }
  return { execution: fill, quantityBefore: before, quantityAfter: state.quantity, averageCostAfter: state.cost,
    grossPriceDifference, action: fill.side === 'buy' ? before === 0 ? 'open' : 'add' : state.quantity === 0 ? 'close' : 'reduce',
    note: '仅依赖用户手工期初快照与区间逐笔成交；流水可用量不代表券商结算后可卖量。费用未包含。' };
}

/**
 * 按逐笔成交重放仓位，不从当前持仓倒推；同秒异向成交因缺少先后顺序停止推算。
 * @param context 已验证的查询上下文。
 * @param opening 手工期初快照。
 * @returns 时间顺序流水。
 */
function buildLedger(context: Context, opening: OpeningPosition | null | undefined): LedgerEntry[] {
  const state: PositionState = { quantity: opening?.quantity ?? null,
    cost: opening && opening.quantity > 0 ? opening.costPrice : null };
  const directions = new Map<number, Set<Execution['side']>>();
  for (const fill of context.fills) {
    const sides = directions.get(fill.time) ?? new Set<Execution['side']>();
    sides.add(fill.side); directions.set(fill.time, sides);
  }
  let reason = !context.complete ? '逐笔成交缺失或不完整，不能重建仓位，也不能判定遗漏。' :
    !opening ? '未提供用户手工期初快照，仓位和操作分类未知，不能判定遗漏。' : '';
  return context.fills.map((fill) => {
    if (!reason && directions.get(fill.time)!.size > 1) {
      reason = '同一秒存在异向成交且没有逐笔顺序，不能确定操作分类及后续仓位。';
      state.quantity = null; state.cost = null;
    }
    if (reason || state.quantity === null) return unknownEntry(fill, reason || '前序流水出现超出可用量异常，后续仓位未知。');
    return applyFill(fill, state);
  });
}

/**
 * 取得固定周期的实际成交窗口，不利用相邻柱时间差扩大窗口。
 * @param context 行情上下文。
 * @param index K 线索引。
 * @returns 实际开盘至确认的闭开窗口；缺柱返回 null。
 */
function windowAt(context: Context, index: number): Window | null {
  const candle = context.data.candles[index];
  if (!candle) return null;
  const { symbol, period } = context.data;
  return { candle, start: barOpenTime(candle.time, symbol, period),
    end: signalConfirmationTime(candle.time, symbol, period) };
}

/**
 * 检查完整且已结束的成交窗口，避免把部分查询中的首笔认作窗口首笔。
 * @param context 成交上下文。
 * @param window 实际窗口。
 * @returns 是否完全覆盖且行情已确认。
 */
function covered(context: Context, window: Window): boolean {
  return context.complete && window.candle.confirmed && context.start <= window.start && context.end >= window.end;
}

/**
 * 建立不含任何成交归因的信号初始状态。
 * @param signal 原始信号。
 * @param context 行情与成交范围。
 * @param hasOpening 是否存在用户手工期初。
 * @returns 下一柱状态；只有完整窗口和手工期初允许称为窗口未匹配。
 */
function initialReview(signal: Signal, context: Context, hasOpening: boolean): ExecutionSignalReview {
  const confirmationTime = signalConfirmationTime(signal.time, context.data.symbol, context.data.period);
  const next = windowAt(context, signal.index + 1);
  const item: ExecutionSignalReview = { signal, state: 'unknown', execution: null, confirmationTime,
    nextOpenPrice: next?.candle.open ?? null, delaySeconds: null, priceDeviation: null, priceDeviationPercent: null,
    note: '逐笔成交缺失或不完整，执行情况未知，不能判定遗漏。' };
  if (!context.complete) return item;
  if (!signal.confirmed || !context.data.candles[signal.index].confirmed) {
    return { ...item, state: 'pending', note: '信号所在柱尚未确认，等待确认后再匹配。' };
  }
  if (!next) return { ...item, state: 'pending', note: '下一柱尚未出现，等待可成交窗口。' };
  if (next.start < confirmationTime) return { ...item, note: '下一柱窗口与信号确认时刻重叠，不能可靠匹配。' };
  if (context.start > next.start || context.end < next.end) {
    return { ...item, note: '查询范围没有覆盖完整下一柱窗口，执行情况未知。' };
  }
  if (!next.candle.confirmed) return { ...item, state: 'pending', note: '下一柱尚未确认，窗口还未完整结束。' };
  return { ...item, state: hasOpening ? 'unmatched' : 'unknown', note: hasOpening ?
    '完整下一柱窗口未分配到同证券同向成交；不表示遗漏、因果或损失。' :
    '未提供手工期初快照；下一柱未分配到同向成交，不能判定遗漏。' };
}

/**
 * 在完整窗口查找最早尚未分配的同向成交，同秒按 ID 稳定排序。
 * @param item 待匹配信号。
 * @param context 成交上下文。
 * @param window 已完整覆盖的窗口。
 * @param used 已分配成交 ID。
 * @returns 首笔可分配成交或 null。
 */
function firstFill(item: ExecutionSignalReview, context: Context, window: Window, used: Set<string>): Execution | null {
  return context.fills.find((fill) => !used.has(fill.id) && fill.side === item.signal.side &&
    fill.time >= Math.max(window.start, item.confirmationTime) && fill.time < window.end &&
    (!isCalendarPeriod(context.data.period) || context.data.period === 'day' || isRegularTradingTime(fill.time, context.data.symbol))) ?? null;
}

/**
 * 记录确认到成交延迟和相对下一柱 open 的原始价格偏差，价格偏差不是盈亏。
 * @param item 待更新结果。
 * @param fill 选中的成交。
 * @param delayed 是否为延后候选。
 * @param used 已分配集合，原地记录避免再次使用。
 * @returns 无返回值，原地更新结果。
 */
function assignFill(item: ExecutionSignalReview, fill: Execution, delayed: boolean, used: Set<string>): void {
  used.add(fill.id);
  item.execution = fill;
  item.state = delayed ? 'delayed-candidate' : 'matched';
  item.delaySeconds = finiteResult(fill.time - item.confirmationTime);
  item.priceDeviation = finiteResult(fill.price - item.nextOpenPrice!);
  item.priceDeviationPercent = finiteResult(item.priceDeviation / item.nextOpenPrice! * 100);
  item.note = `${delayed ? '延后成交候选：确认后第 2～5 根柱内首笔可分配同向成交' : '完整下一柱窗口内首笔可分配同证券同向成交'}；仅为时间对应，不证明因果，不推定遗漏或损失。价格偏差为成交价减下一柱 open，未扣费，不是盈亏。`;
}

/**
 * 先分配所有信号的下一柱成交，再寻找延后候选，避免候选抢占另一信号的直接匹配。
 * @param context 同证券完整成交上下文。
 * @param signals 父组件提供的全部信号，不自行筛选。
 * @param hasOpening 是否有手工期初。
 * @returns 保持输入信号顺序的匹配结果，每笔成交最多使用一次。
 */
function matchSignals(context: Context, signals: Signal[], hasOpening: boolean): ExecutionSignalReview[] {
  const items = signals.map((signal) => initialReview(signal, context, hasOpening));
  const ordered = [...items].sort((left, right) => left.confirmationTime - right.confirmationTime || left.signal.id.localeCompare(right.signal.id));
  const used = new Set<string>();
  const eligible = ordered.filter((item) => {
    const next = windowAt(context, item.signal.index + 1);
    return item.signal.confirmed && context.data.candles[item.signal.index].confirmed && next !== null &&
      next.start >= item.confirmationTime && covered(context, next);
  });
  for (const item of eligible) {
    const fill = firstFill(item, context, windowAt(context, item.signal.index + 1)!, used);
    if (fill) assignFill(item, fill, false, used);
  }
  for (const item of eligible.filter((review) => !review.execution)) {
    for (let offset = 2; offset <= 5; offset += 1) {
      const window = windowAt(context, item.signal.index + offset);
      // 缺失/未结束/不完整窗口使“首笔”无法证实，不能跳过后继续找。
      if (!window || !covered(context, window) || window.start < item.confirmationTime) break;
      const fill = firstFill(item, context, window, used);
      if (fill) { assignFill(item, fill, true, used); break; }
    }
  }
  return items;
}

/**
 * 对已知有效流水使用 FIFO 匹配先卖后买的数量，严格要求买入时间晚于卖出。
 * @param ledger 已重放的流水。
 * @param complete 成交是否完整；不完整时不生成候选。
 * @returns 仅描述数量与价差的候选，不推定交易意图或净收益。
 */
function matchSellBuy(ledger: LedgerEntry[], complete: boolean): SellBuyCandidate[] {
  if (!complete) return [];
  const sells: { fill: Execution; remaining: number }[] = [];
  const candidates: SellBuyCandidate[] = [];
  let head = 0;
  for (const entry of ledger) {
    if (entry.action === 'unknown' || entry.action === 'anomaly') continue;
    const fill = entry.execution;
    if (fill.side === 'sell') { sells.push({ fill, remaining: fill.quantity }); continue; }
    let remaining = fill.quantity;
    while (remaining > 0 && head < sells.length && sells[head].fill.time < fill.time) {
      const sell = sells[head];
      const matchedQuantity = Math.min(remaining, sell.remaining);
      const priceDifference = finiteResult(sell.fill.price - fill.price);
      candidates.push({ label: '卖出后买回候选', sell: sell.fill, buy: fill, matchedQuantity,
        priceDifference, priceDifferenceAmount: finiteResult(priceDifference * matchedQuantity) });
      remaining -= matchedQuantity; sell.remaining -= matchedQuantity;
      if (sell.remaining === 0) head += 1;
    }
  }
  return candidates;
}

/**
 * 重放单证券仓位并核查成交与信号的时间关系；不会读取账户或反推期初。
 * @param input 行情、父组件全部信号，以及可选的用户手工期初快照。
 * @returns 仓位流水、一次性成交匹配及卖后买回候选；输入错误明确抛出。
 */
export function buildExecutionReview({ data, signals, openingPosition }: ExecutionReviewInput): ExecutionReviewResult {
  validateOpening(openingPosition);
  const context = makeContext(data);
  validateSignals(signals, data.candles);
  const ledger = buildLedger(context, openingPosition);
  return { status: context.complete && openingPosition != null &&
      ledger.every((entry) => entry.action !== 'unknown' && entry.action !== 'anomaly') ? 'known' : 'unknown',
    ledger, signalReviews: matchSignals(context, signals, openingPosition != null),
    sellBuyCandidates: matchSellBuy(ledger, context.complete),
    notes: [
      '期初仅接受用户手工声明的区间起点快照，不从当前持仓反推历史。缺失期初或完整逐笔成交时，仓位未知，不能判定遗漏。',
      '移动平均成本和卖出价差金额不包含佣金、税费、汇率及公司行动，不能作为已实现净利。流水可用量不代表结算后可卖量。',
      '卖出后买回候选按匹配数量比较价差，不推定反 T 意图，价差金额不是净盈利。',
      '全部信号由父组件传入；日线复用交易所时区的 09:30～16:00 窗口，沿用现有规则，未建模半日市。',
      '直接匹配优先于延后候选；候选仅查确认后第 2～5 根现有柱，每笔成交最多分配一次，不表示因果或损失。',
    ] };
}
