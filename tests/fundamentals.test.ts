import test from 'node:test';
import assert from 'node:assert/strict';
import { relativeValuations } from '../shared/fundamentals';
import { demoFundamentals } from '../server/demo-fundamentals';
import { normalizeFundamentals } from '../server/fundamentals';

/** 验证可审查的同行分位数及每股基数，不依赖UI文本。 */
test('相对估值按同行中位数与四分位数计算，排除本股', () => {
  const data = demoFundamentals('NVDA.US');
  data.peers.push(data.company);
  const pe = relativeValuations(data).find(value => value.key === 'pe')!;
  assert.equal(pe.basis, 4);
  assert.equal(pe.median, 25);
  assert.equal(pe.central, 100);
  assert.equal(pe.lowerMultiple, 21);
  assert.equal(pe.upperMultiple, 29.5);
  assert.equal(pe.low, 84);
  assert.equal(pe.high, 118);
  assert.equal(pe.upside, 0);
  assert.equal(pe.peers.length, 4);
});

/** 亏损、冲突、重复、跨币种与缺失样本不得悄悄进入估值。 */
test('估值拒绝无效倍数及少于两家可比同行', () => {
  const data = demoFundamentals('700.HK');
  data.company.pe = -10;
  data.company.excludedMethods = ['pb'];
  data.peers = [
    { ...data.peers[0], ps: 2 },
    { ...data.peers[0], ps: 8 },
    { ...data.peers[1], ps: null },
    { ...data.peers[2], currency: 'USD' },
    { ...data.peers[3], ps: 4, excludedMethods: ['ps'] },
  ];
  assert.deepEqual(relativeValuations(data), []);
  data.peers.push({ ...data.peers[1], symbol: 'EXTRA.HK', ps: 4 });
  const values = relativeValuations(data);
  assert.equal(values.length, 1);
  assert.equal(values[0].key, 'ps');
  assert.equal(values[0].central, 60);
});

/** 上游财务金额和百分比保持原单位，财报与比较快照的期间不混用。 */
test('基本面解析保留期间与百分数并停用价格每股字段冲突的方法', () => {
  const rows = ['NVDA.US', 'TSM.US', 'AVGO.US'].map(symbol => ({ symbol, currency: 'USD', price_close: '100',
    pe: '25', eps: '2', pb: '4', bps: '25', ps: '5', sales_ps: '20', div_yld: '0.25', roe: '16' }));
  const report = { list: { IS: { indicators: [{ currency: 'USD', accounts: [{ field: 'OperatingRevenue', values: [
    { fp_end: '1751328000', period: 'Q2 2025', value: '200', yoy: '12.5' },
    { fp_end: '1782864000', period: 'Q2 2026', value: '300', yoy: '50' },
  ] }] }] } } };
  const data = normalizeFundamentals({ list: rows }, report, 'NVDA.US');
  assert.equal(data.company.dividendYield, 0.25);
  assert.deepEqual(data.company.excludedMethods, ['pe']);
  assert.equal(data.metrics.find(metric => metric.label === '营业收入')?.value, 300);
  assert.match(data.metrics.find(metric => metric.label === '营业收入')!.period, /2026-07-01/);
  assert.equal(data.metrics.find(metric => metric.label === '营收同比')?.value, 50);
  assert.deepEqual(relativeValuations(data).map(method => method.key), ['pb', 'ps']);
  const invalid = normalizeFundamentals({ list: [{ ...rows[0], pe: ' ', pb: false, market_value: '' }] }, null, 'NVDA.US');
  assert.equal(invalid.company.pe, null);
  assert.equal(invalid.company.pb, null);
  assert.equal(invalid.company.marketCap, null);
  assert.throws(() => normalizeFundamentals({ list: rows }, null, 'AAPL.US'), /缺少/);
});

/** 零价、NaN和溢出不应产生可展示的金额。 */
test('无有效价格或数值溢出时不输出估值', () => {
  const data = demoFundamentals('NVDA.US');
  for (const price of [0, -1, null, NaN]) {
    data.company.price = price;
    assert.deepEqual(relativeValuations(data), []);
  }
  data.company.price = Number.MAX_VALUE;
  data.company.pe = Number.MIN_VALUE;
  data.company.pb = null;
  data.company.ps = null;
  assert.deepEqual(relativeValuations(data), []);
});
