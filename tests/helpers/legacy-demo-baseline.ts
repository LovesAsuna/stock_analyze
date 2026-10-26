import type { Candle, Execution, Period, Signal } from '../../shared/types';

/** 原测试的六个 Node/V8 SHA256；顺序与 demoCandles 原始 JSON 属性顺序一致。 */
export const LEGACY_DEMO_CASES = [
  { symbol: 'NVDA.US', period: 'day', sha256: 'd4055254719299dfd733d478719d1f4441cd79076be9740dfc857b861eddc6f8' },
  { symbol: 'NVDA.US', period: '1h', sha256: '098997c0f52e4cb905359215af19c259240bc4b378d95c56bb5a267a0854ca76' },
  { symbol: 'NVDA.US', period: '15m', sha256: '6f7df6cdfca174ae4b433c651e4e969b0106ee33817bebfa85066bdeb1df365b' },
  { symbol: '700.HK', period: 'day', sha256: '2a266a0a3588c2ecb5c76300e90c07b0d5b2fea16bf90c11071d4ff0fb81bcc2' },
  { symbol: '700.HK', period: '1h', sha256: '68383174ea30ba2c287c7e7f902542cde8624144c6694451f1da7bdd83277f49' },
  { symbol: '700.HK', period: '15m', sha256: 'b7aa4701b89e2c66484d1e4d0ab48c5d5c22cbcfa79e37389c1af9e824944064' },
] as const satisfies ReadonlyArray<{ symbol: string; period: Period; sha256: string }>;

/** 覆盖全部旧 demo 样本的成交查询闭开范围，避免仅比较没有成交的末周。 */
export const LEGACY_EXECUTION_RANGE = { start: '2000-01-01', end: '2100-01-01' };

type SignalIdentity = Omit<Signal, 'close' | 'referencePrice' | 'nextFiveReturn'>;
type ExecutionIdentity = Omit<Execution, 'price'>;

/** 每根原始 OHLCV 均保存双精度值；信号、成交只保存需要精确兼容的离散字段。 */
export interface LegacyDemoBaseline {
  provenance: { runtime: string; engine: string; note: string };
  symbol: string;
  period: Period;
  sha256: string;
  candles: Candle[];
  signals: SignalIdentity[];
  executions: ExecutionIdentity[];
}

/**
 * 去除价格及事后收益，保留信号身份、方向、确认与可执行时间及中文决策依据。
 * @param signals 默认策略生成的完整信号序列。
 * @returns 保持顺序和数量的离散信号快照。
 */
export function signalIdentities(signals: Signal[]): SignalIdentity[] {
  return signals.map(({ close, referencePrice, nextFiveReturn, ...identity }) => identity);
}

/**
 * 去除价格，保留演示成交身份、证券、方向、时间和数量。
 * @param executions demoMarket 返回的完整范围成交序列。
 * @returns 保持顺序和笔数的离散成交快照。
 */
export function executionIdentities(executions: Execution[]): ExecutionIdentity[] {
  return executions.map(({ price, ...identity }) => identity);
}
