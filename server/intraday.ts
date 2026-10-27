import { cli, normalizeSymbol, rows, timestamp } from './longbridge.js';
import { nativeSession } from './native-feed.js';
import { exchangeParts, validateIntradaySelection } from '../shared/intraday.js';
import type { IntradayData, IntradayPoint, IntradaySession } from '../shared/intraday.js';

type PointSession = IntradayPoint['session'];
/** 原生分时只读参数，历史日期使用交易所YYYYMMDD。 */
type IntradayPayload = { symbol: string; session: IntradaySession; date?: string };
/** 可注入原生请求、旧CLI请求与时钟；仅显式cliFallback时才使用CLI回退。 */
export interface IntradayOptions {
  request?: typeof cli;
  nativeRequest?: (payload: IntradayPayload) => Promise<unknown>;
  cliFallback?: boolean;
  now?: Date;
}

/** 解析非负数，参数为外部值和字段名，返回有限数字或抛出明确结构错误。 */
function numeric(value: unknown, field: string): number {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean'
    || !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error(`Longbridge 分时字段 ${field} 无效。`);
  return Number(value);
}

/** 优先解析官方时段枚举字符串，参数为外部 trade_session，返回已识别时段或 null。 */
function explicitSession(value: unknown): PointSession | null {
  const label = String(value ?? '').replace(/[^a-z]/gi, '').toLowerCase();
  if (['intraday', 'regular', 'normal', 'normaltrade', 'regulartrade'].includes(label)) return 'regular';
  if (['pre', 'pretrade', 'premarket', 'premarkettrade'].includes(label)) return 'pre';
  if (['post', 'posttrade', 'postmarket', 'postmarkettrade'].includes(label)) return 'post';
  if (['overnight', 'overnighttrade', 'night', 'nighttrade'].includes(label)) return 'overnight';
  return null;
}

/** 缺少时段枚举时按交易所本地时钟推断，参数为原始时间和代码，返回时段或休市 null。 */
function clockSession(time: number, symbol: string): PointSession | null {
  const local = exchangeParts(time, symbol);
  const minute = local.hour * 60 + local.minute;
  if (symbol.endsWith('.HK')) {
    return (minute >= 570 && minute < 720) || (minute >= 780 && minute <= 970) ? 'regular' : null;
  }
  if (minute < 240 || minute >= 1200) return 'overnight';
  if (minute < 570) return 'pre';
  if (minute < 960) return 'regular';
  return 'post';
}

/** 将真实分时响应标准化，参数为 CLI 响应和代码，返回保留原时间且排序去重的独立分时点。 */
export function normalizeIntraday(value: unknown, symbol: string): IntradayPoint[] {
  const normalizedSymbol = normalizeSymbol(symbol);
  const points: IntradayPoint[] = [];
  for (const record of rows(value, ['timeshares', 'lines', 'intraday'])) {
    const time = timestamp(record.timestamp ?? record.time);
    const session = explicitSession(record.trade_session ?? record.tradeSession) ?? clockSession(time, normalizedSymbol);
    if (!session || (normalizedSymbol.endsWith('.HK') && session !== 'regular')) continue;
    const price = numeric(record.price, 'price');
    if (price <= 0) throw new Error('Longbridge 分时价格必须大于零。');
    const averageValue = record.avg_price ?? record.average_price;
    const averagePrice = averageValue === undefined || averageValue === null || averageValue === ''
      ? null : numeric(averageValue, 'avg_price');
    points.push({ time, price, volume: numeric(record.volume, 'volume'),
      averagePrice: averagePrice === 0 ? null : averagePrice, session });
  }
  return [...new Map(points.map((point) => [point.time, point])).values()].sort((left, right) => left.time - right.time);
}

/** 根据交易所当天生成最多十二个倒序日期，参数为时钟和代码，返回 YYYYMMDD 日期列表。 */
function candidateDates(now: Date, symbol: string): string[] {
  const local = exchangeParts(now.getTime() / 1000, symbol);
  const midnight = Date.UTC(local.year, local.month - 1, local.day);
  return Array.from({ length: 12 }, (_, offset) => new Date(midnight - offset * 86400000)
    .toISOString().slice(0, 10).replaceAll('-', ''));
}

/** 执行单日期分时。参数：payload代码时段日期、options请求配置；返回：真实原始响应。 */
async function requestIntraday(payload: IntradayPayload, options: IntradayOptions): Promise<unknown> {
  const cliRequest = (): Promise<unknown> => {
    const args = ['intraday', payload.symbol, '--session', 'all'];
    if (payload.date) args.push('--date', payload.date);
    return (options.request ?? cli)(args, payload.date ? 60_000 : 10_000);
  };
  if (options.request) return cliRequest();
  try { return await (options.nativeRequest ?? nativeSession.intradayCall.bind(nativeSession))(payload); }
  catch {
    if (options.cliFallback) return cliRequest();
    throw new Error('桌面原生分时读取失败，请检查桌面安装、网络、登录及行情权限。');
  }
}

/**
 * 查询最近有指定时段数据的一日或五日分时；最多十二次、并发最多二，空夜盘绝不替代常规数据。
 * @param symbol 港美证券代码。
 * @param session 独立分时时段。
 * @param days 需要的非空交易日数。
 * @param options 可选测试时钟及只读请求器。
 * @returns 标准分时响应；数据不足、权限或历史不可用以明确 warning 呈现。
 */
async function collectIntraday(symbol: string, session: IntradaySession, days: 1 | 5,
  options: IntradayOptions = {}): Promise<IntradayData> {
  symbol = normalizeSymbol(symbol);
  validateIntradaySelection(session, days);
  const now = options.now ?? new Date();
  const response: IntradayData = { source: 'longbridge', symbol, session, days, points: [],
    fetchedAt: now.toISOString(), warnings: [] };
  if (symbol.endsWith('.HK') && !['all', 'regular'].includes(session)) {
    response.warnings.push('港股不提供此盘前、盘后或夜盘分时；未使用常规时段替代。');
    return response;
  }
  const dates = candidateDates(now, symbol);
  const collected = new Map<number, IntradayPoint>();
  let available = 0;
  let failed = 0;
  for (let offset = 0; offset < dates.length && available < days; offset += 2) {
    const batch = await Promise.allSettled(dates.slice(offset, offset + 2).map(async (date) => {
      // 当前入口允许返回最近完整时段，历史严格按交易所日期查询。
      const value = await requestIntraday({ symbol, session, ...(date === dates[0] ? {} : { date }) }, options);
      return normalizeIntraday(value, symbol).filter((point) => session === 'all' || point.session === session);
    }));
    // 即使较早日期先完成，也必须按候选日期顺序挑选最近交易日。
    for (const result of batch) {
      if (result.status === 'rejected') { failed += 1; continue; }
      if (available >= days) continue;
      const unique = result.value.filter((point) => !collected.has(point.time));
      if (!unique.length) continue;
      available += 1;
      for (const point of unique) collected.set(point.time, point);
    }
    // 原生连接不可用时停止整轮回溯，保留已读数据，不再重复触发安装或登录失败。
    if (!options.request && batch.every((result) => result.status === 'rejected')) break;
  }
  response.points = [...collected.values()].sort((left, right) => left.time - right.time);
  if (failed) response.warnings.push(`${failed} 个日期分时读取或解析失败，请检查${options.request ? 'CLI登录' : '桌面原生引擎、网络、登录'}、行情权限或历史分时可用性。`);
  if (available < days) response.warnings.push(`最近 12 个交易所自然日仅找到 ${available}/${days} 个非空交易日（${session}）；未使用其他时段替代。`);
  if (session === 'overnight' && !response.points.length) response.warnings.push('没有可用的真实夜盘分时，证券、账户权限或该日期可能不支持夜盘。');
  console.info(`[longbridge] intraday 读取完成：${available} 日，${response.points.length} 点，${failed} 次失败`);
  return response;
}

/** 保持完整一日或五日查询的原生会话代。参数：代码、时段、天数、可选测试配置；返回：完整分时响应。 */
export async function liveIntraday(symbol: string, session: IntradaySession, days: 1 | 5,
  options: IntradayOptions = {}): Promise<IntradayData> {
  symbol = normalizeSymbol(symbol);
  validateIntradaySelection(session, days);
  const read = (): Promise<IntradayData> => collectIntraday(symbol, session, days, options);
  if (options.request || options.nativeRequest) return read();
  return nativeSession.withCandleSession(read);
}
