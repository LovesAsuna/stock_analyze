import { test, expect, type Page } from '@playwright/test';

/** 统计图表中波浪令牌的实际像素。参数：测试页面；返回：匹配线色的像素数，用于验证绘制及清除。 */
function wavePixelCount(page: Page): Promise<number> {
  return page.locator('.stock-chart').evaluate(host => {
    let count = 0;
    for (const canvas of host.querySelectorAll('canvas')) {
      const context = canvas.getContext('2d'); if (!context) continue;
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let offset = 0; offset < data.length; offset += 4) {
        if (Math.abs(data[offset] - 202) < 5 && Math.abs(data[offset + 1] - 108) < 5 && Math.abs(data[offset + 2] - 172) < 5) count++;
      }
    }
    return count;
  });
}

/** 使用已知推动浪样本替换演示K线，不接触真实行情。参数：无；返回：带确认尾部的OHLCV。 */
function fixtureCandles() {
  const prices = [110, 100, 120, 110, 145, 130, 155, 140, 149, 125, 138];
  return Array.from({ length: 81 }, (_, index) => {
    const segment = Math.min(Math.floor(index / 8), prices.length - 2);
    const close = prices[segment] + (prices[segment + 1] - prices[segment]) * (index - segment * 8) / 8;
    return { time: 1770000000 + index * 86400, open: close, close, high: close + 0.25, low: close - 0.25, volume: 1000, confirmed: true };
  });
}

test('K线波浪图层实际绘制、灵敏度、明细、关闭及分时隔离', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1536, height: 1200 });
  await page.route('**/api/market?**', async route => {
    const response = await route.fetch(); const data = await response.json();
    await route.fulfill({ response, json: { ...data, candles: fixtureCandles(), executions: [] } });
  });
  await page.goto('/');
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  await page.getByRole('button', { name: '展开指标', exact: true }).click();
  const toggle = page.getByRole('checkbox', { name: '自动埃略特波浪', exact: true });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  const result = page.getByLabel('埃略特波浪识别结果');
  await expect(result).toContainText('上涨推动浪候选 1–5 + A–B–C');
  await expect(result).toContainText('候选编号可能重绘');
  await expect(result).toContainText('分析窗口：');
  await expect(page.getByRole('slider', { name: '波浪窗口起点', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: '波浪窗口终点', exact: true })).toBeVisible();
  await expect(result).toContainText(/推动浪 2026\/\d{2}\/\d{2} → 2026\/\d{2}\/\d{2}/);
  await result.getByText('查看波浪拐点与确认时间').click();
  await expect(result.locator('tbody tr')).toHaveCount(9);
  await expect(result.locator('tbody tr').last()).toContainText('C');
  // 读取真实canvas颜色，确认折线已绘制，而不是只检查说明文字和复选框。
  await expect.poll(() => wavePixelCount(page)).toBeGreaterThan(50);
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await page.getByRole('button', { name: '缩小', exact: true }).click();
  await page.locator('.analysis-panel').screenshot({ path: 'artifacts/elliott-wave-candles.png' });
  await page.getByLabel('波浪灵敏度', { exact: true }).selectOption('12');
  await expect(result).toContainText('未找到符合规则');
  await page.getByLabel('波浪灵敏度', { exact: true }).selectOption('3');
  await expect(result).toContainText('上涨推动浪候选');
  await toggle.uncheck(); await expect(result).toHaveCount(0);
  await expect.poll(() => wavePixelCount(page)).toBe(0);
  await page.getByRole('button', { name: '盘中分时', exact: true }).click();
  await expect(page.locator('.intraday-chart canvas').first()).toBeVisible();
  await expect(toggle).toHaveCount(0); await expect(result).toHaveCount(0);
  await page.getByRole('button', { name: '日线', exact: true }).click();
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('窗口外旧浪不显示，主动选择历史窗口可识别；边界支持拖动及键盘', async ({ page }) => {
  await page.route('**/api/market?**', async route => {
    const response = await route.fetch(); const data = await response.json();
    const candles = fixtureCandles(); const latest = candles.at(-1)!;
    candles.push(...Array.from({ length: 120 }, (_, index) => ({ ...latest, time: latest.time + (index + 1) * 86400 })));
    await route.fulfill({ response, json: { ...data, candles, executions: [] } });
  });
  await page.goto('/');
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  await page.getByRole('button', { name: '展开指标', exact: true }).click();
  await page.getByRole('checkbox', { name: '自动埃略特波浪', exact: true }).check();
  const result = page.getByLabel('埃略特波浪识别结果');
  await expect(result).toContainText('所选窗口内未找到符合规则的标准推动浪');
  await expect(result).toContainText('不向窗口外寻找旧浪');
  await expect(result.locator('details')).toHaveCount(0);
  await expect.poll(() => wavePixelCount(page)).toBe(0);
  await page.getByLabel('波浪分析起点', { exact: true }).selectOption('0');
  await page.getByLabel('波浪分析终点', { exact: true }).selectOption('80');
  await expect(result).toContainText('上涨推动浪候选');
  await page.getByRole('button', { name: '适应全部', exact: true }).click();
  const start = page.getByRole('slider', { name: '波浪窗口起点', exact: true });
  await start.focus(); await start.press('ArrowRight');
  await expect(start).toHaveAttribute('aria-valuenow', '1');
  await start.press('ArrowLeft');
  await expect(start).toHaveAttribute('aria-valuenow', '0');
  const box = await start.boundingBox(); expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down(); await page.mouse.move(box!.x + box!.width / 2 + 70, box!.y + box!.height / 2, { steps: 8 });
  // 拖动只更新局部预览，日期控件与波浪结果在松手时才提交，避免高频整图计算。
  await expect.poll(async () => Number(await start.getAttribute('aria-valuenow'))).toBeGreaterThan(10);
  await expect(page.getByLabel('波浪分析起点', { exact: true })).toHaveValue('0');
  await expect(result).toContainText('上涨推动浪候选');
  await page.mouse.up();
  await expect.poll(async () => Number(await start.getAttribute('aria-valuenow'))).toBeGreaterThan(10);
  await expect(result).toContainText('所选窗口内未找到');
  await page.getByLabel('波浪分析起点', { exact: true }).selectOption('0');
  await expect.poll(() => wavePixelCount(page)).toBeGreaterThan(50);
  const end = page.getByRole('slider', { name: '波浪窗口终点', exact: true });
  await end.focus(); await end.press('Home');
  await expect(end).toHaveAttribute('aria-valuenow', '0');
  await expect(result).toContainText('所选窗口内未找到');
  await page.getByLabel('波浪分析终点', { exact: true }).selectOption('80');
  const beforeZoom = await end.boundingBox();
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await expect(end).toHaveAttribute('aria-valuenow', '80');
  await expect.poll(async () => Math.abs((await end.boundingBox())!.x - beforeZoom!.x)).toBeGreaterThan(1);
  await page.getByRole('button', { name: '缩小', exact: true }).click();
  await expect(page.getByLabel('波浪分析起点', { exact: true })).toHaveValue('0');
  await page.locator('.analysis-panel').screenshot({ path: 'artifacts/elliott-wave-window.png' });
  await page.getByRole('button', { name: '周线', exact: true }).click();
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  await page.getByRole('button', { name: '展开指标', exact: true }).click();
  const toggle = page.getByRole('checkbox', { name: '自动埃略特波浪', exact: true });
  await expect(toggle).not.toBeChecked(); await toggle.check();
  await expect(page.getByLabel('波浪分析终点', { exact: true })).toHaveValue('200');
});

test('窄屏与真实演示数据开启波浪不产生横向溢出或页面错误', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 375, height: 900 }); await page.goto('/');
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  await page.getByRole('button', { name: '展开指标', exact: true }).click();
  await page.getByRole('checkbox', { name: '自动埃略特波浪', exact: true }).check();
  await expect(page.getByLabel('埃略特波浪识别结果')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.analysis-panel').screenshot({ path: 'artifacts/elliott-wave-mobile.png' });
  expect(errors).toEqual([]);
});
