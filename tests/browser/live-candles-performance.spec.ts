import { test, expect, type Page } from '@playwright/test';
import type { Candle, MarketData } from '../../shared/types';
import type { useRealtimeMarket } from '../../src/useRealtimeMarket';

interface Probe {
  live: ReturnType<typeof useRealtimeMarket>;
  data: MarketData | null;
  error: string;
}
type ProbeWindow = Window & { candleProbe: {
  current: Probe; previous: Probe; baseline: MarketData;
  emit: (frames: unknown[]) => void; fail: () => void; reload: () => void;
} };
const start = Date.parse('2026-10-19T13:30:00Z') / 1000;

/** 生成原生柱样本；参数为序号及确认状态，返回合法OHLCV。 */
function candle(index: number, confirmed = true): Candle {
  return { time: start + index * 900, open: 100, high: 110, low: 90, close: 100, volume: 1000, confirmed };
}

/** 包装原生快照；参数为柱和接收秒数，返回受控SSE事件。 */
function frame(candles: Candle[], second: number): unknown {
  return { type: 'candles', symbol: 'DRAM.US', period: '15m', candles,
    receivedAt: new Date((start + second) * 1000).toISOString() };
}

/** 安装受控事件源和HTTP基线并仅挂载目标hook；参数为页面和历史，返回就绪任务。 */
async function mountProbe(page: Page, candles: Candle[]): Promise<void> {
  const baseline: MarketData = { source: 'longbridge', symbol: 'DRAM.US', period: '15m', candles,
    fetchedAt: '2026-10-19T13:30:00Z', warnings: [], executions: [], executionsComplete: true,
    executionRange: { start: '2026-10-19', end: '2026-10-20' }, adjustment: 'none' };
  await page.addInitScript(() => {
    const target = window as unknown as ProbeWindow;
    target.candleProbe = {} as ProbeWindow['candleProbe'];
    class ControlledEventSource {
      onmessage: ((message: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      /** 注册受控推送；参数为订阅地址，返回测试事件源。 */
      constructor(_url: string) {
        target.candleProbe.emit = frames => {
          for (const item of frames) this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(item) }));
        };
        target.candleProbe.fail = () => this.onerror?.();
      }
      /** 清理订阅回调；无参数、无返回。 */
      close(): void { this.onmessage = null; this.onerror = null; }
    }
    window.EventSource = ControlledEventSource as unknown as typeof EventSource;
  });
  await page.route('**/api/**', route => new URL(route.request().url()).pathname === '/api/market'
    ? route.fulfill({ json: baseline }) : route.fulfill({ status: 503, json: { error: '外围接口已隔离。' } }));
  await page.route('**/__live-candles-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('/__live-candles-test');
  await page.evaluate(async () => {
    const reactPath = '/node_modules/.vite/deps/react.js';
    const domPath = '/node_modules/.vite/deps/react-dom_client.js';
    const hookPath = '/src/useRealtimeMarket.ts';
    const reactModule = await import(reactPath);
    const domModule = await import(domPath);
    const React = (reactModule.default ?? reactModule) as typeof import('react');
    const { createRoot } = (domModule.default ?? domModule) as typeof import('react-dom/client');
    const { useRealtimeMarket, useLiveMarketData } = await import(hookPath) as typeof import('../../src/useRealtimeMarket');
    const target = (window as unknown as ProbeWindow).candleProbe;
    /** 挂载真实hook并记录提交后的引用；无参数，返回空测试视图。 */
    function Harness() {
      const [data, setData] = React.useState<MarketData | null>(null);
      const live = useRealtimeMarket('longbridge', 'DRAM.US', '15m');
      const merged = useLiveMarketData(data, live);
      React.useEffect(() => {
        target.reload = () => { void fetch('/api/market').then(response => response.json()).then(value => {
          target.baseline = value; setData(value);
        }); };
        target.reload();
      }, []);
      React.useEffect(() => { target.current = { live, ...merged }; });
      return null;
    }
    createRoot(document.getElementById('root')!).render(React.createElement(Harness));
  });
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as ProbeWindow).candleProbe.current?.data))).toBe(true);
}

/** 保存已提交引用供后续比较；参数为页面，返回保存任务。 */
async function checkpoint(page: Page): Promise<void> {
  await page.evaluate(() => { const target = (window as unknown as ProbeWindow).candleProbe; target.previous = target.current; });
}

/** 投递测试帧；参数为页面和帧序列，返回投递任务。 */
async function emit(page: Page, frames: unknown[]): Promise<void> {
  await page.evaluate(items => (window as unknown as ProbeWindow).candleProbe.emit(items), frames);
}

/** 读取引用语义和状态；参数为页面，返回可跨进程序列化的断言值。 */
async function inspect(page: Page) {
  return page.evaluate(() => {
    const { current, previous, baseline } = (window as unknown as ProbeWindow).candleProbe;
    return {
      sameLive: current.live?.candles === previous?.live?.candles,
      sameData: current.data === previous?.data,
      sameCandles: current.data?.candles === previous?.data?.candles,
      sameFirst: current.data?.candles[0] === previous?.data?.candles[0],
      sameLast: current.data?.candles.at(-1) === previous?.data?.candles.at(-1),
      isBaseline: current.data === baseline, receivedAt: current.live?.receivedAt,
      state: current.live?.state, sync: current.live?.sync.candles?.state,
      message: current.live?.message, error: current.error,
      length: current.live?.candles.length, close: current.data?.candles.at(-1)?.close,
      volume: current.data?.candles.at(-1)?.volume, confirmed: current.data?.candles.at(-1)?.confirmed,
    };
  });
}

/** 验证重复、修订和状态事件彼此独立；参数为浏览器页面，返回测试任务。 */
test('相同原生快照保留hook与MarketData引用，修订和错误恢复仍传播', async ({ page }) => {
  const bars = [candle(0), candle(1, false)];
  await mountProbe(page, bars);
  const sync = { type: 'sync', symbol: 'DRAM.US', period: '15m', channel: 'candles',
    transport: 'desktop-ws', mode: 'event', state: 'connected' };
  const connected = { type: 'status', symbol: 'DRAM.US', state: 'connected', message: '已恢复' };
  await emit(page, [connected, sync, frame(bars, 1)]);
  await expect.poll(() => inspect(page)).toMatchObject({ isBaseline: true, length: 2, state: 'connected', sync: 'connected' });
  await checkpoint(page);
  await emit(page, [frame(bars, 2)]);
  await expect.poll(() => inspect(page)).toMatchObject({ sameLive: true, sameData: true, sameCandles: true,
    sameFirst: true, sameLast: true, receivedAt: new Date((start + 2) * 1000).toISOString() });
  const revised = { ...bars[1], volume: 2000, close: 105 };
  await emit(page, [frame([revised], 3)]);
  await expect.poll(() => inspect(page)).toMatchObject({ sameLive: false, sameData: false, sameFirst: true, sameLast: false, volume: 2000, close: 105 });
  await checkpoint(page);
  await emit(page, [frame([revised], 4)]);
  await expect.poll(() => inspect(page)).toMatchObject({ sameLive: true, sameData: true, sameLast: true,
    receivedAt: new Date((start + 4) * 1000).toISOString() });
  await emit(page, [{ type: 'quote', quote: { symbol: 'DRAM.US', price: 999, previousClose: 100, timestamp: start + 5, session: 'regular' } },
    frame([{ ...revised, high: 99 }], 5)]);
  await expect.poll(() => inspect(page)).toMatchObject({ sameLive: true, sameData: true, state: 'reconnecting', sync: 'reconnecting', close: 105 });
  await emit(page, [frame([revised], 6)]);
  await expect.poll(() => inspect(page)).toMatchObject({ sameLive: true, sameData: true, state: 'reconnecting', sync: 'reconnecting' });
  await emit(page, [connected, sync]);
  await expect.poll(() => inspect(page)).toMatchObject({ sameData: true, state: 'connected', sync: 'connected', message: '已恢复' });
  await page.evaluate(() => (window as unknown as ProbeWindow).candleProbe.fail());
  await expect.poll(() => inspect(page)).toMatchObject({ sameData: true, state: 'reconnecting', sync: 'reconnecting' });
  await emit(page, [{ type: 'bad-frame' }]);
  await expect.poll(() => inspect(page)).toMatchObject({ sameData: true, message: '实时事件格式无效，保留已知行情并等待重新同步。' });
  await emit(page, [connected, sync, frame([{ ...revised, confirmed: true }, candle(2, false)], 7)]);
  await expect.poll(() => inspect(page)).toMatchObject({ sameFirst: true, state: 'connected', sync: 'connected', length: 3 });
  await checkpoint(page);
  await emit(page, [frame([{ ...revised, confirmed: false }, candle(2, false)], 8)]);
  await expect.poll(() => inspect(page)).toMatchObject({ sameLive: true, sameData: true, sameCandles: true });
});

/** 验证截断只在超限发生，历史与实时之间的缺口持续可见且能够恢复；返回测试任务。 */
test('1000柱边界复用引用，历史缺口检测与HTTP恢复不会被缓存吞掉', async ({ page }) => {
  const bars = Array.from({ length: 1000 }, (_, index) => candle(index));
  await mountProbe(page, bars);
  await emit(page, [frame(bars, 1)]);
  await expect.poll(() => inspect(page)).toMatchObject({ length: 1000, isBaseline: true });
  await checkpoint(page);
  await emit(page, [frame(bars, 2)]);
  await expect.poll(() => inspect(page)).toMatchObject({ sameLive: true, sameData: true,
    receivedAt: new Date((start + 2) * 1000).toISOString() });
  await emit(page, [frame([candle(1000, false)], 3)]);
  await expect.poll(() => inspect(page)).toMatchObject({ length: 1000, sameLive: false, sameData: false, sameFirst: true });
  await checkpoint(page);
  await emit(page, [frame([candle(1000, false)], 4)]);
  await expect.poll(() => inspect(page)).toMatchObject({ sameLive: true, sameData: true,
    receivedAt: new Date((start + 4) * 1000).toISOString() });
  const misaligned = { source: 'longbridge', symbol: 'DRAM.US', period: '15m', candles: [candle(-1, false)],
    fetchedAt: '2026-10-19T13:30:00Z', warnings: [], executions: [], executionsComplete: true,
    executionRange: { start: '2026-10-19', end: '2026-10-20' }, adjustment: 'none' };
  await page.route('**/api/market', route => route.fulfill({ json: misaligned }));
  await page.evaluate(() => (window as unknown as ProbeWindow).candleProbe.reload());
  await expect.poll(() => inspect(page)).toMatchObject({ isBaseline: true, error: '实时K线与历史数据尚未对齐，保留历史快照并等待同步。' });
  await checkpoint(page);
  await emit(page, [frame([candle(1000, false)], 5)]);
  await expect.poll(() => inspect(page)).toMatchObject({ sameLive: true, sameData: true,
    error: '实时K线与历史数据尚未对齐，保留历史快照并等待同步。' });
  await page.unroute('**/api/market');
  await page.evaluate(() => (window as unknown as ProbeWindow).candleProbe.reload());
  await expect.poll(() => inspect(page)).toMatchObject({ error: '', length: 1000, sameLive: true, sameData: false });
});
