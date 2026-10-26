import { useEffect, useMemo, useState } from 'react';
import { createDefaultPlan, validatePlan, type TradingPlan } from '../shared/strategy';
import type { Candle, IndicatorConfig, IndicatorPoint, Period, Signal, SourceMode } from '../shared/types';
import { signalConfirmationTime } from '../shared/review';
import { appendPlanRevision } from '../shared/plan-history';

const PLAN_KEY = 'market-lens-plans-v1';
const EVENT_KEY = 'market-lens-alerts-v1';

export interface PlanAlert {
  id: string; planId: string; revision: number; symbol: string; source: SourceMode; period: Period;
  confirmedAt: number; detectedAt: string; side: 'buy' | 'sell'; close: number; reasons: string[];
  /** 触发时完整规则快照，与后续编辑版本分离。 */
  plan: TradingPlan;
  /** 仅保留触发柱及当时指标，不包含账户仓位与逐笔成交。 */
  evidence: { candle: Candle; indicator: IndicatorPoint };
}

/**
 * 读取本机计划历史，逐项校验后才允许执行。
 * @returns 有效计划及可见的存储错误；不将损坏数据当作有效规则。
 */
function loadPlans(): { plans: TradingPlan[]; error: string } {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(PLAN_KEY) ?? '[]');
    if (!Array.isArray(values) || values.length > 100) throw new Error('计划列表结构或数量无效');
    values.forEach(validatePlan);
    return { plans: values, error: '' };
  } catch (failure) {
    console.warn('本机交易计划读取失败，已停用损坏的保存内容。');
    return { plans: [], error: failure instanceof Error ? failure.message : '本机计划读取失败' };
  }
}

/**
 * 读取提醒证据；每份计划快照必须通过领域边界校验。
 * @returns 最近有效提醒；损坏数据不参与任何交易判断。
 */
function loadAlerts(): PlanAlert[] {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(EVENT_KEY) ?? '[]');
    if (!Array.isArray(values) || values.length > 200) throw new Error('提醒列表结构无效');
    return values.filter((item): item is PlanAlert => {
      if (!item || typeof item !== 'object') return false;
      const value = item as PlanAlert;
      validatePlan(value.plan);
      return typeof value.id === 'string' && value.planId === value.plan.id && value.revision === value.plan.revision &&
        value.symbol === value.plan.symbol && value.source === value.plan.source && value.period === value.plan.period &&
        Number.isFinite(value.confirmedAt) && Number.isFinite(Date.parse(value.detectedAt)) &&
        (value.side === 'buy' || value.side === 'sell') && Number.isFinite(value.close) &&
        Array.isArray(value.reasons) && value.reasons.every((reason) => typeof reason === 'string');
    });
  } catch {
    console.warn('本机提醒证据无法读取，监控保持关闭。');
    return [];
  }
}

/**
 * 管理按来源、证券和周期隔离的版本化计划。
 * @param context 当前数据上下文与未保存模板使用的指标配置。
 * @returns 保存版本、预览模板、编辑入口与明确存储状态。
 */
export function useTradingPlan(context: { symbol: string; source: SourceMode; period: Period; config: IndicatorConfig }) {
  const [store, setStore] = useState(loadPlans);
  const [editing, setEditing] = useState<TradingPlan | null>(null);
  const { symbol, source, period, config } = context;
  const saved = store.plans.find((plan) => plan.symbol === symbol && plan.source === source && plan.period === period) ?? null;
  const preview = useMemo(() => createDefaultPlan(symbol, source, period, config), [symbol, source, period, config]);
  const plan = saved ?? preview;
  /** 校验并保存新版本；失败时保留原运行版本，返回错误供表单显示。 */
  const save = (next: TradingPlan): void => {
    validatePlan(next);
    if (next.symbol !== symbol || next.source !== source || next.period !== period) throw new Error('计划上下文已改变，请重新打开编辑器。');
    const plans = appendPlanRevision(store.plans, next);
    try { localStorage.setItem(PLAN_KEY, JSON.stringify(plans)); }
    catch { throw new Error('浏览器无法保存交易计划，请允许本机存储后重试。'); }
    setStore({ plans, error: '' }); setEditing(null);
  };
  return { plan, saved, editing, setEditing, save, error: store.error,
    history: store.plans.filter((item) => item.id === plan.id).slice(0, 10) };
}

/**
 * 页面级定时检查与新信号证据留存；启用之前的历史信号不会补发。
 * @param input 当前保存计划、历史引擎输出及刷新入口。
 * @returns 开关、启用时间、证据列表和存储错误。
 */
export function usePlanMonitor(input: { plan: TradingPlan | null; signals: Signal[]; candles: Candle[]; indicators: IndicatorPoint[]; lastTime: number | null; scope: string; loading: boolean; refresh: () => void }) {
  const [armed, setArmed] = useState<{ key: string; at: number; after: number; historyStart: number | null; scope: string } | null>(null);
  const [events, setEvents] = useState(loadAlerts);
  const [error, setError] = useState('');
  const key = input.plan ? `${input.plan.id}-${input.plan.revision}` : '';
  const historyStart = input.candles[0]?.time ?? null;
  const enabled = Boolean(key && armed?.key === key && armed.scope === input.scope && armed.historyStart === historyStart);
  useEffect(() => { setArmed(null); }, [key]);
  useEffect(() => {
    if (armed && (armed.scope !== input.scope || armed.historyStart !== historyStart)) {
      setArmed(null); setError('研究范围或历史起点已变化，本页监控已停止。检查回测持仓后请重新开启。');
    }
  }, [armed, input.scope, historyStart]);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => { if (!input.loading) input.refresh(); }, 75_000);
    return () => window.clearInterval(timer);
  }, [enabled, input.loading, input.refresh]);
  useEffect(() => {
    if (!enabled || !armed || !input.plan) return;
    const plan = input.plan;
    const fresh = input.signals.filter((signal) => signal.time > armed.after &&
      signalConfirmationTime(signal.time, plan.symbol, plan.period) >= armed.at);
    if (!fresh.length) return;
    setEvents((previous) => {
      const additions = fresh.map((signal): PlanAlert => ({ id: `${key}-${signal.id}`, planId: plan.id,
        revision: plan.revision, symbol: plan.symbol, source: plan.source, period: plan.period,
        confirmedAt: signalConfirmationTime(signal.time, plan.symbol, plan.period), detectedAt: new Date().toISOString(),
        side: signal.side, close: signal.close, reasons: signal.reasons, plan: structuredClone(plan),
        evidence: { candle: structuredClone(input.candles[signal.index]), indicator: structuredClone(input.indicators[signal.index]) } }))
        .filter((event) => !previous.some((item) => item.id === event.id));
      if (!additions.length) return previous;
      const next = [...additions.reverse(), ...previous].slice(0, 200);
      try { localStorage.setItem(EVENT_KEY, JSON.stringify(next)); }
      catch { setError('提醒已在本页生成，但浏览器无法保存证据；关闭页面将丢失本次记录。'); }
      return next;
    });
  }, [enabled, armed, input.plan, input.signals, input.candles, input.indicators, key]);
  /** 从启用时刻及最新已确认柱之后开始；重新编辑版本必须重新开启。 */
  const toggle = () => {
    setError('');
    setArmed(enabled ? null : { key, at: Date.now() / 1000, after: input.lastTime ?? Infinity, historyStart, scope: input.scope });
  };
  return { enabled, toggle, armedAt: enabled ? armed?.at : null, error,
    events: events.filter((event) => event.planId === input.plan?.id && event.source === input.plan.source) };
}
