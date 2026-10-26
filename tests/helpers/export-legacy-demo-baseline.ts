import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { demoCandles, demoMarket } from '../../server/demo';
import { calculateIndicators } from '../../shared/indicators';
import { generateSignals } from '../../shared/signals';
import { executionIdentities, LEGACY_DEMO_CASES, LEGACY_EXECUTION_RANGE, signalIdentities,
  type LegacyDemoBaseline } from './legacy-demo-baseline';

/**
 * 导出前验证六个旧 SHA256，任一不符都禁止写入 fixture；--compare 仅量化当前运行时差异。
 * 源码存在 .js/无扩展名混用导入，先用 Bun 仅打包，再用 Node 26/V8 执行全部数学计算。
 * 复现：bun build ./tests/helpers/export-legacy-demo-baseline.ts --target=node --outfile=<临时路径>.mjs
 * 然后：node <临时路径>.mjs <项目绝对路径>/tests/fixtures/legacy-demo
 * 比较：bun tests/helpers/export-legacy-demo-baseline.ts <相同fixture目录> --compare
 * @returns 成功无返回值；路径、运行时、哈希或离散行为不符合时抛出明确错误。
 */
function main(): void {
  const directory = process.argv[2];
  assert.ok(directory, '必须提供 fixture 目录绝对路径');
  const fixtureDirectory = pathToFileURL(`${directory.replaceAll('\\', '/').replace(/\/$/, '')}/`);
  if (process.argv[3] === '--compare') {
    compareRuntime(fixtureDirectory);
    return;
  }
  assert.equal(process.versions.node.split('.')[0], '26', '必须使用 Node 26 导出旧基准');
  assert.ok(!('bun' in process.versions), '必须由 Node/V8 执行导出，Bun 只能用于临时打包');
  const baselines: LegacyDemoBaseline[] = LEGACY_DEMO_CASES.map(({ symbol, period, sha256 }) => {
    const candles = demoCandles(symbol, period);
    assert.equal(createHash('sha256').update(JSON.stringify(candles)).digest('hex'), sha256,
      `${symbol}/${period} 未通过原始 SHA256 验证，禁止更新旧基准`);
    const signals = signalIdentities(generateSignals(candles, calculateIndicators(candles)));
    const executions = executionIdentities(demoMarket(symbol, period,
      LEGACY_EXECUTION_RANGE.start, LEGACY_EXECUTION_RANGE.end).executions);
    assert.ok(signals.length > 0 && executions.length > 0, `${symbol}/${period} 必须覆盖非空信号和成交`);
    return { provenance: { runtime: `Node ${process.version}`, engine: `V8 ${process.versions.v8}`,
      note: '未经修改的 server/demo.ts；Bun 仅打包，Node 26 执行。六组原测试 SHA256 全部验证后导出；每行一根原始 Candle，保留 JSON 属性顺序以便复核哈希。' },
    symbol, period, sha256, candles, signals, executions };
  });
  mkdirSync(fixtureDirectory, { recursive: true });
  for (const baseline of baselines) {
    const { candles, signals, executions, ...metadata } = baseline;
    // 每根一行便于定位差异，六个独立 JSON 避免超长代码文件；不舍入任何价格。
    const header = JSON.stringify(metadata).slice(0, -1);
    const content = `${header},\n"candles":[\n${candles.map((candle) => JSON.stringify(candle)).join(',\n')}\n],\n`
      + `"signals":${JSON.stringify(signals)},\n"executions":${JSON.stringify(executions)}\n}\n`;
    writeFileSync(new URL(`${baseline.symbol}-${baseline.period}.json`, fixtureDirectory), content);
    console.info(`${baseline.symbol}/${baseline.period}: SHA256 已验证 ${baseline.sha256}; `
      + `${candles.length} 根，${signals.length} 信号，${executions.length} 成交`);
  }
}

/**
 * 逐字段量化当前运行时与已验证 Node 基准的误差，并断言离散行情、信号、成交完全一致。
 * @param directory 已导出 fixture 目录的 file URL。
 * @returns 输出每组 OHLC 最大绝对、相对及相对 Number.EPSILON 误差，失败抛出断言错误。
 */
function compareRuntime(directory: URL): void {
  console.info(`当前运行时 Node=${process.version}, Bun=${'bun' in process.versions ? process.versions.bun : '无'}`);
  for (const { symbol, period, sha256 } of LEGACY_DEMO_CASES) {
    const baseline = JSON.parse(readFileSync(new URL(`${symbol}-${period}.json`, directory), 'utf8')) as LegacyDemoBaseline;
    assert.equal(createHash('sha256').update(JSON.stringify(baseline.candles)).digest('hex'), sha256);
    const actual = demoCandles(symbol, period);
    assert.equal(actual.length, baseline.candles.length);
    let changed = 0;
    let maxAbsolute = 0;
    let maxRelative = 0;
    let worst = '';
    for (const [index, candle] of actual.entries()) {
      const expected = baseline.candles[index];
      for (const field of ['time', 'volume', 'confirmed'] as const) {
        assert.equal(candle[field], expected[field], `${symbol}/${period}[${index}].${field}`);
      }
      for (const field of ['open', 'high', 'low', 'close'] as const) {
        const absolute = Math.abs(candle[field] - expected[field]);
        const relative = absolute / Math.abs(expected[field]);
        if (absolute !== 0) changed += 1;
        if (absolute > maxAbsolute) { maxAbsolute = absolute; worst = `[${index}].${field}`; }
        maxRelative = Math.max(maxRelative, relative);
      }
    }
    assert.deepEqual(signalIdentities(generateSignals(actual, calculateIndicators(actual))), baseline.signals);
    assert.deepEqual(executionIdentities(demoMarket(symbol, period,
      LEGACY_EXECUTION_RANGE.start, LEGACY_EXECUTION_RANGE.end).executions), baseline.executions);
    console.info(JSON.stringify({ symbol, period, candles: actual.length, changed, maxAbsolute, maxRelative,
      epsilonMultiple: maxRelative / Number.EPSILON, worst, signals: baseline.signals.length,
      executions: baseline.executions.length }));
  }
}

main();
