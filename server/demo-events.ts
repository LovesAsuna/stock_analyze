import type { EventData, EventScope, MarketEvent } from '../shared/events.js';
import { normalizeSymbol } from './longbridge.js';

/**
 * 构造与真实新闻明确区分的演示事件，不冒充市场已发生或确定计划。
 * @param scope 全局或当前证券范围。
 * @param symbol 个股代码，全局忽略。
 * @returns 固定演示窗口和具名合成事件。
 */
export function demoEvents(scope: EventScope, symbol?: string): EventData {
  const security = scope === 'security' ? normalizeSymbol(symbol) : null;
  const base = { source: '合成演示', url: null, publishedAt: null, scheduledAt: null,
    dateOnly: false, summary: '仅用于展示交互与信息结构，不对应真实事件。', symbol: security };
  const events: MarketEvent[] = scope === 'global' ? [
    { ...base, id: 'demo-macro', title: '演示：央行政策会议日历', kind: 'macro', scheduledAt: '2026-10-28T18:00:00Z' },
    { ...base, id: 'demo-policy-news', title: '演示：宏观政策与通胀动态', kind: 'news', publishedAt: '2026-10-24T03:00:00Z' },
    { ...base, id: 'demo-geopolitics', title: '演示：地缘与能源市场新闻', kind: 'news', publishedAt: '2026-10-23T15:00:00Z' },
  ] : [
    { ...base, id: 'demo-earnings', title: `演示：${security} 季度业绩披露`, kind: 'earnings', scheduledAt: '2026-10-29', dateOnly: true,
      summary: '演示：交易所当地日期，盘后；没有准确时刻。' },
    { ...base, id: 'demo-filing', title: `演示：${security} 公司披露公告`, kind: 'filing', publishedAt: '2026-10-24T01:00:00Z' },
    { ...base, id: 'demo-security-news', title: `演示：${security} 业务与行业新闻`, kind: 'news', publishedAt: '2026-10-23T20:00:00Z' },
  ];
  return { source: 'demo', scope, symbol: security, fetchedAt: '2026-10-24T06:00:00Z',
    window: { start: '2026-10-17', end: '2026-11-23' }, events,
    warnings: ['全部内容为合成演示，不代表真实会议、财报日期、公司公告或财经新闻。'] };
}
