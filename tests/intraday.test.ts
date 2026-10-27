import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveIntraday, normalizeIntraday } from '../server/intraday';
import { demoIntraday } from '../server/demo';
import { exchangeParts, exchangeTimestamp } from '../shared/intraday';
import { nativeSession } from '../server/native-feed';

/** 构造不含账户字段的真实契约样本，参数为时间和额外字段，返回CLI点。 */
function point(time: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { timestamp: time, price: '100', volume: '123', avg_price: '99.5', ...extra };
}

test('分时保留真实时间、字符串trade_session、均价并排序去重', () => {
  const overnight = point('2026-10-15T00:30:00Z', { trade_session: 'Overnight' });
  const regular = point('2026-10-14T14:00:00Z', { trade_session: 'Intraday', avg_price: null });
  const result = normalizeIntraday({ base_price: '99', timeshares: [overnight, regular, regular], avg_price_algo: 1 }, 'NVDA.US');
  assert.equal(result.length, 2);
  assert.equal(result[0].time, Date.parse('2026-10-14T14:00:00Z') / 1000);
  assert.equal(result[0].session, 'regular');
  assert.equal(result[0].averagePrice, null);
  assert.equal(result[1].session, 'overnight');
  assert.equal(result[1].averagePrice, 99.5);
  assert.throws(() => normalizeIntraday([point('2026-10-14T14:00:00Z', { volume: -1 })], 'NVDA.US'), /volume/);
  assert.throws(() => normalizeIntraday([point('2026-10-14T14:00:00Z', { price: 0 })], 'NVDA.US'), /价格/);
  assert.throws(() => normalizeIntraday([point('2026-10-14 14:00:00')], 'NVDA.US'), /时区/);
});

test('缺少时段字段按美东夏令时、冬令时边界分类', () => {
  for (const [date, opening] of [['2026-07-10', 13], ['2026-01-09', 14]] as const) {
    const rows = [point(`${date}T${opening}:29:00Z`), point(`${date}T${opening}:30:00Z`),
      point(`${date}T${opening + 6}:59:00Z`), point(`${date}T${opening + 7}:00:00Z`)];
    assert.deepEqual(normalizeIntraday(rows, 'NVDA.US').map((entry) => entry.session), ['pre', 'regular', 'regular', 'post']);
  }
  assert.equal(normalizeIntraday([point('2026-10-14T08:00:00Z')], 'NVDA.US')[0].session, 'pre');
  assert.equal(normalizeIntraday([point('2026-10-15T00:00:00Z')], 'NVDA.US')[0].session, 'overnight');
});

test('最近五个非空交易日按交易所日期回溯，最多12次并发2，保留时间', async () => {
  const requested: string[] = [];
  let active = 0;
  let maxActive = 0;
  const request = async (args: string[]): Promise<unknown> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    assert.equal(args[args.indexOf('--session') + 1], 'all');
    const date = args.includes('--date') ? args[args.indexOf('--date') + 1] : '20261019';
    requested.push(date);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
    return day === 0 || day === 6 ? [] : [point(`${iso}T14:00:00Z`)];
  };
  // UTC已经10月20日，美东仍是10月19日。
  const result = await liveIntraday('NVDA.US', 'regular', 5, { now: new Date('2026-10-20T01:00:00Z'), request });
  assert.equal(requested[0], '20261019');
  assert.equal(result.points.length, 5);
  assert.equal(maxActive, 2);
  assert.ok(requested.length <= 12);
  assert.deepEqual(result.points.map((entry) => new Date(entry.time * 1000).toISOString().slice(0, 10)),
    ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19']);
});

test('空夜盘不替代常规时段，港股特殊时段直接空并提示', async () => {
  let calls = 0;
  const request = async (): Promise<unknown> => { calls += 1; return [point('2026-10-14T14:00:00Z')]; };
  const overnight = await liveIntraday('NVDA.US', 'overnight', 1, { request });
  assert.equal(calls, 12);
  assert.deepEqual(overnight.points, []);
  assert.match(overnight.warnings.join(' '), /真实夜盘/);
  const hongKong = await liveIntraday('700.HK', 'pre', 5, { request });
  assert.equal(calls, 12);
  assert.deepEqual(hongKong.points, []);
  assert.match(hongKong.warnings.join(' '), /港股/);
  assert.deepEqual(normalizeIntraday([point('2026-10-14T04:30:00Z')], '700.HK'), []);
});

test('单日读取与解析失败显式提示，边界输入验证且不泄漏响应原文', async () => {
  const result = await liveIntraday('NVDA.US', 'regular', 1, { request: async () => { throw new Error('SECRET_ACCOUNT'); } });
  assert.equal(result.points.length, 0);
  assert.match(result.warnings.join(' '), /12 个日期/);
  assert.doesNotMatch(result.warnings.join(' '), /SECRET_ACCOUNT/);
  await assert.rejects(liveIntraday('NVDA.US;whoami', 'all', 1), /证券代码/);
  await assert.rejects(liveIntraday('NVDA.US', 'all', 2 as 1), /天数/);
});

test('原生读取传递目标时段与历史日期，五日结果不依赖CLI', async () => {
  const requested: Array<{ symbol: string; session: string; date?: string }> = [];
  const result = await liveIntraday('AAPL.US', 'regular', 5, {
    now: new Date('2026-10-27T16:00:00Z'),
    nativeRequest: async (payload) => {
      requested.push(payload);
      const date = payload.date ?? '20261027';
      const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
      return [point(`${iso}T14:00:00Z`)];
    },
  });
  assert.deepEqual(requested[0], { symbol: 'AAPL.US', session: 'regular' });
  assert.equal(requested[1].date, '20261026');
  assert.ok(requested.every((payload) => payload.session === 'regular'));
  assert.equal(result.points.length, 5);
  assert.deepEqual(result.warnings, []);
});

test('默认入口直接调用共享原生会话，成功结果无需CLI安装', async () => {
  const original = nativeSession.intradayCall;
  const requested: unknown[] = [];
  nativeSession.intradayCall = async (payload) => { requested.push(payload); return [point('2026-10-27T14:00:00Z')]; };
  try {
    const result = await liveIntraday('AAPL.US', 'regular', 1, { now: new Date('2026-10-27T16:00:00Z') });
    assert.equal(result.points.length, 1);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(requested[0], { symbol: 'AAPL.US', session: 'regular' });
  } finally { nativeSession.intradayCall = original; }
});

test('原生不可用停止回溯且不启动CLI，部分成功点仍保留', async () => {
  let requests = 0;
  const result = await liveIntraday('AAPL.US', 'all', 5, {
    now: new Date('2026-10-27T16:00:00Z'),
    nativeRequest: async () => {
      requests += 1;
      if (requests === 1) return [point('2026-10-27T14:00:00Z')];
      throw new Error('SECRET_DESKTOP_TOKEN');
    },
  });
  assert.equal(result.points.length, 1);
  assert.equal(requests, 4);
  assert.match(result.warnings.join(' '), /桌面原生引擎/);
  assert.doesNotMatch(result.warnings.join(' '), /SECRET_DESKTOP_TOKEN|longbridge check/);
  const unavailable = await liveIntraday('AAPL.US', 'regular', 1, { nativeRequest: async () => { throw new Error('engine-missing'); } });
  assert.match(unavailable.warnings.join(' '), /2 个日期/);
});

test('分时demo确定性、五日330/390点、港股午休及明确合成标记', () => {
  const us = demoIntraday('NVDA.US', 'regular', 5);
  assert.deepEqual(us, demoIntraday('NVDA.US', 'regular', 5));
  assert.equal(us.source, 'demo');
  assert.equal(us.points.length, 390 * 5);
  assert.match(us.warnings.join(' '), /合成/);
  const hk = demoIntraday('700.HK', 'regular', 1);
  assert.equal(hk.points.length, 330);
  assert.ok(hk.points.every((entry) => { const local = exchangeParts(entry.time, '700.HK'); return local.hour !== 12; }));
  assert.deepEqual(demoIntraday('700.HK', 'overnight', 1).points, []);
  const overnight = demoIntraday('NVDA.US', 'overnight', 1);
  assert.equal(overnight.points.length, 480);
  assert.equal(new Date(overnight.points[0].time * 1000).toISOString(), '2026-10-16T00:00:00.000Z');
  assert.ok(overnight.points.every((entry) => entry.volume > 0));
  const winter = { year: 2026, month: 1, day: 9, hour: 9, minute: 30 };
  assert.equal(new Date(exchangeTimestamp(winter, 'NVDA.US') * 1000).toISOString(), '2026-01-09T14:30:00.000Z');
});
