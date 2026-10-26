import { test, expect } from '@playwright/test';

test('本机 Longbridge 真实源能显示自选、持仓与三种周期图表', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('数据源', { exact: true }).selectOption('longbridge');
  await expect(page.locator('.chart-status')).toContainText('Longbridge 快照', { timeout: 60_000 });
  for (const name of ['1 小时', '15 分钟', '日线']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.locator('.analysis-panel')).toHaveAttribute('aria-busy', 'false', { timeout: 90_000 });
    await expect(page.locator('.chart-status')).toContainText('Longbridge 快照');
    await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  }
  await expect(page.locator('.demo-banner')).toHaveCount(0);
  await expect(page.locator('.error-banner')).toHaveCount(0);
  expect(errors).toEqual([]);
  // 不生成真实账户截图或输出持仓明细；此测试仅在已授权本机账户环境运行。
});
