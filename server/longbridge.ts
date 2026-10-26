import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { signalConfirmationTime } from '../shared/review.js';
import { exchangeParts } from '../shared/intraday.js';
import { isCalendarPeriod, periodSeconds } from '../shared/periods.js';
import type { Candle, Execution, MarketData, Period, Position, Security, Workspace } from '../shared/types.js';

const executeFile = promisify(execFile);
type Row = Record<string, unknown>;
const cache = new Map<string, { until: number; value: unknown }>();
const pending = new Map<string, Promise<unknown>>();

/** 将未知值转换成对象，参数为外部响应，返回可安全访问的字段集合。 */
function object(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

/** 解包 Longbridge 的数组或嵌套集合，无法识别结构时抛出错误而非返回空账户。 */
export function rows(value: unknown, keys: string[] = []): Row[] {
  if (Array.isArray(value)) return value.map(object);
  const record = object(value);
  for (const key of [...keys, 'data', 'list', 'items', 'result']) {
    if (record[key] !== undefined) return rows(record[key], keys.filter((candidate) => candidate !== key));
  }
  throw new Error('Longbridge 返回了无法识别的数据结构，请核对 CLI 版本与响应字段。');
}

/** 严格解析必需数字；缺失、空字符串和非有限值均报错。 */
function number(value: unknown, field: string): number {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) {
    throw new Error(`Longbridge 字段 ${field} 缺失或不是有效数字。`);
  }
  return Number(value);
}

/** 规范化港股前导零和市场后缀，返回只允许港美股的证券代码。 */
export function normalizeSymbol(value: unknown): string {
  let symbol = String(value ?? '').trim().toUpperCase();
  if (/^\d+\.HK$/.test(symbol)) symbol = `${Number(symbol.split('.')[0])}.HK`;
  if (!/^(?:[A-Z][A-Z0-9.-]{0,35}\.US|\d{1,5}\.HK)$/.test(symbol)) throw new Error('证券代码格式应为 NVDA.US 或 700.HK，仅支持港股和美股。');
  return symbol;
}

/** 解析带时区的日期或 Unix 秒/毫秒，拒绝没有时区的歧义时间。 */
export function timestamp(value: unknown): number {
  const numeric = Number(value);
  if (value !== '' && value !== null && value !== undefined && Number.isFinite(numeric) && numeric > 0) {
    return Math.floor(numeric > 1e12 ? numeric / 1000 : numeric);
  }
  const text = String(value ?? '');
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) throw new Error('行情或成交时间缺少时区，无法可靠地归属交易日。');
  const result = Date.parse(text) / 1000;
  if (!Number.isFinite(result)) throw new Error('Longbridge 返回了无效时间。');
  return result;
}

/** 固定参数以无 shell 子进程调用只读 CLI，缓存及合并并发请求，错误不泄露凭证。 */
export async function cli(args: string[], ttl = 60_000): Promise<unknown> {
  const key = JSON.stringify(args);
  const cached = cache.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  const existing = pending.get(key);
  if (existing) return existing;
  const job = (async () => {
    console.info(`[longbridge] ${args[0]} 开始读取`);
    try {
      const { stdout } = await executeFile('longbridge', [...args, '--format', 'json'], {
        timeout: 45_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: false,
      });
      const value: unknown = JSON.parse(stdout);
      const response = object(value);
      if (response.error || (response.code !== undefined && ![0, '0'].includes(response.code as number))) {
        throw new Error('API_RESPONSE');
      }
      if (cache.size > 120) cache.clear();
      cache.set(key, { until: Date.now() + ttl, value });
      return value;
    } catch (error) {
      const code = object(error).code;
      console.error(`[longbridge] ${args[0]} 读取失败 (${String(code ?? '响应错误')})`);
      throw new Error(`Longbridge ${args[0]} 读取失败。请在本机运行 longbridge check 检查登录和行情权限，重试或查看服务端日志。`);
    }
  })();
  pending.set(key, job);
  try { return await job; } finally { pending.delete(key); }
}

/** 读取持仓及自选；返回各字段的完整性，部分接口失败会保留明确警告。 */
export async function liveWorkspace(): Promise<Workspace> {
  const [positionResult, watchResult] = await Promise.allSettled([cli(['positions']), cli(['watchlist'])]);
  const warnings: string[] = [];
  const securities = new Map<string, Security>();
  const positions: Position[] = [];
  const addSecurity = (record: Row): string | null => {
    try {
      const symbol = normalizeSymbol(record.symbol);
      const market = symbol.endsWith('.HK') ? 'HK' : 'US';
      securities.set(symbol, { symbol, name: String(record.name ?? record.symbol_name ?? symbol), market, currency: market === 'HK' ? 'HKD' : 'USD' });
      return symbol;
    } catch { return null; } // 自选可以包含本产品尚未支持的非港美市场。
  };
  if (positionResult.status === 'fulfilled') {
    for (const record of rows(positionResult.value, ['stock_list', 'positions', 'channels'])) {
      const records = Array.isArray(record.positions) ? rows(record.positions) : [record];
      for (const position of records) {
        const symbol = addSecurity(position);
        if (!symbol) continue;
        positions.push({ symbol, quantity: number(position.quantity, 'quantity'),
          available: number(position.available_quantity ?? position.available ?? position.quantity, 'available'),
          costPrice: number(position.cost_price, 'cost_price'), currency: String(position.currency ?? (symbol.endsWith('.HK') ? 'HKD' : 'USD')) });
      }
    }
  } else warnings.push(positionResult.reason.message);
  if (watchResult.status === 'fulfilled') {
    for (const group of rows(watchResult.value, ['groups'])) {
      for (const security of rows(group.securities ?? [], [])) addSecurity(security);
    }
  } else warnings.push(watchResult.reason.message);
  if (positionResult.status === 'rejected' && watchResult.status === 'rejected') throw new Error(warnings.join(' '));
  return { source: 'longbridge', fetchedAt: new Date().toISOString(), securities: [...securities.values()], positions,
    warnings, positionsComplete: positionResult.status === 'fulfilled' };
}

/** 读取周期日期，参数为原始 UTC 秒和代码，返回兼容 UTC 午夜标签的交易所年月日。 */
function candleDate(time: number, symbol: string): { year: number; month: number; day: number } {
  const utc = new Date(time * 1000);
  return utc.getUTCHours() === 0 && utc.getUTCMinutes() === 0 && utc.getUTCSeconds() === 0
    ? { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() }
    : exchangeParts(time, symbol);
}

/** 规范化长周期日期标签，参数为原始秒、证券和周期，返回周期首日 UTC 午夜标签。 */
function calendarLabel(time: number, symbol: string, period: Period): number {
  const date = candleDate(time, symbol);
  if (period === 'month' || period === 'quarter') date.day = 1;
  if (period === 'quarter') date.month = Math.floor((date.month - 1) / 3) * 3 + 1;
  if (period === 'year') { date.month = 1; date.day = 1; }
  const midnight = Date.UTC(date.year, date.month - 1, date.day) / 1000;
  return period === 'week' ? midnight - ((new Date(midnight * 1000).getUTCDay() + 6) % 7) * 86400 : midnight;
}

/**
 * 从规范化月线聚合季度；要求首月存在，避免分块、订阅增量缺首月时覆盖完整季度。
 * @param months 已校验月线。
 * @param symbol 港美证券代码。
 * @returns 按季度起始标签排序的 OHLCV；当前季度仅在季度结束后确认。
 */
function quarterlyCandles(months: Candle[], symbol: string): Candle[] {
  const groups = new Map<number, Candle[]>();
  for (const candle of months) {
    const label = calendarLabel(candle.time, symbol, 'quarter');
    const group = groups.get(label) ?? [];
    group.push(candle);
    groups.set(label, group);
  }
  const result: Candle[] = [];
  for (const [time, group] of groups) {
    const quarterMonth = new Date(time * 1000).getUTCMonth();
    const monthNumbers = group.map((candle) => new Date(candle.time * 1000).getUTCMonth());
    if (monthNumbers[0] !== quarterMonth) continue;
    // 缺失中间月份不能当作完整季度；当前季度允许尚未到来的月份缺席。
    if (monthNumbers.some((month, index) => month !== quarterMonth + index)) continue;
    const ended = (signalConfirmationTime(time, symbol, 'quarter') + 60) * 1000 <= Date.now();
    if (ended && group.length !== 3) continue;
    result.push({ time, open: group[0].open, close: group.at(-1)!.close,
      high: Math.max(...group.map((candle) => candle.high)), low: Math.min(...group.map((candle) => candle.low)),
      volume: group.reduce((sum, candle) => sum + candle.volume, 0),
      confirmed: ended && group.length === 3 && group.every((candle) => candle.confirmed) });
  }
  return result;
}

/** 将外部 OHLCV 规范化，参数为原始响应、证券及周期，返回校验排序去重的柱；quarter 输入必须为月线。 */
export function normalizeCandles(value: unknown, symbol: string, period: Period): Candle[] {
  const inputPeriod = period === 'quarter' ? 'month' : period;
  const candles = rows(value, ['candlesticks']).map((record): Candle => {
    const rawTime = timestamp(record.timestamp ?? record.time);
    const time = isCalendarPeriod(inputPeriod) && inputPeriod !== 'day' ? calendarLabel(rawTime, symbol, inputPeriod) : rawTime;
    const candle = { time, open: number(record.open, 'open'), high: number(record.high, 'high'),
      low: number(record.low, 'low'), close: number(record.close, 'close'), volume: number(record.volume, 'volume'), confirmed: false };
    if (candle.low <= 0 || candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close) || candle.volume < 0) {
      throw new Error('Longbridge K 线价格或成交量结构无效。');
    }
    // 日线以交易所当地标准收盘确认，兼容 UTC 午夜的日期标签；留 60 秒同步缓冲。
    candle.confirmed = (signalConfirmationTime(time, symbol, inputPeriod) + 60) * 1000 <= Date.now();
    return candle;
  });
  const sorted = [...new Map(candles.map((candle) => [candle.time, candle])).values()].sort((left, right) => left.time - right.time);
  return period === 'quarter' ? quarterlyCandles(sorted, symbol) : sorted;
}

/** 成交方向必须有明确来源；无法解析的记录不能被猜测为买入或卖出。 */
export function normalizeExecutions(value: unknown, symbol: string): Execution[] {
  return rows(value, ['trades', 'executions']).map((record): Execution => {
    const sideText = String(record.side ?? record.trade_direction ?? record.direction ?? '').toLowerCase();
    const side = sideText === 'buy' ? 'buy' : sideText === 'sell' ? 'sell' : null;
    if (!side) throw new Error('历史成交缺少明确买卖方向，需要补充订单详情后才能判断执行情况。');
    return { id: String(record.trade_id ?? record.id ?? `${record.order_id}-${record.trade_done_at}`),
      symbol: normalizeSymbol(record.symbol ?? symbol), side,
      price: number(record.price, 'price'), quantity: number(record.quantity, 'quantity'),
      time: timestamp(record.trade_done_at ?? record.time ?? record.executed_at) };
  }).filter((execution) => execution.symbol === symbol);
}

const DAY_MS = 86400000;
/** 每块自然日上限保证低于1000柱；预热和允许复盘跨度均为有限自然日。 */
const HISTORY_LIMITS: Record<Period, { chunk: number; warmup: number; range: number }> = {
  '1m': { chunk: 2, warmup: 7, range: 30 }, '5m': { chunk: 7, warmup: 7, range: 90 },
  '15m': { chunk: 28, warmup: 16, range: 180 }, '30m': { chunk: 60, warmup: 32, range: 365 },
  '1h': { chunk: 120, warmup: 65, range: 730 }, day: { chunk: 900, warmup: 900, range: 7300 },
  week: { chunk: 3650, warmup: 2200, range: 14600 }, month: { chunk: 7300, warmup: 7300, range: 14600 },
  quarter: { chunk: 7300, warmup: 10950, range: 14600 }, year: { chunk: 36500, warmup: 14600, range: 14600 },
};

/** 严格验证查询日期，参数为 YYYY-MM-DD 字符串，返回 UTC 午夜毫秒，非法输入抛错。 */
function historyDate(value: string): number {
  const result = Date.parse(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(result)
    || new Date(result).toISOString().slice(0, 10) !== value) throw new Error('行情查询日期必须是有效的 YYYY-MM-DD。');
  return result;
}

/**
 * 计算覆盖复盘区间及指标预热的有限历史窗口，季度额外对齐首月，长周期无需伪造200年。
 * @param period 已支持周期。
 * @param start 中国复盘起始日期。
 * @param end 中国复盘终止日期。
 * @param now 当前绝对时间毫秒，默认系统时钟。
 * @returns CLI 包含首尾日期窗口，过大或未来区间抛出明确错误。
 */
export function marketHistoryWindow(period: Period, start: string, end: string, now = Date.now()): { start: string; end: string } {
  const limits = HISTORY_LIMITS[period];
  if (!limits || (!isCalendarPeriod(period) && periodSeconds(period) === null)) throw new Error('不支持的 K 线周期。');
  const first = historyDate(start);
  const last = historyDate(end);
  if (first >= last) throw new Error('复盘起点必须早于终点。');
  if (first > now + DAY_MS) throw new Error('复盘起点不能位于未来。');
  // 图表会接入当前实时订阅，历史基线必须连续到当前；旧分钟复盘若跨度过大需明确拒绝。
  if ((Math.max(now, last) - first) / DAY_MS > limits.range) {
    throw new Error(`${period} 复盘范围过大（含至当前实时行情），最多支持 ${limits.range} 个自然日，请缩短区间或使用更长周期。`);
  }
  const historyFirst = new Date(first - limits.warmup * DAY_MS);
  if (period === 'quarter') {
    historyFirst.setUTCMonth(Math.floor(historyFirst.getUTCMonth() / 3) * 3, 1);
  } else if (period === 'month' || period === 'year') {
    if (period === 'year') historyFirst.setUTCMonth(0);
    historyFirst.setUTCDate(1);
  }
  return { start: historyFirst.toISOString().slice(0, 10), end: new Date(Math.max(now, last)).toISOString().slice(0, 10) };
}

/**
 * 按周期安全分块读取历史，最多48次、并发二；季度先完整合并月线再统一聚合。
 * @param symbol 规范化证券代码。
 * @param period 用户选定周期。
 * @param start 包含首日。
 * @param end 包含尾日。
 * @param request 可注入只读请求器。
 * @returns 合并的原始柱，触及CLI上限立即报错。
 */
export async function candleHistory(symbol: string, period: Period, start: string, end: string, request = cli): Promise<Row[]> {
  const limits = HISTORY_LIMITS[period];
  if (!limits) throw new Error('不支持的 K 线周期。');
  const first = historyDate(start);
  const last = historyDate(end);
  if (first > last) throw new Error('历史查询起点晚于终点。');
  const dates: Array<{ start: string; end: string }> = [];
  for (let cursor = first; cursor <= last; cursor += limits.chunk * DAY_MS) {
    dates.push({ start: new Date(cursor).toISOString().slice(0, 10),
      end: new Date(Math.min(cursor + (limits.chunk - 1) * DAY_MS, last)).toISOString().slice(0, 10) });
    if (dates.length > 48) throw new Error('历史范围需要超过48次查询，请缩短复盘区间。');
  }
  const result: Row[] = [];
  for (let offset = 0; offset < dates.length; offset += 2) {
    const batch = await Promise.all(dates.slice(offset, offset + 2).map(async (range) => {
      const chunk = rows(await request(['kline', 'history', symbol, '--period', period === 'quarter' ? 'month' : period,
        '--start', range.start, '--end', range.end, '--adjust', 'none', '--session', 'intraday']), ['candlesticks']);
      if (chunk.length >= 1000) throw new Error('单个历史分块触及1000根上限，无法保证复盘完整，请缩短查询区间。');
      return chunk;
    }));
    result.push(...batch.flat());
  }
  return result;
}

/** 读取行情及中国时间闭开范围内成交；不支持的历史成交结构显式降级为未知。 */
export async function liveMarket(symbol: string, period: Period, start: string, end: string): Promise<MarketData> {
  symbol = normalizeSymbol(symbol);
  const warnings: string[] = [];
  const history = marketHistoryWindow(period, start, end);
  const [marketResult, executionResult] = await Promise.allSettled([
    candleHistory(symbol, period, history.start, history.end),
    cli(['order', 'executions', '--history', '--symbol', symbol, '--start', `${start}T00:00:00+08:00`, '--end', `${end}T00:00:00+08:00`]),
  ]);
  if (marketResult.status === 'rejected') throw marketResult.reason;
  const candles = normalizeCandles(marketResult.value, symbol, period);
  if (candles.length === 0) throw new Error('Longbridge 未返回 K 线，请检查证券代码与行情权限。');
  let executions: Execution[] = [];
  let executionsComplete = false;
  if (executionResult.status === 'fulfilled') {
    try {
      executions = normalizeExecutions(executionResult.value, symbol).filter((execution) => execution.time >= Date.parse(`${start}T00:00:00+08:00`) / 1000 && execution.time < Date.parse(`${end}T00:00:00+08:00`) / 1000);
      executionsComplete = true;
    } catch (error) { warnings.push((error as Error).message); }
  } else warnings.push(`${executionResult.reason.message} 美国账户的聚合订单不能代替逐笔成交，此处标记执行状态未知。`);
  if (candles.length < 200) warnings.push('历史不足 200 根，指标可供查看，但不生成已确认策略信号。');
  warnings.push('历史不复权 / 常规交易时段；拆股附近指标需人工核查。历史及成交为缓存快照；实时价格由独立订阅更新，图表同步原生常规时段K线，实时性取决于账户权限和连接状态。');
  return { source: 'longbridge', symbol, period, candles, executions, fetchedAt: new Date().toISOString(),
    warnings, executionsComplete, executionRange: { start, end }, adjustment: 'none' };
}
