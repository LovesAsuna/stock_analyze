import { test, expect } from '@playwright/test';

/** 通过同源SSE响应驱动真实EventSource，验证报价与原生K线使用不同数据口径。 */
test('实时价格与原生K线分别更新，切换演示源关闭真实订阅', async ({ page, request }) => {
  const response = await request.get('/api/market?source=demo&symbol=NVDA.US&period=day&start=2026-10-12&end=2026-10-17');
  const data = await response.json();
  const last = data.candles.at(-1);
  const quoteTime = Math.floor(Date.now() / 1000);
  const snapshot = { ...last, close: last.close + 1, high: Math.max(last.high, last.close + 1) };
  const frames = [
    { type: 'status', symbol: 'NVDA.US', state: 'connected', message: '桌面原生WS已订阅（测试）' },
    { type: 'quote', quote: { symbol: 'NVDA.US', price: 321.5, previousClose: 300, timestamp: quoteTime, session: 'regular' } },
    { type: 'quote', quote: { symbol: 'NVDA.US', price: 1, previousClose: 300, timestamp: quoteTime - 1, session: 'regular' } },
    { type: 'candles', symbol: 'NVDA.US', period: 'day', candles: [snapshot], receivedAt: new Date().toISOString() },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  await page.route('**/api/workspace?source=longbridge', route => route.fulfill({ json: {
    source: 'longbridge', fetchedAt: new Date().toISOString(), securities: [], positions: [], positionsComplete: true, warnings: [],
  } }));
  await page.route('**/api/market?source=longbridge*', route => route.fulfill({ json: { ...data, source: 'longbridge' } }));
  await page.route('**/api/stream?*', route => route.fulfill({ contentType: 'text/event-stream', body: frames }));
  await page.goto('/');
  await page.getByLabel('数据源', { exact: true }).selectOption('longbridge');
  await expect(page.locator('.quote > strong')).toHaveText('321.50');
  await expect(page.locator('.quote')).toContainText('较昨收');
  await expect(page.locator('.realtime-status')).toContainText('行情时间（中国）');
  await page.getByText('行情与指标数据表（最近 60 根）').click();
  await expect(page.locator('.data-details tbody tr').first()).toContainText(snapshot.close.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  await page.getByLabel('数据源', { exact: true }).selectOption('demo');
  await expect(page.locator('.realtime-status')).toHaveCount(0);
  await expect(page.locator('.quote > strong')).not.toHaveText('321.50');
});
