import test from 'node:test';
import assert from 'node:assert/strict';
import { exchangeParts, exchangeTimestamp, type IntradayData } from '../shared/intraday';
import { intradayTimeline, intradayVolumeData } from '../src/intraday-viewport';

/** 构造仅一真实点的未完盘快照。参数：代码、时段、本地时钟及日期；返回：固定数据源的分时数据。 */
function snapshot(symbol: string, session: IntradayData['session'], hour: number, minute: number, month = 10, day = 23): IntradayData {
  return { source: 'demo', symbol, session, days: 1, fetchedAt: '2026-10-23T16:00:00Z', warnings: [],
    points: [{ time: exchangeTimestamp({ year: 2026, month, day, hour, minute }, symbol),
      price: 100, volume: 25, averagePrice: 99, session: session === 'all' ? 'regular' : session }] };
}

for (const [month, expectedUTC] of [[7, 13], [12, 14]] as const) {
  test(`美股盘中完整固定时轴使用交易所时间，${month}月正确处理DST且未来只留白`, () => {
    const data = snapshot('NVDA.US', 'regular', 10, 12, month);
    const times = intradayTimeline(data);
    assert.equal(times.length, 391);
    assert.equal(new Date(times[0] * 1000).getUTCHours(), expectedUTC);
    assert.equal(exchangeParts(times[0], data.symbol).minute, 30);
    assert.equal(exchangeParts(times.at(-1)!, data.symbol).hour, 16);
    const volume = intradayVolumeData(data, 'orange', 'green');
    assert.equal(volume.filter(point => 'value' in point).length, 1);
    assert.deepEqual(volume.at(-1), { time: times.at(-1) });
    assert.equal(data.points.length, 1);
  });
}

test('港股固定时轴保留午休断线且不创造午间价格', () => {
  const data = snapshot('700.HK', 'regular', 10, 0);
  const times = intradayTimeline(data);
  assert.equal(times.length, 332);
  assert.ok(times.every(time => { const parts = exchangeParts(time, data.symbol); return parts.hour !== 12 || parts.minute === 0; }));
  assert.equal(exchangeParts(times.at(-1)!, data.symbol).hour, 16);
});

test('夜盘跨午夜仍为同一完整时段，五日不追加整日空白坐标', () => {
  const evening = snapshot('NVDA.US', 'overnight', 20, 5, 10, 22);
  const morning = snapshot('NVDA.US', 'overnight', 3, 5, 10, 23);
  assert.deepEqual(intradayTimeline(evening), intradayTimeline(morning));
  assert.equal(intradayTimeline(evening).length, 481);
  const five = { ...evening, days: 5 as const };
  assert.deepEqual(intradayTimeline(five), []);
  assert.equal(intradayVolumeData(five, 'orange', 'green').length, 1);
});
