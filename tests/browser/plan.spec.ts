import { test, expect } from '@playwright/test';

/** 编辑、版本持久化、源隔离及路径读取覆盖同一规则的完整产品流程。 */
test('保存交易计划、查看历史路径并保持来源隔离', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('440 根 · 合成快照')).toBeVisible();
  await page.getByRole('button', { name: '建立交易计划', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑交易计划' });
  await dialog.getByLabel('计划名称', { exact: true }).fill('回踩后趋势计划');
  await dialog.getByText('观察价格与风险执行', { exact: true }).click();
  await dialog.getByLabel('观察入场价', { exact: false }).fill('100');
  await dialog.getByLabel('回测初始资金', { exact: false }).fill('100000');
  await dialog.getByRole('button', { name: '保存并回测' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.plan-toolbar')).toContainText('回踩后趋势计划');
  await expect(page.locator('.plan-toolbar')).toContainText('v2');
  await page.getByRole('button', { name: '价格路径', exact: true }).click();
  await expect(page.getByRole('img', { name: /历史交易入场后的价格路径/ })).toBeVisible();
  await page.getByLabel('路径检查柱数').fill('3');
  await expect(page.locator('.path-readout')).toContainText('第 3 根');
  await page.getByRole('button', { name: '规则检查', exact: true }).click();
  await expect(page.locator('.rule-checklist')).toContainText('100.00');
  await page.getByRole('button', { name: '开启本页监控', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止本页监控' })).toBeVisible();
  await page.getByRole('button', { name: '监控证据 0', exact: true }).click();
  await expect(page.locator('.alert-evidence')).toContainText('历史回测结果不会补发');
  await page.getByLabel('复盘时间范围').selectOption('month');
  await expect(page.getByRole('button', { name: '开启本页监控', exact: true })).toBeVisible();
  await expect(page.locator('.alert-evidence')).toContainText('本页监控已停止');
  await page.reload();
  await expect(page.locator('.plan-toolbar')).toContainText('回踩后趋势计划');
  await expect(page.getByRole('button', { name: '开启本页监控', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '1 小时', exact: true }).click();
  await expect(page.locator('.plan-toolbar')).toContainText('未保存模板');
  await page.getByRole('button', { name: '日线', exact: true }).click();
  await expect(page.locator('.plan-toolbar')).toContainText('回踩后趋势计划');
  await expect(page.getByRole('button', { name: '开启本页监控', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/plan-workbench-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

/** 模拟行情推进验证新提醒去重，并检查导出证据包含原始输入。 */
test('监控记录启用后的新信号，重复刷新不重复提醒', async ({ page, request }) => {
  const response = await request.get('/api/market?source=demo&symbol=NVDA.US&period=1h&start=2026-10-12&end=2026-10-17');
  const data = await response.json();
  const now = Math.floor(Date.now() / 1000);
  // 固定监控启用时钟，避免慢机器超过10秒后把测试信号判为启用前历史。
  await page.addInitScript((time) => { Date.now = () => time * 1000; }, now);
  const candle = { ...data.candles.at(-1), time: now - 3590, open: 100, close: 101, high: 102, low: 99, confirmed: false };
  data.candles.push(candle);
  let confirmed = false;
  await page.route('**/api/market?*', (route) => route.fulfill({ json: { ...data, candles: [...data.candles.slice(0, -1), { ...candle, confirmed }] } }));
  await page.goto('/');
  await page.getByRole('button', { name: '1 小时', exact: true }).click();
  await expect(page.locator('.chart-status')).toContainText('641 根');
  await page.getByRole('button', { name: '建立交易计划', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑交易计划' });
  const chinaStart = new Date((now - 60 + 8 * 3600) * 1000).toISOString().slice(0, 19);
  await dialog.getByLabel('生效时间（中国时间）', { exact: true }).fill(chinaStart);
  const entry = dialog.getByRole('group', { name: '入场条件', exact: true });
  await entry.getByRole('group').last().getByRole('button', { name: '移除条件 2' }).click();
  await entry.getByRole('combobox', { name: '左侧指标', exact: true }).selectOption('close');
  await entry.getByRole('combobox', { name: '右侧字段', exact: true }).selectOption('constant');
  await entry.getByLabel('阈值', { exact: true }).fill('0');
  await dialog.getByRole('button', { name: '保存并回测' }).click();
  await page.getByRole('button', { name: '开启本页监控', exact: true }).click();
  confirmed = true;
  await page.getByRole('button', { name: '刷新行情', exact: true }).click();
  await expect(page.getByRole('button', { name: '监控证据 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '刷新行情', exact: true }).click();
  await expect(page.getByRole('button', { name: '监控证据 1', exact: true })).toBeVisible();
  const events = await page.evaluate(() => JSON.parse(localStorage.getItem('market-lens-alerts-v1') ?? '[]'));
  expect(events).toHaveLength(1);
  expect(events[0].evidence.candle.close).toBe(101);
  expect(events[0].evidence.indicator.time).toBe(candle.time);
  expect(events[0].plan.revision).toBe(2);
});

/** 图上取价必须经过显式保存，取消草稿不改变生效规则。 */
test('图上取价进入草稿，取消后保留原计划', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('440 根 · 合成快照')).toBeVisible();
  await page.getByRole('button', { name: '取止损价', exact: true }).click();
  const chart = page.locator('.stock-chart');
  await chart.click({ position: { x: 150, y: 160 } });
  const dialog = page.getByRole('dialog', { name: '编辑交易计划' });
  await expect(dialog).toBeVisible();
  await dialog.getByText('观察价格与风险执行', { exact: true }).click();
  await expect(dialog.getByLabel('固定止损价', { exact: false })).not.toHaveValue('');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.plan-toolbar')).toContainText('未保存模板');
});

/** 手工期初应用后才能分类流水，清除后恢复未知。 */
test('成交流水使用手工期初而不反推当前持仓', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('440 根 · 合成快照')).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('NVDA.US / 700.HK').fill('700.HK');
  await page.keyboard.press('Enter');
  await page.getByLabel('复盘时间范围').selectOption('month');
  const ledger = page.locator('.execution-ledger');
  await expect(ledger.getByText('未知', { exact: true }).first()).toBeVisible();
  await ledger.getByText('设置期初仓位', { exact: true }).click();
  await ledger.getByLabel('手工期初数量', { exact: true }).fill('1000');
  await ledger.getByLabel('手工期初单位成本（可选）', { exact: true }).fill('400');
  await ledger.getByRole('button', { name: '应用手工期初快照', exact: true }).click();
  await expect(ledger.getByRole('status')).toContainText('可按手工期初');
  await ledger.getByRole('button', { name: '清除期初快照', exact: true }).click();
  await expect(ledger.getByRole('status')).toContainText('仓位状态未知');
});

for (const width of [320, 375, 414, 768]) {
  test(`交易计划编辑器在 ${width}px 可保存且没有横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByText('440 根 · 合成快照')).toBeVisible();
    await page.getByRole('button', { name: '建立交易计划', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '编辑交易计划' });
    await dialog.getByLabel('计划名称', { exact: true }).fill('移动端计划');
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/plan-editor-${width}.png` });
    await dialog.getByRole('button', { name: '保存并回测' }).click();
    await expect(page.locator('.plan-toolbar')).toContainText('移动端计划');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
