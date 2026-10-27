import { exchangeParts, type IntradayPoint, type IntradaySession } from './intraday.js';

/** 校验分时流的完整分钟点，拒绝错误上下文或无效数值。参数：外部事件、证券、时段；返回：排序原始点。 */
export function parseIntradayUpdate(value: unknown, symbol: string, session: IntradaySession): { points: IntradayPoint[]; receivedAt: string } {
  const event = value as { type?: string; symbol?: string; session?: string; points?: IntradayPoint[]; receivedAt?: string };
  if (!event || event.type !== 'points' || event.symbol !== symbol || event.session !== session || !Array.isArray(event.points) || event.points.length > 6000 ||
    typeof event.receivedAt !== 'string' || !Number.isFinite(Date.parse(event.receivedAt))) throw new Error('分时推送上下文无效');
  let previous = 0;
  for (const point of event.points) {
    if (!point || !Number.isSafeInteger(point.time) || point.time <= previous || !Number.isFinite(point.price) || point.price <= 0 ||
      !Number.isFinite(point.volume) || point.volume < 0 || (point.averagePrice !== null && (!Number.isFinite(point.averagePrice) || point.averagePrice <= 0)) ||
      !['regular', 'pre', 'post', 'overnight'].includes(point.session) || (session !== 'all' && point.session !== session) ||
      (symbol.endsWith('.HK') && point.session !== 'regular')) throw new Error('分时推送点无效');
    previous = point.time;
  }
  return { points: event.points, receivedAt: event.receivedAt };
}

/** 合并当前快照与历史基线，保留真实交易日并限制一日或五日窗口。参数：历史、当前点、证券、天数；返回：去重有序点。 */
export function mergeIntradayUpdate(history: IntradayPoint[], update: IntradayPoint[], symbol: string, days: 1 | 5): IntradayPoint[] {
  if (!update.length) return history;
  const latest = new Map(history.map(point => [point.time, point]));
  for (const point of update) latest.set(point.time, point);
  const points = [...latest.values()].sort((left, right) => left.time - right.time);
  /** 夜盘20:00之后属于下一个交易日，避免把一条夜盘拆成两天。参数：分钟点；返回：交易日标识。 */
  const dayOf = (point: IntradayPoint): string => {
    const parts = exchangeParts(point.time, symbol);
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + (point.session === 'overnight' && parts.hour >= 20 ? 1 : 0)));
    return date.toISOString().slice(0, 10);
  };
  const dates = [...new Set(points.map(dayOf))].sort().slice(-days);
  return points.filter(point => dates.includes(dayOf(point)));
}
