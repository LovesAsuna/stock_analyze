import { test, expect, type Page } from '@playwright/test';
import type { AuthStatus } from '../../shared/auth';

/** 安装不含真实令牌的认证桩。参数：页面；返回：可推进扫码结果、计数的控制器。 */
async function mockAuth(page: Page) {
  let status: AuthStatus = { state: 'idle', message: '尚未登录网页行情会话。', expiresAt: null, revision: 0 };
  const calls = { start: 0, cancel: 0, logout: 0 };
  await page.route('**/api/auth/**', async route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1);
    if (action === 'qr') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="280"><rect width="280" height="280" fill="white"/><path d="M40 40h80v80H40zM160 40h80v80h-80zM40 160h80v80H40z" fill="black"/></svg>' });
    if (action === 'start' || action === 'cancel' || action === 'logout') {
      expect(route.request().method()).toBe('POST');
      expect(route.request().headers()['x-market-lens']).toBe('1');
      expect(route.request().postDataJSON()).toEqual({});
      calls[action] += 1;
      status = action === 'start'
        ? { state: 'waiting', message: '请使用长桥 App 扫码，并在手机确认登录。', expiresAt: Date.now() + 90_000, revision: status.revision + 1 }
        : { state: 'idle', message: '本次网页会话已结束。', expiresAt: null, revision: status.revision + 1 };
    }
    return route.fulfill({ json: status });
  });
  return { calls, set: (next: Partial<AuthStatus>) => { status = { ...status, ...next }; } };
}

/** 扫码成功只更新原生会话入口，关闭成功弹窗不退出；退出为显式操作。 */
test('扫码登录、成功状态和显式退出', async ({ page }) => {
  const mock = await mockAuth(page);
  const errors: string[] = []; page.on('pageerror', failure => errors.push(failure.message));
  await page.goto('/');
  await page.getByRole('button', { name: '登录长桥', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '登录长桥', exact: true });
  await expect(dialog.getByRole('button', { name: '生成登录二维码' })).toBeEnabled();
  expect(mock.calls.start).toBe(0);
  await dialog.getByRole('button', { name: '生成登录二维码' }).click();
  await expect(dialog.getByRole('img', { name: '使用长桥 App 扫描此登录二维码' })).toBeVisible();
  await expect(dialog.locator('.auth-countdown')).toContainText('有效时间');
  await expect(dialog.locator('.auth-boundary')).toContainText('持仓与成交流水仍使用本机 CLI');
  mock.set({ state: 'success', message: '扫码登录成功，行情正在使用登录会话。', expiresAt: null });
  await expect(dialog.getByRole('heading', { name: '网页行情会话已登录' })).toBeVisible();
  await dialog.getByRole('button', { name: '返回工作台' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: '长桥已登录' })).toBeVisible();
  expect(mock.calls.logout).toBe(0);
  await page.getByRole('button', { name: '长桥已登录' }).click();
  await dialog.getByRole('button', { name: '退出本次登录' }).click();
  await expect(dialog.getByRole('button', { name: '生成登录二维码' })).toBeVisible();
  expect(mock.calls.logout).toBe(1);
  expect(errors).toEqual([]);
});

/** Esc关闭等待扫码必须先取消，焦点恢复到入口；过期与网络错误保持可重试。 */
test('关闭扫码先取消，并处理过期与读取错误', async ({ page }) => {
  const mock = await mockAuth(page);
  await page.goto('/');
  const entry = page.getByRole('button', { name: '登录长桥', exact: true });
  await entry.click();
  const dialog = page.getByRole('dialog', { name: '登录长桥', exact: true });
  await dialog.getByRole('button', { name: '生成登录二维码' }).click();
  await expect(dialog.getByRole('img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  expect(mock.calls.cancel).toBe(1);
  await expect(entry).toBeFocused();
  await entry.click();
  mock.set({ state: 'expired', message: '二维码已过期，请重新生成。', expiresAt: null });
  await expect(dialog.getByRole('heading', { name: '二维码已过期' })).toBeVisible();
  await dialog.getByRole('button', { name: '重新生成', exact: true }).click();
  await expect(dialog.getByRole('img')).toBeVisible();
  await page.route('**/api/auth/start', route => route.fulfill({ status: 503, json: { message: '不可用' } }));
  await dialog.getByRole('button', { name: '重新生成', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('HTTP 503');
  await expect(dialog.getByRole('button', { name: '重新生成', exact: true })).toBeEnabled();
});

/** 取消请求迟于生成返回时，旧状态不得重新打开二维码。 */
test('生成中可以取消，迟到的生成响应不会覆盖取消结果', async ({ page }) => {
  const mock = await mockAuth(page);
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/auth/start', async route => {
    await hold;
    await route.fulfill({ json: { state: 'waiting', message: '迟到响应', expiresAt: Date.now() + 90_000, revision: 1 } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '登录长桥', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '登录长桥', exact: true });
  await dialog.getByRole('button', { name: '生成登录二维码' }).click();
  await expect(dialog.getByRole('heading', { name: '正在生成二维码' })).toBeVisible();
  await dialog.getByRole('button', { name: '取消登录', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  release();
  await page.getByRole('button', { name: '登录长桥', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '生成登录二维码' })).toBeVisible();
  expect(mock.calls.cancel).toBe(1);
});

/** 创建请求结果未知时，关闭仍需服务端取消，避免遗留可写入的扫码流程。 */
test('生成请求网络失败后关闭仍取消可能存在的会话', async ({ page }) => {
  const mock = await mockAuth(page);
  await page.route('**/api/auth/start', route => route.abort('failed'));
  await page.goto('/');
  await page.getByRole('button', { name: '登录长桥', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '登录长桥', exact: true });
  await dialog.getByRole('button', { name: '生成登录二维码' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(mock.calls.cancel).toBe(1);
});

for (const width of [320, 375, 414, 768]) {
  /** 窄屏二维码、动作按钮和入口不得溢出，截图使用合成二维码。 */
  test(`扫码弹窗在 ${width}px 无横向溢出且按钮单行`, async ({ page }) => {
    await mockAuth(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: '登录长桥', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '登录长桥', exact: true });
    await dialog.getByRole('button', { name: '生成登录二维码' }).click();
    await expect(dialog.getByRole('img')).toBeVisible();
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const buttons = await dialog.locator('button').evaluateAll(elements => elements.every(element => {
      const style = getComputedStyle(element);
      return style.whiteSpace === 'nowrap' && element.getBoundingClientRect().height >= 44;
    }));
    expect(buttons).toBe(true);
    await page.screenshot({ path: `artifacts/login-dialog-${width}.png` });
    await page.keyboard.press('Escape');
  });
}
