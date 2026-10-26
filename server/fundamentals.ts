import type { FinancialMetric, FundamentalCompany, FundamentalData } from '../shared/fundamentals.js';
import { cli, normalizeSymbol, rows } from './longbridge.js';

type Row = Record<string, unknown>;
type Method = 'pe' | 'pb' | 'ps';
const METHODS = [
  { key: 'pe', field: 'eps', label: 'PE / EPS' },
  { key: 'pb', field: 'bps', label: 'PB / BPS' },
  { key: 'ps', field: 'sales_ps', label: 'PS / 每股收入' },
] as const;
const REPORT_METRICS = [
  { section: 'IS', field: 'OperatingRevenue', label: '营业收入', unit: 'money', growth: '营收同比' },
  { section: 'IS', field: 'NetProfit', label: '净利润', unit: 'money', growth: '净利润同比' },
  { section: 'CF', field: 'NetOperateCashFlow', label: '经营现金流', unit: 'money' },
  { section: 'IS', field: 'ROEDf', label: '净资产收益率 ROE', unit: 'percent' },
  { section: 'IS', field: 'GrossMgn', label: '毛利率', unit: 'percent' },
  { section: 'IS', field: 'NetProfitMarginDf', label: '净利率', unit: 'percent' },
] as const;

/** 将外部值安全解包；参数为未知响应，返回对象或空对象。 */
function object(value: unknown): Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

/** 严格解析十进制有限数；参数为外部字段，空值、布尔值及无效文本返回 null。 */
function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 读取非空文本；参数为外部值和缺省文本，返回经过 trim 的字符串。 */
function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/** 识别真正缺失的每股字段；参数为原字段，返回是否允许仅按倍数推导隐含基数。 */
function missing(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/**
 * 核对同一行的价格、倍数和每股字段，避免使用相互冲突的上游口径。
 * @param company 已解析的公司。
 * @param record 原始比较行。
 * @param warnings 收集不含原始响应的提示。
 * @returns 必须禁用的估值方法。
 */
function excludedMethods(company: FundamentalCompany, record: Row, warnings: string[]): Method[] {
  const excluded: Method[] = [];
  for (const method of METHODS) {
    const multiple = company[method.key];
    if (multiple === null || multiple <= 0 || company.price === null || company.price <= 0) {
      excluded.push(method.key);
      warnings.push(`${company.symbol} ${method.label} 缺少正价格或正倍数，不用于相对估值。`);
      continue;
    }
    if (missing(record[method.field])) {
      warnings.push(`${company.symbol} 缺少 ${method.field}，${method.key.toUpperCase()} 仅可推导隐含每股基数，尚未完成交叉核验。`);
      continue;
    }
    const basis = numeric(record[method.field]);
    if (basis === null || basis <= 0) {
      excluded.push(method.key);
      warnings.push(`${company.symbol} ${method.label} 每股基数无效或不为正，不用于相对估值。`);
      continue;
    }
    const implied = company.price / basis;
    // 以响应倍数为比较基准；上游不同报告期可能导致同一行数据不一致。
    if (!Number.isFinite(implied) || Math.abs(implied / multiple - 1) > 0.05) {
      excluded.push(method.key);
      warnings.push(`${company.symbol} ${method.label} 与价格交叉核验偏差超过 5%，已禁用该估值方法。`);
    }
  }
  return excluded;
}

/** 将比较行规范化；参数为原始行和提示集合，返回保留上游币种、数值及禁用方法的公司。 */
function normalizeCompany(record: Row, warnings: string[]): FundamentalCompany {
  const symbol = normalizeSymbol(record.symbol);
  const currency = text(record.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`Longbridge ${symbol} 比较数据缺少明确币种。`);
  const company: FundamentalCompany = {
    symbol, name: text(record.name, symbol), currency,
    price: numeric(record.price_close), marketCap: numeric(record.market_value),
    pe: numeric(record.pe), pb: numeric(record.pb), ps: numeric(record.ps),
    dividendYield: numeric(record.div_yld), roe: numeric(record.roe), netMargin: numeric(record.net_margin),
  };
  company.excludedMethods = excludedMethods(company, record, warnings);
  return company;
}

/** 解析财报日期；参数为 Unix 秒/毫秒或严格日期字符串，返回毫秒或 null。 */
function reportTime(value: unknown): number | null {
  const number = numeric(value);
  if (number !== null && number > 0) {
    const milliseconds = number > 1e12 ? number : number * 1000;
    return Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value ? milliseconds : null;
}

/** 从账户值中选报告结束日最新的一项；参数为账户，返回原始值及已解析日期，未知日期不冒充最新。 */
function latestValue(account: Row): { row: Row; time: number } | null {
  const values = Array.isArray(account.values) ? rows(account.values) : [];
  const dated = values.flatMap(row => {
    const time = reportTime(row.fp_end);
    return time === null ? [] : [{ row, time }];
  });
  return dated.sort((earlier, later) => later.time - earlier.time)[0] ?? null;
}

/**
 * 从完整财报读取指定账户，保留真实财年标签、截止日、币种与百分数口径。
 * @param report 完整 financial-report 响应。
 * @param warnings 提示集合。
 * @returns 可验证报告期的常用财务指标。
 */
function financialMetrics(report: unknown, warnings: string[]): FinancialMetric[] {
  const sections = object(object(report).list);
  const metrics: FinancialMetric[] = [];
  for (const spec of REPORT_METRICS) {
    const section = object(sections[spec.section]);
    const indicators = Array.isArray(section.indicators) ? rows(section.indicators) : [];
    const matches = indicators.flatMap(indicator => {
      const accounts = Array.isArray(indicator.accounts) ? rows(indicator.accounts) : [];
      return accounts.filter(account => account.field === spec.field).flatMap(account => {
        const latest = latestValue(account);
        return latest ? [{ indicator, ...latest }] : [];
      });
    }).sort((earlier, later) => later.time - earlier.time);
    const latest = matches[0];
    if (!latest) continue;
    const date = new Date(latest.time).toISOString().slice(0, 10);
    const period = `${text(latest.row.period, '财报')} · 截至 ${date}`;
    const currency = text(latest.indicator.currency).toUpperCase();
    if (spec.unit === 'money' && !/^[A-Z]{3}$/.test(currency)) {
      warnings.push(`${spec.label}缺少财报币种，未展示金额。`);
      continue;
    }
    metrics.push({ label: spec.label, value: numeric(latest.row.value), unit: spec.unit, period,
      ...(spec.unit === 'money' ? { currency } : {}) });
    // 完整 financial-report 的同比已经是百分数；不能沿用 --latest 的小数比例规则。
    if ('growth' in spec) metrics.push({ label: spec.growth, value: numeric(latest.row.yoy), unit: 'percent', period });
  }
  if (!metrics.length) warnings.push('未获得可确认报告期的完整财报指标；财报可能尚未发布或当前响应结构不受支持。');
  return metrics;
}

/** 从比较快照补充比率；参数为当前公司原始行及已有财务指标，返回明确标记期间未知的补充指标。 */
function comparisonMetrics(record: Row, existing: FinancialMetric[]): FinancialMetric[] {
  const fields = [
    { field: 'roe', label: '净资产收益率 ROE' }, { field: 'roa', label: '总资产收益率 ROA' },
    { field: 'net_margin', label: '净利率' }, { field: 'liabilities_assets', label: '资产负债率' },
  ];
  return fields.filter(spec => !existing.some(metric => metric.label === spec.label)).flatMap(spec => {
    const value = numeric(record[spec.field]);
    return value === null ? [] : [{ label: spec.label, value, unit: 'percent' as const, period: '上游比较快照 · 财报期间未提供' }];
  });
}

/**
 * 归一化真实公开基本面，不引入图表价格、硬编码同行或未经验证的 TTM 标签。
 * @param compare 同一币种的 compare JSON 响应。
 * @param report 完整 financial-report JSON 响应，读取失败可为 null。
 * @param symbol 当前港美证券代码。
 * @returns 公司、真实同行、财务指标及口径警告；当前证券缺失时抛错。
 */
export function normalizeFundamentals(compare: unknown, report: unknown, symbol: string): FundamentalData {
  symbol = normalizeSymbol(symbol);
  const warnings = ['同行由 Longbridge 自动选择；比较接口未提供行业名称、行情日期及财报期间，TTM 口径未经验证。'];
  const records = rows(compare);
  const companies: FundamentalCompany[] = [];
  const seen = new Set<string>();
  let baseRecord: Row | undefined;
  for (const record of records) {
    try {
      const company = normalizeCompany(record, warnings);
      if (seen.has(company.symbol)) continue;
      seen.add(company.symbol);
      companies.push(company);
      if (company.symbol === symbol) baseRecord = record;
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : 'Longbridge 比较数据包含无效证券行，已跳过。');
    }
  }
  const company = companies.find(candidate => candidate.symbol === symbol);
  if (!company || !baseRecord) throw new Error(`Longbridge 比较响应缺少 ${symbol} 的有效公司数据。`);
  const peers = companies.filter(candidate => candidate.symbol !== symbol);
  if (peers.length < 2) warnings.push('上游返回的有效同行不足两家，无法形成完整的相对估值区间。');
  if (peers.some(peer => peer.currency !== company.currency)) warnings.push('上游同行包含不同币种，相对估值将排除币种不同的样本。');
  const metrics = financialMetrics(report, warnings);
  metrics.push(...comparisonMetrics(baseRecord, metrics));
  return { source: 'longbridge', symbol, fetchedAt: new Date().toISOString(), company, peers, industry: null,
    comparisonBasis: `上游同一 compare 接口口径；${company.currency}；财报期间未提供，非已验证 TTM。`, metrics,
    warnings: [...new Set(warnings)] };
}

/**
 * 并行读取公开比较与完整财报，比较不可用则失败，财报失败允许部分展示。
 * @param symbol 当前港美证券代码。
 * @returns 使用上游同一比较价格的真实基本面数据。
 */
export async function liveFundamentals(symbol: string): Promise<FundamentalData> {
  symbol = normalizeSymbol(symbol);
  const currency = symbol.endsWith('.HK') ? 'HKD' : 'USD';
  const [comparison, report] = await Promise.allSettled([
    cli(['compare', symbol, '--currency', currency], 60_000),
    cli(['financial-report', symbol], 300_000),
  ]);
  if (comparison.status === 'rejected') throw comparison.reason;
  const data = normalizeFundamentals(comparison.value, report.status === 'fulfilled' ? report.value : null, symbol);
  if (report.status === 'rejected') data.warnings.push('Longbridge 财报读取失败，当前仅展示比较快照；请检查财报权限或稍后重试。');
  console.info(`[longbridge] fundamentals 读取完成：${data.peers.length} 个同行，${data.metrics.length} 项指标`);
  return data;
}
