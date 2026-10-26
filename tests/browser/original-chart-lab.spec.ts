import { test, expect } from '@playwright/test';

/** 原版WASM以合成行情运行，隔离账户、外网与浏览器存储，并验收跨周期及真实输入。 */
test('原版实验绘制合成行情、切周期、缩放并释放资源', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const unexpected: string[] = [];
  page.on('request', request => {
    if (request.frame().url().includes('/chart-lab/frame') && !new URL(request.url()).pathname.startsWith('/chart-lab/')) unexpected.push(request.url());
  });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/');
  await page.getByRole('button', { name: '原版图表实验', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '原版图表实验', exact: true });
  await expect(dialog).toContainText('合成行情已绘制', { timeout: 30000 });
  const frameElement = dialog.locator('iframe'); await expect(frameElement).toHaveAttribute('sandbox', 'allow-scripts');
  let frame = page.frames().find(candidate => candidate.url().includes('/chart-lab/frame'))!;
  const initial = await frame.evaluate(() => JSON.parse((window as any).Module.getChartVisibleRange()));
  expect(initial.some((range: any) => range.yMaxValue > range.yMinValue && range.yMaxValue > 1)).toBe(true);
  const inaccessible = await frame.evaluate(() => {
    try { localStorage.getItem('test'); return false; } catch { return true; }
  });
  expect(inaccessible).toBe(true);
  const canvas = frame.locator('canvas'); await canvas.hover({ position: { x: 350, y: 200 } });
  const before = await frame.evaluate(() => (window as any).Module.getChartVisibleRange());
  // 内置样本只有40柱，连续放大使可见范围从全部样本收窄。
  for (let step = 0; step < 20; step++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(25); }
  await expect.poll(() => frame.evaluate(() => (window as any).Module.getChartVisibleRange())).not.toBe(before);
  for (const period of ['week', 'month', 'quarter', 'year', '1m', '5m', '15m', '30m', '60m', 'intraday', 'five-day', 'day']) {
    await page.getByLabel('原版实验周期').selectOption(period);
    await expect(dialog).toContainText('合成行情已绘制', { timeout: 20000 });
    frame = page.frames().find(candidate => candidate.url().includes('/chart-lab/frame'))!;
    const ranges = await frame.evaluate(() => JSON.parse((window as any).Module.getChartVisibleRange()));
    expect(ranges.some((range: any) => range.yMaxValue > range.yMinValue && range.yMaxValue > 1)).toBe(true);
    const unit = { day: 'd', week: 'w', month: 'm', year: 'y' }[period as 'day' | 'week' | 'month' | 'year'];
    if (unit) expect(await frame.evaluate(() => (window as any).Module.getCurrentSubTypeTimeUnit())).toBe(unit);
  }
  await dialog.screenshot({ path: 'artifacts/longbridge-original-lab-desktop.png' });
  await page.getByRole('button', { name: '关闭实验', exact: true }).click();
  await expect(dialog).not.toBeVisible(); await expect(frameElement).toHaveCount(0);
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  expect(unexpected).toEqual([]); expect(errors).toEqual([]);
});

for (const width of [320, 375, 414, 768]) {
  /** 窄屏实验对话框保留关闭入口，不造成根文档横向溢出。 */
  test(`原版实验在${width}px可打开和关闭`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await page.goto('/');
    await page.getByRole('button', { name: '原版图表实验', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '原版图表实验', exact: true });
    await expect(dialog).toContainText('合成行情已绘制', { timeout: 30000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const bounds = await dialog.boundingBox(); expect(bounds!.width).toBeLessThanOrEqual(width);
    await dialog.screenshot({ path: `artifacts/longbridge-original-lab-${width}.png` });
    await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
    await expect(dialog.locator('iframe')).toHaveCount(0);
  });
}
