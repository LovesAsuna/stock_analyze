import type { Candle, IndicatorPoint, Signal } from './types';
import { validateCandles } from './indicators';
import { barOpenTime, signalConfirmationTime } from './review';
import { evaluateGroup, validatePlan, type TradingPlan } from './strategy';

/** 模拟多头交易，收益含买卖两侧费用；未平仓交易的已实现收益为空。 */
export type SimulatedTrade = {
  id: string; entryIndex: number; entryTime: number; entryPrice: number;
  exitIndex: number | null; exitTime: number | null; exitPrice: number | null;
  quantity: number; returnPct: number | null; pnl: number | null; exitReason: string | null;
  stopPrice: number | null; targetPrice: number | null; trailPrice: number | null;
  barsHeld: number; maePct: number; mfePct: number;
};
/**
 * 持仓期间的原始价格路径百分比，基准为入场柱原始开盘价（不含费用、滑点）。
 * offset 0 恒为 0；offset 1 为入场柱收盘，离场开盘所在柱不采样。
 * 后续 offset 只包含仍持有至该柱收盘的样本，count 会变化，不能视为策略收益。
 */
export type PathPoint = { offset: number; count: number; mean: number; median: number; p25: number; p75: number };
/** trades 仅含已平仓交易，openTrade 单独保留，所有收益和回撤字段均为百分比。 */
export type BacktestResult = {
  signals: Signal[]; trades: SimulatedTrade[]; openTrade: SimulatedTrade | null;
  equity: { time: number; value: number }[]; paths: PathPoint[]; warnings: string[];
  /** 实际已估值研究段，包含端点；不是计划闭开边界或成交复盘查询范围。 */
  researchRange: { start: number | null; end: number | null };
  metrics: {
    closedTrades: number; winRate: number | null; totalReturn: number; maxDrawdown: number;
    profitFactor: number | null; exposurePct: number;
  };
};

type PendingOrder = { side: 'buy' | 'sell'; index: number; confirmedAt: number; reason: string };
type Holding = { trade: SimulatedTrade; entryCost: number; highestHigh: number; path: number[] };
type Engine = {
  candles: Candle[]; points: IndicatorPoint[]; plan: TradingPlan; result: BacktestResult;
  start: number; end: number; initialCapital: number; cash: number; holding: Holding | null;
  pending: PendingOrder | null; samples: number[][]; studyBars: number; exposedBars: number;
};

/**
 * 校验指标序列，确保缺失字段、时间错位与中途未确认柱不会静默参与交易。
 * @param candles 完整行情。
 * @param points 调用已有指标引擎得到的同长度序列。
 * @returns 验证成功无返回值，失败抛出中文错误。
 */
function validateInputs(candles: Candle[], points: IndicatorPoint[]): void {
  validateCandles(candles);
  if (candles.length !== points.length) throw new Error('指标数量必须与 K 线数量一致');
  let unconfirmed = false;
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const point = points[index];
    if (!point || point.time !== candle.time) throw new Error(`第 ${index} 根指标时间与 K 线不一致`);
    if (!candle.confirmed) unconfirmed = true;
    else if (unconfirmed) throw new Error(`第 ${index} 根已确认 K 线之前存在未确认柱`);
    for (const field of ['fastMA', 'slowMA', 'macd', 'macdSignal', 'histogram', 'rsi', 'plusDI', 'minusDI',
      'adx', 'sar', 'bollUpper', 'bollMiddle', 'bollLower', 'volumeRatio'] as const) {
      const value = point[field];
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error(`第 ${index} 根指标 ${field} 必须是有限数或 null`);
      }
    }
    if (typeof point.sarBull !== 'boolean') throw new Error(`第 ${index} 根 SAR 方向无效`);
  }
}

/**
 * 建立空结果，说明模型假设以便调用方直接展示。
 * @returns 无交易、无收益且带必要模型说明的结果。
 */
function emptyResult(): BacktestResult {
  return {
    signals: [], trades: [], openTrade: null, equity: [], paths: [], researchRange: { start: null, end: null },
    warnings: [
      '研究采用收盘风险模型：止损、止盈及追踪止损仅比较已确认收盘价，下一根已确认柱开盘成交；不是券商盘中保护单。',
      '开盘成交包含跳空和不利滑点；收盘止盈触发后仍可能因次柱跳空而亏损。',
      '路径为持仓期间相对入场柱原始开盘的价格统计：offset 0=0，offset 1=入场柱收盘；不含费用与滑点，样本数随持仓期限变化。',
    ],
    metrics: { closedTrades: 0, winRate: null, totalReturn: 0, maxDrawdown: 0, profitFactor: null, exposurePct: 0 },
  };
}

/**
 * 限制逐柱拒单警告数量，保留模型说明且避免长序列产生无限重复文本。
 * @param engine 当前引擎状态。
 * @param message 明确说明原因的警告。
 * @returns 写入不超过 100 条警告，达到上限后提示省略，无返回值。
 */
function warn(engine: Engine, message: string): void {
  if (engine.result.warnings.length < 99) engine.result.warnings.push(message);
  else if (engine.result.warnings.length === 99) engine.result.warnings.push('警告已达到 100 条，其余逐柱警告省略。');
}

/**
 * 仅生成当前已知证据的规则信号，不使用未来柱决定当前交易方向。
 * @param engine 现金账户状态。
 * @param index 当前已确认柱。
 * @param side 规则方向。
 * @param reason 入场、离场或风险说明。
 * @param reasons 规则证据。
 * @returns 写入信号并建立仅可在下一柱执行的订单，无返回值。
 */
function queueOrder(engine: Engine, index: number, side: Signal['side'], reason: string, reasons: string[]): void {
  const candle = engine.candles[index];
  const confirmedAt = signalConfirmationTime(candle.time, engine.plan.symbol, engine.plan.period);
  engine.result.signals.push({
    id: `${engine.plan.id}-${engine.plan.revision}-${candle.time}-${side}`,
    time: candle.time, index, side, title: reason, reasons, close: candle.close,
    eligibleTime: null, referencePrice: null, nextFiveReturn: null, confirmed: true,
  });
  engine.pending = { side, index, confirmedAt, reason };
}

/**
 * 按实际含滑点入场价检查固定风险价，并尝试现金买入。
 * @param engine 当前状态。
 * @param index 下一根已确认柱位置。
 * @param time 实际开盘 UTC 秒。
 * @returns 成交时建立持仓，拒单时附加警告，无返回值。
 */
function enter(engine: Engine, index: number, time: number): void {
  const { plan } = engine;
  const price = engine.candles[index].open * (1 + plan.slippageBps / 10000);
  if ((plan.stopPrice !== null && plan.stopPrice >= price) || (plan.targetPrice !== null && plan.targetPrice <= price)) {
    warn(engine, `第 ${index} 根跳过入场：固定止损必须低于实际入场价，固定止盈必须高于实际入场价（${price.toFixed(4)}）。`);
    return;
  }
  const cost = price * plan.quantity * (1 + plan.feeBps / 10000);
  if (!Number.isFinite(cost)) throw new Error('模拟入场金额溢出，请降低价格、数量或费用');
  if (cost > engine.cash) {
    warn(engine, `第 ${index} 根跳过入场：现金不足以支付固定数量 ${plan.quantity} 及单边费用，不借款或自动缩量。`);
    return;
  }
  engine.cash -= cost;
  const trade: SimulatedTrade = {
    id: `${plan.id}-${plan.revision}-trade-${engine.candles[index].time}`,
    entryIndex: index, entryTime: time, entryPrice: price, exitIndex: null, exitTime: null, exitPrice: null,
    quantity: plan.quantity, returnPct: null, pnl: null, exitReason: null,
    // 显式固定价优先；未设置时才使用相对实际模拟成交价的百分比风险线。
    stopPrice: plan.stopPrice ?? (plan.stopLossPct > 0 ? price * (1 - plan.stopLossPct / 100) : null),
    targetPrice: plan.targetPrice ?? (plan.takeProfitPct > 0 ? price * (1 + plan.takeProfitPct / 100) : null),
    trailPrice: null, barsHeld: 0, maePct: 0, mfePct: 0,
  };
  engine.holding = { trade, entryCost: cost, highestHigh: 0, path: [0] };
}

/**
 * 将已存在的持仓在次柱开盘卖出，并把净现金收入计入账本。
 * @param engine 当前账户。
 * @param index 成交柱。
 * @param time 实际开盘时间。
 * @param reason 前柱收盘已确认的离场原因。
 * @returns 完成平仓，无返回值；无仓时不生成卖出。
 */
function exit(engine: Engine, index: number, time: number, reason: string): void {
  const holding = engine.holding;
  if (!holding) return;
  const price = engine.candles[index].open * (1 - engine.plan.slippageBps / 10000);
  const proceeds = price * holding.trade.quantity * (1 - engine.plan.feeBps / 10000);
  const pnl = proceeds - holding.entryCost;
  // 开盘跳空属于持仓退出路径；此时已知的只有开盘及实际成交价，不能读取本柱高低收盘。
  holding.trade.maePct = Math.min(holding.trade.maePct, (price / holding.trade.entryPrice - 1) * 100);
  holding.trade.mfePct = Math.max(holding.trade.mfePct, (price / holding.trade.entryPrice - 1) * 100);
  if (!Number.isFinite(proceeds) || !Number.isFinite(pnl)) throw new Error('模拟离场金额溢出');
  engine.cash += proceeds;
  Object.assign(holding.trade, {
    exitIndex: index, exitTime: time, exitPrice: price, pnl,
    returnPct: pnl / holding.entryCost * 100, exitReason: reason,
  });
  engine.result.trades.push(holding.trade);
  engine.samples.push(holding.path);
  engine.holding = null;
}

/**
 * 消费上一根的订单，任何拒单只影响成交，不抹去已经确认的信号。
 * @param engine 当前状态。
 * @param index 当前已确认柱。
 * @param openTime 真实开盘时间。
 * @returns 无返回值，订单仅尝试一次，不顺延补成交。
 */
function executePending(engine: Engine, index: number, openTime: number): void {
  const pending = engine.pending;
  engine.pending = null;
  if (!pending || pending.index + 1 !== index) return;
  if (openTime < engine.start || openTime >= engine.end) {
    warn(engine, `第 ${index} 根订单未成交：下一柱开盘超出计划有效闭开范围。`);
    return;
  }
  if (openTime < pending.confirmedAt) throw new Error(`第 ${index} 根开盘早于上一根信号确认，行情周期重叠`);
  if (pending.side === 'buy' && !engine.holding) enter(engine, index, openTime);
  else if (pending.side === 'sell' && engine.holding) exit(engine, index, openTime, pending.reason);
}

/**
 * 使用前已完成柱高点计算追踪价，在收盘判断风险并按保守顺序选择离场原因。
 * @param engine 当前状态。
 * @param candle 当前已确认柱。
 * @returns 风险触发的中文原因，未触发返回 null。
 */
function riskReason(engine: Engine, candle: Candle): string | null {
  const holding = engine.holding!;
  const trade = holding.trade;
  const trailing = engine.plan.trailingStopPct;
  // 本柱 high 直到所有收盘判定完成才更新，绝不用于同柱追踪触发。
  if (trailing > 0 && trade.barsHeld > 1) {
    trade.trailPrice = holding.highestHigh * (1 - trailing / 100);
  }
  if (trade.stopPrice !== null && candle.close <= trade.stopPrice) return '收盘止损触发，次柱开盘离场';
  if (trade.trailPrice !== null && candle.close <= trade.trailPrice) return '收盘追踪止损触发，次柱开盘离场';
  if (trade.targetPrice !== null && candle.close >= trade.targetPrice) return '收盘止盈触发，次柱开盘离场';
  return null;
}

/**
 * 在收盘更新持仓统计并决定下一柱订单；本柱开盘离场后可在收盘确认次柱重入。
 * @param engine 当前账户。
 * @param index 当前已确认收盘位置。
 * @returns 更新持仓和信号，无返回值。
 */
function processClose(engine: Engine, index: number): void {
  const { candles, points, plan } = engine;
  const candle = candles[index];
  const holding = engine.holding;
  if (holding) {
    const trade = holding.trade;
    trade.barsHeld += 1;
    trade.maePct = Math.min(trade.maePct, (candle.low / trade.entryPrice - 1) * 100);
    trade.mfePct = Math.max(trade.mfePct, (candle.high / trade.entryPrice - 1) * 100);
    holding.path.push((candle.close / candles[trade.entryIndex].open - 1) * 100);
    const risk = riskReason(engine, candle);
    const group = evaluateGroup(plan.exit, candles, points, index);
    const timeout = plan.maxHoldingBars > 0 && trade.barsHeld >= plan.maxHoldingBars;
    const reason = risk ?? (group.matched ? '计划离场条件收盘确认，次柱开盘离场'
      : timeout ? '达到最长持仓柱数，次柱开盘离场' : null);
    if (reason) queueOrder(engine, index, 'sell', reason, risk ? [risk] : timeout && !group.matched
      ? [`已持有 ${trade.barsHeld} 根完整柱，上限 ${plan.maxHoldingBars}`] : group.reasons);
    holding.highestHigh = Math.max(holding.highestHigh, candle.high);
  } else {
    const group = evaluateGroup(plan.entry, candles, points, index);
    const priceReady = plan.entryPrice === null || candle.close >= plan.entryPrice;
    if (group.matched && priceReady) {
      queueOrder(engine, index, 'buy', '计划入场条件收盘确认，次柱开盘买入', [
        ...group.reasons, ...(plan.entryPrice === null ? [] : [`收盘价不低于观察价 ${plan.entryPrice}（附加过滤，非限价单）`]),
      ]);
    }
  }
}

/**
 * 记录现金加持仓市值的权益，避免把固定数量账户误算成复利满仓收益。
 * @param engine 当前账户。
 * @param time 估值时间。
 * @param price 此时可知的价格。
 * @returns 写入权益点，无返回值。
 */
function markEquity(engine: Engine, time: number, price: number): void {
  const value = engine.cash + (engine.holding ? engine.holding.trade.quantity * price : 0);
  if (!Number.isFinite(value)) throw new Error('模拟权益溢出');
  engine.result.equity.push({ time, value });
  engine.result.researchRange.start ??= time;
  engine.result.researchRange.end = time;
}

/**
 * 补齐信号的事后参考字段，字段不参与当前决策，未确认柱不提供参考价。
 * @param engine 回测完成后的状态。
 * @returns 更新信号元数据，无返回值；最后一柱信号保留等待状态。
 */
function annotateSignals(engine: Engine): void {
  for (const signal of engine.result.signals) {
    const next = engine.candles[signal.index + 1];
    if (!next) continue;
    signal.eligibleTime = next.time;
    const nextOpen = barOpenTime(next.time, engine.plan.symbol, engine.plan.period);
    if (!next.confirmed || nextOpen < engine.start || nextOpen >= engine.end) continue;
    signal.referencePrice = next.open;
    const fifth = engine.candles[signal.index + 5];
    if (fifth?.confirmed && signalConfirmationTime(fifth.time, engine.plan.symbol, engine.plan.period) < engine.end) {
      signal.nextFiveReturn = (fifth.close / next.open - 1) * 100;
    }
  }
}

/**
 * 对已排序样本使用线性插值计算分位数。
 * @param sorted 已升序排列的非空数列。
 * @param fraction 0 到 1 的分位点。
 * @returns 对应分位值。
 */
function quantile(sorted: number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

/**
 * 汇总实际持仓期间的价格路径，不补齐缺少或离场之后的样本。
 * @param samples 每笔交易的相对开盘路径。
 * @returns 按 offset 递增的均值与四分位统计。
 */
function summarizePaths(samples: number[][]): PathPoint[] {
  const offsets: number[][] = [];
  for (const sample of samples) sample.forEach((value, offset) => (offsets[offset] ??= []).push(value));
  return offsets.map((values, offset) => {
    values.sort((left, right) => left - right);
    return { offset, count: values.length, mean: values.reduce((sum, value) => sum + value, 0) / values.length,
      median: quantile(values, 0.5), p25: quantile(values, 0.25), p75: quantile(values, 0.75) };
  });
}

/**
 * 从净现金盈亏和权益曲线计算绩效，未平仓收益只体现在市值权益中。
 * @param engine 完成模拟的账户。
 * @returns 填充结果指标和路径，无返回值。
 */
function finish(engine: Engine): void {
  const { result } = engine;
  if (engine.holding) {
    result.openTrade = engine.holding.trade;
    engine.samples.push(engine.holding.path);
    warn(engine, '研究结束仍有未平仓交易，未强制卖出；权益含最后有效价格的持仓市值，未扣除尚未发生的卖出费用。');
  }
  if (engine.pending) warn(engine, '最后已确认信号仍在等待下一根有效且已确认的 K 线开盘，不计作模拟成交。');
  const profits = result.trades.filter((trade) => trade.pnl! > 0).reduce((sum, trade) => sum + trade.pnl!, 0);
  const losses = -result.trades.filter((trade) => trade.pnl! < 0).reduce((sum, trade) => sum + trade.pnl!, 0);
  let peak = engine.initialCapital;
  let drawdown = 0;
  for (const point of result.equity) {
    peak = Math.max(peak, point.value);
    if (peak > 0) drawdown = Math.max(drawdown, (peak - point.value) / peak * 100);
  }
  const last = result.equity.at(-1)?.value ?? engine.initialCapital;
  result.metrics = {
    closedTrades: result.trades.length,
    winRate: result.trades.length ? result.trades.filter((trade) => trade.pnl! > 0).length / result.trades.length * 100 : null,
    totalReturn: engine.initialCapital > 0 ? (last / engine.initialCapital - 1) * 100 : 0,
    maxDrawdown: drawdown, profitFactor: losses > 0 ? profits / losses : null,
    exposurePct: engine.studyBars > 0 ? engine.exposedBars / engine.studyBars * 100 : 0,
  };
  result.paths = summarizePaths(engine.samples);
  annotateSignals(engine);
}

/**
 * 执行只做多、固定数量、无借款的收盘确认研究回测。
 * 风险及规则均在收盘判断、次柱开盘执行，持仓时不再买入、空仓时不卖出。
 * 至少已有 200 根确认柱才允许信号；初始资金使用计划显式保存的现金预算。
 * @param candles 时间严格递增的行情，末尾未确认柱完全不执行也不估值。
 * @param points 复用 calculateIndicators 的等长指标，调用方须使用计划中的配置。
 * @param plan 经边界校验的完整交易计划；有效范围按真实确认及开盘时间闭开判断。
 * @returns 已平仓交易、独立未平仓交易、现金权益、路径及模型警告。
 */
export function runBacktest(candles: Candle[], points: IndicatorPoint[], plan: TradingPlan): BacktestResult {
  validatePlan(plan);
  validateInputs(candles, points);
  const result = emptyResult();
  const start = Date.parse(plan.validFrom) / 1000;
  const end = Date.parse(plan.validUntil) / 1000;
  const first = candles.findIndex((candle, index) => index >= 199 && candle.confirmed &&
    signalConfirmationTime(candle.time, plan.symbol, plan.period) >= start &&
    signalConfirmationTime(candle.time, plan.symbol, plan.period) < end);
  if (first < 0) {
    result.warnings.push('有效研究区间没有达到 200 根已确认柱预热门槛的收盘数据，未产生交易或绩效。');
    return result;
  }
  const capital = plan.initialCapital;
  result.warnings.push(`初始现金预算为 ${capital}（标的计价币种）；固定数量交易，费用及滑点计入现金，不借款。`);
  const engine: Engine = { candles, points, plan, result, start, end, initialCapital: capital, cash: capital,
    holding: null, pending: null, samples: [], studyBars: 0, exposedBars: 0 };
  for (let index = first; index < candles.length; index += 1) {
    const candle = candles[index];
    if (!candle.confirmed) break;
    const openTime = barOpenTime(candle.time, plan.symbol, plan.period);
    const closeTime = signalConfirmationTime(candle.time, plan.symbol, plan.period);
    if (openTime >= end) break;
    executePending(engine, index, openTime);
    if (closeTime >= end) {
      // 只可使用边界前已知的开盘价，禁止用边界后的高低收盘估值。
      if (openTime >= start) {
        markEquity(engine, openTime, candle.open);
        if (engine.holding) {
          const trade = engine.holding.trade;
          const change = (candle.open / trade.entryPrice - 1) * 100;
          trade.maePct = Math.min(trade.maePct, change);
          trade.mfePct = Math.max(trade.mfePct, change);
        }
      }
      warn(engine, '计划有效期在本柱内结束，仅处理有效期内开盘；未使用期末之后的收盘、高低价或强制平仓。');
      break;
    }
    engine.studyBars += 1;
    if (engine.holding) engine.exposedBars += 1;
    processClose(engine, index);
    markEquity(engine, closeTime, candle.close);
  }
  finish(engine);
  return result;
}
