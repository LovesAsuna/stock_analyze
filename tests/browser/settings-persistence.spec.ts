import { test, expect, type Page } from '@playwright/test';

/** 仅在测试中暴露图表公开API。参数：页面；返回：无，不增加生产调试入口。 */
async function inspectViewport(page: Page) {
  await page.route('**/src/Chart.tsx*', async route => {
    const response = await route.fetch(); const body = await response.text(); const marker = 'const price = chart.addSeries(';
    expect(body).toContain(marker);
    await route.fulfill({ response, body: body.replace(marker, `window.settingsChart = chart; ${marker}`) });
  });
}

/** 读取当前公开逻辑范围。参数：页面；返回：图表可视跨度。 */
function span(page: Page) {
  return page.evaluate(() => {
    const chart = (window as unknown as { settingsChart: import('lightweight-charts').IChartApi }).settingsChart;
    const range = chart.timeScale().getVisibleLogicalRange(); return range ? range.to - range.from : 0;
  });
}

/** 主工作台、指标和波浪须跨刷新恢复，日周缩放记录相互独立。 */
test('证券、复盘、指标、波浪和手动缩放跨刷新恢复', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await inspectViewport(page); await page.setViewportSize({ width: 1536, height: 1200 }); await page.goto('/');
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  await page.keyboard.press('Control+k'); await page.getByPlaceholder('NVDA.US / 700.HK').fill('RKLB.US'); await page.keyboard.press('Enter');
  await expect(page.locator('.security-overview')).toContainText('RKLB');
  await page.getByLabel('复盘时间范围').selectOption('custom');
  await page.getByLabel('开始', { exact: true }).fill('2026-10-01');
  await page.getByLabel('结束（不含）', { exact: true }).fill('2026-10-20');
  await page.getByRole('button', { name: '应用', exact: true }).click();
  await page.getByRole('button', { name: '展开指标', exact: true }).click();
  await page.getByRole('checkbox', { name: 'MA 5 / 10 / 20 / 50（图表）', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'SAR', exact: true }).check();
  await page.getByRole('checkbox', { name: 'BOLL', exact: true }).check();
  await page.getByRole('checkbox', { name: '策略信号', exact: true }).uncheck();
  await page.getByLabel('技术指标副图').selectOption('rsi');
  await page.getByRole('checkbox', { name: '自动埃略特波浪', exact: true }).check();
  await page.getByLabel('波浪灵敏度', { exact: true }).selectOption('3');
  await page.getByLabel('波浪分析起点', { exact: true }).selectOption('300');
  await page.getByLabel('波浪分析终点', { exact: true }).selectOption('400');
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await expect.poll(() => span(page)).toBeLessThan(20); const zoomed = await span(page);
  await page.reload(); await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  await expect(page.locator('.security-overview')).toContainText('RKLB');
  await expect(page.getByLabel('复盘时间范围')).toHaveValue('custom');
  await expect(page.locator('.range-label')).toHaveText('10-01 — 10-20 不含');
  await expect(page.getByRole('checkbox', { name: 'MA 5 / 10 / 20 / 50（图表）', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'SAR', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'BOLL', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: '策略信号', exact: true })).not.toBeChecked();
  await expect(page.getByLabel('技术指标副图')).toHaveValue('rsi');
  await expect(page.getByLabel('波浪灵敏度', { exact: true })).toHaveValue('3');
  await expect(page.getByLabel('波浪分析起点', { exact: true })).toHaveValue('300');
  await expect(page.getByLabel('波浪分析终点', { exact: true })).toHaveValue('400');
  await expect.poll(() => span(page)).toBeCloseTo(zoomed, 4);
  await page.getByRole('button', { name: '周线', exact: true }).click();
  await expect.poll(() => span(page)).toBeGreaterThan(50);
  await page.reload(); await expect(page.getByRole('button', { name: '周线', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '日线', exact: true }).click();
  await expect.poll(() => span(page)).toBeCloseTo(zoomed, 4);
  await expect(page.getByLabel('波浪分析起点', { exact: true })).toHaveValue('300');
  await page.locator('.analysis-panel').screenshot({ path: 'artifacts/settings-persistence.png' });
  expect(errors).toEqual([]);
});

/** 真实模式使用受控数据，不连接账户；重开恢复来源，分时视图和指标不退回默认。 */
test('来源和分时设置刷新恢复且空闲期间不重复写存储', async ({ page, request }) => {
  const response = await request.get('/api/market?source=demo&symbol=NVDA.US&period=day&start=2026-10-12&end=2026-10-17');
  const market = await response.json();
  await page.addInitScript(() => {
    class OfflineEventSource { onmessage = null; close() {} }
    window.EventSource = OfflineEventSource as unknown as typeof EventSource;
    const original = Storage.prototype.setItem;
    (window as unknown as { settingsWrites: number }).settingsWrites = 0;
    Storage.prototype.setItem = function (key, value) {
      (window as unknown as { settingsWrites: number }).settingsWrites++; return original.call(this, key, value);
    };
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/market') return route.fulfill({ json: { ...market, source: url.searchParams.get('source') } });
    if (url.pathname === '/api/workspace') return route.fulfill({ json: {
      source: url.searchParams.get('source'), fetchedAt: market.fetchedAt, securities: [], positions: [], positionsComplete: true, warnings: [],
    } });
    if (url.pathname === '/api/intraday') {
      url.searchParams.set('source', 'demo'); const fixture = await route.fetch({ url: url.toString() });
      const data = await fixture.json(); return route.fulfill({ json: { ...data, source: new URL(route.request().url()).searchParams.get('source') } });
    }
    return route.fulfill({ status: 503, json: { error: '设置测试隔离外围接口。' } });
  });
  await page.goto('/'); await page.getByLabel('数据源', { exact: true }).selectOption('longbridge');
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  await page.reload(); await expect(page.getByLabel('数据源', { exact: true })).toHaveValue('longbridge');
  await page.getByRole('button', { name: '展开分时时段菜单', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '盘前', exact: true }).click();
  await expect(page.locator('.intraday-chart canvas').first()).toBeVisible();
  await page.getByRole('button', { name: '展开指标', exact: true }).click();
  await page.getByRole('checkbox', { name: 'RSI (6 / 12 / 24)', exact: true }).uncheck();
  await page.reload(); await expect(page.locator('.intraday-chart canvas').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '盘前分时', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('checkbox', { name: 'RSI (6 / 12 / 24)', exact: true })).not.toBeChecked();
  // 两帧渲染和读取不会产生设置写入；设置已在pagehide提交，无需用耗时阈值判断。
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => (window as unknown as { settingsWrites: number }).settingsWrites)).toBe(0);
});

/** 栏目和分类属于用户偏好，关闭抽屉及刷新均保留，弹窗本身不自动打开。 */
test('市场过滤、研究栏目、策略栏目和事件分类保留', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  await page.locator('.watchlist-market-tabs').getByRole('button', { name: '美股', exact: true }).click();
  await page.getByRole('button', { name: '基本面估值', exact: true }).click();
  await page.getByRole('button', { name: '规则检查', exact: true }).click();
  await page.getByRole('button', { name: '全局事件', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '全局事件', exact: true });
  await drawer.getByRole('button', { name: '新闻', exact: true }).click();
  await page.keyboard.press('Escape'); await page.reload();
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  await expect(page.locator('.watchlist-market-tabs').getByRole('button', { name: '美股', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '基本面估值', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '规则检查', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(drawer).not.toBeVisible();
  await page.getByRole('button', { name: '全局事件', exact: true }).click();
  await expect(drawer.getByRole('button', { name: '新闻', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

/** 损坏内容和拒写时须明确提示，当前页仍可调整。 */
test('损坏设置安全回退，禁止存储时保留本页调整并显示提示', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('market-lens-workspace-v1', '{broken');
    Storage.prototype.setItem = () => { throw new DOMException('disabled', 'SecurityError'); };
  });
  await page.goto('/'); await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  await expect(page.getByText('部分本机设置无法读取，已使用默认值。重新调整后可再次保存。', { exact: true })).toBeVisible();
  await page.getByLabel('复盘时间范围').selectOption('month');
  await expect(page.getByLabel('复盘时间范围')).toHaveValue('month');
  await expect(page.getByText('设置已应用，但无法保存到浏览器；刷新后可能丢失，请检查本地存储权限或空间。', { exact: true })).toBeVisible();
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
});
