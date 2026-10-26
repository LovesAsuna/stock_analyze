import { test, expect } from '@playwright/test';

/** 所有K线周期均触发对应数据读取，切换回原周期后计划不混用。 */
test('十种K线周期切换并保持计划上下文', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('440 根 · 合成快照')).toBeVisible();
  for (const [period, label] of [['week', '周线'], ['month', '月线'], ['quarter', '季线'], ['year', '年线'], ['1m', '1 分钟'], ['5m', '5 分钟'], ['15m', '15 分钟'], ['30m', '30 分钟'], ['1h', '1 小时'], ['day', '日线']]) {
    const response = page.waitForResponse(response => response.url().includes('/api/market?') && new URL(response.url()).searchParams.get('period') === period);
    await page.getByRole('button', { name: label, exact: true }).click();
    const result = await response; expect(result.status()).toBe(200);
    const data = await result.json(); expect(data.period).toBe(period); expect(data.candles.length).toBeGreaterThan(0);
    await expect(page.locator('.stock-chart canvas').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.strategy-workbench .section-header p')).toContainText(data.symbol);
  }
  expect(errors).toEqual([]);
});

/** 分时切换使用独立接口，不展示K线计划和模拟成交，五日返回多个交易日。 */
test('五种分时与5日视图使用真实独立数据契约', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('440 根 · 合成快照')).toBeVisible();
  for (const [session, label] of [['overnight', '夜盘'], ['pre', '盘前'], ['regular', '盘中'], ['post', '盘后'], ['all', '全部']]) {
    const response = page.waitForResponse(response => response.url().includes('/api/intraday?') && new URL(response.url()).searchParams.get('session') === session);
    await page.getByRole('button', { name: '展开分时时段菜单', exact: true }).click();
    await page.getByRole('menuitemradio', { name: label, exact: true }).click();
    const data = await (await response).json(); expect(data.session).toBe(session); expect(data.days).toBe(1);
    expect(data.points.length).toBeGreaterThan(0);
    if (session !== 'all') expect(data.points.every((point: { session: string }) => point.session === session)).toBe(true);
    await expect(page.locator('.intraday-chart canvas').first()).toBeVisible();
    await expect(page.locator('.plan-toolbar')).toHaveCount(0);
    await expect(page.locator('.strategy-workbench')).toHaveCount(0);
  }
  const five = page.waitForResponse(response => response.url().includes('/api/intraday?') && new URL(response.url()).searchParams.get('days') === '5');
  await page.getByRole('button', { name: '5 日', exact: true }).click();
  const data = await (await five).json(); expect(data.days).toBe(5); expect(data.points.length).toBeGreaterThan(1000);
  await expect(page.locator('.intraday-chart canvas').first()).toBeVisible();
  for (const name of ['放大', '缩小', '适应全部', '回到最新']) {
    const action = page.getByRole('button', { name, exact: true });
    await expect(action).toBeVisible();
    await action.click();
  }
  await page.getByText(`分时数据表（${data.points.length} 点）`, { exact: true }).click();
  await expect(page.locator('.intraday-table tbody tr')).toHaveCount(data.points.length);
  await page.getByRole('button', { name: '日线', exact: true }).click();
  await expect(page.locator('.plan-toolbar')).toBeVisible();
  expect(errors).toEqual([]);
});

/** 没有对应夜盘数据时保留空状态，绝不用盘中或合成数据填充。 */
test('港股不提供夜盘时明确显示空状态', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '搜索港股、美股 Ctrl K' }).click();
  await page.getByPlaceholder('NVDA.US / 700.HK').fill('700.HK'); await page.keyboard.press('Enter');
  await expect(page.locator('.security-identity h2')).toContainText('700.HK');
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  await page.getByRole('button', { name: '展开分时时段菜单', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '夜盘', exact: true }).click();
  await expect(page.getByText('所选时段暂无分时数据', { exact: true })).toBeVisible();
  await expect(page.locator('.intraday-chart')).toHaveCount(0);
  await expect(page.locator('.intraday-notes')).toContainText('港股');
});

for (const width of [320, 375, 414, 768, 1536]) {
  /** 按钮在小屏换行，图表不撑宽页面。 */
  test(`时间维度在${width}px可操作且无横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); await page.goto('/');
    await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
    await page.getByRole('button', { name: '展开分时时段菜单', exact: true }).click();
    await page.getByRole('menuitemradio', { name: '盘前', exact: true }).click();
    await expect(page.locator('.intraday-chart canvas').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/timeframes-${width}.png` });
    await page.getByRole('button', { name: '30 分钟', exact: true }).click();
    await expect(page.locator('.stock-chart canvas').first()).toBeVisible({ timeout: 15_000 });
  });
}
