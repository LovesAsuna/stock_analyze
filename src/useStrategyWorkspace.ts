import { useCallback, useEffect, useMemo, useState } from 'react';
import { calculateIndicators } from '../shared/indicators';
import { runBacktest } from '../shared/backtest';
import { inChinaRange, signalConfirmationTime } from '../shared/review';
import type { IndicatorConfig, MarketData, Period, SourceMode } from '../shared/types';
import type { PlanLevel } from './StrategyWorkbench';
import { usePlanMonitor, useTradingPlan } from './useTradingPlan';

/**
 * 将计划、指标、历史执行和监控统一到同一版本，避免界面重复计算不同规则。
 * @param input 数据、当前范围、全局模板参数及刷新回调。
 * @returns 图表与复盘共用的运行状态和编辑动作。
 */
export function useStrategyWorkspace(input: { data: MarketData | null; symbol: string; source: SourceMode; period: Period;
  config: IndicatorConfig; range: { start: string; end: string }; loading: boolean; refresh: () => void }) {
  const contextData = input.data?.source === input.source && input.data.symbol === input.symbol && input.data.period === input.period ? input.data : null;
  input = { ...input, data: contextData };
  const store = useTradingPlan(input);
  const [picking, setPicking] = useState<PlanLevel | null>(null);
  const plan = store.plan;
  const indicators = useMemo(() => calculateIndicators(input.data?.candles ?? [], plan.indicatorConfig), [input.data, plan.indicatorConfig]);
  const result = useMemo(() => runBacktest(input.data?.candles ?? [], indicators, plan), [input.data, indicators, plan]);
  const signals = useMemo(() => result.signals.filter((signal) => inChinaRange(
    signalConfirmationTime(signal.time, input.symbol, input.period), input.range.start, input.range.end)),
  [result.signals, input.range, input.symbol, input.period]);
  const monitor = usePlanMonitor({ plan: store.saved, signals: result.signals, candles: input.data?.candles ?? [], indicators,
    lastTime: input.data?.candles.slice().reverse().find((candle) => candle.confirmed)?.time ?? null,
    scope: `${input.source}:${input.symbol}:${input.period}:${input.range.start}:${input.range.end}`,
    loading: input.loading, refresh: input.refresh });
  useEffect(() => { setPicking(null); store.setEditing(null); }, [input.source, input.symbol, input.period]);
  /** 图上取价只生成草稿，显式保存后才影响规则与模拟交易。 */
  const pickPrice = useCallback((price: number) => {
    if (!picking || !Number.isFinite(price) || price <= 0) return;
    store.setEditing({ ...structuredClone(plan), [picking]: Math.round(price * 10000) / 10000 });
    setPicking(null);
  }, [picking, plan, store.setEditing]);
  /** 全局指标设置用于模板；已有计划则新增版本并停用原监控。 */
  const saveConfig = (config: IndicatorConfig): void => {
    if (store.saved) store.save({ ...plan, indicatorConfig: config, revision: plan.revision + 1, updatedAt: new Date().toISOString() });
  };
  return { ...store, plan, indicators, result, allSignals: result.signals, signals, monitor, picking, setPicking, pickPrice, saveConfig,
    edit: () => store.setEditing(structuredClone(plan)) };
}
