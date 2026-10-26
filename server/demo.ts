import type { Candle, Execution, MarketData, Period, Security, Workspace } from '../shared/types.js';
import { calculateIndicators } from '../shared/indicators.js';
import { generateSignals } from '../shared/signals.js';
import { barOpenTime, signalConfirmationTime } from '../shared/review.js';
import { periodSeconds, isCalendarPeriod } from '../shared/periods.js';
import { exchangeTimestamp, validateIntradaySelection } from '../shared/intraday.js';
import type { IntradayData, IntradayPoint, IntradaySession } from '../shared/intraday.js';
import { normalizeSymbol } from './longbridge.js';

export const DEMO_SECURITIES: Security[] = [
  { symbol: 'NVDA.US', name: '英伟达', market: 'US', currency: 'USD' },
  { symbol: 'AAPL.US', name: '苹果', market: 'US', currency: 'USD' },
  { symbol: 'TSLA.US', name: '特斯拉', market: 'US', currency: 'USD' },
  { symbol: '700.HK', name: '腾讯控股', market: 'HK', currency: 'HKD' },
  { symbol: '9988.HK', name: '阿里巴巴', market: 'HK', currency: 'HKD' },
  { symbol: '2228.HK', name: '晶泰控股', market: 'HK', currency: 'HKD' },
];

/** 生成可重复的合成行情。参数为代码和周期，返回 OHLCV；不引用任何真实历史价格。 */
export function demoCandles(symbol: string, period: Period): Candle[] {
  symbol = normalizeSymbol(symbol);
  const seed = [...symbol].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  const base = symbol === '2228.HK' ? 6 : symbol === '700.HK' ? 420 : 90 + seed % 130;
  if (isCalendarPeriod(period) && period !== 'day') return calendarDemoCandles(symbol, period, seed, base);
  const step = periodSeconds(period) ?? 86400;
  const count = period === 'day' ? 440 : 640;
  const timestamps: number[] = [];
  let cursor = Date.parse('2026-10-16T00:00:00Z') / 1000;
  while (timestamps.length < count) {
    const weekday = new Date(cursor * 1000).getUTCDay();
    if (weekday > 0 && weekday < 6) {
      const openTime = barOpenTime(cursor, symbol, 'day');
      const isHK = symbol.endsWith('.HK');
      const offsets = period === 'day' ? [0] : Array.from({ length: Math.ceil(6.5 * 3600 / step) }, (_, index) => index * step)
        .filter((offset) => !isHK || offset < 2.5 * 3600 || offset >= 3.5 * 3600);
      timestamps.unshift(...offsets.map((offset) => openTime + offset));
    }
    cursor -= 86400;
  }
  timestamps.splice(0, timestamps.length - count);
  let previousClose = base;
  return timestamps.map((time, index) => {
    const wave = Math.sin(index / 10.5 + seed / 35) * 0.009;
    const noise = Math.sin(index * 2.37 + seed) * 0.004;
    const close = Math.max(base * 0.3, previousClose * (1 + 0.00065 + wave + noise));
    const open = previousClose * (1 + Math.sin(index * 1.7) * 0.003);
    const candle: Candle = {
      time, open, close, high: Math.max(open, close) * (1.004 + Math.abs(noise)),
      low: Math.min(open, close) * (0.996 - Math.abs(noise)),
      volume: Math.round((1_000_000 + seed * 4500) * (0.7 + Math.abs(Math.sin(index * 1.3)) * 0.8)),
      confirmed: true,
    };
    previousClose = close;
    return candle;
  });
}

/**
 * 生成确定性日历周期样本，不虚构200年历史；当前周期依固定演示截止时间确认。
 * @param symbol 证券代码。
 * @param period 周、月、季、年周期。
 * @param seed 证券确定性种子。
 * @param base 合成基价。
 * @returns 按周期首日标签排序的合成柱。
 */
function calendarDemoCandles(symbol: string, period: Period, seed: number, base: number): Candle[] {
  const count = period === 'year' ? 26 : period === 'quarter' ? 104 : 240;
  const anchor = new Date('2026-10-16T00:00:00Z');
  anchor.setUTCDate(period === 'week' ? anchor.getUTCDate() - (anchor.getUTCDay() + 6) % 7 : 1);
  if (period === 'quarter') anchor.setUTCMonth(9);
  if (period === 'year') anchor.setUTCMonth(0);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(anchor);
    const distance = count - 1 - index;
    if (period === 'week') date.setUTCDate(date.getUTCDate() - 7 * distance);
    else date.setUTCMonth(date.getUTCMonth() - distance * (period === 'year' ? 12 : period === 'quarter' ? 3 : 1));
    const time = date.getTime() / 1000;
    const open = base * (0.6 + index / count * 0.6 + Math.sin(index / 7 + seed) * 0.05);
    const close = open * (1 + Math.sin(index * 1.71 + seed) * 0.06);
    return { time, open, close, high: Math.max(open, close) * 1.03, low: Math.min(open, close) * 0.97,
      volume: Math.round((1_000_000 + seed * 4500) * (period === 'year' ? 240 : period === 'quarter' ? 60 : period === 'month' ? 20 : 5)),
      confirmed: signalConfirmationTime(time, symbol, period) < Date.parse('2026-10-17T00:00:00Z') / 1000 };
  });
}

/** 返回明确标记的演示工作区；模拟持仓与用户的任何历史账户无关。 */
export function demoWorkspace(): Workspace {
  return {
    source: 'demo', fetchedAt: new Date().toISOString(), securities: DEMO_SECURITIES,
    positions: DEMO_SECURITIES.filter((_, index) => index % 2 === 0).map((security) => {
      const candles = demoCandles(security.symbol, 'day');
      return { symbol: security.symbol, quantity: security.market === 'HK' ? 2000 : 100,
        available: security.market === 'HK' ? 2000 : 100,
        costPrice: candles.at(-15)!.close, currency: security.currency };
    }),
    positionsComplete: true,
    warnings: ['演示行情、持仓、成交均为合成数据，不对应真实市场或你的账户。演示截止 2026-10-16。'],
  };
}

/** 生成演示行情及部分模拟成交，返回与真实数据源相同的数据契约。 */
export function demoMarket(symbol: string, period: Period, start: string, end: string): MarketData {
  symbol = normalizeSymbol(symbol);
  const candles = demoCandles(symbol, period);
  const signals = generateSignals(candles, calculateIndicators(candles));
  const executions: Execution[] = signals.filter((signal, index) => index % 3 !== 1 && signal.eligibleTime)
    .map((signal, index) => ({ id: `demo-${index}`, symbol, side: signal.side,
      time: barOpenTime(signal.eligibleTime!, symbol, period) + 5,
      price: signal.referencePrice! * (signal.side === 'buy' ? 1.001 : 0.999), quantity: 100 }))
    .filter((execution) => execution.time >= Date.parse(`${start}T00:00:00+08:00`) / 1000
      && execution.time < Date.parse(`${end}T00:00:00+08:00`) / 1000);
  return { source: 'demo', symbol, period, candles, executions,
    fetchedAt: new Date().toISOString(), warnings: ['合成数据仅用于体验功能；指标和复盘结论不代表真实行情。'],
    executionsComplete: true, executionRange: { start, end }, adjustment: 'none' };
}

/** 生成单日合成分时，参数为代码、本地日期、时段及日序，返回固定一分钟间隔样本。 */
function demoIntradayPoints(symbol: string, date: Date, session: IntradaySession, dayIndex: number): IntradayPoint[] {
  const isHK = symbol.endsWith('.HK');
  const ranges: Array<{ session: IntradayPoint['session']; start: number; end: number }> = isHK
    ? [{ session: 'regular', start: 570, end: 720 }, { session: 'regular', start: 780, end: 960 }]
    : [{ session: 'overnight', start: -240, end: 240 }, { session: 'pre', start: 240, end: 570 },
      { session: 'regular', start: 570, end: 960 }, { session: 'post', start: 960, end: 1200 }];
  const seed = [...symbol].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  const base = symbol === '2228.HK' ? 6 : 80 + seed % 170;
  const result: IntradayPoint[] = [];
  let weighted = 0;
  let totalVolume = 0;
  for (const range of ranges.filter((candidate) => session === 'all' || candidate.session === session)) {
    for (let minute = range.start; minute < range.end; minute += 1) {
      // 仅合成演示增加确定性的分钟扰动，呈现折线波动；真实行情沿用上游原始价格。
      const mixedMinute = Math.imul(minute + 1440 + seed, 0x45d9f3b);
      const noiseSeed = Math.imul(mixedMinute ^ (mixedMinute >>> 16), 0x45d9f3b);
      const minuteNoise = (((noiseSeed ^ (noiseSeed >>> 16)) >>> 0) / 0xffffffff - 0.5) * 0.0018;
      const price = base * (1 + dayIndex * 0.003 + Math.sin(minute / 47 + seed) * 0.008 + minuteNoise);
      const volume = 100 + ((minute * 37 + seed) % 2000 + 2000) % 2000;
      weighted += price * volume;
      totalVolume += volume;
      // 美股夜盘从前一自然日20:00开始，保持原始UTC时间跨午夜，不平移到常规交易日。
      const localDate = new Date(date.getTime() + Math.floor(minute / 1440) * 86400000);
      const clockMinute = (minute % 1440 + 1440) % 1440;
      result.push({ time: exchangeTimestamp({ year: localDate.getUTCFullYear(), month: localDate.getUTCMonth() + 1,
        day: localDate.getUTCDate(), hour: Math.floor(clockMinute / 60), minute: clockMinute % 60 }, symbol),
      price, volume, averagePrice: weighted / totalVolume, session: range.session });
    }
  }
  return result;
}

/**
 * 生成明确标记且确定性的独立分时样本，固定截止2026-10-16；不引用真实账户或价格。
 * @param symbol 港美证券代码。
 * @param session 分时时段，港股不支持的时段返回空与提示。
 * @param days 一日或五日。
 * @returns source=demo 的独立分时响应。
 */
export function demoIntraday(symbol: string, session: IntradaySession, days: 1 | 5): IntradayData {
  symbol = normalizeSymbol(symbol);
  validateIntradaySelection(session, days);
  const response: IntradayData = { source: 'demo', symbol, session, days, points: [],
    fetchedAt: '2026-10-16T20:00:00.000Z', warnings: ['合成分时仅用于功能演示，不代表真实市场；演示截止2026-10-16。'] };
  if (symbol.endsWith('.HK') && !['all', 'regular'].includes(session)) {
    response.warnings.push('港股不提供此盘前、盘后或夜盘分时；未使用常规时段替代。');
    return response;
  }
  let cursor = Date.parse('2026-10-16T00:00:00Z');
  let generated = 0;
  while (generated < days) {
    const date = new Date(cursor);
    if (date.getUTCDay() > 0 && date.getUTCDay() < 6) {
      response.points.push(...demoIntradayPoints(symbol, date, session, -generated));
      generated += 1;
    }
    cursor -= 86400000;
  }
  response.points.sort((left, right) => left.time - right.time);
  return response;
}
