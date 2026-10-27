import { test, expect, type Page } from '@playwright/test';
import type { IntradayData, IntradayPoint, IntradaySession } from '../../shared/intraday';

interface TestStream { url: string; closed: boolean; send: (frames: unknown[]) => void }
type StreamWindow = Window & { intradayTestStreams: TestStream[] };
const baselineAt = '2026-10-23T13:32:00Z';
const updateAt = '2026-10-23T13:33:00Z';

/** 生成完整分钟点；参数为交易日、价格、成交量和时段，返回原始分钟快照。 */
function point(date: string, price: number, volume: number, session: 'regular' | 'pre' = 'regular'): IntradayPoint {
  return { time: Date.parse(`${date}T${session === 'pre' ? '12' : '13'}:30:00Z`) / 1000, price, volume, averagePrice: price, session };
}

/** 生成匹配HTTP请求的真实结构；参数为上下文、分钟点，返回分时基线。 */
function baseline(symbol: string, session: IntradaySession, days: 1 | 5, points: IntradayPoint[]): IntradayData {
  return { source: 'longbridge', symbol, session, days, points, fetchedAt: baselineAt, warnings: [] };
}

/** 注册受控事件源并保留旧实例，用于模拟关闭后仍排队的回调；参数为页面，返回初始化任务。 */
async function controlStreams(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as unknown as StreamWindow;
    target.intradayTestStreams = [];
    class ControlledEventSource {
      onmessage: ((message: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      record: TestStream;
      /** 保存订阅地址与消息发送器；参数为地址，返回测试实例。 */
      constructor(url: string) {
        this.record = { url, closed: false, send: frames => {
          for (const frame of frames) this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
        } };
        target.intradayTestStreams.push(this.record);
      }
      /** 标记关闭但保留已排队消息的发送器；无参数、无返回。 */
      close(): void { this.record.closed = true; }
    }
    window.EventSource = ControlledEventSource as unknown as typeof EventSource;
  });
}

/** 读取分时订阅地址与关闭状态；参数为页面，返回按建立顺序排列的分时实例信息。 */
async function streams(page: Page): Promise<{ url: string; closed: boolean }[]> {
  return page.evaluate(() => (window as unknown as StreamWindow).intradayTestStreams
    .filter(stream => stream.url.startsWith('/api/intraday-stream?')).map(({ url, closed }) => ({ url, closed })));
}

/** 向指定分时实例投递帧，关闭的旧实例也可投递；参数为页面、下标和事件，返回投递任务。 */
async function send(page: Page, index: number, frames: unknown[]): Promise<void> {
  await page.evaluate(({ streamIndex, events }) => {
    (window as unknown as StreamWindow).intradayTestStreams
      .filter(stream => stream.url.startsWith('/api/intraday-stream?'))[streamIndex].send(events);
  }, { streamIndex: index, events: frames });
}

/** 创建同一上下文的更新与来源帧；参数为证券、时段、分钟点，返回独立sync和points事件。 */
function update(symbol: string, session: IntradaySession, points: IntradayPoint[]): unknown[] {
  return [
    { type: 'sync', symbol, channel: 'intraday', transport: 'desktop-ws', mode: 'event', state: 'connected' },
    { type: 'points', symbol, session, points, receivedAt: updateAt },
  ];
}

/** 安装外围HTTP桩，分时请求由调用方精确控制；参数为页面、行情样本及处理器，返回路由设置任务。 */
async function mockApi(page: Page, market: unknown, intraday: (url: URL) => Promise<IntradayData>): Promise<void> {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/intraday') return route.fulfill({ json: await intraday(url) });
    if (url.pathname === '/api/market') return route.fulfill({ json: { ...(market as object), source: url.searchParams.get('source'), symbol: url.searchParams.get('symbol') } });
    if (url.pathname === '/api/workspace') return route.fulfill({ json: {
      source: url.searchParams.get('source'), fetchedAt: baselineAt, positionsComplete: true, warnings: [], positions: [],
      securities: ['NVDA.US', 'RKLB.US'].map(symbol => ({ symbol, name: symbol, market: 'US', currency: 'USD' })),
    } });
    return route.fulfill({ status: 503, json: { error: '测试中隔离外围接口。' } });
  });
}

/** 先推送再返回旧HTTP基线，验证五日历史保留、当前分钟替换以及状态元数据；返回异步测试任务。 */
test('分时推送先于HTTP仍保留最新值，同分钟成交量替换且五日历史完整', async ({ page, request }) => {
  const response = await request.get('/api/market?source=demo&symbol=NVDA.US&period=day&start=2026-10-12&end=2026-10-17');
  const market = await response.json();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const history = ['19', '20', '21', '22', '23'].map((day, index) => point(`2026-10-${day}`, 100 + index, 1000 + index));
  let requested = false;
  await controlStreams(page);
  await mockApi(page, market, async () => {
    requested = true; await gate;
    return baseline('NVDA.US', 'regular', 5, history);
  });
  await page.goto('/');
  await page.getByLabel('数据源', { exact: true }).selectOption('longbridge');
  await page.getByRole('button', { name: '5 日', exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  await expect.poll(async () => (await streams(page)).length).toBe(1);
  await expect(page.locator('.realtime-status')).toContainText('分时图：等待确认');
  const current = point('2026-10-23', 222.25, 1500);
  await send(page, 0, update('NVDA.US', 'regular', [current]));
  await expect(page.locator('.realtime-status')).toContainText('分时图：桌面WS · 桌面推送触发更新（真实快照校正）');
  release();
  await page.locator('.intraday-table summary').click();
  const rows = page.locator('.intraday-table tbody tr');
  await expect(rows).toHaveCount(5);
  await expect(rows.first().locator('td').nth(2)).toHaveText('100.000');
  await expect(rows.last().locator('td').nth(2)).toHaveText('222.250');
  await expect(rows.last().locator('td').nth(4)).toHaveText('1,500');
  await send(page, 0, update('NVDA.US', 'regular', [{ ...current, price: 223.5, volume: 1600 }]));
  await expect(rows).toHaveCount(5);
  await expect(rows.last().locator('td').nth(2)).toHaveText('223.500');
  await expect(rows.last().locator('td').nth(4)).toHaveText('1,600');
  await expect(rows.nth(3).locator('td').nth(2)).toHaveText('103.000');
});

/** 旧时段、旧证券的HTTP和排队SSE都不能覆盖当前图表或元数据；返回异步测试任务。 */
test('切换分时时段和证券隔离迟到HTTP与旧SSE回调', async ({ page, request }) => {
  const response = await request.get('/api/market?source=demo&symbol=NVDA.US&period=day&start=2026-10-12&end=2026-10-17');
  const market = await response.json();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requested: string[] = [];
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await controlStreams(page);
  await mockApi(page, market, async url => {
    const symbol = url.searchParams.get('symbol')!;
    const session = url.searchParams.get('session') as 'regular' | 'pre';
    requested.push(`${symbol}:${session}`);
    if (symbol === 'NVDA.US') await gate;
    return baseline(symbol, session, 1, [point('2026-10-23', symbol === 'NVDA.US' ? 999 : 44.5, 900, session)]);
  });
  await page.goto('/');
  await page.getByLabel('数据源', { exact: true }).selectOption('longbridge');
  await page.getByRole('button', { name: '盘中分时', exact: true }).click();
  await expect.poll(() => requested).toContain('NVDA.US:regular');
  await expect.poll(async () => (await streams(page)).length).toBe(1);
  await send(page, 0, update('NVDA.US', 'regular', [point('2026-10-23', 220, 800)]));
  await page.getByRole('button', { name: '展开分时时段菜单', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '盘前', exact: true }).click();
  await expect.poll(() => requested).toContain('NVDA.US:pre');
  await expect.poll(async () => (await streams(page)).length).toBe(2);
  await expect(page.locator('.realtime-status')).toContainText('分时图：等待确认');
  await send(page, 0, update('NVDA.US', 'regular', [point('2026-10-23', 777, 777)]));
  await expect(page.locator('.realtime-status')).toContainText('分时图：等待确认');
  await expect(page.locator('.intraday-notes')).toContainText('等待分时快照');
  await page.locator('.security-row').filter({ hasText: 'RKLB' }).click();
  await page.locator('.intraday-table summary').click();
  const rows = page.locator('.intraday-table tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('td').nth(2)).toHaveText('44.500');
  await expect.poll(async () => (await streams(page)).length).toBe(3);
  const subscriptions = await streams(page);
  expect(subscriptions.map(stream => stream.closed)).toEqual([true, true, false]);
  expect(new URL(subscriptions[2].url, 'http://localhost').searchParams.get('session')).toBe('pre');
  await send(page, 2, update('RKLB.US', 'pre', [point('2026-10-23', 45.75, 950, 'pre')]));
  await expect(rows.first().locator('td').nth(2)).toHaveText('45.750');
  await send(page, 0, update('NVDA.US', 'regular', [point('2026-10-23', 777, 777)]));
  await send(page, 1, [
    { type: 'sync', symbol: 'NVDA.US', channel: 'intraday', transport: 'cli', mode: 'snapshot', intervalMs: 9000, state: 'connected' },
    ...update('NVDA.US', 'pre', [point('2026-10-23', 888, 888, 'pre')]).slice(1),
  ]);
  release();
  await expect(page.locator('.security-identity h2')).toContainText('RKLB.US');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('td').nth(2)).toHaveText('45.750');
  await expect(rows.first().locator('td').nth(4)).toHaveText('950');
  await expect(page.locator('.realtime-status')).toContainText('分时图：桌面WS · 桌面推送触发更新（真实快照校正）');
  await expect(page.locator('.realtime-status')).not.toContainText('每9秒');
  expect(errors).toEqual([]);
});
