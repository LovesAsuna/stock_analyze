import type { FundamentalCompany, FundamentalData } from '../shared/fundamentals.js';
import { normalizeSymbol } from './longbridge.js';

/**
 * 构造明确标记的合成基本面，样本名称不冒充真实同业数据。
 * @param symbol 当前证券代码。
 * @returns 固定日期的演示指标、合成同行及估值输入。
 */
export function demoFundamentals(symbol: string): FundamentalData {
  symbol = normalizeSymbol(symbol);
  const currency = symbol.endsWith('.HK') ? 'HKD' : 'USD';
  const company: FundamentalCompany = { symbol, name: '当前证券 · 合成样本', currency,
    price: 100, marketCap: 100_000_000_000, pe: 25, pb: 4, ps: 5, dividendYield: 1.2, roe: 16, netMargin: 20 };
  const peers = [18, 22, 28, 34].map((pe, index): FundamentalCompany => ({
    symbol: `DEMO${index + 1}.${symbol.endsWith('.HK') ? 'HK' : 'US'}`, name: `合成同业 ${index + 1}`, currency,
    price: 50 + index * 20, marketCap: (60 + index * 15) * 1e9,
    pe, pb: 2.5 + index, ps: 3 + index, dividendYield: 0.8 + index * 0.3, roe: 12 + index * 2, netMargin: 15 + index * 3,
  }));
  return { source: 'demo', symbol, fetchedAt: '2026-10-16T20:00:00.000Z', company, peers,
    industry: '合成行业', comparisonBasis: '合成财年口径；仅用于演示，不对应真实公司财务。',
    metrics: [
      { label: '净资产收益率 ROE', value: 16, unit: 'percent', period: '合成财年 2025' },
      { label: '净利率', value: 20, unit: 'percent', period: '合成财年 2025' },
      { label: '资产负债率', value: 38, unit: 'percent', period: '合成财年 2025' },
      { label: '营业收入', value: 20e9, unit: 'money', currency, period: '合成财年 2025' },
      { label: '营收同比', value: 12, unit: 'percent', period: '合成财年 2025' },
      { label: '经营现金流', value: 5e9, unit: 'money', currency, period: '合成财年 2025' },
    ], warnings: ['价格、财务指标和同业全部为合成样本，估值结果仅用于验证计算和界面。'] };
}
