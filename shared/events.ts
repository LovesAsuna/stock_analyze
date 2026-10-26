import type { SourceMode } from './types';

export type EventScope = 'global' | 'security';
export type EventKind = 'macro' | 'earnings' | 'filing' | 'news';

/** 新闻发布时间与计划发生时间分别存储，不能从标题猜测财报日期。 */
export interface MarketEvent {
  id: string;
  title: string;
  kind: EventKind;
  source: string;
  url: string | null;
  publishedAt: string | null;
  scheduledAt: string | null;
  /** 仅有日期的日历不伪造时刻或时区。 */
  dateOnly: boolean;
  summary: string | null;
  symbol: string | null;
}

/** 各上游独立失败时保留已读结果及提示，不假称新闻列表就是完整日历。 */
export interface EventData {
  source: SourceMode;
  scope: EventScope;
  symbol: string | null;
  fetchedAt: string;
  window: { start: string; end: string };
  events: MarketEvent[];
  warnings: string[];
}

/** 安全解析外链。参数：上游URL；返回：仅HTTP(S)链接或null，拒绝脚本及带凭据地址。 */
export function eventLink(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
