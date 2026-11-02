import { test, expect, type Page } from '@playwright/test';

/** 校验当前栏目同时提供视觉及无障碍状态。参数：page页面、section锚点；返回：断言完成Promise。 */
async function expectCurrent(page: Page, section: string): Promise<void> {
  const navigation = page.getByRole('navigation', { name: '工作台导航' });
  await expect(navigation.locator('a.active')).toHaveCount(1);
  await expect(navigation.locator(`a[href="#${section}"]`)).toHaveAttribute('aria-current', 'location');
  await expect(navigation.locator('a[aria-current="location"]')).toHaveCount(1);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1050 });
  await page.goto('/');
  await expect(page.locator('#strategy')).toBeVisible();
});

test('点击侧栏锚点随平滑滚动切换高亮，浏览器返回恢复当前位置', async ({ page }) => {
  await expectCurrent(page, 'analysis');
  const navigation = page.getByRole('navigation', { name: '工作台导航' });
  for (const section of ['strategy', 'review', 'analysis']) {
    await navigation.locator(`a[href="#${section}"]`).click();
    await expectCurrent(page, section);
  }
  await page.goBack();
  await expectCurrent(page, 'review');
  await page.screenshot({ path: 'artifacts/workspace-navigation-review.png' });
});

test('滚轮上下滚动同步栏目，忽略旧hash并在页尾保持复盘高亮', async ({ page }) => {
  await page.goto('/#analysis');
  await expect(page.locator('#strategy')).toBeVisible();
  // 在图表外滚动，避免图表自身的缩放手势消费滚轮。
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  await page.mouse.move(90, 200);
  for (const section of ['strategy', 'review', 'strategy', 'analysis']) {
    const delta = await page.locator(`#${section}`).evaluate(element => element.getBoundingClientRect().top - 20);
    await page.mouse.wheel(0, delta);
    await expectCurrent(page, section);
  }
  await page.mouse.wheel(0, 100000);
  await expectCurrent(page, 'review');
  await expect(page).toHaveURL(/#analysis$/);
});

test('直接打开复盘锚点及区域异步移除后重新计算高亮', async ({ page }) => {
  await page.goto('/#review');
  await expect(page.locator('#review')).toBeVisible();
  await expectCurrent(page, 'review');
  await page.locator('#analysis').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: '盘中分时', exact: true }).click();
  await expect(page.locator('#strategy')).toHaveCount(0);
  await expect(page.locator('#review')).toHaveCount(0);
  await expectCurrent(page, 'analysis');
});
