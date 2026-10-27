import { test, expect, type Page } from '@playwright/test';

/**
 * 向当前测试事件流发送帧，控制错误和恢复次序。
 * @param page 当前浏览器页面。
 * @param events 待发送的原始事件帧，允许包含非法边界样本。
 * @returns 所有帧交给前端处理后的异步任务。
 */
async function emitStream(page: Page, events: unknown[]): Promise<void> {
  await page.evaluate(frames => window.dispatchEvent(new CustomEvent('market-stream-test', { detail: frames })), events);
}

/** 验证元数据决定更新说明、周期隔离和异常恢复；参数为浏览器与请求上下文，返回异步测试任务。 */
test('同步说明据实区分推送与快照，异常保留行情且不播报逐笔时间', async ({ page, request }) => {
  const response = await request.get('/api/market?source=demo&symbol=NVDA.US&period=day&start=2026-10-12&end=2026-10-17');
  const data = await response.json();
  await page.addInitScript(() => {
    class ControlledEventSource {
      onmessage: ((message: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      /** 接收手动帧；参数为测试自定义事件，返回无。 */
      listener = (event: Event) => {
        for (const frame of (event as CustomEvent<unknown[]>).detail) this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
      };
      /** 注册测试流；参数为同源订阅地址，返回实例。 */
      constructor(_url: string) { window.addEventListener('market-stream-test', this.listener); }
      /** 关闭旧订阅；无参数、无返回。 */
      close() { window.removeEventListener('market-stream-test', this.listener); }
    }
    window.EventSource = ControlledEventSource as unknown as typeof EventSource;
  });
  await page.route('**/api/workspace?source=longbridge', route => route.fulfill({ json: {
    source: 'longbridge', fetchedAt: new Date().toISOString(), securities: [], positions: [], positionsComplete: true, warnings: [],
  } }));
  await page.route('**/api/market?source=longbridge*', route => route.fulfill({ json: { ...data, source: 'longbridge' } }));
  await page.goto('/');
  await page.getByLabel('数据源', { exact: true }).selectOption('longbridge');
  const status = page.locator('.realtime-status');
  await expect(status).toContainText('报价：等待确认');
  const sync = { type: 'sync', symbol: 'NVDA.US', state: 'connected' };
  const quote = { type: 'quote', quote: { symbol: 'NVDA.US', price: 321.5, previousClose: 300, timestamp: 1792418437, session: 'regular' } };
  await emitStream(page, [{ type: 'status', symbol: 'NVDA.US', state: 'connected', message: '桌面WS已订阅，每5秒（仅诊断）' }, quote]);
  await expect(status).toContainText('报价：等待确认');
  await expect(status).toContainText('K线：等待确认');
  await expect(status.locator('details p')).not.toBeVisible();
  await emitStream(page, [
    { ...sync, channel: 'quote', transport: 'desktop-ws', mode: 'push' },
    { ...sync, channel: 'candles', transport: 'desktop-http', mode: 'snapshot', intervalMs: 1250, period: 'day' },
  ]);
  await expect(status).toContainText('报价：桌面WS · 实时推送');
  await expect(status).toContainText('K线：桌面HTTP · 每1.25秒快照');
  await expect(status.locator('.realtime-quote-time')).toContainText(/\d{2}:\d{2}:37/);
  await expect(status.getByRole('status')).toHaveAttribute('aria-atomic', 'true');
  await expect(status.getByRole('status')).not.toContainText('行情时间');
  await expect(status).not.toContainText('60秒');
  await emitStream(page, [
    { ...sync, channel: 'candles', transport: 'cli', mode: 'snapshot', intervalMs: 9000, period: 'week' },
    { ...sync, symbol: 'WRONG.US', channel: 'quote', transport: 'cli', mode: 'snapshot', intervalMs: 9000 },
  ]);
  await expect(status).toContainText('每1.25秒快照');
  await expect(status).toContainText('报价：桌面WS · 实时推送');
  await emitStream(page, [{ ...sync, channel: 'candles', transport: 'desktop-ws', mode: 'event', period: 'day' }]);
  await expect(status).toContainText('桌面推送触发更新（真实快照校正）');
  await emitStream(page, [{ ...sync, channel: 'quote', transport: 'desktop-ws', mode: 'push', intervalMs: 5000 }]);
  await expect(status.getByRole('status')).toContainText('恢复中');
  await expect(status.locator('.realtime-error')).toBeVisible();
  await expect(page.locator('.quote > strong')).toHaveText('321.50');
  await expect(status).toContainText('报价：桌面WS · 实时推送 · 恢复中');
  await emitStream(page, [
    { type: 'status', symbol: 'NVDA.US', state: 'connected', message: '连接已恢复（仅诊断）' },
    { ...sync, channel: 'quote', transport: 'desktop-ws', mode: 'push' },
    { ...sync, channel: 'candles', transport: 'desktop-ws', mode: 'event', period: 'day' },
  ]);
  await expect(status.getByRole('status')).toHaveText('实时行情 · 已连接');
  await expect(status.locator('.realtime-error')).toHaveCount(0);
  await expect(page.locator('.quote > strong')).toHaveText('321.50');
  await page.getByRole('button', { name: '周线', exact: true }).click();
  await expect(status).toContainText('报价：等待确认');
  await expect(status).toContainText('K线：等待确认');
  await emitStream(page, [{ ...sync, channel: 'quote', transport: 'cli', mode: 'snapshot', intervalMs: 7000, period: 'day' }]);
  await expect(status).toContainText('报价：等待确认');
  await emitStream(page, [{ ...sync, channel: 'quote', transport: 'cli', mode: 'snapshot', intervalMs: 7000, period: 'week' }]);
  await expect(status).toContainText('报价：CLI · 每7秒快照');
  await page.setViewportSize({ width: 375, height: 812 });
  await expect.poll(() => status.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});

/** 切换持仓期权及返回股票时建立独立事件流，失败不能锁死前端或要求整页刷新。 */
test('持仓期权订阅失败后切回股票无需刷新恢复行情', async ({ page, request }) => {
  const response = await request.get('/api/market?source=demo&symbol=NVDA.US&period=day&start=2026-10-12&end=2026-10-17');
  const data = await response.json();
  const symbols = ['NVDA.US', 'DRAM261218C100000.US', 'RKLB261218C100000.US'];
  const streams: string[] = [];
  let navigations = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations += 1; });
  await page.route('**/api/workspace?source=longbridge', route => route.fulfill({ json: {
    source: 'longbridge', fetchedAt: new Date().toISOString(), positionsComplete: true, warnings: [],
    securities: symbols.map(symbol => ({ symbol, name: symbol, market: 'US', currency: 'USD' })),
    positions: symbols.slice(1).map(symbol => ({ symbol, quantity: 1, available: 1, costPrice: 2, currency: 'USD' })),
  } }));
  await page.route('**/api/market?source=longbridge*', route => {
    const symbol = new URL(route.request().url()).searchParams.get('symbol');
    return route.fulfill({ json: { ...data, symbol, source: 'longbridge' } });
  });
  await page.route('**/api/stream?*', route => {
    const symbol = new URL(route.request().url()).searchParams.get('symbol')!;
    streams.push(symbol);
    const events = symbol === 'NVDA.US' ? [
      { type: 'status', symbol, state: 'connected', message: '股票行情已恢复（测试）' },
      { type: 'quote', quote: { symbol, price: 321.5, previousClose: 300, timestamp: Math.floor(Date.now() / 1000), session: 'regular' } },
    ] : [{ type: 'status', symbol, state: 'error', message: '当前合约订阅暂不可用，将自动重试（测试）' }];
    return route.fulfill({ contentType: 'text/event-stream', body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') });
  });
  await page.goto('/');
  await page.getByLabel('数据源', { exact: true }).selectOption('longbridge');
  await expect(page.locator('.quote > strong')).toHaveText('321.50');
  for (const symbol of symbols.slice(1)) {
    await page.locator('.security-row').filter({ hasText: symbol.replace('.US', '') }).click();
    await expect(page.locator('.security-identity h2')).toContainText(symbol);
    // 测试响应在发送错误帧后结束，真实EventSource可能已进入自动重连状态。
    await expect(page.locator('.realtime-status')).toContainText(/当前合约订阅暂不可用|恢复中/);
    await page.locator('.security-row').filter({ hasText: 'NVDA' }).click();
    await expect(page.locator('.realtime-status')).toContainText('行情时间（中国）');
    await expect(page.locator('.quote > strong')).toHaveText('321.50');
  }
  expect(streams).toEqual(['NVDA.US', symbols[1], 'NVDA.US', symbols[2], 'NVDA.US']);
  expect(navigations).toBe(1);
});

/** 通过同源SSE响应驱动真实EventSource，验证报价与原生K线使用不同数据口径。 */
test('实时价格与原生K线分别更新，切换演示源关闭真实订阅', async ({ page, request }) => {
  const response = await request.get('/api/market?source=demo&symbol=NVDA.US&period=day&start=2026-10-12&end=2026-10-17');
  const data = await response.json();
  const last = data.candles.at(-1);
  const quoteTime = Math.floor(Date.now() / 1000);
  const snapshot = { ...last, close: last.close + 1, high: Math.max(last.high, last.close + 1) };
  const frames = [
    { type: 'status', symbol: 'NVDA.US', state: 'connected', message: '桌面原生WS已订阅（测试）' },
    { type: 'quote', quote: { symbol: 'NVDA.US', price: 321.5, previousClose: 300, timestamp: quoteTime, session: 'regular' } },
    { type: 'quote', quote: { symbol: 'NVDA.US', price: 1, previousClose: 300, timestamp: quoteTime - 1, session: 'regular' } },
    { type: 'candles', symbol: 'NVDA.US', period: 'day', candles: [snapshot], receivedAt: new Date().toISOString() },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  await page.route('**/api/workspace?source=longbridge', route => route.fulfill({ json: {
    source: 'longbridge', fetchedAt: new Date().toISOString(), securities: [], positions: [], positionsComplete: true, warnings: [],
  } }));
  await page.route('**/api/market?source=longbridge*', route => route.fulfill({ json: { ...data, source: 'longbridge' } }));
  await page.route('**/api/stream?*', route => route.fulfill({ contentType: 'text/event-stream', body: frames }));
  await page.goto('/');
  await page.getByLabel('数据源', { exact: true }).selectOption('longbridge');
  await expect(page.locator('.quote > strong')).toHaveText('321.50');
  await expect(page.locator('.quote')).toContainText('较昨收');
  await expect(page.locator('.realtime-status')).toContainText('行情时间（中国）');
  await page.getByText('行情与指标数据表（最近 60 根）').click();
  await expect(page.locator('.data-details tbody tr').first()).toContainText(snapshot.close.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  await page.getByLabel('数据源', { exact: true }).selectOption('demo');
  await expect(page.locator('.realtime-status')).toHaveCount(0);
  await expect(page.locator('.quote > strong')).not.toHaveText('321.50');
});
