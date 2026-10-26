import test from 'node:test';
import assert from 'node:assert/strict';
import { appendPlanRevision } from '../shared/plan-history';
import { createDefaultPlan } from '../shared/strategy';
import { DEFAULT_CONFIG } from '../shared/types';

/** 高频编辑一个证券时，其他证券的最新计划必须仍然存在。 */
test('保存大量同证券版本不驱逐其他证券的活跃计划', () => {
  const first = createDefaultPlan('A.US', 'demo', 'day', DEFAULT_CONFIG);
  const second = createDefaultPlan('B.US', 'demo', 'day', DEFAULT_CONFIG);
  let history = [first];
  for (let revision = 1; revision <= 150; revision += 1) history = appendPlanRevision(history, { ...second, revision });
  assert.ok(history.some((plan) => plan.id === first.id));
  assert.equal(history[0].revision, 150);
  assert.ok(history.filter((plan) => plan.id === second.id).length <= 10);
});

/** 活跃上下文满额要明确拒绝，不能静默覆盖用户的规则。 */
test('超过100个活跃上下文明确拒绝且不修改原历史', () => {
  const previous = Array.from({ length: 100 }, (_, index) => createDefaultPlan(`T${index}.US`, 'demo', 'day', DEFAULT_CONFIG));
  const snapshot = structuredClone(previous);
  assert.throws(() => appendPlanRevision(previous, createDefaultPlan('EXTRA.US', 'demo', 'day', DEFAULT_CONFIG)), /100/);
  assert.deepEqual(previous, snapshot);
});
