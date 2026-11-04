import { test, expect } from '@playwright/test';

/** 全局和证券入口位于不同上下文，不预加载新闻；日历与资讯分别展示。 */
test('全局与个股事件入口独立、分类可筛选并正确返回焦点', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/events?')) requests.push(request.url()); });
  await page.goto('/');
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  expect(requests).toEqual([]);
  const globalEntry = page.locator('.topbar').getByRole('button', { name: '全局事件', exact: true });
  await globalEntry.click();
  let dialog = page.getByRole('dialog', { name: '全局事件', exact: true });
  await expect(dialog).toContainText('演示：央行政策会议日历');
  await expect(dialog).toContainText('日历与计划事件');
  await expect(dialog).toContainText('近期发布');
  await dialog.getByRole('button', { name: '新闻', exact: true }).click();
  await expect(dialog.locator('.market-event-card')).toHaveCount(2);
  await expect(dialog).not.toContainText('演示：央行政策会议日历');
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  await expect(globalEntry).toBeFocused();
  await page.locator('.chart-toolbar').getByRole('button', { name: '个股事件', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '个股事件', exact: true });
  await expect(dialog).toContainText('NVDA.US');
  await expect(dialog.locator('.market-event-card')).toHaveCount(3);
  await dialog.getByRole('button', { name: '财报', exact: true }).click();
  await expect(dialog.locator('.market-event-card')).toHaveCount(1);
  await expect(dialog).toContainText('时刻未提供');
  await dialog.getByRole('button', { name: '关闭个股事件', exact: true }).click();
  expect(requests.every(url => new URL(url).searchParams.get('source') === 'demo')).toBe(true);
});

/** 失败不混入演示内容，刷新可恢复；危险原文链接不能作为可点击导航。 */
test('事件失败重试、空状态及原文链接边界', async ({ page }) => {
  let mode = 'fail';
  await page.route('**/api/events?**', async route => {
    if (mode === 'fail') return route.fulfill({ status: 400, json: { error: '新闻服务暂不可用' } });
    const response = await route.fetch();
    const data = await response.json();
    data.events = mode === 'empty' ? [] : [{ ...data.events[0], title: '不安全链接样本', url: 'javascript:alert(1)' }];
    await route.fulfill({ response, json: data });
  });
  await page.goto('/'); await page.getByRole('button', { name: '全局事件', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '全局事件', exact: true });
  await expect(dialog).toContainText('新闻服务暂不可用');
  await expect(dialog.locator('.market-event-card')).toHaveCount(0);
  mode = 'empty'; await dialog.getByRole('button', { name: '重试事件', exact: true }).click();
  await expect(dialog).toContainText('当前范围没有可展示的事件');
  mode = 'unsafe'; await dialog.getByRole('button', { name: '刷新事件', exact: true }).click();
  await expect(dialog).toContainText('不安全链接样本');
  await expect(dialog.locator('.market-event-card a')).toHaveCount(0);
});

/** 换证券后新请求属于当前代码，抽屉不残留上一只股票的新闻。 */
test('个股事件随当前证券切换并清除旧内容', async ({ page }) => {
  await page.route('**/api/events?**', async route => {
    const response = await route.fetch(); const data = await response.json();
    const symbol = new URL(route.request().url()).searchParams.get('symbol');
    data.events.push({ ...data.events.find((event: { kind: string }) => event.kind === 'news'),
      id: `news:sina:${symbol}`, title: `测试多渠道新闻：${symbol}`, source: '新浪财经 个股新闻', symbol });
    data.sources = [{ label: '新浪财经 个股新闻', state: 'ok', count: 1 },
      { label: '雪球 个股新闻', state: 'error', count: 0 }];
    await route.fulfill({ response, json: data });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '个股事件', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '个股事件', exact: true });
  await expect(dialog).toContainText('演示：NVDA.US 季度业绩披露');
  await expect(dialog).toContainText('测试多渠道新闻：NVDA.US');
  await expect(dialog.getByRole('list', { name: '事件渠道状态' })).toContainText('雪球 个股新闻：读取失败');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '搜索港股、美股 Ctrl K', exact: true }).click();
  await page.getByPlaceholder('NVDA.US / 700.HK').fill('700.HK');
  await page.keyboard.press('Enter');
  await expect(page.locator('.security-identity h2')).toContainText('700.HK');
  await page.getByRole('button', { name: '个股事件', exact: true }).click();
  await expect(dialog).toContainText('演示：700.HK 季度业绩披露');
  await expect(dialog).toContainText('测试多渠道新闻：700.HK');
  await expect(dialog).not.toContainText('NVDA.US');
});

/** 部分来源失败不遮蔽成功事件；即使没有警告文案，也可检查来源状态和日期粒度。 */
test('多渠道状态区分失败与成功空列表，官方事件保留自然日', async ({ page }) => {
  await page.route('**/api/events?**', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.events = [{ ...data.events[0], id: 'macro:fec:2026-11-03', title: '测试：美国中期选举',
      source: '美国 FEC 官方选举日期', scheduledAt: '2026-11-03', publishedAt: null, dateOnly: true }];
    data.window = { start: '2026-10-27', end: '2026-12-03' };
    data.warnings = [];
    data.sources = [{ label: '美国 FEC 官方选举日期', state: 'ok', count: 1 },
      { label: '雪球快讯', state: 'error', count: 0 }, { label: '空渠道', state: 'ok', count: 0 }];
    await route.fulfill({ response, json: data });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '全局事件', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '全局事件', exact: true });
  const status = dialog.getByRole('list', { name: '事件渠道状态' });
  await expect(status).toContainText('美国 FEC 官方选举日期：已读取，窗口内 1 条');
  await expect(status).toContainText('雪球快讯：读取失败，当前结果未包含此渠道');
  await expect(status).toContainText('空渠道：已读取，窗口内 0 条');
  await expect(dialog.locator('.market-event-card')).toContainText('测试：美国中期选举');
  await expect(dialog.locator('.market-event-time')).toHaveText('计划发生：2026-11-03 · 时刻未提供');
  await dialog.locator('.market-event-card').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/events-multi-source.png' });
});

/** 持续报价必须更新价格，同时不重新计算已经加载的事件时间；刷新和分类仍须生效。 */
test('个股事件打开时实时报价不重复计算新闻列表', async ({ page, request }) => {
  const market = await (await request.get('/api/market?source=demo&symbol=NVDA.US&period=day&start=2026-10-12&end=2026-10-17')).json();
  const snapshot = await (await request.get('/api/events?source=demo&scope=security&symbol=NVDA.US')).json();
  const publishedAt = '2026-11-03T15:00:00Z';
  snapshot.source = 'longbridge'; snapshot.fetchedAt = '2026-11-03T16:00:00Z';
  snapshot.window = { start: '2026-10-27', end: '2026-12-03' };
  snapshot.events = Array.from({ length: 100 }, (_, index) => ({ ...snapshot.events.find((item: { kind: string }) => item.kind === 'news'),
    id: `performance-news-${index}`, title: `报价隔离测试新闻 ${index + 1}`, publishedAt, scheduledAt: null, dateOnly: false }));
  let eventRequests = 0;
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/market') return route.fulfill({ json: { ...market, source: url.searchParams.get('source') } });
    if (url.pathname === '/api/workspace') return route.fulfill({ json: {
      source: url.searchParams.get('source'), fetchedAt: snapshot.fetchedAt, securities: [], positions: [], positionsComplete: true, warnings: [],
    } });
    if (url.pathname === '/api/events') { eventRequests++; return route.fulfill({ json: snapshot }); }
    return route.fulfill({ status: 503, json: { error: '性能回归测试中隔离外围接口。' } });
  });
  await page.addInitScript(marker => {
    const target = window as unknown as Window & { eventDateReads: number; sendEventQuote: (price: number) => void };
    target.eventDateReads = 0;
    // 计数实际事件日期的解析，兼容格式器复用，避免把CPU耗时阈值当成稳定的回归断言。
    window.Date = new Proxy(Date, { construct(original, args, constructor) {
      if (args[0] === marker) target.eventDateReads++;
      return Reflect.construct(original, args, constructor);
    } });
    class ControlledEventSource {
      onmessage: ((event: MessageEvent) => void) | null = null;
      /** 注册只读报价发送器；无参数，返回受控事件源实例。 */
      constructor() {
        target.sendEventQuote = price => this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'quote',
          quote: { symbol: 'NVDA.US', price, previousClose: 200, timestamp: Math.floor(Date.now() / 1000), session: 'regular' } }) }));
      }
      /** 关闭后移除发送器；无参数，无返回值。 */
      close(): void { target.sendEventQuote = () => { throw new Error('测试事件流已经关闭。'); }; }
    }
    window.EventSource = ControlledEventSource as unknown as typeof EventSource;
  }, publishedAt);
  await page.goto('/');
  await page.getByLabel('数据源', { exact: true }).selectOption('longbridge');
  await expect(page.locator('.stock-chart canvas').first()).toBeVisible();
  await page.getByRole('button', { name: '个股事件', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '个股事件', exact: true });
  await expect(dialog.locator('.market-event-card')).toHaveCount(100);
  await expect(dialog.locator('.market-event-time').first()).toHaveText('发布：2026/11/3 23:00:00 北京时间');
  const reads = () => page.evaluate(() => (window as unknown as { eventDateReads: number }).eventDateReads);
  const initialReads = await reads(); expect(initialReads).toBeGreaterThanOrEqual(100);
  // 开发环境的StrictMode会重放首次请求；只断言报价期间不增加、手动刷新会增加。
  const initialRequests = eventRequests;
  for (const price of [201, 202, 203]) {
    await page.evaluate(value => (window as unknown as { sendEventQuote: (price: number) => void }).sendEventQuote(value), price);
    await expect(page.locator('.security-overview .quote > strong')).toHaveText(price.toFixed(2));
  }
  expect(await reads()).toBe(initialReads); expect(eventRequests).toBe(initialRequests);
  await dialog.getByRole('button', { name: '财报', exact: true }).click();
  await expect(dialog.locator('.market-event-card')).toHaveCount(0);
  await dialog.getByRole('button', { name: '新闻', exact: true }).click();
  await expect(dialog.locator('.market-event-card')).toHaveCount(100);
  await dialog.getByRole('button', { name: '刷新事件', exact: true }).click();
  await expect.poll(() => eventRequests).toBe(initialRequests + 1);
  await expect(dialog.locator('.market-event-card')).toHaveCount(100);
  await page.screenshot({ path: 'artifacts/events-quote-isolation.png' });
});

for (const width of [375, 1536]) {
  /** 全局各分组倒序，长列表只在抽屉内容中滚动，头部与分类保持可用。 */
  test(`${width}px全局倒序与单滚动区域`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/events?**', async route => {
      const response = await route.fetch();
      const data = await response.json();
      data.events = [1, 3, 2].map(day => ({ ...data.events[0], id: `macro-${day}`, title: `计划日${day}`, scheduledAt: `2026-10-0${day}T12:00:00Z` }));
      data.events.push(...Array.from({ length: 20 }, (_, index) => ({ ...data.events[0], id: `news-${index}`, title: `新闻${index}`, kind: 'news', scheduledAt: null, publishedAt: `2026-10-${String(index + 1).padStart(2, '0')}T12:00:00Z` })));
      await route.fulfill({ response, json: data });
    });
    await page.goto('/');
    const entry = page.getByRole('button', { name: '全局事件', exact: true });
    await entry.click();
    const dialog = page.getByRole('dialog', { name: '全局事件', exact: true });
    await expect(dialog.locator('.market-event-card')).toHaveCount(23);
    await expect(dialog.locator('.market-event-group').first().locator('.market-event-card h3')).toHaveText(['计划日3', '计划日2', '计划日1']);
    await expect(dialog.locator('.market-event-group').nth(1).locator('.market-event-card h3').first()).toHaveText('新闻19');
    const before = await dialog.evaluate(element => ({
      pageY: scrollY, headerTop: element.querySelector('.event-center-header')!.getBoundingClientRect().top,
      rootLocked: getComputedStyle(document.documentElement).overflowY === 'hidden',
      singleScroller: element.scrollHeight <= element.clientHeight,
    }));
    expect(before.rootLocked).toBe(true);
    expect(before.singleScroller).toBe(true);
    await dialog.locator('.event-center-content').evaluate(element => { element.scrollTop = 800; });
    const after = await dialog.evaluate(element => ({
      pageY: scrollY, headerTop: element.querySelector('.event-center-header')!.getBoundingClientRect().top,
      contentY: element.querySelector('.event-center-content')!.scrollTop,
      toolbarVisible: element.querySelector('.event-center-toolbar')!.getBoundingClientRect().top >= element.querySelector('.event-center-header')!.getBoundingClientRect().bottom - 1,
    }));
    expect(after.pageY).toBe(before.pageY);
    expect(after.headerTop).toBe(before.headerTop);
    expect(after.contentY).toBeGreaterThan(0);
    expect(after.toolbarVisible).toBe(true);
    await page.screenshot({ path: `artifacts/events-single-scroll-${width}.png` });
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).not.toBe('hidden');
    await expect(entry).toBeFocused();
  });
}

for (const width of [375, 1536]) {
  /** 带原文链接的真实长度标题及连续英文必须完整换行，不得撑出卡片。 */
  test(`${width}px长新闻链接在卡片内换行`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    await page.route('**/api/events?**', async route => {
      const response = await route.fetch();
      const data = await response.json();
      data.events = [
        '10月不加息，12月再出手？美联储抗通胀“慢加息”路径浮现，沃什下周讲话成最大看点',
        `公司公告与财经新闻：${'LongUnbrokenNewsIdentifier'.repeat(12)}`,
      ].map((title, index) => ({ ...data.events[1], id: `long-news-${index}`, title, url: 'https://example.com/news' }));
      await route.fulfill({ response, json: data });
    });
    await page.goto('/');
    await page.getByRole('button', { name: '全局事件', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '全局事件', exact: true });
    await dialog.getByRole('button', { name: '新闻', exact: true }).click();
    await expect(dialog.locator('.market-event-card a')).toHaveCount(2);
    const layout = await dialog.evaluate(element => ({
      inside: element.scrollWidth <= element.clientWidth,
      titles: [...element.querySelectorAll<HTMLElement>('.market-event-card h3')].every(title => {
        const bounds = title.getBoundingClientRect();
        const fragments = [...title.querySelector('a')!.getClientRects()];
        return title.scrollWidth <= title.clientWidth && fragments.every(fragment => fragment.right <= bounds.right + 1)
          && title.clientHeight > parseFloat(getComputedStyle(title).lineHeight) * 1.5;
      }),
    }));
    expect(layout).toEqual({ inside: true, titles: true });
    await page.screenshot({ path: `artifacts/events-long-news-${width}.png` });
  });
}

/** 月历数量跟随分类，日期选择与清除联动列表，跨月及键盘操作可用。 */
test('事件月历按显示日期计数并筛选当天列表', async ({ page }) => {
  // 当前日期不同于演示快照，验证“今天”来自时钟而不是 fetchedAt。
  await page.clock.setFixedTime(new Date('2026-10-25T02:00:00Z'));
  await page.goto('/');
  await page.getByRole('button', { name: '全局事件', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '全局事件', exact: true });
  const calendar = dialog.getByRole('region', { name: '事件月历', exact: true });
  await expect(calendar).toContainText('2026年10月');
  const today = calendar.locator('[aria-current="date"]');
  await expect(today).toHaveAttribute('aria-label', '2026-10-25，当前结果无条目');
  await expect(today).toContainText('今天');
  await expect(calendar.getByRole('button', { name: '2026-10-24，1条事件', exact: true })).toBeVisible();
  await calendar.getByRole('button', { name: '2026-10-29，1条事件', exact: true }).click();
  await expect(dialog.locator('.market-event-card')).toHaveCount(1);
  await expect(dialog).toContainText('演示：央行政策会议日历');
  await calendar.getByRole('button', { name: '查看全部日期', exact: true }).click();
  await expect(dialog.locator('.market-event-card')).toHaveCount(3);
  await dialog.getByRole('button', { name: '新闻', exact: true }).click();
  await expect(calendar.getByRole('button', { name: '2026-10-29，当前结果无条目', exact: true })).toBeEnabled();
  await calendar.getByRole('button', { name: '2026-10-24，1条事件', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.locator('.market-event-card')).toHaveCount(1);
  await expect(dialog.locator('.market-event-card')).toContainText('宏观政策与通胀动态');
  await calendar.getByRole('button', { name: '下个月', exact: true }).click();
  await expect(calendar).toContainText('2026年11月');
  await expect(calendar.getByRole('button', { name: '下个月', exact: true })).toBeDisabled();
  await expect(calendar.getByRole('button', { name: '2026-11-24，查询范围外', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '个股事件', exact: true }).click();
  const security = page.getByRole('dialog', { name: '个股事件', exact: true });
  await security.getByRole('button', { name: '2026-10-29，1条事件', exact: true }).click();
  await expect(security.locator('.market-event-card')).toHaveCount(1);
  await expect(security.locator('.market-event-card')).toContainText('时刻未提供');
});

for (const width of [320, 375, 414, 768, 1536]) {
  /** 小屏入口文字完整、抽屉内容局部滚动，不撑宽文档。 */
  test(`${width}px事件入口与抽屉无横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await page.getByRole('button', { name: '全局事件', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '全局事件', exact: true });
    await expect(dialog.locator('.market-event-card')).toHaveCount(3);
    const layout = await dialog.evaluate(element => ({
      root: document.documentElement.scrollWidth <= innerWidth,
      inside: element.scrollWidth <= element.clientWidth,
      edge: element.getBoundingClientRect().right <= innerWidth,
    }));
    expect(layout).toEqual({ root: true, inside: true, edge: true });
    await page.screenshot({ path: `artifacts/events-global-${width}.png` });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '个股事件', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '个股事件', exact: true })).toContainText('季度业绩披露');
  });
}
