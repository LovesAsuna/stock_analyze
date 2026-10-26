import type { MarketData, Period, SourceMode, Workspace } from '../shared/types';
import type { FundamentalData } from '../shared/fundamentals';
import type { EventData, EventScope } from '../shared/events';

/** 读取本地只读接口。参数为路径、查询参数和取消信号，返回经过 HTTP 状态检查的 JSON。 */
async function request<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${path}?${new URLSearchParams(params)}`, { signal });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? `数据读取失败（HTTP ${response.status}）。`);
  return payload as T;
}

/** 查询指定数据源的自选及持仓，取消信号用于避免切换时展示旧账户数据。 */
export function fetchWorkspace(source: SourceMode, signal?: AbortSignal): Promise<Workspace> {
  return request('/api/workspace', { source }, signal);
}

/** 读取独立全局或证券事件；参数：来源、范围、代码、取消信号；返回：标准事件快照。 */
export function fetchEvents(source: SourceMode, scope: EventScope, symbol?: string, signal?: AbortSignal): Promise<EventData> {
  return request('/api/events', { source, scope, ...(scope === 'security' && symbol ? { symbol } : {}) }, signal);
}

/** 获取当前证券独立基本面快照；参数：来源、代码和取消信号；返回：标准化财务及同行数据。 */
export function fetchFundamentals(source: SourceMode, symbol: string, signal?: AbortSignal): Promise<FundamentalData> {
  return request('/api/fundamentals', { source, symbol }, signal);
}

/** 获取行情与选定中国时间区间内的成交，返回统一市场数据对象。 */
export function fetchMarket(source: SourceMode, symbol: string, period: Period, start: string, end: string, signal?: AbortSignal): Promise<MarketData> {
  return request('/api/market', { source, symbol, period, start, end }, signal);
}
