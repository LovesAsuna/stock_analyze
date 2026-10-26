import type { Candle, IndicatorPoint, Period } from '../shared/types';
import type { ChartStudyPoint } from './chart-study-data';
import { formatNumber, formatPercent, formatTime } from './format';

interface Props {
  selected?: Candle; previous?: Candle; point?: IndicatorPoint; study?: ChartStudyPoint;
  symbol: string; period: Period; tooltip: boolean; showAverages: boolean;
}

/** 图内指标读数与十字线行情卡。参数：当前柱、前柱及显示指标；返回：不截获鼠标的文字覆盖层。 */
export function ChartReadouts({ selected, previous, point, study, symbol, period, tooltip, showAverages }: Props) {
  const change = selected && previous ? selected.close - previous.close : null;
  return <>
    <div className="terminal-readouts" aria-live="off">
      <div className="terminal-price-readout"><strong>{symbol}</strong><span>{selected ? formatTime(selected.time, symbol, period) : '等待行情'}</span><span>不复权</span></div>
      <div className="terminal-averages">{showAverages && (['ma5', 'ma10', 'ma20', 'ma50'] as const).map((key, index) => <span key={key}><i className={`study-key study-key-${index + 1}`} />{key.toUpperCase()} {formatNumber(study?.[key])}</span>)}</div>
      <div className="terminal-indicators"><span>SAR {formatNumber(point?.sar)}</span><span>RSI {formatNumber(point?.rsi, 1)}</span><span>量比 {formatNumber(point?.volumeRatio)}×</span></div>
    </div>
    {selected && <div className={tooltip ? 'ohlc chart-quote-card is-hovered' : 'ohlc terminal-ohlc'} data-testid="chart-ohlc" aria-live="off">
      {tooltip && <strong>{formatTime(selected.time, symbol, period)} · {symbol.endsWith('.HK') ? '香港时间' : '美东时间'}</strong>}
      <dl><div><dt>开盘</dt><dd>{formatNumber(selected.open)}</dd></div><div><dt>最高</dt><dd>{formatNumber(selected.high)}</dd></div>
        <div><dt>最低</dt><dd>{formatNumber(selected.low)}</dd></div><div><dt>收盘</dt><dd>{formatNumber(selected.close)}</dd></div>
        <div><dt>涨跌额</dt><dd>{formatNumber(change)}</dd></div><div><dt>涨跌幅</dt><dd>{formatPercent(previous && selected ? (selected.close / previous.close - 1) * 100 : null)}</dd></div>
        <div><dt>成交量</dt><dd>{formatNumber(selected.volume, 0)}</dd></div></dl>
      {!selected.confirmed && <span>尚未确认</span>}
    </div>}
  </>;
}
