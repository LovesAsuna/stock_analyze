import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { conditionLabel, validatePlan } from '../shared/strategy';
import { PERIOD_LABELS } from '../shared/periods';
import type { Condition, ConditionGroup, Metric, TradingPlan } from '../shared/strategy';
import './plans.css';

type PlanEditorProps = {
  plan: TradingPlan | null;
  onSave: (plan: TradingPlan) => void;
  onClose: () => void;
};
type DraftProps = Omit<PlanEditorProps, 'plan'> & { plan: TradingPlan };
type IndicatorConfig = TradingPlan['indicatorConfig'];
type IndicatorKey = 'fastMA' | 'slowMA' | 'rsiPeriod' | 'sarStart' | 'sarStep' | 'sarMax';
type RiskKey = 'stopLossPct' | 'takeProfitPct' | 'trailingStopPct' | 'maxHoldingBars'
  | 'quantity' | 'initialCapital' | 'feeBps' | 'slippageBps';
type PriceKey = 'entryPrice' | 'stopPrice' | 'targetPrice';
type NumberFieldProps = {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  optional?: boolean;
  min?: number;
  max?: number;
  step?: number | 'any';
  hint?: string;
};

const METRICS: ReadonlyArray<{ value: Metric; label: string }> = [
  { value: 'close', label: '收盘价' }, { value: 'fastMA', label: '快均线' },
  { value: 'slowMA', label: '慢均线' }, { value: 'histogram', label: 'MACD 柱' },
  { value: 'rsi', label: 'RSI' }, { value: 'adx', label: 'ADX' },
  { value: 'plusDI', label: '+DI' }, { value: 'minusDI', label: '−DI' },
  { value: 'sar', label: 'SAR' }, { value: 'volumeRatio', label: '量比' },
];
const OPERATORS: ReadonlyArray<{ value: Condition['operator']; label: string }> = [
  { value: 'gt', label: '大于' }, { value: 'lt', label: '小于' },
  { value: 'crossUp', label: '向上穿越' }, { value: 'crossDown', label: '向下穿越' },
];
const RISK_FIELDS: ReadonlyArray<{ key: RiskKey; label: string; step: number | 'any'; min: number }> = [
  { key: 'stopLossPct', label: '止损（%）', step: 'any', min: 0 },
  { key: 'takeProfitPct', label: '止盈（%）', step: 'any', min: 0 },
  { key: 'trailingStopPct', label: '追踪止损（%）', step: 'any', min: 0 },
  { key: 'maxHoldingBars', label: '最大持有柱数', step: 1, min: 0 },
  { key: 'quantity', label: '数量', step: 1, min: 1 },
  { key: 'initialCapital', label: '回测初始资金（标的计价币种）', step: 'any', min: Number.MIN_VALUE },
  { key: 'feeBps', label: '费用（基点）', step: 'any', min: 0 },
  { key: 'slippageBps', label: '滑点（基点）', step: 'any', min: 0 },
];
const INDICATOR_FIELDS: ReadonlyArray<{ key: IndicatorKey; label: string; min: number; step: number | 'any' }> = [
  { key: 'fastMA', label: '快均线周期', min: 1, step: 1 },
  { key: 'slowMA', label: '慢均线周期', min: 1, step: 1 },
  { key: 'rsiPeriod', label: 'RSI 周期', min: 1, step: 1 },
  { key: 'sarStart', label: 'SAR 初始加速因子', min: Number.MIN_VALUE, step: 'any' },
  { key: 'sarStep', label: 'SAR 加速步长', min: Number.MIN_VALUE, step: 'any' },
  { key: 'sarMax', label: 'SAR 最大加速因子', min: Number.MIN_VALUE, step: 'any' },
];

/**
 * 将时间转换为中国时区的原生日期时间输入值，与浏览器本地时区无关。
 * @param timestamp 带时区的时间字符串，空值显示为空。
 * @returns 精确到秒的中国时间；时间无效时返回空字符串。
 */
function toChinaInput(timestamp: string | null): string {
  if (!timestamp) return '';
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) return '';
  return new Date(milliseconds + 8 * 60 * 60 * 1000).toISOString().slice(0, 19);
}

/**
 * 为原生日期时间输入显式附加中国时区，不经过浏览器本地时区转换。
 * @param localTime 中国时间输入值。
 * @returns 带 +08:00 偏移的时间字符串；空输入返回空字符串供校验提示。
 */
function fromChinaInput(localTime: string): string {
  if (!localTime) return '';
  return `${localTime.length === 16 ? `${localTime}:00` : localTime}+08:00`;
}

/**
 * 格式化版本保存时间。
 * @param timestamp 领域模型中的带时区时间。
 * @returns 中国时间和明确的时区说明，无效值返回说明文字。
 */
function savedTimeLabel(timestamp: string): string {
  const localTime = toChinaInput(timestamp);
  return localTime ? `${localTime.replace('T', ' ')}（中国时间 UTC+08:00）` : '尚无有效保存时间';
}

/**
 * 创建与运行中计划完全隔离的草稿，包括所有指标参数及条件对象。
 * @param plan 已保存的原始计划。
 * @returns 可供本地编辑的新计划对象。
 */
function cloneDraft(plan: TradingPlan): TradingPlan {
  return {
    ...plan,
    indicatorConfig: { ...plan.indicatorConfig },
    entry: { ...plan.entry, conditions: plan.entry.conditions.map(cloneCondition) },
    exit: { ...plan.exit, conditions: plan.exit.conditions.map(cloneCondition) },
  };
}

/**
 * 复制条件，避免草稿与运行计划共享可变对象。
 * @param condition 原始条件。
 * @returns 独立的条件副本。
 */
function cloneCondition(condition: Condition): Condition {
  return { ...condition };
}

/**
 * 渲染原生数字输入，保留空值语义且拒绝将空输入自动变为零。
 * @param props 标签、数值、约束与修改回调。
 * @returns 带可访问标签与提示的数字输入。
 */
function NumberField({ label, value, onChange, optional = false, min, max, step = 'any', hint }: NumberFieldProps) {
  const hintId = useId();
  return (
    <label className="plan-editor-field">
      <span>{label}{optional && <small>（可留空）</small>}</span>
      <input type="number" value={value !== null && Number.isFinite(value) ? value : ''}
        required={!optional} min={min} max={max} step={step}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.valueAsNumber)} />
      {hint && <small id={hintId}>{hint}</small>}
    </label>
  );
}

/**
 * 渲染一个条件的可编辑字段及领域描述。
 * @param props 当前条件、排序编号、更新回调与删除回调。
 * @returns 条件编辑行。
 */
function ConditionRow({ condition, index, onChange, onRemove }: {
  condition: Condition;
  index: number;
  onChange: (condition: Condition) => void;
  onRemove: () => void;
}) {
  return (
    <div className="condition-row" role="group" aria-label={`条件 ${index + 1}`}>
      <label className="plan-editor-field"><span>左侧指标</span>
        <select value={condition.left}
          onChange={(event) => onChange({ ...condition, left: event.target.value as Metric })}>
          {METRICS.map((metric) => <option key={metric.value} value={metric.value}>{metric.label}</option>)}
        </select>
      </label>
      <label className="plan-editor-field"><span>比较关系</span>
        <select value={condition.operator}
          onChange={(event) => onChange({ ...condition, operator: event.target.value as Condition['operator'] })}>
          {OPERATORS.map((operator) => <option key={operator.value} value={operator.value}>{operator.label}</option>)}
        </select>
      </label>
      <label className="plan-editor-field"><span>右侧字段</span>
        <select value={condition.right}
          onChange={(event) => onChange({ ...condition, right: event.target.value as Condition['right'] })}>
          <option value="constant">固定阈值</option>
          {METRICS.map((metric) => <option key={metric.value} value={metric.value}>{metric.label}</option>)}
        </select>
      </label>
      {condition.right === 'constant' ? (
        <NumberField label="阈值" value={condition.value}
          onChange={(value) => onChange({ ...condition, value: value ?? Number.NaN })} />
      ) : <p className="condition-row-value">逐柱比较两项指标</p>}
      <button className="plan-editor-button condition-row-remove" type="button" onClick={onRemove}
        aria-label={`移除条件 ${index + 1}`}>移除</button>
      <p className="condition-row-description">{condition.right === 'constant' && !Number.isFinite(condition.value)
        ? '请填写有效阈值' : conditionLabel(condition)}</p>
    </div>
  );
}

/**
 * 编辑全部满足或任一满足的条件组。
 * @param props 组标题、条件组和不可变更新回调。
 * @returns 包含添加、移除操作的条件组区域。
 */
function ConditionGroupEditor({ title, group, onChange }: {
  title: string;
  group: ConditionGroup;
  onChange: (group: ConditionGroup) => void;
}) {
  /**
   * 添加具有稳定唯一标识的默认条件。
   * @returns 无返回值，通知上层替换条件组。
   */
  function addCondition(): void {
    onChange({ ...group, conditions: [...group.conditions, {
      id: crypto.randomUUID(), left: 'close', operator: 'gt', right: 'constant', value: 0,
    }] });
  }
  return (
    <fieldset className="plan-editor-section">
      <legend>{title}</legend>
      <div className="plan-editor-group-toolbar">
        <label className="plan-editor-field"><span>满足方式</span>
          <select value={group.mode}
            onChange={(event) => onChange({ ...group, mode: event.target.value as ConditionGroup['mode'] })}>
            <option value="all">所有条件满足</option><option value="any">任一条件满足</option>
          </select>
        </label>
        <button type="button" className="plan-editor-button" onClick={addCondition}>添加条件</button>
      </div>
      {group.conditions.length === 0 && <p className="plan-editor-note">暂无条件，请添加后保存。</p>}
      <div className="plan-editor-conditions">
        {group.conditions.map((condition, index) => (
          <ConditionRow key={condition.id} condition={condition} index={index}
            onChange={(updated) => onChange({ ...group,
              conditions: group.conditions.map((current) => current.id === condition.id ? updated : current) })}
            onRemove={() => onChange({ ...group,
              conditions: group.conditions.filter((current) => current.id !== condition.id) })} />
        ))}
      </div>
    </fieldset>
  );
}

/**
 * 渲染计划名称、生效时间与锁定的市场上下文。
 * @param props 当前草稿及更新回调。
 * @returns 计划基本信息区域。
 */
function PlanIdentityFields({ draft, onChange }: { draft: TradingPlan; onChange: (draft: TradingPlan) => void }) {
  return (
    <fieldset className="plan-editor-section">
      <legend>计划信息</legend>
      <dl className="plan-editor-context" aria-label="锁定的市场上下文">
        <div><dt>证券 · 锁定</dt><dd>{draft.symbol}</dd></div>
        <div><dt>来源 · 锁定</dt><dd>{draft.source === 'demo' ? '演示数据' : 'Longbridge'}</dd></div>
        <div><dt>周期 · 锁定</dt><dd>{PERIOD_LABELS[draft.period]}</dd></div>
      </dl>
      <label className="plan-editor-field"><span>计划名称</span>
        <input value={draft.name} required maxLength={120} autoFocus
          onChange={(event) => onChange({ ...draft, name: event.target.value })} />
      </label>
      <div className="plan-editor-grid">
        <label className="plan-editor-field"><span>生效时间（中国时间）</span>
          <input type="datetime-local" step={1} required value={toChinaInput(draft.validFrom)}
            onChange={(event) => onChange({ ...draft, validFrom: fromChinaInput(event.target.value) })} />
        </label>
        <label className="plan-editor-field"><span>失效时间（中国时间）</span>
          <input type="datetime-local" step={1} required value={toChinaInput(draft.validUntil)}
            onChange={(event) => onChange({ ...draft, validUntil: fromChinaInput(event.target.value) })} />
        </label>
      </div>
      <p className="plan-editor-note">所有时间以中国时间 UTC+08:00 显示与保存，失效时间须晚于生效时间。</p>
    </fieldset>
  );
}

/**
 * 渲染价格、风险执行与指标参数，完整保留未展示的指标配置。
 * @param props 当前草稿及更新回调。
 * @returns 按用途折叠的参数区域。
 */
function PlanParameterFields({ draft, onChange }: { draft: TradingPlan; onChange: (draft: TradingPlan) => void }) {
  /**
   * 更新可为空的观察价格。
   * @param key 价格字段名。
   * @param value 新价格，空输入保持 null。
   * @returns 无返回值，通知上层替换草稿。
   */
  function updatePrice(key: PriceKey, value: number | null): void {
    onChange({ ...draft, [key]: value });
  }
  /**
   * 更新风险数值，空必填项用非有限值表示，避免误存为零。
   * @param key 风险字段名。
   * @param value 输入数值。
   * @returns 无返回值，通知上层替换草稿。
   */
  function updateRisk(key: RiskKey, value: number | null): void {
    onChange({ ...draft, [key]: value ?? Number.NaN });
  }
  /**
   * 更新单个指标参数，其余配置保持原值。
   * @param key 指标参数名。
   * @param value 输入数值。
   * @returns 无返回值，通知上层替换草稿。
   */
  function updateIndicator(key: IndicatorKey, value: number | null): void {
    const indicatorConfig: IndicatorConfig = { ...draft.indicatorConfig, [key]: value ?? Number.NaN };
    onChange({ ...draft, indicatorConfig });
  }
  return (
    <>
      <details className="plan-editor-details">
        <summary>观察价格与风险执行</summary>
        <fieldset className="plan-editor-section">
          <legend>价格（按证券报价单位）</legend>
          <div className="plan-editor-grid">
            <NumberField label="观察入场价" optional min={0} value={draft.entryPrice}
              onChange={(value) => updatePrice('entryPrice', value)} />
            <NumberField label="固定止损价" optional min={0} value={draft.stopPrice}
              onChange={(value) => updatePrice('stopPrice', value)} />
            <NumberField label="目标价" optional min={0} value={draft.targetPrice}
              onChange={(value) => updatePrice('targetPrice', value)} />
          </div>
        </fieldset>
        <fieldset className="plan-editor-section">
          <legend>风险、数量与成本</legend>
          <div className="plan-editor-grid">
            {RISK_FIELDS.map((field) => <NumberField key={field.key} label={field.label}
              value={draft[field.key]} min={field.min} step={field.step}
              onChange={(value) => updateRisk(field.key, value)} />)}
          </div>
          <p className="plan-editor-note">百分比按 % 填写；1 基点 = 0.01%。风险阈值统一以收盘价比较，下一柱开盘执行，不是触价保护单。</p>
        </fieldset>
      </details>
      <details className="plan-editor-details">
        <summary>指标参数</summary>
        <fieldset className="plan-editor-section">
          <legend>本计划的指标配置</legend>
          <div className="plan-editor-grid">
            {INDICATOR_FIELDS.map((field) => <NumberField key={field.key} label={field.label}
              value={draft.indicatorConfig[field.key]} min={field.min} step={field.step}
              onChange={(value) => updateIndicator(field.key, value)} />)}
          </div>
          <p className="plan-editor-note">参数随本计划版本保存；其他已有指标配置完整保留。未保存的修改不会改变运行中的计划。</p>
        </fieldset>
      </details>
    </>
  );
}

/**
 * 展示保存时间、研究边界和统一的风险执行方式。
 * @param props 已保存的计划及说明区域标识。
 * @returns 计划编辑器顶部说明区域。
 */
function PlanEditorNotice({ plan, id }: { plan: TradingPlan; id: string }) {
  return (
    <div className="plan-editor-notice" id={id}>
      <p>当前版本保存时间：{savedTimeLabel(plan.updatedAt)}</p>
      <p>回测仅用于研究规则，不能证明历史上已存在本计划。保存时间记录实际版本变更；回测研究与实时监控分离。</p>
      <p>入场、退出及风险规则统一在收盘时比较，下一柱开盘执行；固定止损与追踪止损均不是触价保护单。</p>
    </div>
  );
}

/**
 * 管理单个版本的隔离草稿、原生模态框及保存校验。
 * @param props 非空原始计划、保存回调和关闭请求回调。
 * @returns 当前版本的原生模态编辑器。
 */
function PlanEditorDraft({ plan, onSave, onClose }: DraftProps) {
  const [draft, setDraft] = useState<TradingPlan>(() => cloneDraft(plan));
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const errorsRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const noteId = useId();
  const errorsId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  useEffect(() => {
    if (errors.length) errorsRef.current?.focus();
  }, [errors]);

  /**
   * 修改本地草稿，移除上次提交状态，不影响父级运行状态。
   * @param nextDraft 新的隔离草稿。
   * @returns 无返回值。
   */
  function updateDraft(nextDraft: TradingPlan): void {
    setDraft(nextDraft);
    setErrors([]);
    setSaved(false);
  }

  /**
   * 完成原生输入校验和领域校验后，发布新版本，交由父组件关闭。
   * @param event 表单提交事件。
   * @returns 无返回值；失败时保留草稿并显示明确错误。
   */
  function saveDraft(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const candidate: TradingPlan = {
      ...cloneDraft(draft), name: draft.name.trim(), revision: plan.revision + 1,
      updatedAt: new Date().toISOString(),
      validFrom: fromChinaInput(toChinaInput(draft.validFrom)),
      validUntil: fromChinaInput(toChinaInput(draft.validUntil)),
    };
    try {
      validatePlan(candidate);
      // 折叠区域中的输入也要检查；先展开再调用原生校验，确保可聚焦。
      const invalidInputs = event.currentTarget.querySelectorAll<HTMLInputElement>('input:invalid');
      invalidInputs.forEach((input) => input.closest('details')?.setAttribute('open', ''));
      if (!event.currentTarget.reportValidity()) {
        setErrors(['请修正表单中标记的必填项或数值范围。']);
        return;
      }
      onSave(candidate);
      setSaved(true);
      console.info('[PlanEditor] 计划新版本已提交', { revision: candidate.revision });
    } catch (error) {
      const message = error instanceof Error ? error.message : '发生未知错误';
      setErrors([`计划保存失败：${message}`]);
      console.error('[PlanEditor] 计划校验或保存失败');
    }
  }

  return (
    <dialog ref={dialogRef} className="plan-editor" aria-label="编辑交易计划" aria-describedby={noteId}
      onClick={(event) => { if (event.target === dialogRef.current) onClose(); }}
      onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <form className="plan-editor-form" noValidate onSubmit={saveDraft}>
        <header className="plan-editor-header">
          <div><p className="plan-editor-eyebrow">计划版本 {plan.revision}</p><h2 id={titleId}>编辑交易计划</h2></div>
          <button className="plan-editor-button" type="button" onClick={onClose} aria-label="关闭计划编辑器">关闭</button>
        </header>
        <div className="plan-editor-body">
          <PlanEditorNotice plan={plan} id={noteId} />
          <PlanIdentityFields draft={draft} onChange={updateDraft} />
          <ConditionGroupEditor title="入场条件" group={draft.entry}
            onChange={(entry) => updateDraft({ ...draft, entry })} />
          <ConditionGroupEditor title="退出条件" group={draft.exit}
            onChange={(exit) => updateDraft({ ...draft, exit })} />
          <PlanParameterFields draft={draft} onChange={updateDraft} />
        </div>
        <footer className="plan-editor-footer">
          {errors.length > 0 && <div id={errorsId} ref={errorsRef} className="plan-editor-error"
            role="alert" tabIndex={-1}><strong>无法保存计划</strong><ul>
              {errors.map((message, index) => <li key={`${index}-${message}`}>{message}</li>)}
            </ul></div>}
          {saved && <p className="plan-editor-success" role="status">计划已提交保存与回测，请以父级返回结果为准。</p>}
          <p className="plan-editor-note">保存后创建版本 {plan.revision + 1}，并使用当前时间记录更新。</p>
          <div className="plan-editor-actions">
            <button className="plan-editor-button" type="button" onClick={onClose}>取消</button>
            <button className="plan-editor-button plan-editor-primary" type="submit" disabled={saved}
              aria-describedby={errors.length ? errorsId : undefined}>保存并回测</button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}

/**
 * 按计划标识和版本号重建草稿；空计划不打开对话框。
 * @param props 待编辑计划、保存回调和关闭请求回调。
 * @returns 非空计划对应的编辑器，或 null。
 */
export function PlanEditor({ plan, onSave, onClose }: PlanEditorProps) {
  return plan ? <PlanEditorDraft key={`${plan.id}-${plan.revision}`} plan={plan} onSave={onSave} onClose={onClose} /> : null;
}
