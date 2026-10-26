import { defineConfig } from '@playwright/test';

/** 使用已安装的本机 Chrome 驱动工作台，避免额外下载浏览器。 */
export default defineConfig({
  testDir: './tests/browser', timeout: 45_000, workers: 1,
  testIgnore: process.env.LONGBRIDGE_LIVE_TEST === '1' ? [] : ['**/live.spec.ts'],
  use: { baseURL: 'http://127.0.0.1:5173', browserName: 'chromium', channel: 'chrome', headless: true },
  reporter: 'list',
});
