import { validatePlan, type TradingPlan } from './strategy';

/**
 * 保存新修订，优先保留每个来源/证券/周期的最新计划，再保留最多10个旧版本。
 * @param previous 已校验的本机计划历史。
 * @param next 待保存的新版本。
 * @returns 新列表；上下文超过100个则明确拒绝，绝不静默删除活跃计划。
 */
export function appendPlanRevision(previous: TradingPlan[], next: TradingPlan): TradingPlan[] {
  validatePlan(next);
  previous.forEach(validatePlan);
  const scope = (plan: TradingPlan) => `${plan.source}:${plan.symbol}:${plan.period}`;
  const all = [next, ...previous.filter((plan) => !(plan.id === next.id && plan.revision === next.revision))];
  const latest = new Map<string, TradingPlan>();
  for (const plan of all) if (!latest.has(scope(plan))) latest.set(scope(plan), plan);
  if (latest.size > 100) throw new Error('已保存100个证券/来源/周期计划，本次未保存；请先导出并整理计划。');
  const selected = new Set(latest.values());
  const versions = new Map<string, number>();
  for (const plan of all) {
    const count = versions.get(plan.id) ?? 0;
    if (count >= 10 || selected.size >= 100) continue;
    selected.add(plan); versions.set(plan.id, count + 1);
  }
  return all.filter((plan) => selected.has(plan));
}
