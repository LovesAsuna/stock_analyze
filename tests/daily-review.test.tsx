import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DailyReview } from '../src/DailyReview';
import { calculateIndicators } from '../shared/indicators';
import type { Candle, MarketData, Period } from '../shared/types';

/** 构造有区分度的柱；参数为UTC日期、价格与确认状态，返回合法OHLCV。 */
function candle(iso: string, price: number, confirmed = true): Candle {
  return { time: Date.parse(iso) / 1000, open: price, high: price + 1, low: price - 1, close: price, volume: 100, confirmed };
}

/** 渲染真实逐日组件；参数为柱、市场和周期，返回固定两周范围内的HTML。 */
function render(candles: Candle[], symbol = 'NVDA.US', period: Period = '15m'): string {
  const data: MarketData = { source: 'demo', symbol, period, candles, executions: [], fetchedAt: '2026-11-04T00:00:00Z',
    warnings: [], executionsComplete: true, executionRange: { start: '2026-10-26', end: '2026-11-07' }, adjustment: 'none' };
  const indicators = calculateIndicators(candles).map((point, index) => ({ ...point, fastMA: candles[index].close }));
  return renderToStaticMarkup(<DailyReview data={data} indicators={indicators} review={[]}
    start="2026-10-26" end="2026-11-07" onSelect={() => { throw new Error('静态渲染不能调用图表定位。'); }} />);
}

/** 定位受控HTML中的日期行；参数为渲染结果与MM-DD，返回对应行，缺失时明确失败。 */
function row(html: string, date: string): string {
  const found = html.match(/<tr>.*?<\/tr>/g)?.find(value => value.includes(date));
  if (!found) throw new Error(`逐日复盘缺少日期：${date}`);
  return found;
}

/** 最新已确认柱必须覆盖同日早柱，未确认尾柱和空白日不能冒充收盘。 */
test('逐日索引只选择每个中国工作日最后一根已确认柱', () => {
  const candles = [candle('2026-10-26T13:30:00Z', 101), candle('2026-10-26T13:45:00Z', 202),
    candle('2026-10-26T14:00:00Z', 999, false)];
  const html = render(candles);
  assert.ok(row(html, '10-26').includes('MA 202.00 /'));
  assert.ok(!row(html, '10-26').includes('MA 101.00 /'));
  assert.ok(!row(html, '10-26').includes('MA 999.00 /'));
  assert.ok(row(html, '10-27').includes('无已确认柱'));
  assert.equal(html.match(/class="text-button day-locate"/g)?.length, 1);
  const confirmed = render(candles.map(value => ({ ...value, confirmed: true })));
  assert.ok(row(confirmed, '10-26').includes('MA 999.00 /'));
});

/** 美股收盘跨中国日期并经历DST，港股维持当天，周末仍按既有工作日约定排除。 */
test('逐日归组保留港美股收盘、中国周末和夏令时语义', () => {
  const candles = [candle('2026-10-30T00:00:00Z', 303), candle('2026-11-02T00:00:00Z', 404)];
  const us = render(candles, 'NVDA.US', 'day');
  assert.ok(row(us, '10-30').includes('无已确认柱'));
  assert.ok(!us.includes('MA 303.00 /'));
  assert.ok(row(us, '11-02').includes('无已确认柱'));
  assert.ok(row(us, '11-03').includes('MA 404.00 /'));
  const hk = render(candles, '700.HK', 'day');
  assert.ok(row(hk, '10-30').includes('MA 303.00 /'));
  assert.ok(row(hk, '11-02').includes('MA 404.00 /'));
  assert.ok(row(hk, '11-03').includes('无已确认柱'));
});
