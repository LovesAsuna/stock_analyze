import { test, expect } from '@playwright/test';

type PerformanceWindow = Window & { historyDateReads: number; streamSubscriptions: number; settingsWrites: number };

/** 纯报价不能重扫历史复盘；折叠表格按需生成，展开后报价也不能触发历史重算。 */
test('真实数据主页持续报价不重复计算历史，表格只在展开后生成', async ({ page, request }) => {
  const response = await request.get('/api/market?source=demo&symbol=NVDA.US&period=day&start=2026-10-12&end=2026-10-17');
  const market = await response.json();
  await page.addInitScript(firstTime => {
    const target = window as unknown as PerformanceWindow;
    target.historyDateReads = 0; target.streamSubscriptions = 0; target.settingsWrites = 0;
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) { target.settingsWrites++; return originalSetItem.call(this, key, value); };
    // 观察历史首柱的实际日期换算，避免使用易受机器负载影响的毫秒阈值。
    window.Date = new Proxy(Date, { construct(original, args, constructor) {
      if (args[0] === firstTime * 1000) target.historyDateReads++;
      return Reflect.construct(original, args, constructor);
    } });
    class ControlledEventSource {
      onmessage: ((event: MessageEvent) => void) | null = null;
      /** 投递测试报价；参数为受控事件，返回无。 */
      listener = (event: Event) => {
        this.onmessage?.(new MessageEvent('message', { data: JSON.stringify((event as CustomEvent).detail) }));
      };
      /** 注册测试行情流；无参数，返回实例，且不连接账户或外部网络。 */
      constructor() { target.streamSubscriptions++; window.addEventListener('home-quote-test', this.listener); }
      /** 释放旧证券订阅；无参数、无返回值。 */
      close(): void { window.removeEventListener('home-quote-test', this.listener); }
    }
    window.EventSource = ControlledEventSource as unknown as typeof EventSource;
  }, market.candles[0].time);
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/market') return route.fulfill({ json: { ...market, source: url.searchParams.get('source') } });
    if (url.pathname === '/api/workspace') return route.fulfill({ json: {
      source: url.searchParams.get('source'), fetchedAt: market.fetchedAt, securities: [], positions: [], positionsComplete: true, warnings: [],
    } });
    return route.fulfill({ status: 503, json: { error: '主页性能测试中隔离外围接口。' } });
  });
  await page.goto('/');
  await page.getByLabel('数据源', { exact: true }).selectOption('longbridge');
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  await expect(page.locator('.daily-panel tbody tr')).toHaveCount(5);
  const dailyBefore = await page.locator('.daily-panel tbody').textContent();
  await expect(page.locator('.data-details tbody tr')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('market-lens-workspace-v1') ?? 'null')?.value?.source)).toBe('longbridge');
  const counters = () => page.evaluate(() => {
    const target = window as unknown as PerformanceWindow;
    return { dates: target.historyDateReads, subscriptions: target.streamSubscriptions, writes: target.settingsWrites };
  });
  const initial = await counters(); expect(initial.dates).toBeGreaterThan(0);
  for (const price of [301, 302, 303]) {
    await page.evaluate(value => window.dispatchEvent(new CustomEvent('home-quote-test', { detail: { type: 'quote',
      quote: { symbol: 'NVDA.US', price: value, previousClose: 300, timestamp: Math.floor(Date.now() / 1000), session: 'regular' } } })), price);
    await expect(page.locator('.quote > strong')).toHaveText(price.toFixed(2));
  }
  expect(await counters()).toEqual(initial);
  await expect(page.locator('.daily-panel tbody')).toHaveText(dailyBefore ?? '');
  await page.locator('.data-details summary').click();
  await expect(page.locator('.data-details tbody tr')).toHaveCount(60);
  const firstClose = market.candles.at(-1).close.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  await expect(page.locator('.data-details tbody tr').first().locator('td').nth(4)).toHaveText(firstClose);
  const expanded = await counters();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('home-quote-test', { detail: { type: 'quote',
    quote: { symbol: 'NVDA.US', price: 304, previousClose: 300, timestamp: Math.floor(Date.now() / 1000), session: 'regular' } } })));
  await expect(page.locator('.quote > strong')).toHaveText('304.00');
  expect(await counters()).toEqual(expanded);
  await expect(page.locator('.data-details tbody tr').first().locator('td').nth(4)).toHaveText(firstClose);
  await page.locator('.data-details summary').click();
  await expect(page.locator('.data-details tbody tr')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/home-quote-isolation.png' });
});
