import { test, expect } from '@playwright/test';

/** 图表设置、真实全屏和底部周期栏保持同一操作上下文。 */
test('图表工具、偏好保存与全屏周期切换', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1536, height: 1100 }); await page.goto('/');
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  const positions = await page.evaluate(() => ({ chart: document.querySelector('.stock-chart')!.getBoundingClientRect().bottom,
    periods: document.querySelector('.timeframe-controls')!.getBoundingClientRect().top }));
  expect(positions.periods).toBeGreaterThanOrEqual(positions.chart);
  await page.getByRole('button', { name: '展开指标', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'MA 5 / 10 / 20 / 50（图表）', exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: '策略 MA 10 / 20', exact: true }).check();
  await page.getByRole('button', { name: '收起指标', exact: true }).click();
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await page.getByRole('button', { name: '缩小', exact: true }).click();
  await page.getByRole('button', { name: '适应全部', exact: true }).click();
  await page.getByRole('button', { name: '回到最新', exact: true }).click();
  await page.getByRole('button', { name: '打开 K 线设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'K 线设置', exact: true });
  await settings.getByLabel('显示网格', { exact: true }).check();
  await settings.getByLabel('空心涨柱', { exact: true }).uncheck();
  await settings.getByLabel('对数', { exact: true }).check();
  await settings.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByLabel('十字线模式').selectOption('normal');
  await page.reload(); await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  await expect(page.getByLabel('十字线模式')).toHaveValue('normal');
  await page.getByRole('button', { name: '打开 K 线设置', exact: true }).click();
  await expect(settings.getByLabel('显示网格', { exact: true })).toBeChecked();
  await expect(settings.getByLabel('空心涨柱', { exact: true })).not.toBeChecked();
  await expect(settings.getByLabel('对数', { exact: true })).toBeChecked();
  await settings.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('button', { name: '进入全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.className)).toBe('analysis-panel');
  await page.getByRole('button', { name: '周线', exact: true }).click();
  await expect(page.getByRole('button', { name: '周线', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '退出全屏', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '退出全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  expect(errors).toEqual([]);
});

/** 默认日线聚焦近一个月，新实例挂载和周期切换正确应用，手动缩放不被重绘覆盖。 */
test('日线首次显示近一个月并保留手动缩放', async ({ page }) => {
  // 仅测试时记录真实图表实例，通过公开时间轴API读取视野，不增加生产环境测试接口。
  await page.route('**/src/Chart.tsx*', async route => {
    const response = await route.fetch(); const body = await response.text();
    const marker = 'const price = chart.addSeries(';
    expect(body).toContain(marker);
    await route.fulfill({ response, body: body.replace(marker, `window.dailyViewportChart = chart; ${marker}`) });
  });
  await page.setViewportSize({ width: 1536, height: 1100 }); await page.goto('/');
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  const span = () => page.evaluate(() => {
    const chart = (window as unknown as { dailyViewportChart: import('lightweight-charts').IChartApi }).dailyViewportChart;
    const range = chart.timeScale().getVisibleLogicalRange();
    return range ? range.to - range.from : 0;
  });
  await expect.poll(span).toBeGreaterThan(18);
  expect(await span()).toBeLessThan(25);
  const initial = await span();
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await expect.poll(span).toBeLessThan(initial);
  const zoomed = await span();
  await page.getByRole('button', { name: '展开指标', exact: true }).click();
  await page.getByRole('checkbox', { name: 'MA 5 / 10 / 20 / 50（图表）', exact: true }).uncheck();
  await expect.poll(span).toBeCloseTo(zoomed, 4);
  await page.getByRole('button', { name: '周线', exact: true }).click();
  await expect.poll(span).toBeGreaterThan(50);
  await page.getByRole('button', { name: '日线', exact: true }).click();
  await expect.poll(span).toBeCloseTo(zoomed, 4);
  await page.reload(); await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  await expect.poll(span).toBeCloseTo(zoomed, 4);
  await page.locator('.analysis-panel').screenshot({ path: 'artifacts/daily-one-month.png' });
});

/** 自定义菜单向上展开并支持键盘关闭，分时保留真实多窗格与完整表格。 */
test('分时菜单、指标窗格及十字线行情卡', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1536, height: 1200 }); await page.goto('/');
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  await page.getByRole('button', { name: '展开分时时段菜单', exact: true }).click();
  const menu = page.getByRole('menu', { name: '分时时段菜单', exact: true });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
  await page.getByRole('button', { name: '展开分时时段菜单', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '盘前', exact: true }).click();
  await expect(page.locator('.intraday-chart canvas').first()).toBeVisible();
  await expect(page.locator('.intraday-panel')).toContainText('RSI');
  await expect(page.locator('.intraday-panel')).toContainText('MACD');
  await page.getByRole('button', { name: '日线', exact: true }).click();
  const chart = page.locator('.stock-chart'); await expect(chart.locator('canvas').first()).toBeVisible();
  await chart.hover({ position: { x: 280, y: 180 } });
  await expect(page.locator('.chart-quote-card')).toContainText('开盘');
  await expect(page.locator('.chart-quote-card')).toContainText('美东时间');
  await page.locator('.analysis-panel').screenshot({ path: 'artifacts/longbridge-replica-candles.png' });
  expect(errors).toEqual([]);
});
