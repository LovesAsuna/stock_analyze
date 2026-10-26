import type { SourceMode } from './types';

/** 统一基本面口径；数值缺失用 null，百分比以百分数表示。 */
export interface FundamentalCompany {
  symbol: string;
  name: string;
  currency: string;
  price: number | null;
  marketCap: number | null;
  pe: number | null;
  pb: number | null;
  ps: number | null;
  dividendYield: number | null;
  /** 与同业比较快照一致的百分数，报告期可能未提供。 */
  roe?: number | null;
  netMargin?: number | null;
  /** 倍数与同接口每股字段交叉核对失败的方法，不用于估值。 */
  excludedMethods?: ('pe' | 'pb' | 'ps')[];
}

/** 财务指标单独保留财报期间和单位，避免与行情快照混为同一期。 */
export interface FinancialMetric {
  label: string;
  value: number | null;
  unit: 'percent' | 'number' | 'money';
  period: string;
  currency?: string;
}

/** 服务端归一化后的基本面响应，同行由上游选择。 */
export interface FundamentalData {
  source: SourceMode;
  symbol: string;
  fetchedAt: string;
  company: FundamentalCompany;
  peers: FundamentalCompany[];
  industry: string | null;
  comparisonBasis: string;
  metrics: FinancialMetric[];
  warnings: string[];
}

/** 每种相对估值都保留独立结果，不把不同方法任意加权成一个目标价。 */
export interface RelativeValuation {
  key: 'pe' | 'pb' | 'ps';
  label: string;
  basisLabel: string;
  basis: number;
  median: number;
  lowerMultiple: number;
  upperMultiple: number;
  low: number;
  central: number;
  high: number;
  upside: number;
  peers: FundamentalCompany[];
}

/** 计算递增数组的线性插值分位数。参数：有限有序数值和0–1分位；返回：样本分位。 */
function quantile(sorted: number[], percentile: number): number {
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

/**
 * 计算同行倍数相对估值，不预测未来收益，也不跨币种推算每股金额。
 * @param data 当前证券及上游自动选择的同口径行业样本。
 * @returns 各自拥有至少两家有效同行、当前基数为正的估值方法。
 */
export function relativeValuations(data: FundamentalData): RelativeValuation[] {
  const company = data.company;
  if (company.price === null || !Number.isFinite(company.price) || company.price <= 0) return [];
  const methods = [
    { key: 'pe', label: '市盈率估值', basisLabel: '隐含每股盈利' },
    { key: 'pb', label: '市净率估值', basisLabel: '隐含每股净资产' },
    { key: 'ps', label: '市销率估值', basisLabel: '隐含每股收入' },
  ] as const;
  return methods.flatMap(method => {
    const multiple = company[method.key];
    if (company.excludedMethods?.includes(method.key) || multiple === null || !Number.isFinite(multiple) || multiple <= 0) return [];
    const seen = new Set([company.symbol]);
    const peers = data.peers.filter(peer => {
      const value = peer[method.key];
      if (seen.has(peer.symbol) || peer.excludedMethods?.includes(method.key) || peer.currency !== company.currency
        || value === null || !Number.isFinite(value) || value <= 0) return false;
      seen.add(peer.symbol);
      return true;
    });
    if (peers.length < 2) return [];
    const sorted = peers.map(peer => peer[method.key]!).sort((earlier, later) => earlier - later);
    const basis = company.price! / multiple;
    const median = quantile(sorted, 0.5);
    const lowerMultiple = quantile(sorted, 0.25);
    const upperMultiple = quantile(sorted, 0.75);
    const central = basis * median;
    const low = basis * lowerMultiple;
    const high = basis * upperMultiple;
    const upside = (central / company.price! - 1) * 100;
    if (basis <= 0 || ![basis, median, central, low, high, upside].every(Number.isFinite)) return [];
    return [{ ...method, basis, median, lowerMultiple, upperMultiple, low, central, high, upside, peers }];
  });
}
