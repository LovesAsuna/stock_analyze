import { eventLink, type MarketEvent } from '../shared/events.js';
import { normalizeSymbol } from './longbridge.js';
import { object, text, originalId } from './event-values.js';
import { plain, chinaTime, parsePublicNews } from './public-event-parsers.js';

export interface PublicSecurity { symbol: string; code: string; name: string; quoteId: string }

/** 精确匹配证券和市场，不能取搜索结果第一项。参数：建议接口JSON、证券；返回：经过校验的港美股身份。 */
export function parsePublicSecurity(value: unknown, symbol: string): PublicSecurity {
  symbol = normalizeSymbol(symbol);
  const table = object(object(value).QuotationCodeTable);
  if (table.Status !== 0 || !Array.isArray(table.Data)) throw new Error('东方财富未返回有效的证券映射。');
  const hongKong = symbol.endsWith('.HK');
  const code = symbol.slice(0, -3);
  const expected = hongKong ? code.padStart(5, '0') : code.replace(/[.-]/g, '_');
  for (const item of table.Data) {
    const row = object(item); const market = text(row.MktNum); const name = text(row.Name);
    const matched = hongKong ? market === '116' : ['105', '106', '107'].includes(market ?? '');
    if (matched && row.Code === expected && row.QuoteID === `${market}.${expected}` && name) {
      return { symbol, code, name: name.slice(0, 100), quoteId: row.QuoteID as string };
    }
  }
  throw new Error('东方财富未找到与当前证券代码和市场完全一致的记录。');
}

/** 转义证券及名称中的正则字符。参数：普通文本；返回：可安全放入正则的字面文本。 */
function escaped(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 去掉英文公司组织后缀供全文检索，不截短中文名以免混淆其他公司。参数：已校验身份；返回：公司名检索词。 */
export function securityNewsQuery(security: PublicSecurity): string {
  return security.name.replace(/\s+(?:(?:Inc|Corp|Corporation|Ltd|Limited|Holdings|PLC)\.?\s*)+$/i, '').trim() || security.code;
}

/** 检查正文明确提到证券或完整公司名，短美股代码和港股数字不能匹配普通词或价格。参数：文本、身份；返回：是否相关。 */
export function mentionsSecurity(content: string, security: PublicSecurity): boolean {
  const name = securityNewsQuery(security);
  if (/[㐀-鿿]/.test(name) && name.length >= 2 && content.includes(name)) return true;
  if (!/[㐀-鿿]/.test(name) && name.length >= 4
    && new RegExp(`(?<![A-Za-z0-9])${escaped(name)}(?![A-Za-z0-9])`, 'i').test(content)) return true;
  const code = escaped(security.code);
  const pattern = security.symbol.endsWith('.HK')
    ? `(?:HK[:：]?\\s*0*${code}(?!\\d)|(?<!\\d)0*${code}\\.HK\\b)`
    : security.code.length <= 2 ? `(?:\\$${code}\\b|\\b${code}\\.US\\b)`
      : `(?<![A-Za-z0-9_.-])\\$?${code}(?:\\.US)?(?![A-Za-z0-9_.-])`;
  return new RegExp(pattern).test(content);
}

/** 解析东方财富证券页面使用的关联资讯，不以标题必须含代码误删上游关联报道。参数：JSON、身份；返回：当前证券新闻。 */
export function parseEastmoneyStockNews(value: unknown, security: PublicSecurity): MarketEvent[] {
  const root = object(value);
  if (String(root.code) !== '1') throw new Error('东方财富个股资讯返回错误状态。');
  if (root.data === null) return [];
  const list = object(root.data).list;
  if (!Array.isArray(list)) throw new Error('东方财富个股资讯响应结构变化。');
  return list.slice(0, 100).flatMap(item => {
    const row = object(item); const id = originalId(row.Art_Code); const title = plain(row.Art_Title);
    const publishedAt = chinaTime(row.Art_ShowTime);
    if (!id || !title || !publishedAt) return [];
    return [{ id: `news:eastmoney:${id}`, kind: 'news' as const, title, summary: null,
      source: '东方财富 个股资讯', url: eventLink(row.Art_Url) ?? eventLink(row.Art_OriginUrl),
      publishedAt, scheduledAt: null, dateOnly: false, symbol: security.symbol }];
  });
}

/** 见闻必须使用search/live，另校验全文避免代码子串误匹配。参数：搜索JSON、身份；返回：当前证券快讯。 */
export function parseWallstreetStockNews(value: unknown, security: PublicSecurity): MarketEvent[] {
  const root = object(value); const items = object(root.data).items;
  const events = parsePublicNews('wallstreetcn', value);
  const matching = new Set((Array.isArray(items) ? items : []).flatMap(item => {
    const row = object(item);
    return mentionsSecurity([row.title, row.content_text, row.content_more].map(plain).join(' '), security) ? [String(row.id)] : [];
  }));
  return events.filter(event => matching.has(event.id.slice('news:wallstreetcn:'.length)))
    .map(event => ({ ...event, source: '华尔街见闻 个股快讯', symbol: security.symbol }));
}

/** 解析新浪港美股证券列表，美股逐条校验相关性，港股核验页面证券身份。参数：已解码HTML、身份；返回：相关新闻。 */
export function parseSinaStockNews(html: string, security: PublicSecurity): MarketEvent[] {
  const list = html.match(/<ul\b[^>]*(?:class=["']xb_list["']|id=["']js_ggzx["'])[^>]*>([\s\S]*?)<\/ul>/i);
  if (!list) throw new Error('新浪个股新闻列表结构变化。');
  const hongKong = security.symbol.endsWith('.HK');
  // 港股页提供证券身份，可采用其关联列表；美股页可能只有输入回显，仍须逐条校验。
  if (hongKong && !new RegExp(`<em\\b[^>]*>\\s*${security.code.padStart(5, '0')}\\.HK\\b`, 'i').test(html)) {
    throw new Error('新浪港股新闻页面证券代码不匹配。');
  }
  const events: MarketEvent[] = [];
  for (const item of list[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const link = item[1].match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    const title = plain(link?.[2]); const url = eventLink(link?.[1]);
    const date = plain(item[1]).match(/(\d{4})[年-](\d{2})[月-](\d{2})日?\s+(\d{2}:\d{2})(:\d{2})?/);
    const publishedAt = date ? chinaTime(`${date[1]}-${date[2]}-${date[3]} ${date[4]}${date[5] ?? ':00'}`) : null;
    if (!title || !url || !publishedAt || (!hongKong && !mentionsSecurity(title, security))) continue;
    events.push({ id: `news:sina:${url}`, kind: 'news', title, summary: null, source: '新浪财经 个股新闻', url,
      publishedAt, scheduledAt: null, dateOnly: false, symbol: security.symbol });
  }
  return events;
}
