import test from 'node:test';
import assert from 'node:assert/strict';
import { liveMarket, liveWorkspace, marketHistoryWindow } from '../server/longbridge.js';
import { nativeSession } from '../server/native-feed.js';
import type { Period } from '../shared/types.js';
import { PERIODS } from '../shared/periods.js';

const start = '2025-01-01';
const end = '2025-04-01';
const rawCandle = { timestamp: Date.parse('2025-01-02T14:30:00Z') / 1000,
  open: 10, high: 12, low: 9, close: 11, volume: 100 };
const position = { symbol: 'NVDA.US', name: '英伟达', quantity: '10', available_quantity: '8', cost_price: '120', currency: 'USD' };
const watchlist = { groups: [{ securities: [{ symbol: '00700.HK', name: '腾讯' }] }] };

/** 模拟CLI未安装。参数：无；返回：带ENOENT代码的错误，不访问真实账户。 */
function missingCli(): Error & { code: string } {
  return Object.assign(new Error('spawn longbridge ENOENT'), { code: 'ENOENT' });
}

/** 返回原始测试柱。参数：无；返回：已知有效历史数据，隔离桌面引擎。 */
async function history(): Promise<Record<string, unknown>[]> { return [rawCandle]; }

for (const symbol of ['NVDA.US', 'QQQ.US', '700.HK', 'NVDA261120C200000.US']) {
  test(`${symbol}默认读取桌面历史，CLI仅可选读取成交且ENOENT不阻断`, async (context) => {
    const nativeCalls: unknown[] = [];
    const cliCalls: string[][] = [];
    context.mock.method(nativeSession, 'withCandleSession', async (job: () => Promise<unknown>) => job());
    context.mock.method(nativeSession, 'candleCall', async (payload: unknown) => {
      nativeCalls.push(payload);
      return [rawCandle];
    });
    const result = await liveMarket(symbol, 'day', start, end, {
      executions: async (args) => { cliCalls.push(args); throw missingCli(); },
    });
    assert.deepEqual(nativeCalls, [{ symbol, period: 'day', count: 1000 }]);
    assert.equal(cliCalls.length, 1);
    assert.deepEqual(cliCalls[0].slice(0, 2), ['order', 'executions']);
    assert.ok(cliCalls.every((args) => !args.includes('kline')));
    assert.equal(result.source, 'longbridge');
    assert.equal(result.symbol, symbol);
    assert.equal(result.candles[0].close, rawCandle.close);
    assert.deepEqual(result.executions, []);
    assert.equal(result.executionsComplete, false);
    assert.match(result.warnings.join(' '), /未安装 Longbridge CLI/);
    assert.match(result.warnings.join(' '), /成交状态未知.*不能据此认定没有成交/);
  });
}

test('季度桌面历史使用月线、从预热首月读取并聚合真实OHLCV', async (context) => {
  const calls: { symbol: string; period: string; count: number }[] = [];
  context.mock.method(nativeSession, 'withCandleSession', async (job: () => Promise<unknown>) => job());
  context.mock.method(nativeSession, 'candleCall', async (payload: typeof calls[number]) => {
    calls.push(payload);
    return [1, 2, 3].map((month) => ({ timestamp: Date.UTC(2025, month - 1, 1) / 1000,
      open: 10 + month, high: 15 + month, low: 8 + month, close: 12 + month, volume: month * 100 }));
  });
  const result = await liveMarket('NVDA.US', 'quarter', start, end, { executions: async () => [] });
  assert.deepEqual(calls, [{ symbol: 'NVDA.US', period: 'month', count: 1000 }]);
  assert.deepEqual(result.candles, [{ time: Date.UTC(2025, 0, 1) / 1000, open: 11, high: 18,
    low: 9, close: 15, volume: 600, confirmed: true }]);
  assert.equal(result.executionsComplete, true);
  const requests: unknown[][] = [];
  await liveMarket('00700.hk', 'quarter', start, end, {
    history: async (...args) => {
      requests.push(args);
      return [1, 2, 3].map((month) => ({ ...rawCandle, timestamp: Date.UTC(2025, month - 1, 1) / 1000 }));
    },
    executions: async () => [],
  });
  assert.deepEqual(requests, [['700.HK', 'quarter', marketHistoryWindow('quarter', start, end).start]]);
});

test('所有支持周期均将有限预热窗口传入桌面读取器', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  for (const period of PERIODS) {
    const requests: unknown[][] = [];
    const result = await liveMarket('QQQ.US', period, yesterday, today, {
      history: async (...args) => {
        requests.push(args);
        return period === 'quarter'
          ? [0, 1, 2].map((month) => ({ ...rawCandle, timestamp: Date.UTC(2025, month, 1) / 1000 }))
          : [rawCandle];
      },
      executions: async () => [],
    });
    assert.deepEqual(requests, [['QQQ.US', period, marketHistoryWindow(period, yesterday, today).start]]);
    assert.equal(result.period, period);
    assert.ok(result.candles.length > 0);
    assert.equal(result.executionsComplete, true);
  }
});

test('CLI正常时保留逐笔成交及中国时间闭开边界', async () => {
  const first = Date.parse(`${start}T00:00:00+08:00`) / 1000;
  const last = Date.parse(`${end}T00:00:00+08:00`) / 1000;
  const calls: string[][] = [];
  const result = await liveMarket('NVDA.US', 'day', start, end, {
    history,
    executions: async (args) => {
      calls.push(args);
      return [first - 1, first, last - 1, last].map((time, index) => ({
        trade_id: `trade-${index}`, symbol: 'NVDA.US', side: 'Buy', price: '10', quantity: '2', time,
      }));
    },
  });
  assert.deepEqual(calls, [['order', 'executions', '--history', '--symbol', 'NVDA.US',
    '--start', `${start}T00:00:00+08:00`, '--end', `${end}T00:00:00+08:00`]]);
  assert.deepEqual(result.executions.map((execution) => execution.time), [first, last - 1]);
  assert.equal(result.executionsComplete, true);
  assert.deepEqual(result.executionRange, { start, end });
});

test('畸形成交响应仍有行情，但不能伪造没有成交或部分完整成交', async () => {
  const result = await liveMarket('NVDA.US', 'day', start, end, {
    history,
    executions: async () => [{ ...rawCandle, symbol: 'NVDA.US', side: 'Buy', price: 10, quantity: 1, time: rawCandle.timestamp },
      { side: 'Unknown' }],
  });
  assert.equal(result.candles.length, 1);
  assert.equal(result.executionsComplete, false);
  assert.deepEqual(result.executions, []);
  assert.match(result.warnings.join(' '), /方向.*成交状态未知/);
});

test('桌面历史错误或空历史继续明确失败，不替换为演示或CLI行情', async () => {
  for (const read of [async () => { throw new Error('桌面行情权限不足'); }, async () => []]) {
    await assert.rejects(liveMarket('NVDA.US', 'day', start, end, { history: read, executions: async () => [] }),
      /桌面行情权限不足|未返回 K 线/);
  }
});

test('证券、日期及周期在调用任何读取器前校验', async () => {
  let reads = 0;
  const readers = { history: async () => { reads += 1; return [rawCandle]; },
    executions: async () => { reads += 1; return []; } };
  await assert.rejects(liveMarket('NVDA.US; invalid', 'day', start, end, readers), /证券代码/);
  await assert.rejects(liveMarket('NVDA.US', 'day', '2025-02-30', end, readers), /日期/);
  await assert.rejects(liveMarket('NVDA.US', 'invalid' as Period, start, end, readers), /周期/);
  assert.equal(reads, 0);
});

test('持仓和自选CLI均ENOENT时工作区仍支持手工行情且保留真实来源', async () => {
  const calls: string[][] = [];
  const workspace = await liveWorkspace(async (args) => { calls.push(args); throw missingCli(); });
  assert.deepEqual(calls, [['positions'], ['watchlist']]);
  assert.equal(workspace.source, 'longbridge');
  assert.deepEqual(workspace.securities, []);
  assert.deepEqual(workspace.positions, []);
  assert.equal(workspace.positionsComplete, false);
  assert.match(workspace.warnings.join(' '), /持仓读取失败.*自选读取失败.*手工搜索/);
  assert.match(workspace.warnings.join(' '), /未安装 Longbridge CLI/);
  const market = await liveMarket('QQQ.US', 'day', start, end, {
    history, executions: async () => { throw missingCli(); },
  });
  assert.equal(market.source, 'longbridge');
  assert.equal(market.candles.length, 1);
});

test('持仓成功自选失败保留账户与完整性，自选成功持仓失败不能认定空持仓', async () => {
  const positionsOnly = await liveWorkspace(async (args) => {
    if (args[0] === 'positions') return { channels: [{ positions: [position] }] };
    throw new Error('自选服务暂不可用');
  });
  assert.equal(positionsOnly.positionsComplete, true);
  assert.equal(positionsOnly.positions[0].quantity, 10);
  assert.equal(positionsOnly.securities[0].symbol, 'NVDA.US');
  assert.match(positionsOnly.warnings.join(' '), /自选读取失败/);
  const watchOnly = await liveWorkspace(async (args) => {
    if (args[0] === 'watchlist') return watchlist;
    throw new Error('持仓权限不足');
  });
  assert.equal(watchOnly.positionsComplete, false);
  assert.deepEqual(watchOnly.positions, []);
  assert.equal(watchOnly.securities[0].symbol, '700.HK');
  assert.match(watchOnly.warnings.join(' '), /持仓读取失败.*不代表没有持仓/);
});

test('账户两路成功维持原账户数据，明确空持仓仍完整', async () => {
  const result = await liveWorkspace(async (args) => args[0] === 'positions' ? { stock_list: [position] } : watchlist);
  assert.equal(result.positionsComplete, true);
  assert.equal(result.positions[0].available, 8);
  assert.equal(result.positions[0].costPrice, 120);
  assert.deepEqual(result.securities.map((security) => security.symbol), ['NVDA.US', '700.HK']);
  assert.deepEqual(result.warnings, []);
  const empty = await liveWorkspace(async () => []);
  assert.equal(empty.positionsComplete, true);
  assert.deepEqual(empty.positions, []);
  assert.deepEqual(empty.warnings, []);
});

test('账户响应解析失败降级并保留有效数据，不把部分持仓标为完整', async () => {
  const partial = await liveWorkspace(async (args) => args[0] === 'positions'
    ? { stock_list: [position, { ...position, symbol: 'QQQ.US', cost_price: '' }] } : watchlist);
  assert.equal(partial.positionsComplete, false);
  assert.equal(partial.positions.length, 1);
  assert.equal(partial.positions[0].symbol, 'NVDA.US');
  assert.ok(partial.securities.some((security) => security.symbol === '700.HK'));
  assert.match(partial.warnings.join(' '), /持仓读取失败.*cost_price/);
  const malformed = await liveWorkspace(async (args) => args[0] === 'positions' ? { stock_list: [position] } : { invalid: true });
  assert.equal(malformed.positionsComplete, true);
  assert.equal(malformed.positions.length, 1);
  assert.match(malformed.warnings.join(' '), /自选读取失败.*数据结构/);
});

test('读取器同步抛错也降级为可用工作区和未知成交', async () => {
  const workspace = await liveWorkspace(() => { throw missingCli(); });
  assert.equal(workspace.positionsComplete, false);
  assert.equal(workspace.source, 'longbridge');
  const market = await liveMarket('NVDA.US', 'day', start, end, {
    history, executions: () => { throw missingCli(); },
  });
  assert.equal(market.candles.length, 1);
  assert.equal(market.executionsComplete, false);
});
