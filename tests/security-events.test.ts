import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePublicSecurity, mentionsSecurity, securityNewsQuery, parseEastmoneyStockNews, parseSinaStockNews, parseWallstreetStockNews, type PublicSecurity } from '../server/security-event-parsers';
import { securityEventSources } from '../server/security-events';
import { collectEventSources } from '../server/events';
import { fetchEventText } from '../server/public-events';

const nvidia: PublicSecurity = { symbol: 'NVDA.US', code: 'NVDA', name: '英伟达', quoteId: '105.NVDA' };
const rocket: PublicSecurity = { symbol: 'RKLB.US', code: 'RKLB', name: 'Rocket Lab Corp', quoteId: '105.RKLB' };
const tencent: PublicSecurity = { symbol: '700.HK', code: '700', name: '腾讯控股', quoteId: '116.00700' };

/** 构造公开证券建议协议的精简样本。参数：上游记录；返回：成功JSON，测试不得调用账户接口。 */
function identityFixture(records: unknown[]) { return { QuotationCodeTable: { Status: 0, Data: records } }; }

/** 构造见闻搜索样本。参数：正文；返回：固定发布时间的合法快讯响应。 */
function wallFixture(content: string) {
  return { code: 20000, data: { items: [{ id: 9, title: '', content_text: content, display_time: 1793718000 }] } };
}

test('证券映射精确匹配市场和代码，不使用名称相近或其他市场的第一项', () => {
  const values = identityFixture([{ Code: 'NVDA', Name: '其他市场', MktNum: '185', QuoteID: '185.NVDA' },
    { Code: 'NVDA', Name: '英伟达', MktNum: '105', QuoteID: '105.NVDA' }]);
  assert.deepEqual(parsePublicSecurity(values, 'nvda.us'), nvidia);
  assert.deepEqual(parsePublicSecurity(identityFixture([{ Code: '00700', Name: '腾讯控股', MktNum: '116', QuoteID: '116.00700' }]), '00700.HK'), tencent);
  for (const market of ['106', '107']) assert.equal(parsePublicSecurity(identityFixture([
    { Code: 'SPY', Name: '标普ETF', MktNum: market, QuoteID: `${market}.SPY` },
  ]), 'SPY.US').quoteId, `${market}.SPY`);
  assert.throws(() => parsePublicSecurity(values, 'NVDS.US'), /完全一致/);
  assert.throws(() => parsePublicSecurity({ QuotationCodeTable: { Status: 0, Data: null } }, 'NVDA.US'), /映射/);
  assert.throws(() => securityEventSources('NVDA.US&url=https://example.com'), /证券代码格式/);
});

test('相关性识别完整公司名与代码，短代码、价格和相似证券不能误匹配', () => {
  assert.equal(securityNewsQuery(rocket), 'Rocket Lab');
  for (const content of ['英伟达发布新芯片', '$NVDA rises', 'NVDA.US上涨']) assert.equal(mentionsSecurity(content, nvidia), true);
  for (const content of ['NVDAX上涨', 'XNVDAX', '其他公司的新闻']) assert.equal(mentionsSecurity(content, nvidia), false);
  assert.equal(mentionsSecurity('Rocket Lab announces launch', rocket), true);
  assert.equal(mentionsSecurity('rocket laboratory research', rocket), false);
  for (const content of ['股价700美元', '腾讯音乐发布业绩']) assert.equal(mentionsSecurity(content, tencent), false);
  for (const content of ['00700.HK上涨', 'HK:00700', '腾讯控股披露业绩']) assert.equal(mentionsSecurity(content, tencent), true);
  const short = { ...nvidia, symbol: 'A.US', code: 'A', name: 'Agilent Technologies Inc' };
  assert.equal(mentionsSecurity('A new product', short), false);
  assert.equal(mentionsSecurity('$A reports earnings', short), true);
});

test('东方财富关联新闻保持证券、真实文章ID与北京时间，空结果和协议错误分别处理', () => {
  const [item] = parseEastmoneyStockNews({ code: 1, data: { list: [{ Art_Code: '9223372036854775807', Art_Title: '<b>市场综述</b>',
    Art_ShowTime: '2026-11-03 23:00:00', Art_Url: 'javascript:bad()', Art_OriginUrl: 'https://finance.eastmoney.com/a/1.html' }] } }, rocket);
  assert.equal(item.symbol, 'RKLB.US'); assert.equal(item.title, '市场综述');
  assert.equal(item.id, 'news:eastmoney:9223372036854775807'); assert.equal(item.publishedAt, '2026-11-03T15:00:00.000Z');
  assert.equal(item.url, 'https://finance.eastmoney.com/a/1.html'); assert.equal(item.scheduledAt, null);
  assert.deepEqual(parseEastmoneyStockNews({ code: 1, data: null }, rocket), []);
  assert.throws(() => parseEastmoneyStockNews({ code: 1, data: {} }, rocket), /结构变化/);
  assert.throws(() => parseEastmoneyStockNews({ code: 0 }, rocket), /错误状态/);
});

test('见闻按搜索结果全文核验，使用content_more，排除相似代码和其他公司', () => {
  const data = wallFixture('英伟达发布新产品');
  assert.equal(parseWallstreetStockNews(data, nvidia)[0].symbol, 'NVDA.US');
  assert.deepEqual(parseWallstreetStockNews(wallFixture('NVDAX新产品'), nvidia), []);
  assert.deepEqual(parseWallstreetStockNews(wallFixture('腾讯音乐'), tencent), []);
  const more = { code: 20000, data: { items: [{ id: 2, title: '芯片市场', content_more: '英伟达公告', display_time: 1793718000 }] } };
  assert.equal(parseWallstreetStockNews(more, nvidia).length, 1);
  assert.throws(() => parseWallstreetStockNews({ code: 500 }, nvidia), /错误状态/);
});

test('新浪美股回退全市场不能混入个股，港股先核验页面身份再读取关联列表', () => {
  const us = '<ul class="xb_list"><li><span class="xb_list_r">媒体 | 2026年11月03日 05:40</span><a href="https://finance.sina.com.cn/a">RKLB收跌</a></li>'
    + '<li><span>2026年11月03日 05:41</span><a href="https://finance.sina.com.cn/b">其他证券和全球动态</a></li></ul>';
  const items = parseSinaStockNews(us, rocket);
  assert.equal(items.length, 1); assert.equal(items[0].publishedAt, '2026-11-02T21:40:00.000Z'); assert.equal(items[0].symbol, 'RKLB.US');
  assert.deepEqual(parseSinaStockNews(us, nvidia), []);
  const hk = '<em>00700.HK(TENCENT)</em><ul id="js_ggzx" class="list01"><li><a href="https://finance.sina.com.cn/hk">腾讯新动态</a><span class="rt">2026-11-03 23:16:09</span></li></ul>';
  assert.equal(parseSinaStockNews(hk, tencent)[0].publishedAt, '2026-11-03T15:16:09.000Z');
  assert.throws(() => parseSinaStockNews(hk.replace('00700.HK', '00762.HK'), tencent), /证券代码不匹配/);
  assert.throws(() => parseSinaStockNews('<html>登录页面</html>', rocket), /结构变化/);
});

test('公开读取可按新浪声明使用GBK解码，默认UTF8仍严格拒绝错误编码', async () => {
  const request = (async () => new Response(Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]))) as typeof fetch;
  assert.equal(await fetchEventText('https://example.com', request, 'gb18030'), '中文');
  await assert.rejects(fetchEventText('https://example.com', request));
});

test('个股来源接入真实聚合路径，缓存和并发按证券隔离，雪球失败不影响三家结果', async () => {
  const calls: string[] = [];
  const request = (async (input: string | URL | Request) => {
    const url = new URL(String(input)); calls.push(url.href);
    const symbol = url.searchParams.get('input') ?? '';
    if (url.hostname === 'searchapi.eastmoney.com') return Response.json(identityFixture([
      { Code: symbol, Name: symbol, MktNum: '105', QuoteID: `105.${symbol}` },
    ]));
    if (url.hostname === 'xueqiu.com') return new Response('<html>verification</html>');
    if (url.hostname === 'biz.finance.sina.com.cn') return new Response(`<ul class="xb_list"><li><span>2026-11-03 23:00:00</span><a href="https://finance.sina.com.cn/test">${url.searchParams.get('symbol')} stock news</a></li></ul>`);
    if (url.hostname === 'api-one.wallstcn.com') return Response.json(wallFixture(`${url.searchParams.get('query')} stock news`));
    if (url.hostname === 'np-listapi.eastmoney.com') return Response.json({ code: 1, data: { list: [
      { Art_Code: '1', Art_Title: '关联资讯', Art_ShowTime: '2026-11-03 23:00:00', Art_Url: 'https://finance.eastmoney.com/a/1.html' },
    ] } });
    throw new Error('测试禁止请求未声明的来源');
  }) as typeof fetch;
  for (const symbol of ['NVDA.US', 'RKLB.US']) {
    const result = await collectEventSources(securityEventSources(symbol, request), Date.parse('2026-11-03T16:00:00Z'), '2026-10-27', '2026-12-03');
    assert.equal(result.events.length, 3); assert.ok(result.events.every(item => item.symbol === symbol));
    assert.deepEqual(result.sources.map(source => source.state), ['ok', 'ok', 'ok', 'error']);
    assert.equal(calls.filter(url => new URL(url).searchParams.get('input') === symbol.slice(0, -3)).length, 1);
  }
  const before = calls.length;
  await Promise.all(securityEventSources('NVDA.US', request).map(source => source.read().catch(() => [])));
  assert.equal(calls.length, before);
  assert.ok(calls.some(url => url.includes('/search/live?')));
  assert.ok(calls.some(url => new URL(url).searchParams.get('mTypeAndCode') === '105.RKLB'));
  assert.ok(calls.every(url => !url.includes('fomccalendars') && !url.includes('livenews/list')));
});
