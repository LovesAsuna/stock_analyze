import { test, expect } from '@playwright/test';

/** 分时指标独立显示、真实工具栏、十字线与键盘读数使用同一快照。 */
test('分时终端窗格切换、tooltip、全屏周期栏及完整表格', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1536, height: 1200 }); await page.goto('/');
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  await page.getByRole('button', { name: '展开分时时段菜单', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '盘中', exact: true }).click();
  const terminal = page.locator('.intraday-terminal');
  await expect(terminal.locator('.intraday-chart canvas').first()).toBeVisible();
  await expect(terminal.locator('.intraday-pane-legend')).toHaveCount(4);
  await page.getByRole('button', { name: '展开指标', exact: true }).click();
  const rsi = page.getByRole('checkbox', { name: 'RSI (6 / 12 / 24)', exact: true });
  const macd = page.getByRole('checkbox', { name: 'MACD (12 / 26 / 9)', exact: true });
  await expect(rsi).toBeChecked(); await expect(macd).toBeChecked();
  await rsi.uncheck(); await expect(terminal.locator('.intraday-pane-legend')).toHaveCount(3);
  await macd.uncheck(); await expect(terminal.locator('.intraday-pane-legend')).toHaveCount(2);
  await rsi.check(); await expect(terminal.locator('.intraday-pane-legend')).toHaveCount(3);
  await macd.check(); await expect(terminal.locator('.intraday-pane-legend')).toHaveCount(4);
  await page.getByRole('button', { name: '收起指标', exact: true }).click();
  await terminal.locator('.intraday-chart').hover({ position: { x: 280, y: 180 } });
  await expect(terminal.locator('.intraday-tooltip')).toContainText('RSI6');
  await expect(terminal.locator('.intraday-tooltip')).toContainText('DEA');
  const range = page.getByRole('slider', { name: '检查分时点', exact: true });
  await range.focus(); await range.press('Home');
  await expect(range).toHaveValue('0');
  await expect(terminal.locator('.intraday-terminal-readout')).toContainText('键盘读数');
  for (const name of ['放大', '缩小', '适应全部', '回到最新']) {
    await expect(terminal.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  const positions = await terminal.evaluate(element => ({
    chart: element.querySelector('.intraday-terminal-stage')!.getBoundingClientRect().bottom,
    footer: element.querySelector('.intraday-terminal-footer')!.getBoundingClientRect().top,
  }));
  expect(Math.abs(positions.chart - positions.footer)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: '进入全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('analysis-panel'))).toBe(true);
  await expect(terminal.getByRole('button', { name: '展开分时时段菜单', exact: true })).toBeVisible();
  await expect(terminal.locator('.timeframe-controls select')).toHaveCount(0);
  await expect(terminal.getByRole('button', { name: '5 日', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '退出全屏', exact: true }).click();
  await terminal.locator('.intraday-table summary').click();
  await expect(terminal.locator('.intraday-table tbody tr')).toHaveCount(390);
  await expect(terminal.locator('.intraday-table thead')).toContainText('RSI24');
  await terminal.locator('.intraday-table summary').click();
  await terminal.screenshot({ path: 'artifacts/intraday-terminal-desktop.png' });
  expect(errors).toEqual([]);
});

/** 空数据不会吞掉底部周期栏，提示始终在数据口径之前。 */
test('分时空状态保留周期栏且位于notes之前', async ({ page }) => {
  await page.route('**/api/intraday?**', async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, points: [] } });
  });
  await page.goto('/');
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  await page.getByRole('button', { name: '展开分时时段菜单', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '盘中', exact: true }).click();
  await expect(page.getByText('所选时段暂无分时数据', { exact: true })).toBeVisible();
  await expect(page.locator('.intraday-terminal-footer')).toBeVisible();
  const positions = await page.evaluate(() => ({
    footer: document.querySelector('.intraday-terminal-footer')!.getBoundingClientRect().bottom,
    notes: document.querySelector('.intraday-notes')!.getBoundingClientRect().top,
  }));
  expect(positions.footer).toBeLessThanOrEqual(positions.notes);
});

/** 小屏图例仍可读，指标控制、周期栏和表格均不会撑宽页面。 */
test('375px分时终端无横向溢出', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 375, height: 1000 }); await page.goto('/');
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  await page.getByRole('button', { name: '展开分时时段菜单', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '盘前', exact: true }).click();
  await expect(page.locator('.intraday-pane-legend')).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.intraday-terminal').screenshot({ path: 'artifacts/intraday-terminal-mobile.png' });
  expect(errors).toEqual([]);
});
