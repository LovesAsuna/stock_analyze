import type { IndicatorPoint, MarketData, ReviewItem } from '../shared/types';
import { inChinaRange, signalConfirmationTime } from '../shared/review';
import { formatNumber, formatTime } from './format';

interface Props { data: MarketData; indicators: IndicatorPoint[]; review: ReviewItem[]; start: string; end: string; onSelect: (time: number) => void }

/** 将绝对时间映射到中国日历日；参数为 UTC 秒，返回用于归组的日期。 */
function chinaDate(time: number): string {
  return new Date(time * 1000 + 8 * 3600000).toISOString().slice(0, 10);
}

/** 逐中国工作日对照收盘指标与实际操作，包括没有触发策略的成交和无操作日。 */
export function DailyReview({ data, indicators, review, start, end, onSelect }: Props) {
  const dates: string[] = [];
  for (let cursor = Date.parse(`${start}T00:00:00+08:00`); cursor < Date.parse(`${end}T00:00:00+08:00`); cursor += 86400000) {
    const date = new Date(cursor + 8 * 3600000);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(date.toISOString().slice(0, 10));
  }
  const executions = data.executions.filter((execution) => inChinaRange(execution.time, start, end));
  const matchedIds = new Set(review.flatMap((item) => item.execution ? [item.execution.id] : []));
  return <section className="review-panel daily-panel">
    <div className="section-header"><div><h2>逐日操作检查</h2><p>中国时间工作日 · 汇总当日确认的最后一根 K 线 · 保留没有信号的操作</p></div></div>
    <div className="table-scroll"><table><thead><tr><th>中国日期</th><th>收盘趋势 / 动量</th><th>波动 / 成交量</th><th>当日成交</th><th>复盘关注点</th></tr></thead><tbody>
      {dates.map((date) => {
        const reverseIndex = [...data.candles].reverse().findIndex((candle) => candle.confirmed && chinaDate(signalConfirmationTime(candle.time, data.symbol, data.period)) === date);
        const index = reverseIndex < 0 ? -1 : data.candles.length - 1 - reverseIndex;
        const candle = data.candles[index]; const point = indicators[index];
        const fills = executions.filter((execution) => chinaDate(execution.time) === date);
        const items = review.filter((item) => chinaDate(signalConfirmationTime(item.signal.time, data.symbol, data.period)) === date);
        const missing = items.filter((item) => item.state === 'unmatched').length;
        const unknown = items.some((item) => item.state === 'unknown');
        const unassociated = fills.filter((execution) => !matchedIds.has(execution.id)).length;
        return <tr key={date}><td>{date.slice(5)}{candle && <button className="text-button day-locate" onClick={() => onSelect(candle.time)}>定位图表</button>}</td>
          <td>{point ? <><span>MA {formatNumber(point.fastMA)} / {formatNumber(point.slowMA)}</span><small>SAR {point.sarBull ? '多' : '空'} {formatNumber(point.sar)} · MACD柱 {formatNumber(point.histogram, 3)}</small><small>+DI / −DI / ADX {formatNumber(point.plusDI, 1)} / {formatNumber(point.minusDI, 1)} / {formatNumber(point.adx, 1)}</small></> : '无已确认柱（休市或未收盘）'}</td>
          <td>{point ? <><span>RSI {formatNumber(point.rsi, 1)} · 量比 {formatNumber(point.volumeRatio)}×</span><small>布林上 / 下 {formatNumber(point.bollUpper)} / {formatNumber(point.bollLower)}</small></> : '—'}</td>
          <td>{fills.length ? fills.map((fill) => <div className="daily-fill" key={fill.id}>{fill.side === 'buy' ? '买' : '卖'} {formatNumber(fill.quantity, 0)} @ {formatNumber(fill.price)}<small>{formatTime(fill.time, data.symbol, data.period, true)} 中国时间</small></div>) : data.executionsComplete ? '当日无成交' : '成交数据不完整'}</td>
          <td className="review-note">{unknown ? '成交查询范围不足，执行情况待核查。' : missing ? `${missing} 个信号未见同向成交，请核对当时仓位与交易计划。` : items.length ? '已有策略信号，详细成交对应和价格变化见上表。' : '当前策略没有新信号，不以无操作认定遗漏。'}{unassociated > 0 && ` ${unassociated} 笔成交未对应到所选区间内的下一柱信号窗口，请检查入场或离场的独立依据。`}</td></tr>;
      })}
    </tbody></table></div>
    <p className="method-note">日线按当地收盘的实际中国时间归组，因此美股周五收盘通常落在中国周六，按当前约定不计入本周。盘中分析使用 1 小时或 15 分钟周期。</p>
  </section>;
}
