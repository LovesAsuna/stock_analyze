import type { IChartApi, UTCTimestamp, WhitespaceData, HistogramData } from 'lightweight-charts';
import { exchangeParts, exchangeTimestamp, type IntradayData } from '../shared/intraday';

/**
 * 生成完整单日交易时段的空白时间坐标，不填补价格、成交量或指标。
 * @param data 至少包含一个分时点的已校验快照。
 * @returns 按UTC递增的分钟时间；港股午休不占交易分钟宽度，实际缺口仍由折线分段。
 */
export function intradayTimeline(data: IntradayData): number[] {
  const last = data.points.at(-1);
  if (!last || data.days !== 1) return [];
  const parts = exchangeParts(last.time, data.symbol);
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  // 夜盘20:00归入下一交易日，避免午夜刷新导致固定视野跳到另一整天。
  if (last.session === 'overnight' && parts.hour >= 20) day.setUTCDate(day.getUTCDate() + 1);
  const hongKong = data.symbol.endsWith('.HK');
  const ranges: [number, number][] = hongKong ? [[570, 720], [780, 960]]
    : data.session === 'regular' ? [[570, 960]] : data.session === 'pre' ? [[240, 570]]
      : data.session === 'post' ? [[960, 1200]] : data.session === 'overnight' ? [[-240, 240]] : [[-240, 1200]];
  const timeline = new Set(data.points.map(point => point.time));
  for (const [start, end] of ranges) {
    for (let minute = start; minute <= end; minute += 1) {
      const date = new Date(day.getTime() + Math.floor(minute / 1440) * 86400000);
      const clock = (minute % 1440 + 1440) % 1440;
      timeline.add(exchangeTimestamp({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1,
        day: date.getUTCDate(), hour: Math.floor(clock / 60), minute: clock % 60 }, data.symbol));
    }
  }
  return [...timeline].sort((earlier, later) => earlier - later);
}

/**
 * 使用成交量序列对齐完整时间轴；无真实成交量的分钟只提供time。
 * @param data 分时快照。
 * @param up 相邻价格上涨柱色。
 * @param down 相邻价格下跌柱色。
 * @returns 真实量柱及不含value的时间坐标；五日保持已有点。
 */
export function intradayVolumeData(data: IntradayData, up: string, down: string): (HistogramData<UTCTimestamp> | WhitespaceData<UTCTimestamp>)[] {
  const values = new Map(data.points.map((point, index) => [point.time, { time: point.time as UTCTimestamp,
    value: point.volume, color: point.price >= (data.points[index - 1]?.price ?? point.price) ? up : down }]));
  const times = data.days === 1 ? intradayTimeline(data) : data.points.map(point => point.time);
  return times.map(time => values.get(time) ?? { time: time as UTCTimestamp });
}

/**
 * 将全部分钟坐标纳入视野，显式包含尚无价格的未来时间。
 * @param chart 图表实例。
 * @param data 单日快照。
 * @returns 无返回值；空数据不调整。
 */
export function fitIntradayViewport(chart: IChartApi, data: IntradayData): void {
  const times = intradayTimeline(data);
  if (times.length > 1) chart.timeScale().setVisibleLogicalRange({ from: 0, to: times.length - 1 });
}

/**
 * 锁定单日分时所有缩放及平移手势，保留鼠标十字线；滚轮由页面自然滚动。
 * @param chart 公开图表实例。
 * @returns 无返回值。
 */
export function lockIntradayViewport(chart: IChartApi): void {
  // 不设置fixRightEdge：它会按最后真实价格裁去未来空白分钟；范围由显式分钟坐标锁定。
  chart.applyOptions({ handleScroll: false, handleScale: false, kineticScroll: { mouse: false, touch: false },
    timeScale: { rightOffset: 0, minBarSpacing: 0.001, fixLeftEdge: false, fixRightEdge: false,
      lockVisibleTimeRangeOnResize: true } });
}
