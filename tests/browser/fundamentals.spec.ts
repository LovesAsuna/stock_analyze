import { test, expect } from '@playwright/test';

/** 基本面在打开时加载，估值公式和同行表均可检查，切换不会影响主图和自选等高。 */
test('右侧基本面显示指标、同行与可审查的估值依据', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1100 });
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/fundamentals?')) requests.push(request.url()); });
  await page.goto('/');
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  expect(requests).toHaveLength(0);
  const before = await page.locator('.analysis-panel').boundingBox();
  await page.getByRole('button', { name: '基本面估值', exact: true }).click();
  const panel = page.getByRole('region', { name: 'NVDA.US 基本面分析', exact: true });
  await expect(panel.getByText('合成演示 · 非真实财报', { exact: true })).toBeVisible();
  await expect(panel.locator('.fundamental-financials dt').filter({ hasText: '净资产收益率 ROE' })).toBeVisible();
  await expect(panel.locator('.fundamental-peer-table tbody tr')).toHaveCount(5);
  const valuation = panel.locator('.fundamental-valuation-card').first();
  await valuation.locator('summary').click();
  await expect(valuation).toContainText('中位数对应价格 = 4.0000 × 同行中位数 25.00 = 100.00 USD');
  const alignment = await page.evaluate(() => {
    const chart = document.querySelector('.analysis-panel')!.getBoundingClientRect();
    const watchlist = document.querySelector('.watchlist-panel')!.getBoundingClientRect();
    const sidebar = document.querySelector('.research-sidebar')!.getBoundingClientRect();
    return { aligned: Math.abs(chart.bottom - watchlist.bottom) < 2, sidebarRight: sidebar.left >= chart.right,
      overflow: document.documentElement.scrollWidth > innerWidth, height: chart.height };
  });
  expect(alignment).toEqual({ aligned: true, sidebarRight: true, overflow: false, height: before!.height });
  await page.screenshot({ path: 'artifacts/fundamentals-desktop.png', fullPage: false });
  await page.getByRole('button', { name: '技术信号', exact: true }).click();
  await expect(page.getByRole('heading', { name: '信号解读', exact: true })).toBeVisible();
});

/** 失败保留来源，重试恢复；换证券时不展示旧基本面。 */
test('基本面错误可重试，切换证券取消旧快照', async ({ page }) => {
  let fail = true;
  await page.route('**/api/fundamentals?**', async route => {
    if (fail) await route.fulfill({ status: 400, json: { error: '财报权限暂不可用' } });
    else await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: '基本面估值', exact: true }).click();
  await expect(page.locator('.fundamentals-panel')).toContainText('财报权限暂不可用');
  await expect(page.locator('.fundamental-valuation-card')).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: '重试基本面', exact: true }).click();
  await expect(page.locator('.fundamental-valuation-card')).toHaveCount(3);
  await page.getByRole('button', { name: '搜索港股、美股 Ctrl K', exact: true }).click();
  await page.getByPlaceholder('NVDA.US / 700.HK').fill('700.HK'); await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: '700.HK 基本面分析', exact: true })).toContainText('HKD');
  await expect(page.locator('.fundamental-peer-table')).not.toContainText('NVDA.US');
});

/** 说明可由悬浮、键盘与点击触发，不被侧栏裁切，滚动更新位置，Escape可关闭。 */
test('核心指标悬浮说明解释含义、运用与限制', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1000 });
  await page.goto('/');
  await page.getByRole('button', { name: '基本面估值', exact: true }).click();
  const help = page.getByRole('button', { name: '市盈率 PE：含义与运用', exact: true });
  await help.hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toContainText('股价 ÷ 每股盈利');
  await expect(tooltip).toContainText('如何运用');
  await expect(tooltip).toContainText('亏损时不适用');
  await tooltip.hover();
  await expect(tooltip).toBeVisible();
  const box = (await tooltip.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1536);
  await page.keyboard.press('Escape'); await expect(tooltip).toHaveCount(0);
  await help.focus(); await expect(tooltip).toBeVisible();
  await expect(help).toHaveAttribute('aria-describedby', await tooltip.getAttribute('id') as string);
  await page.keyboard.press('Escape'); await expect(tooltip).toHaveCount(0);
  await help.click(); await expect(tooltip).toBeVisible();
  await page.screenshot({ path: 'artifacts/fundamentals-metric-help.png' });
  await page.locator('.fundamentals-panel').evaluate(element => { element.scrollTop += 100; });
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tooltip).toHaveCount(0);
  await page.setViewportSize({ width: 375, height: 1000 });
  const cashFlowHelp = page.getByRole('button', { name: '经营现金流：含义与运用', exact: true });
  await cashFlowHelp.click();
  await expect(tooltip).toContainText('不等于自由现金流');
  const mobileBox = (await tooltip.boundingBox())!;
  expect(mobileBox.x).toBeGreaterThanOrEqual(0);
  expect(mobileBox.x + mobileBox.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

/** 小屏使用文档正常滚动，同行表仅在自身范围滚动。 */
test('375px基本面栏目可展开且无页面横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 1000 });
  await page.goto('/');
  await page.getByRole('button', { name: '基本面估值', exact: true }).click();
  await expect(page.locator('.fundamental-valuation-card')).toHaveCount(3);
  await page.locator('.fundamental-valuation-card').first().locator('summary').click();
  await page.locator('.fundamental-section-heading').first().click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.research-sidebar').screenshot({ path: 'artifacts/fundamentals-mobile.png' });
});
