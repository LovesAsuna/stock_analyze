import { test, expect } from '@playwright/test';

/** 真实页面保留唯一分时菜单，单日图不再提供缩放入口。 */
test('单日分时唯一菜单与细折线截图', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1200 });
  await page.goto('/');
  await page.getByRole('button', { name: '盘中分时', exact: true }).click();
  const terminal = page.locator('.intraday-terminal');
  await expect(terminal.locator('canvas').first()).toBeVisible();
  await expect(page.locator('.timeframe-controls select')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '展开分时时段菜单', exact: true })).toHaveCount(1);
  await expect(terminal.getByRole('group', { name: '图表视野', exact: true })).toHaveCount(0);
  await terminal.screenshot({ path: 'artifacts/intraday-fixed-desktop.png' });
});

/** 用公开API验证锁定后的真实Canvas图表；鼠标滚轮、平移、价轴和时间轴拖动均不改变范围。 */
test('单日未完盘完整时轴和所有鼠标缩放平移锁定', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const chartsPath = '/node_modules/.vite/deps/lightweight-charts.js';
    const viewportPath = '/src/intraday-viewport.ts';
    const { createChart, LineSeries, HistogramSeries, LineType } = await import(chartsPath);
    const { fitIntradayViewport, intradayVolumeData, lockIntradayViewport } = await import(viewportPath);
    const root = document.createElement('div'); root.id = 'fixed-intraday-test';
    root.style.cssText = 'position:fixed;inset:20px auto auto 20px;width:800px;height:500px;z-index:1000;background:#151923';
    document.body.append(root);
    const chart = createChart(root, { width: 800, height: 500, rightPriceScale: { minimumWidth: 70 } });
    const points = Array.from({ length: 151 }, (_, index) => ({ time: 1792762200 + index * 60,
      price: 100 + (index % 7) / 10, averagePrice: 100, volume: index, session: 'regular' }));
    const data = { source: 'demo', symbol: 'NVDA.US', session: 'regular', days: 1, points, warnings: [], fetchedAt: '' };
    const series = chart.addSeries(LineSeries, { lineWidth: 1, lineType: LineType.Simple });
    series.setData(points.map(point => ({ time: point.time, value: point.price })));
    chart.addSeries(HistogramSeries, {}, 1).setData(intradayVolumeData(data, 'orange', 'green'));
    lockIntradayViewport(chart); fitIntradayViewport(chart, data);
    (window as any).fixedIntraday = { chart, series };
  });
  const chart = page.locator('#fixed-intraday-test');
  const read = () => page.evaluate(() => {
    const { chart, series } = (window as any).fixedIntraday;
    return { range: chart.timeScale().getVisibleLogicalRange(), price: series.priceToCoordinate(100.3),
      visible: chart.timeScale().getVisibleRange(), options: chart.options(), line: series.options().lineWidth };
  });
  try {
    await page.waitForTimeout(100);
    const before = await read();
    expect(before.visible.to).toBe(1792785600);
    expect(before.range.to - before.range.from).toBeGreaterThan(389);
    expect(before.line).toBe(1);
    expect(before.options.handleScale.pinch).toBe(false);
    expect(before.options.handleScroll.horzTouchDrag).toBe(false);
    await chart.hover({ position: { x: 250, y: 120 } });
    await page.mouse.wheel(0, -400); await page.mouse.wheel(100, 0);
    const box = (await chart.boundingBox())!;
    for (const [startX, startY, endX, endY] of [[250, 120, 450, 160], [770, 100, 770, 260], [200, 490, 450, 490]]) {
      await page.mouse.move(box.x + startX, box.y + startY); await page.mouse.down();
      await page.mouse.move(box.x + endX, box.y + endY, { steps: 8 }); await page.mouse.up();
    }
    await page.waitForTimeout(100);
    const after = await read();
    expect(after.range).toEqual(before.range);
    expect(after.price).toBeCloseTo(before.price, 4);
  } finally {
    await page.evaluate(() => { (window as any).fixedIntraday.chart.remove(); document.querySelector('#fixed-intraday-test')?.remove(); });
  }
});
