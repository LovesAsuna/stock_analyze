import { DEFAULT_CONFIG, type Candle, type IndicatorConfig, type IndicatorPoint, type Signal } from './types';
import { validateCandles, validateConfig } from './indicators';

type Conditions = { buy: boolean; sell: boolean; bearishFlip: boolean };

/**
 * 验证指标与 K 线一一对应，并拒绝中途夹有未确认柱的历史序列。
 * @param candles 行情序列，允许末尾存在尚未确认的柱。
 * @param indicators 同时间、同长度的指标序列。
 * @returns 验证通过无返回值，否则抛出明确错误。
 */
function validateInputs(candles: Candle[], indicators: IndicatorPoint[]): void {
  validateCandles(candles);
  if (candles.length !== indicators.length) throw new Error('指标数量必须与 K 线数量一致');
  let sawUnconfirmed = false;
  candles.forEach((candle, index) => {
    if (indicators[index].time !== candle.time) throw new Error(`第 ${index} 根指标时间与 K 线不一致`);
    if (!candle.confirmed) sawUnconfirmed = true;
    else if (sawUnconfirmed) throw new Error(`第 ${index} 根已确认 K 线之前存在未确认柱，无法确认历史信号`);
    for (const [name, value] of Object.entries(indicators[index])) {
      if (name !== 'sarBull' && value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error(`第 ${index} 根指标 ${name} 必须是有限数或 null`);
      }
    }
    if (typeof indicators[index].sarBull !== 'boolean') throw new Error(`第 ${index} 根 SAR 方向无效`);
  });
}

/**
 * 仅依据当前及前一根指标判断条件，不使用未来价格或成交。
 * @param candle 当前已确认行情。
 * @param point 当前指标。
 * @param previous 前一根指标，用于识别 SAR 翻空。
 * @param config 策略阈值。
 * @returns 买卖条件以及带空头动量确认的 SAR 翻空标志。
 */
function conditions(candle: Candle, point: IndicatorPoint, previous: IndicatorPoint | undefined,
  config: IndicatorConfig): Conditions {
  const buyReady = [point.fastMA, point.slowMA, point.histogram, point.rsi,
    point.plusDI, point.minusDI, point.adx, point.sar, point.volumeRatio].every((value) => value !== null);
  const momentum = point.histogram !== null && point.plusDI !== null && point.minusDI !== null &&
    point.histogram < 0 && point.minusDI > point.plusDI;
  // 翻空只有在负 MACD 柱与 -DI 优势同时存在时触发；无需等待价格跌破慢均线。
  // 卖出不依赖量比、RSI 或 ADX 的有效性，避免零量窗口或长 RSI 周期屏蔽风险信号。
  const bearishFlip = previous?.sar != null && previous.sarBull && point.sar !== null && !point.sarBull && momentum;
  return {
    buy: buyReady && candle.close > point.fastMA! && point.fastMA! > point.slowMA! && point.histogram! > 0 &&
      point.sarBull && point.plusDI! > point.minusDI! && point.adx! >= config.adxThreshold &&
      point.rsi! >= 45 && point.rsi! <= 75 && point.volumeRatio! >= config.volumeRatio,
    sell: (point.slowMA !== null && candle.close < point.slowMA && momentum &&
      point.sar !== null && !point.sarBull) || bearishFlip,
    bearishFlip,
  };
}

/**
 * 构造只包含当前已知证据的中文解释。
 * @param side 信号方向。
 * @param point 当前指标。
 * @param state 当前条件。
 * @param config 策略参数。
 * @returns 不包含未来收益或事后成交信息的解释列表。
 */
function reasons(side: Signal['side'], point: IndicatorPoint, state: Conditions, config: IndicatorConfig): string[] {
  if (side === 'buy') return [
    `收盘价高于 SMA${config.fastMA}，且 SMA${config.fastMA} 高于 SMA${config.slowMA}`,
    'MACD(12/26/9) 柱大于 0，SAR 为多头方向，+DI 大于 -DI',
    `ADX ${point.adx!.toFixed(2)} 不低于阈值 ${config.adxThreshold}`,
    `Wilder RSI(${config.rsiPeriod}) 为 ${point.rsi!.toFixed(2)}，处于 45 至 75（含边界）`,
    `当前成交量/含当前柱的20根平均成交量为 ${point.volumeRatio!.toFixed(2)}，不低于 ${config.volumeRatio}`,
    '已有至少 200 根已确认 K 线，买入组合条件本根首次成立',
  ];
  return [
    state.bearishFlip ? 'SAR 由多头翻为空头，MACD 柱为负且 -DI 大于 +DI，确认空头动量'
      : `收盘价低于 SMA${config.slowMA}，MACD 柱为负，SAR 为空头且 -DI 大于 +DI`,
    '已有至少 200 根已确认 K 线，卖出组合条件本根首次成立',
  ];
}

/**
 * 生成确定性的收盘确认信号，每个方向仅在条件从不成立变为成立时发出。
 * @param candles 已排序行情，至少 200 根已确认柱后才允许发出信号。
 * @param indicators calculateIndicators 的等长结果。
 * @param config 与指标计算一致的策略参数。
 * @returns 按时间排序的信号。eligibleTime 保留下一柱原始 time；参考价取下一柱开盘，
 * nextFiveReturn 为 (索引+5已确认柱收盘/下一柱开盘-1)*100，属于事后统计百分比而非收益保证。
 */
export function generateSignals(candles: Candle[], indicators: IndicatorPoint[],
  config: IndicatorConfig = DEFAULT_CONFIG): Signal[] {
  validateConfig(config);
  validateInputs(candles, indicators);
  const signals: Signal[] = [];
  let previousBuy = false;
  let previousSell = false;
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (!candle.confirmed) break;
    if (index < 199) continue;
    const state = conditions(candle, indicators[index], indicators[index - 1], config);
    const side = state.buy && !previousBuy ? 'buy' : state.sell && !previousSell ? 'sell' : null;
    previousBuy = state.buy;
    previousSell = state.sell;
    if (side === null) continue;
    const next = candles[index + 1];
    const fifth = candles[index + 5];
    signals.push({
      id: `${candle.time}-${side}`, time: candle.time, index, side,
      title: side === 'buy' ? '多指标共振买入' : '空头共振卖出',
      reasons: reasons(side, indicators[index], state, config), close: candle.close,
      eligibleTime: next?.time ?? null, referencePrice: next?.open ?? null,
      nextFiveReturn: next && fifth?.confirmed ? (fifth.close / next.open - 1) * 100 : null,
      confirmed: true,
    });
  }
  return signals;
}
