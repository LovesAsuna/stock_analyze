import { normalizeSymbol } from './longbridge.js';
import { object } from './event-values.js';
import { parsePublicNews } from './public-event-parsers.js';
import { fetchEventText, readEventSource, type EventReader } from './public-events.js';
import { parsePublicSecurity, parseEastmoneyStockNews, parseSinaStockNews, parseWallstreetStockNews, securityNewsQuery } from './security-event-parsers.js';

/** 构造当前证券的四家公开资讯读取器，不混入全局快讯或官方宏观日程。参数：港美股证券、只读fetch；返回：独立失败且按证券缓存的来源。 */
export function securityEventSources(symbol: string, request: typeof fetch = fetch): EventReader[] {
  symbol = normalizeSymbol(symbol);
  const hongKong = symbol.endsWith('.HK'); const code = symbol.slice(0, -3);
  const lookup = hongKong ? code.padStart(5, '0') : code.replace(/[.-]/g, '_');
  // 三家共享本次精确身份查询；实际读取仍由各自缓存和错误状态独立管理。
  let identity: ReturnType<typeof loadIdentity> | undefined;
  /** 读取公开证券身份，不依赖CLI或账户。参数：无；返回：与市场及证券精确匹配的代码和名称。 */
  async function loadIdentity() {
    const body = await fetchEventText(`https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(lookup)}&type=14&count=10`, request);
    return parsePublicSecurity(JSON.parse(body), symbol);
  }
  const getIdentity = () => identity ??= loadIdentity();
  return [
    { label: '新浪财经 个股新闻', read: () => readEventSource(`sina:${symbol}`, async () => {
      const security = await getIdentity();
      const url = hongKong ? `https://stock.finance.sina.com.cn/hkstock/news/${lookup}.html`
        : `https://biz.finance.sina.com.cn/usstock/usstock_news.php?symbol=${encodeURIComponent(code)}`;
      return parseSinaStockNews(await fetchEventText(url, request, 'gb18030'), security);
    }) },
    { label: '华尔街见闻 个股快讯', read: () => readEventSource(`wallstreetcn:${symbol}`, async () => {
      const security = await getIdentity();
      const body = await fetchEventText(`https://api-one.wallstcn.com/apiv1/search/live?query=${encodeURIComponent(securityNewsQuery(security))}&limit=30`, request);
      return parseWallstreetStockNews(JSON.parse(body), security);
    }) },
    { label: '东方财富 个股资讯', read: () => readEventSource(`eastmoney:${symbol}`, async () => {
      const security = await getIdentity();
      const body = await fetchEventText(`https://np-listapi.eastmoney.com/comm/web/getListInfo?cfh=1&client=web&mTypeAndCode=${encodeURIComponent(security.quoteId)}&type=1&pageSize=30&traceId=market-lens`, request);
      return parseEastmoneyStockNews(JSON.parse(body), security);
    }) },
    { label: '雪球 个股新闻', read: () => readEventSource(`xueqiu:${symbol}`, async () => {
      const body = await fetchEventText(`https://xueqiu.com/statuses/stock_timeline.json?symbol=${encodeURIComponent(lookup)}&count=30&page=1`, request);
      if (!body.trimStart().startsWith('{')) throw new Error('雪球个股接口返回站点验证页面，当前未接入登录凭据。');
      const root = object(JSON.parse(body));
      return parsePublicNews('xueqiu', root.error_code || root.error_description ? root : { items: root.list })
        .map(event => ({ ...event, source: '雪球 个股新闻', symbol }));
    }) },
  ];
}
