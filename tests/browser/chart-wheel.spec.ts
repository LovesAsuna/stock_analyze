import { test, expect } from '@playwright/test';

/** 在真实图表中验收恢复的滚轮阈值、限幅、指针锚点和横向平移。 */
test('恢复的滚轮逻辑保持鼠标锚点并区分平移与缩放', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  const result = await page.evaluate(async () => {
    const wheelModule = '/src/chart-wheel.ts';
    const chartsModule = '/node_modules/.vite/deps/lightweight-charts.js';
    const { bindChartWheel } = await import(wheelModule);
    const { createChart, CandlestickSeries } = await import(chartsModule);
    const container = document.createElement('div'); container.style.cssText = 'width:800px;height:400px';
    document.body.appendChild(container);
    const chart = createChart(container, { width: 800, height: 400 });
    const series = chart.addSeries(CandlestickSeries);
    series.setData(Array.from({ length: 300 }, (_, index) => ({ time: 1700000000 + index * 86400,
      open: 100 + index, high: 103 + index, low: 99 + index, close: 102 + index })));
    chart.timeScale().setVisibleLogicalRange({ from: 170, to: 270 });
    const release = bindChartWheel(container, chart); const scale = chart.timeScale();
    /** 等待公开时间轴异步应用可见区间；参数无，返回两次绘制后的 Promise。 */
    const painted = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await painted();
    /** 派发同一坐标下的真实 DOM 滚轮事件；参数为增量，返回是否被图表消费。 */
    function wheel(deltaX: number, deltaY: number): boolean {
      const bounds = container.getBoundingClientRect();
      return !container.dispatchEvent(new WheelEvent('wheel', { clientX: bounds.left + 240, clientY: bounds.top + 100,
        deltaX, deltaY, bubbles: true, cancelable: true }));
    }
    try {
      const initial = scale.getVisibleLogicalRange(); const anchorBefore = scale.coordinateToLogical(240);
      const consumed = wheel(0, -1000); await painted(); const zoomed = scale.getVisibleLogicalRange();
      const anchorAfter = scale.coordinateToLogical(240); const spacing = scale.options().barSpacing;
      wheel(80, 20); await painted(); const panned = scale.getVisibleLogicalRange();
      wheel(0, 1); await painted(); const tiny = scale.getVisibleLogicalRange();
      release(); wheel(0, 100); await painted(); const released = scale.getVisibleLogicalRange();
      return { initial, zoomed, panned, tiny, released, anchorBefore, anchorAfter, spacing, consumed };
    } finally { release(); chart.remove(); container.remove(); }
  });
  const span = (range: { from: number; to: number }) => range.to - range.from;
  expect(result.consumed).toBe(true);
  expect(span(result.zoomed) / span(result.initial)).toBeCloseTo(1 / 1.1, 6);
  expect(result.anchorAfter).toBeCloseTo(result.anchorBefore, 6);
  expect(span(result.panned)).toBeCloseTo(span(result.zoomed), 6);
  expect(result.panned.from - result.zoomed.from).toBeCloseTo(80 / result.spacing, 6);
  expect(result.tiny).toEqual(result.panned);
  expect(result.released).toEqual(result.tiny);
});

/** 工作台 K 线与分时均使用恢复的交互，滚轮不让页面跳动，切周期后无失效监听。 */
test('工作台 K 线及分时滚轮操作生效且不滚动页面', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1536, height: 1100 }); await page.goto('/');
  for (const selector of ['.stock-chart', '.intraday-chart']) {
    if (selector === '.intraday-chart') await page.getByRole('button', { name: '5 日', exact: true }).click();
    const chart = page.locator(selector); await expect(chart.locator('canvas').first()).toBeVisible();
    await chart.hover({ position: { x: 260, y: 140 } });
    const before = await chart.screenshot(); const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, -100); await page.waitForTimeout(150);
    const after = await chart.screenshot();
    expect(after.equals(before)).toBe(false);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    await page.mouse.wheel(60, 0); await page.waitForTimeout(100);
    await page.getByRole('button', { name: '适应全部', exact: true }).click();
  }
  await page.getByRole('button', { name: '日线', exact: true }).click();
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  expect(errors).toEqual([]);
});
