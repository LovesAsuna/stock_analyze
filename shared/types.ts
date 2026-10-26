/** 统一领域模型：数据源只负责标准化，指标与界面不依赖 CLI 原始结构。 */
/** 常规 K 线周期；分时和五日分时属于独立视图，不参与策略周期。 */
export type Period = '1m' | '5m' | '15m' | '30m' | '1h' | 'day' | 'week' | 'month' | 'quarter' | 'year';
export type SourceMode = 'demo' | 'longbridge';
export type Side = 'buy' | 'sell';

export interface Candle {
  /** UTC Unix 秒。不得人为平移时区。 */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** 服务端仅将已经结束的周期用于确认信号。 */
  confirmed: boolean;
}

export interface Security {
  symbol: string;
  name: string;
  market: 'HK' | 'US';
  currency: 'HKD' | 'USD';
}

export interface Position {
  symbol: string;
  quantity: number;
  available: number;
  costPrice: number;
  currency: string;
}

export interface Execution {
  id: string;
  symbol: string;
  side: Side;
  time: number;
  price: number;
  quantity: number;
}

export interface Workspace {
  source: SourceMode;
  fetchedAt: string;
  securities: Security[];
  positions: Position[];
  warnings: string[];
  /** 真实读取失败时不能伪装成空持仓。 */
  positionsComplete: boolean;
}

export interface MarketData {
  source: SourceMode;
  symbol: string;
  period: Period;
  candles: Candle[];
  executions: Execution[];
  fetchedAt: string;
  warnings: string[];
  executionsComplete: boolean;
  /** 成交查询范围为中国时间的闭开区间。 */
  executionRange: { start: string; end: string };
  adjustment: 'none';
}

export interface IndicatorConfig {
  fastMA: number;
  slowMA: number;
  rsiPeriod: number;
  adxThreshold: number;
  volumeRatio: number;
  sarStart: number;
  sarStep: number;
  sarMax: number;
}

export const DEFAULT_CONFIG: IndicatorConfig = {
  fastMA: 10, slowMA: 20, rsiPeriod: 14, adxThreshold: 20,
  volumeRatio: 1.2, sarStart: 0.02, sarStep: 0.02, sarMax: 0.2,
};

export interface IndicatorPoint {
  time: number;
  fastMA: number | null;
  slowMA: number | null;
  macd: number | null;
  macdSignal: number | null;
  histogram: number | null;
  rsi: number | null;
  plusDI: number | null;
  minusDI: number | null;
  adx: number | null;
  sar: number | null;
  sarBull: boolean;
  bollUpper: number | null;
  bollMiddle: number | null;
  bollLower: number | null;
  volumeRatio: number | null;
}

export interface Signal {
  id: string;
  time: number;
  index: number;
  side: Side;
  title: string;
  reasons: string[];
  close: number;
  /** 收盘后才确认，最早以之后一根的开盘作为比较基准。 */
  eligibleTime: number | null;
  referencePrice: number | null;
  nextFiveReturn: number | null;
  confirmed: boolean;
}

export interface ReviewItem {
  signal: Signal;
  execution: Execution | null;
  state: 'matched' | 'unmatched' | 'pending' | 'unknown';
  note: string;
}
