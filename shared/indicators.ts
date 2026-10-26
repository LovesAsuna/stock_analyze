import { DEFAULT_CONFIG, type Candle, type IndicatorConfig, type IndicatorPoint } from './types';

type NullableSeries = (number | null)[];

/**
 * 验证指标参数，避免无效周期、阈值和加速因子进入计算。
 * @param config 待验证的完整配置。
 * @returns 验证成功时无返回值；失败抛出带中文说明的错误。
 */
export function validateConfig(config: IndicatorConfig): void {
  for (const name of ['fastMA', 'slowMA', 'rsiPeriod'] as const) {
    if (!Number.isSafeInteger(config[name]) || config[name] < 1) {
      throw new Error(`指标参数 ${name} 必须是正整数`);
    }
  }
  if (config.fastMA >= config.slowMA) throw new Error('快速均线周期必须小于慢速均线周期');
  if (!Number.isFinite(config.adxThreshold) || config.adxThreshold < 0 || config.adxThreshold > 100) {
    throw new Error('ADX 阈值必须在 0 到 100 之间');
  }
  if (!Number.isFinite(config.volumeRatio) || config.volumeRatio < 0) {
    throw new Error('量比阈值必须是非负有限数');
  }
  for (const name of ['sarStart', 'sarStep', 'sarMax'] as const) {
    if (!Number.isFinite(config[name]) || config[name] <= 0 || config[name] > 1) {
      throw new Error(`指标参数 ${name} 必须大于 0 且不大于 1`);
    }
  }
  if (config.sarStart > config.sarMax) throw new Error('SAR 初始加速因子不能大于上限');
}

/**
 * 验证按时间严格递增的行情；本引擎不排序、不填补或伪造缺失行情。
 * @param candles UTC Unix 秒的 OHLCV 序列。
 * @returns 验证成功时无返回值；失败抛出包含位置的错误。
 */
export function validateCandles(candles: Candle[]): void {
  candles.forEach((candle, index) => {
    if (!Number.isFinite(candle.time) || !Number.isFinite(new Date(candle.time * 1000).getTime())) {
      throw new Error(`第 ${index} 根 K 线时间无效`);
    }
    if (index > 0 && candle.time <= candles[index - 1].time) {
      throw new Error(`第 ${index} 根 K 线时间必须严格递增`);
    }
    for (const name of ['open', 'high', 'low', 'close'] as const) {
      if (!Number.isFinite(candle[name]) || candle[name] <= 0) {
        throw new Error(`第 ${index} 根 K 线 ${name} 必须是正有限数`);
      }
    }
    if (candle.low > Math.min(candle.open, candle.close) ||
        candle.high < Math.max(candle.open, candle.close) || candle.low > candle.high) {
      throw new Error(`第 ${index} 根 K 线最高价、最低价与开收盘价不一致`);
    }
    if (!Number.isFinite(candle.volume) || candle.volume < 0 || typeof candle.confirmed !== 'boolean') {
      throw new Error(`第 ${index} 根 K 线成交量或确认标志无效`);
    }
  });
}

/**
 * 计算简单移动平均，只有完整窗口才产生数值。
 * @param values 有限数序列。
 * @param period 窗口长度。
 * @returns 与输入等长的均线序列。
 */
function sma(values: number[], period: number): NullableSeries {
  let total = 0;
  return values.map((value, index) => {
    total += value;
    if (index >= period) total -= values[index - period];
    return index + 1 >= period ? total / period : null;
  });
}

/**
 * 用首个完整窗口的 SMA 初始化 EMA；空值中断预热。
 * @param values 可能包含预热空值的序列。
 * @param period 指数平均周期。
 * @returns 预热前为 null 的 EMA 序列。
 */
function ema(values: NullableSeries, period: number): NullableSeries {
  let previous: number | null = null;
  let seedSum = 0;
  let seedCount = 0;
  const alpha = 2 / (period + 1);
  return values.map((value) => {
    if (value === null) {
      previous = null;
      seedSum = 0;
      seedCount = 0;
      return null;
    }
    if (previous !== null) {
      previous += alpha * (value - previous);
      return previous;
    }
    seedSum += value;
    seedCount += 1;
    if (seedCount < period) return null;
    previous = seedSum / period;
    return previous;
  });
}

/**
 * 计算 Wilder RSI，首次使用 period 个价格变化，随后用 1/period 平滑。
 * @param closes 收盘价序列。
 * @param period RSI 周期。
 * @returns 单边上涨为 100、单边下跌为 0、完全不动为 50 的 RSI 序列。
 */
function wilderRsi(closes: number[], period: number): NullableSeries {
  let averageGain = 0;
  let averageLoss = 0;
  return closes.map((close, index) => {
    if (index === 0) return null;
    const change = close - closes[index - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (index <= period) {
      averageGain += gain / period;
      averageLoss += loss / period;
    } else {
      averageGain = (averageGain * (period - 1) + gain) / period;
      averageLoss = (averageLoss * (period - 1) + loss) / period;
    }
    if (index < period) return null;
    if (averageGain === 0 && averageLoss === 0) return 50;
    if (averageLoss === 0) return 100;
    return 100 - 100 / (1 + averageGain / averageLoss);
  });
}

/**
 * 计算固定 14 周期的 Wilder DMI/ADX；不把第一根缺少前收盘的柱作为变化量。
 * @param candles 行情序列。
 * @returns +DI、-DI 在索引 14 起有效，ADX 在索引 27 起有效。
 */
function directionalMovement(candles: Candle[]): { plus: NullableSeries; minus: NullableSeries; adx: NullableSeries } {
  const plus: NullableSeries = candles.map(() => null);
  const minus: NullableSeries = candles.map(() => null);
  const adx: NullableSeries = candles.map(() => null);
  let trueRange = 0;
  let plusMovement = 0;
  let minusMovement = 0;
  let dxSum = 0;
  let previousAdx = 0;
  const period = 14;
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    const up = current.high - previous.high;
    const down = previous.low - current.low;
    const range = Math.max(current.high - current.low,
      Math.abs(current.high - previous.close), Math.abs(current.low - previous.close));
    const positive = up > down && up > 0 ? up : 0;
    const negative = down > up && down > 0 ? down : 0;
    if (index <= period) {
      trueRange += range;
      plusMovement += positive;
      minusMovement += negative;
    } else {
      trueRange = trueRange - trueRange / period + range;
      plusMovement = plusMovement - plusMovement / period + positive;
      minusMovement = minusMovement - minusMovement / period + negative;
    }
    if (index < period) continue;
    const plusValue = trueRange === 0 ? 0 : 100 * plusMovement / trueRange;
    const minusValue = trueRange === 0 ? 0 : 100 * minusMovement / trueRange;
    plus[index] = plusValue;
    minus[index] = minusValue;
    const total = plusValue + minusValue;
    const dx = total === 0 ? 0 : 100 * Math.abs(plusValue - minusValue) / total;
    if (index < 2 * period) dxSum += dx;
    if (index === 2 * period - 1) previousAdx = dxSum / period;
    else if (index >= 2 * period) previousAdx = (previousAdx * (period - 1) + dx) / period;
    if (index >= 2 * period - 1) adx[index] = previousAdx;
  }
  return { plus, minus, adx };
}

/**
 * 计算抛物线 SAR：前两根建立方向，后续约束于之前两根高低价并执行反转。
 * @param candles 行情序列。
 * @param config 初始加速、每次新极值增量及上限。
 * @returns SAR 与多头方向；首根 SAR 为 null，不读取未来柱。
 */
function parabolicSar(candles: Candle[], config: IndicatorConfig): { values: NullableSeries; bulls: boolean[] } {
  const values: NullableSeries = candles.map(() => null);
  const bulls = candles.map(() => true);
  if (candles.length < 2) return { values, bulls };
  let bull = candles[1].close >= candles[0].close;
  let sar = bull ? Math.min(candles[0].low, candles[1].low) : Math.max(candles[0].high, candles[1].high);
  let extreme = bull ? Math.max(candles[0].high, candles[1].high) : Math.min(candles[0].low, candles[1].low);
  let acceleration = config.sarStart;
  values[1] = sar;
  bulls[1] = bull;
  for (let index = 2; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    const beforePrevious = candles[index - 2];
    const projected = sar + acceleration * (extreme - sar);
    sar = bull ? Math.min(projected, previous.low, beforePrevious.low)
      : Math.max(projected, previous.high, beforePrevious.high);
    if ((bull && current.low < sar) || (!bull && current.high > sar)) {
      // 反转从旧趋势极值开始，并包含跳空柱极值，防止 SAR 落入当前柱内部。
      sar = bull ? Math.max(extreme, current.high) : Math.min(extreme, current.low);
      bull = !bull;
      extreme = bull ? current.high : current.low;
      acceleration = config.sarStart;
    } else if ((bull && current.high > extreme) || (!bull && current.low < extreme)) {
      extreme = bull ? current.high : current.low;
      acceleration = Math.min(acceleration + config.sarStep, config.sarMax);
    }
    values[index] = sar;
    bulls[index] = bull;
  }
  return { values, bulls };
}

/**
 * 计算 SMA、MACD(12/26/9)、Wilder RSI/DMI/ADX、SAR、布林带和量比。
 * @param candles 时间递增的 OHLCV；未确认柱可供绘图，但不得据此发出信号。
 * @param config 指标配置，默认 SMA10/20、RSI14、SAR .02/.02/.2。
 * @returns 与行情等长的指标；窗口不足为 null。MACD 柱为 DIF-DEA，不乘二。
 */
export function calculateIndicators(candles: Candle[], config: IndicatorConfig = DEFAULT_CONFIG): IndicatorPoint[] {
  validateConfig(config);
  validateCandles(candles);
  const closes = candles.map((candle) => candle.close);
  const fast = sma(closes, config.fastMA);
  const slow = sma(closes, config.slowMA);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macd = ema12.map((value, index) => value === null || ema26[index] === null ? null : value - ema26[index]!);
  const macdSignal = ema(macd, 9);
  const rsi = wilderRsi(closes, config.rsiPeriod);
  const dmi = directionalMovement(candles);
  const sar = parabolicSar(candles, config);
  const middle = sma(closes, 20);
  const volumeMean = sma(candles.map((candle) => candle.volume), 20);
  return candles.map((candle, index) => {
    const mean = middle[index];
    // 布林带采用当前柱及之前共 20 根的总体方差（分母 20）。
    const deviation = mean === null ? null : Math.sqrt(closes.slice(index - 19, index + 1)
      .reduce((sum, close) => sum + (close - mean) ** 2, 0) / 20);
    return {
      time: candle.time, fastMA: fast[index], slowMA: slow[index],
      macd: macd[index], macdSignal: macdSignal[index],
      histogram: macd[index] === null || macdSignal[index] === null ? null : macd[index]! - macdSignal[index]!,
      rsi: rsi[index], plusDI: dmi.plus[index], minusDI: dmi.minus[index], adx: dmi.adx[index],
      sar: sar.values[index], sarBull: sar.bulls[index],
      bollMiddle: mean, bollUpper: mean === null ? null : mean + 2 * deviation!,
      bollLower: mean === null ? null : mean - 2 * deviation!,
      // 量比以包含当前柱的 20 根平均成交量为基准，零成交量窗口无有效量比。
      volumeRatio: volumeMean[index] === null || volumeMean[index] === 0 ? null : candle.volume / volumeMean[index]!,
    };
  });
}
