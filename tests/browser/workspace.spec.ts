import { test, expect } from '@playwright/test';

test('图表、信号定位、参数设置、证券搜索和数据表可正常使用', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1536, height: 1050 });
  await page.goto('/');
  await expect(page.getByText('440 根 · 合成快照')).toBeVisible();
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  await page.getByLabel('复盘时间范围').selectOption('month');
  await expect(page.locator('.strategy-workbench tbody tr').first()).toBeVisible();
  const before = await page.locator('.ohlc').textContent();
  await page.locator('.strategy-workbench .text-button').first().click();
  await expect(page.locator('.ohlc')).not.toHaveText(before ?? '');
  await page.getByRole('button', { name: '展开指标', exact: true }).click();
  await page.getByRole('checkbox', { name: 'BOLL' }).check();
  await page.getByLabel('技术指标副图').selectOption('dmi');
  await expect(page.locator('.oscillator-caption')).toContainText('ADX');
  await page.getByLabel('技术指标副图').selectOption('rsi');
  await page.getByRole('button', { name: '策略参数', exact: true }).first().click();
  await page.getByLabel('短期均线').fill('8');
  await page.getByRole('button', { name: '应用参数' }).click();
  await expect(page.getByRole('checkbox', { name: '策略 MA 8 / 20' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('NVDA.US / 700.HK').fill('700.HK');
  await page.keyboard.press('Enter');
  await expect(page.locator('.security-heading h2')).toContainText('腾讯控股');
  await expect(page.getByText('440 根 · 合成快照')).toBeVisible();
  await page.getByText('行情与指标数据表（最近 60 根）').click();
  await expect(page.locator('.data-details tbody tr')).toHaveCount(60);
  await page.getByText('行情与指标数据表（最近 60 根）').click();
  await page.getByLabel('复盘时间范围').selectOption('week');
  await expect(page.locator('.daily-panel tbody tr')).toHaveCount(5);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出复盘' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('700.HK');
  await page.screenshot({ path: 'artifacts/workspace-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

for (const width of [320, 375, 414, 768]) {
  test(`在 ${width}px 宽度无页面横向溢出并可搜索`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByText('440 根 · 合成快照')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('.search-pill').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '关闭搜索' }).click();
    await page.screenshot({ path: `artifacts/workspace-${width}.png`, fullPage: true });
  });
}

test('真实源读取失败时不展示演示账户或演示图表', async ({ page }) => {
  await page.route('**/api/**source=longbridge*', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '测试：未登录' }) }));
  await page.goto('/');
  await expect(page.getByText('440 根 · 合成快照')).toBeVisible();
  await page.getByLabel('数据源', { exact: true }).selectOption('longbridge');
  await expect(page.getByRole('alert')).toContainText('测试：未登录');
  await expect(page.locator('.stock-chart')).toHaveCount(0);
  await expect(page.locator('.demo-banner')).toHaveCount(0);
  await expect(page.locator('.security-row')).toHaveCount(0);
});
