import { useEffect, useState } from 'react';
import { BookOpen, RefreshCw } from 'lucide-react';
import type { FundamentalCompany, FundamentalData, FinancialMetric, RelativeValuation } from '../shared/fundamentals';
import { relativeValuations } from '../shared/fundamentals';
import type { SourceMode } from '../shared/types';
import { fetchFundamentals } from './api';
import { formatNumber, formatPercent } from './format';
import { MetricHelp } from './MetricHelp';

/** 金额按同一币种缩写；参数：金额和币种；返回：保留单位的文本，空值为破折号。 */
function money(value: number | null, currency: string): string {
  if (value === null) return '—';
  const scale = Math.abs(value) >= 1e12 ? 1e12 : Math.abs(value) >= 1e8 ? 1e8 : Math.abs(value) >= 1e4 ? 1e4 : 1;
  return `${currency} ${formatNumber(value / scale)}${scale === 1e12 ? '万亿' : scale === 1e8 ? '亿' : scale === 1e4 ? '万' : ''}`;
}

/** 格式化财务字段。参数：保留期间及单位的指标；返回：带单位的显示文本。 */
function metricValue(metric: FinancialMetric): string {
  return metric.unit === 'money' ? money(metric.value, metric.currency ?? '')
    : metric.unit === 'percent' ? metric.value === null ? '—' : `${formatNumber(metric.value)}%` : formatNumber(metric.value);
}

/** 核心倍数与财务指标。参数：独立快照；返回：具名、可读的财务列表。 */
function CoreMetrics({ data }: { data: FundamentalData }) {
  const company = data.company;
  const metrics = [
    { label: '总市值', value: money(company.marketCap, company.currency) },
    { label: '股息率', value: company.dividendYield === null ? '—' : `${formatNumber(company.dividendYield)}%` },
    ...(['pe', 'pb', 'ps'] as const).map(key => ({ label: ({ pe: '市盈率 PE', pb: '市净率 PB', ps: '市销率 PS' })[key],
      value: company[key] === null ? '—' : `${formatNumber(company[key])}×${company.excludedMethods?.includes(key) ? ' · 待核对' : ''}` })),
  ];
  return <section className="fundamental-section bg-surface text-foreground" aria-label="常用基本面指标">
    <div className="fundamental-section-heading"><h3>核心指标</h3><span>原始倍数</span></div>
    <dl className="fundamental-metrics">{metrics.map(metric => <div key={metric.label}><dt><MetricHelp label={metric.label} /></dt><dd>{metric.value}</dd></div>)}</dl>
    <p className="fundamental-note">{data.comparisonBasis}</p>
    <dl className="fundamental-financials">{data.metrics.map(metric => <div key={metric.label}>
      <dt><MetricHelp label={metric.label} /><small>{metric.period || '财报期间未提供'}</small></dt><dd>{metricValue(metric)}</dd>
    </div>)}</dl>
  </section>;
}

/** 一行同行倍数及盈利能力，冲突值显式标记。参数：证券及当前行标识；返回：具名财务单元格。 */
function PeerRow({ company, current = false }: { company: FundamentalCompany; current?: boolean }) {
  return <tr className={current ? 'fundamental-current-row' : ''}>
    <th scope="row"><span>{company.symbol}</span><small>{current ? '当前证券' : company.name}</small></th>
    {(['pe', 'pb', 'ps'] as const).map(key => <td key={key}>
      {formatNumber(company[key], 1)}{company.excludedMethods?.includes(key) && <small>待核对</small>}
    </td>)}
    <td>{company.roe == null ? '—' : `${formatNumber(company.roe, 1)}%`}</td>
    <td>{company.netMargin == null ? '—' : `${formatNumber(company.netMargin, 1)}%`}</td>
  </tr>;
}

/** 同行逐项比较保留原始样本名称。参数：快照；返回：可横向滚动的具名表格。 */
function PeerComparison({ data }: { data: FundamentalData }) {
  return <section className="fundamental-section">
    <div className="fundamental-section-heading"><h3>同行对比</h3><span>{data.peers.length} 家样本</span></div>
    <p className="fundamental-note">{data.industry ?? '行业分类未提供'} · {data.source === 'demo' ? '明确标记的合成样本' : 'Longbridge 自动选取同行'}</p>
    <div className="fundamental-table-scroll" tabIndex={0} role="region" aria-label="同行估值比较表">
      <table className="fundamental-peer-table"><caption className="sr-only">当前证券与上游行业样本估值倍数比较</caption>
        <thead><tr><th scope="col">证券</th><th scope="col">PE</th><th scope="col">PB</th><th scope="col">PS</th><th scope="col">ROE</th><th scope="col">净利率</th></tr></thead>
        <tbody><PeerRow company={data.company} current />{data.peers.map(peer => <PeerRow key={peer.symbol} company={peer} />)}</tbody>
      </table>
    </div>
    <p className="fundamental-note">表格可横向滚动查看 ROE 与净利率；均为同一比较快照，报告期可能未提供。</p>
    {!data.peers.length && <p className="fundamental-note">上游未返回同行，暂不计算行业相对估值。</p>}
  </section>;
}

/** 展示单种相对估值、公式和样本。参数：已核验的方法及计价币；返回：可审查的估值卡。 */
function ValuationCard({ value, currency }: { value: RelativeValuation; currency: string }) {
  return <article className="fundamental-valuation-card">
    <div className="fundamental-section-heading"><h4>{value.label}</h4><span>{value.peers.length} 家有效同行</span></div>
    <p className="fundamental-price">{money(value.central, currency)}<small>同行中位数对应价格</small></p>
    <dl className="fundamental-estimate-facts"><div><dt>25%–75% 样本区间</dt><dd>{formatNumber(value.low)}–{formatNumber(value.high)} {currency}</dd></div>
      <div><dt>相对快照价格</dt><dd>{formatPercent(value.upside)}</dd></div></dl>
    <details><summary>查看计算依据</summary>
      <p>{value.basisLabel} = 比较快照价格 ÷ 当前 {value.key.toUpperCase()} = {formatNumber(value.basis, 4)} {currency}</p>
      <p>中位数对应价格 = {formatNumber(value.basis, 4)} × 同行中位数 {formatNumber(value.median, 2)} = {formatNumber(value.central, 2)} {currency}</p>
      <p>区间采用同行倍数第 25 / 75 百分位 {formatNumber(value.lowerMultiple)}× / {formatNumber(value.upperMultiple)}×，乘以同一每股基数。</p>
      <p>有效样本：{value.peers.map(peer => peer.symbol).join('、')}。排除本股、重复、缺失、非正倍数、币种不同和口径冲突项。</p>
    </details>
  </article>;
}

/** 多方法估值保留各自假设，不把样本分位区间描述为预测概率。参数：快照；返回：独立估值及限制。 */
function ValuationSection({ data }: { data: FundamentalData }) {
  const valuations = relativeValuations(data);
  return <section className="fundamental-section" aria-label="相对估值与依据">
    <div className="fundamental-section-heading"><h3>相对估值</h3><BookOpen size={15} aria-hidden="true" /></div>
    <p className="fundamental-note">按同行当前倍数计算情景价格，区间表示样本分布，不是未来价格预测或置信区间。</p>
    {valuations.map(value => <ValuationCard key={value.key} value={value} currency={data.company.currency} />)}
    {!valuations.length && <p className="fundamental-unavailable">暂不能可靠估值：每种方法需正的当前倍数、有效价格及至少 2 家同币种有效同行。口径冲突的方法已停用。</p>}
    <p className="fundamental-note">PE 受盈利周期影响，亏损时不适用；PB 更适合资产可比的企业；PS 不反映利润与负债。同行由上游自动选择，业务结构、增长、资本结构及财年可能不同。未加入增长预测或 DCF 假设，不合并成单一目标价。</p>
  </section>;
}

/**
 * 按证券与数据源隔离异步快照，关闭标签后取消浏览器请求。
 * @param props 来源、证券及外部刷新序号。
 * @returns 带加载、失败重试与可审查估值的基本面栏目。
 */
export function FundamentalsPanel({ source, symbol, refresh }: { source: SourceMode; symbol: string; refresh: number }) {
  const [data, setData] = useState<FundamentalData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError(''); setLoading(true);
    fetchFundamentals(source, symbol, controller.signal).then(result => {
      if (!controller.signal.aborted) setData(result);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '基本面读取失败。');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [source, symbol, refresh, retry]);
  const snapshot = data?.source === source && data.symbol === symbol ? data : null;
  return <section className="fundamentals-panel" aria-label={`${symbol} 基本面分析`} aria-busy={loading}>
    <header className="fundamental-header"><div><span className="sidebar-eyebrow">财务与定价依据</span><h2>基本面分析</h2><p>{symbol}</p></div>
      <button className="icon-button" type="button" aria-label="刷新基本面" disabled={loading} onClick={() => setRetry(value => value + 1)}><RefreshCw size={15} aria-hidden="true" /></button>
    </header>
    {loading && <p className="fundamental-state" role="status">正在读取财务与行业样本…</p>}
    {error && <div className="fundamental-state" role="alert"><p>{error}</p><button className="button compact" onClick={() => setRetry(value => value + 1)}>重试基本面</button></div>}
    {snapshot && <>
      <div className="fundamental-snapshot"><span>{snapshot.source === 'demo' ? '合成演示 · 非真实财报' : 'Longbridge 比较快照'}</span>
        <strong>{money(snapshot.company.price, snapshot.company.currency)}</strong><small>独立于图表实时价 · 获取于 {new Date(snapshot.fetchedAt).toLocaleString('zh-CN')}</small></div>
      {snapshot.warnings.length > 0 && <details className="fundamental-warnings"><summary>数据口径与提示（{snapshot.warnings.length}）</summary>
        <ul>{snapshot.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details>}
      <CoreMetrics data={snapshot} /><PeerComparison data={snapshot} /><ValuationSection data={snapshot} />
    </>}
  </section>;
}
