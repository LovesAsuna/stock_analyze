import type { Candle, IndicatorConfig, IndicatorPoint, Period, SourceMode } from './types';
import { validateConfig } from './indicators';
import { isPeriod } from './periods';

/** 可用于计划条件的行情与指标字段；数值缺失时条件为未知。 */
export type Metric = 'close' | 'fastMA' | 'slowMA' | 'histogram' | 'rsi' | 'adx' | 'plusDI' | 'minusDI' | 'sar' | 'volumeRatio';
/** 单条比较规则，交叉要求上一柱和当前柱的两侧数值均有效。 */
export type Condition = {
  id: string; left: Metric; operator: 'gt' | 'lt' | 'crossUp' | 'crossDown'; right: Metric | 'constant'; value: number;
};
/** 非空条件组，all 为全部满足，any 为至少一条满足。 */
export type ConditionGroup = { mode: 'all' | 'any'; conditions: Condition[] };
/** 可序列化的单证券、只做多交易计划，百分数字段使用百分比而非小数。 */
export type TradingPlan = {
  schemaVersion: 1; id: string; revision: number; name: string; symbol: string; source: SourceMode; period: Period;
  createdAt: string; updatedAt: string; validFrom: string; validUntil: string;
  entry: ConditionGroup; exit: ConditionGroup; indicatorConfig: IndicatorConfig;
  entryPrice: number | null; stopPrice: number | null; targetPrice: number | null;
  stopLossPct: number; takeProfitPct: number; trailingStopPct: number; maxHoldingBars: number;
  quantity: number; feeBps: number; slippageBps: number;
  /** 初始现金预算，单位为标的计价币种，必须显式保存。 */
  initialCapital: number;
};
/** 逐条保留未知状态，便于展示缺少指标的原因。 */
export type GroupEvaluation = {
  matched: boolean; reasons: string[]; checks: { label: string; matched: boolean; available: boolean }[];
};

const METRIC_LABELS: Record<Metric, string> = {
  close: '收盘价', fastMA: '快速均线', slowMA: '慢速均线', histogram: 'MACD 柱', rsi: 'RSI',
  adx: 'ADX', plusDI: '+DI', minusDI: '-DI', sar: 'SAR', volumeRatio: '量比',
};
const OPERATORS = { gt: '大于', lt: '小于', crossUp: '上穿', crossDown: '下穿' } as const;

/**
 * 拒绝数组、空值及原始值，确保边界校验不会隐式转换输入。
 * @param value 待校验值。
 * @param label 中文字段说明。
 * @returns 验证通过后缩窄为对象，否则抛出中文错误。
 */
function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象`);
}

/**
 * 校验带显式时区的 ISO 时间，拒绝日期自动进位和本机时区解释。
 * @param value 外部时间字段。
 * @param label 中文字段名。
 * @returns UTC 毫秒。
 */
function isoTime(value: unknown, label: string): number {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`${label}必须是带明确时区的 ISO 时间`);
  }
  const parsed = Date.parse(value);
  const date = value.slice(0, 10);
  const day = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed) || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== date ||
      Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) {
    throw new Error(`${label}日期或时间无效`);
  }
  return parsed;
}

/**
 * 检查有限数及取值下界，不接受字符串数字。
 * @param value 待验证值。
 * @param label 字段说明。
 * @param minimum 最小值，包含边界。
 * @returns 验证通过无返回值。
 */
function assertNumber(value: unknown, label: string, minimum = 0): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new Error(`${label}必须是不小于 ${minimum} 的有限数`);
  }
}

/**
 * 校验条件组和每个规则，防止空 all 组合被当作无条件入场。
 * @param value 待验证的组。
 * @param label 入场或离场说明。
 * @returns 验证成功无返回值。
 */
function validateGroup(value: unknown, label: string): void {
  assertObject(value, label);
  if (value.mode !== 'all' && value.mode !== 'any') throw new Error(`${label}组合方式必须是 all 或 any`);
  if (!Array.isArray(value.conditions) || value.conditions.length === 0 || value.conditions.length > 100) {
    throw new Error(`${label}必须包含 1 至 100 条规则`);
  }
  const ids = new Set<string>();
  for (const condition of value.conditions) {
    assertObject(condition, `${label}规则`);
    if (typeof condition.id !== 'string' || !condition.id.trim() || ids.has(condition.id)) {
      throw new Error(`${label}规则 ID 必须非空且唯一`);
    }
    ids.add(condition.id);
    if (typeof condition.left !== 'string' || !Object.hasOwn(METRIC_LABELS, condition.left) ||
        typeof condition.right !== 'string' ||
        (condition.right !== 'constant' && !Object.hasOwn(METRIC_LABELS, condition.right))) {
      throw new Error(`${label}包含不支持的指标`);
    }
    if (typeof condition.operator !== 'string' || !Object.hasOwn(OPERATORS, condition.operator)) {
      throw new Error(`${label}包含不支持的比较方式`);
    }
    if (typeof condition.value !== 'number' || !Number.isFinite(condition.value)) throw new Error(`${label}规则常数必须是有限数`);
  }
}

/**
 * 在系统边界校验完整计划，不校验固定风险价与观察价的相对关系。
 * @param value JSON 或其他外部来源的未知值。
 * @returns 验证通过后断言为 TradingPlan；无效时抛出中文错误。
 */
export function validatePlan(value: unknown): asserts value is TradingPlan {
  assertObject(value, '交易计划');
  if (value.schemaVersion !== 1) throw new Error('交易计划版本必须是 1');
  for (const field of ['id', 'name', 'symbol'] as const) {
    if (typeof value[field] !== 'string' || !value[field].trim() || value[field].length > 200) {
      throw new Error(`计划 ${field} 必须是 1 至 200 字符的非空文本`);
    }
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) throw new Error('计划修订号必须是正整数');
  if (value.source !== 'demo' && value.source !== 'longbridge') throw new Error('计划数据源无效');
  if (!isPeriod(value.period)) throw new Error('计划周期无效');
  const created = isoTime(value.createdAt, '创建时间');
  const updated = isoTime(value.updatedAt, '更新时间');
  if (updated < created) throw new Error('更新时间不能早于创建时间');
  if (isoTime(value.validFrom, '生效时间') >= isoTime(value.validUntil, '失效时间')) throw new Error('生效时间必须早于失效时间');
  validateGroup(value.entry, '入场');
  validateGroup(value.exit, '离场');
  assertObject(value.indicatorConfig, '指标配置');
  validateConfig(value.indicatorConfig as unknown as IndicatorConfig);
  for (const field of ['entryPrice', 'stopPrice', 'targetPrice'] as const) {
    if (value[field] !== null) {
      assertNumber(value[field], field);
      if (value[field] === 0) throw new Error(`${field}必须大于 0 或为 null`);
    }
  }
  for (const field of ['stopLossPct', 'takeProfitPct', 'trailingStopPct', 'feeBps', 'slippageBps'] as const) {
    assertNumber(value[field], field);
  }
  if ((value.stopLossPct as number) >= 100 || (value.trailingStopPct as number) >= 100) throw new Error('止损及追踪止损百分比必须小于 100');
  if ((value.feeBps as number) >= 10000 || (value.slippageBps as number) >= 10000) throw new Error('单边费率及滑点必须小于 10000 bps');
  if (!Number.isSafeInteger(value.maxHoldingBars) || (value.maxHoldingBars as number) < 0) {
    throw new Error('最长持仓柱数必须是非负整数，0 表示禁用');
  }
  if (!Number.isSafeInteger(value.quantity) || (value.quantity as number) <= 0) throw new Error('交易数量必须是正整数');
  assertNumber(value.initialCapital, '初始资金');
  if (value.initialCapital <= 0 || value.initialCapital > 1e12) throw new Error('初始资金必须大于 0 且不超过一万亿');
}

/**
 * 创建用于已加载历史研究的宽松趋势模板，监控启用时间由调用方另行管理。
 * @param symbol 证券代码。
 * @param source 数据源。
 * @param period 行情周期。
 * @param config 已有指标配置，将复制以免联动修改。
 * @returns 采用固定数量和单边费用的独立计划。
 */
export function createDefaultPlan(symbol: string, source: SourceMode, period: Period, config: IndicatorConfig): TradingPlan {
  const now = new Date().toISOString();
  const plan: TradingPlan = {
    schemaVersion: 1, id: `plan-${globalThis.crypto.randomUUID()}`, revision: 1, name: '趋势研究计划',
    symbol, source, period, createdAt: now, updatedAt: now,
    validFrom: '2000-01-01T00:00:00Z', validUntil: '2100-01-01T00:00:00Z',
    entry: { mode: 'all', conditions: [
      { id: 'entry-trend', left: 'fastMA', operator: 'gt', right: 'slowMA', value: 0 },
      { id: 'entry-momentum', left: 'histogram', operator: 'gt', right: 'constant', value: 0 },
    ] },
    exit: { mode: 'all', conditions: [{ id: 'exit-trend', left: 'close', operator: 'lt', right: 'slowMA', value: 0 }] },
    indicatorConfig: { ...config }, entryPrice: null, stopPrice: null, targetPrice: null,
    stopLossPct: 3, takeProfitPct: 6, trailingStopPct: 0, maxHoldingBars: 20,
    quantity: 100, feeBps: 10, slippageBps: 5, initialCapital: 100000,
  };
  validatePlan(plan);
  return plan;
}

/**
 * 将规则转为不包含未来信息的中文标签。
 * @param condition 已校验的单条规则。
 * @returns 例如“快速均线 上穿 慢速均线”。
 */
export function conditionLabel(condition: Condition): string {
  return `${METRIC_LABELS[condition.left]} ${OPERATORS[condition.operator]} ${
    condition.right === 'constant' ? condition.value : METRIC_LABELS[condition.right]}`;
}

/**
 * 读取指定柱的已确认指标，缺失、错位或无效值均为未知。
 * @param metric 需要读取的指标。
 * @param candles 完整行情。
 * @param points 对应指标。
 * @param index 当前或前一柱索引。
 * @returns 有限数或 null，不读取索引之后的数据。
 */
function metricValue(metric: Metric, candles: Candle[], points: IndicatorPoint[], index: number): number | null {
  const candle = candles[index];
  const point = points[index];
  if (!candle?.confirmed || !point || point.time !== candle.time) return null;
  const value = metric === 'close' ? candle.close : point[metric];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 仅依据当前及上一根已确认柱评估条件组；null 不参与数字比较。
 * @param group 已校验的非空规则组。
 * @param candles 行情序列。
 * @param points 同时间指标序列。
 * @param index 当前收盘位置。
 * @returns 组结果、证据文本和带 available 的逐条检查。
 */
export function evaluateGroup(group: ConditionGroup, candles: Candle[], points: IndicatorPoint[], index: number): GroupEvaluation {
  const checks = group.conditions.map((condition) => {
    const label = conditionLabel(condition);
    const left = metricValue(condition.left, candles, points, index);
    const right = condition.right === 'constant' ? condition.value : metricValue(condition.right, candles, points, index);
    const crossing = condition.operator === 'crossUp' || condition.operator === 'crossDown';
    const previousLeft = crossing ? metricValue(condition.left, candles, points, index - 1) : left;
    const previousRight = crossing && condition.right !== 'constant'
      ? metricValue(condition.right, candles, points, index - 1) : right;
    const available = [left, right, previousLeft, previousRight].every((value) => value !== null && Number.isFinite(value));
    let matched = false;
    if (available) {
      if (condition.operator === 'gt') matched = left! > right!;
      else if (condition.operator === 'lt') matched = left! < right!;
      else if (condition.operator === 'crossUp') matched = previousLeft! <= previousRight! && left! > right!;
      else matched = previousLeft! >= previousRight! && left! < right!;
    }
    return { label, matched, available };
  });
  const matched = checks.length > 0 && (group.mode === 'all' ? checks.every((check) => check.matched)
    : checks.some((check) => check.matched));
  return { matched, checks, reasons: checks.map((check) => `${check.label}：${
    !check.available ? '未知（缺少已确认指标）' : check.matched ? '满足' : '不满足'}`) };
}
