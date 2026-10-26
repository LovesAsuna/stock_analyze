import { test, expect } from '@playwright/test';

/** 改版后的自选仍在等高侧栏内部滚动，长合约代码与持仓数量不能相互覆盖。 */
test('新版自选长代码、持仓列与大量证券内部滚动', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1100 });
  const workspace = await (await page.request.get('/api/workspace?source=demo')).json();
  const contract = 'NVDA261218C00150000.US';
  workspace.securities = [{ symbol: contract, name: '英伟达测试合约', market: 'US', currency: 'USD' },
    ...Array.from({ length: 70 }, (_, index) => ({ symbol: `TEST${index}.US`, name: `合成布局测试 ${index}`, market: 'US', currency: 'USD' }))];
  workspace.positions = [{ symbol: contract, quantity: 12345, available: 12345, costPrice: 1, currency: 'USD' }];
  await page.route('**/api/workspace?source=demo', route => route.fulfill({ json: workspace }));
  await page.goto('/');
  await expect(page.getByText('440 根 · 合成快照')).toBeVisible();
  const list = page.getByRole('region', { name: '自选与持仓证券', exact: true });
  const first = list.locator('.security-row').first();
  await expect(first).toContainText('12,345');
  const layout = await first.evaluate(element => {
    const identity = element.querySelector('.security-row-identity')!.getBoundingClientRect();
    const quantity = element.querySelector('.security-row-quantity')!.getBoundingClientRect();
    const sidebar = document.querySelector('.watchlist-panel')!.getBoundingClientRect();
    const analysis = document.querySelector('.analysis-panel')!.getBoundingClientRect();
    const region = document.querySelector('.watchlist-scroll')!;
    return { overlapping: identity.right > quantity.left, aligned: Math.abs(sidebar.bottom - analysis.bottom) < 2,
      scrollable: region.scrollHeight > region.clientHeight, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  expect(layout).toEqual({ overlapping: false, aligned: true, scrollable: true, overflow: false });
  await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(list.locator('.security-row').last()).toBeVisible();
  await page.locator('.watchlist-panel').screenshot({ path: 'artifacts/workspace-redesign-long-watchlist.png' });
});

/** 小屏横向布局、减少动态效果和键盘跳转依然提供可达的工作台入口。 */
test('新版键盘跳转、移动横屏和减少动态效果', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByText('440 根 · 合成快照')).toBeVisible();
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: '跳转到行情图表', exact: true });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#analysis$/);
  const bounds = await page.locator('.analysis-panel').boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(-1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '搜索港股、美股 Ctrl K', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});
