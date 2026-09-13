// Run: node tests/strategy_report_performance.mjs
// Compares the optimized analytics helper with the previous implementation,
// then reports the elapsed time on realistic large intraday histories.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { transform } = require('../frontend/node_modules/esbuild');
const echarts = require('../frontend/node_modules/echarts');
const sourcePath = 'frontend/src/components/backtesting/strategyResults.ts';
const baselineRef = process.argv.find(arg => arg.startsWith('--baseline='))?.slice('--baseline='.length)
  || '1e5992d3cb9f8e960fea12d4fc44a84e7fb5da15';

async function loadAnalytics(source) {
  const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(require, module, module.exports);
  return module.exports;
}

function makeResult(barCount) {
  const equity = Array.from({ length: barCount }, (_, index) => [
    1700000000 + index * 60,
    100000 + (index % 100) * 0.01,
  ]);
  const trades = Array.from({ length: Math.floor(barCount / 10) }, (_, index) => ({
    entry_ts: 1700000000 + index * 600,
    exit_ts: 1700000300 + index * 600,
    direction: index % 3 === 0 ? 'short' : index % 3 === 1 ? 'long' : 'other',
    entry_price: 100,
    exit_price: 101,
    qty: 1,
    pnl: index % 17 === 0 ? Number.NaN : (index % 7) - 3,
    pnl_pct: 1,
    bars_held: 5,
  }));
  return {
    engine: 'python', symbol: 'TEST', timeframe: '1m', initial_capital: 100000,
    final_equity: equity[equity.length - 1][1], net_profit: 100, stats: {},
    equity_curve: equity, trades,
  };
}

const currentSource = readFileSync(sourcePath, 'utf8');
const baselineSource = execFileSync('git', ['show', `${baselineRef}:${sourcePath}`], { encoding: 'utf8' });
const [current, baseline] = await Promise.all([
  loadAnalytics(currentSource), loadAnalytics(baselineSource),
]);
const currentAnalytics = current.strategyAnalytics;
const baselineAnalytics = baseline.strategyAnalytics;

// The optimization must preserve all report values, including invalid P&L
// filtering and the historical behavior for unrecognized trade directions.
const small = makeResult(10_000);
assert.deepStrictEqual(currentAnalytics(small), baselineAnalytics(small));
for (const result of [
  { ...small, trades: [], equity_curve: [], benchmark_curve: [] },
  { ...small, equity_curve: [[-1, 100000], [0, NaN], [1, 99000], [86400, 0], [172800, -1]] },
  { ...small, daily_equity_curve: [[1700000000, 101000], [1700086400, 102000]],
    benchmark_curve: [[1700000000, 100000], [1700086400, 100200]] },
  { ...small, trades: ['__proto__', 'constructor', 'long', 'short'].map(direction => ({ ...small.trades[1], direction })) },
]) assert.deepStrictEqual(currentAnalytics(result), baselineAnalytics(result));

for (const barCount of [500_000, 1_000_000]) {
  const result = makeResult(barCount);
  // Warm up both functions before timing to avoid measuring JIT compilation.
  currentAnalytics(makeResult(1_000));
  baselineAnalytics(makeResult(1_000));
  const currentStart = performance.now();
  currentAnalytics(result);
  const currentMs = performance.now() - currentStart;
  const baselineStart = performance.now();
  baselineAnalytics(result);
  const baselineMs = performance.now() - baselineStart;
  console.log(`${barCount.toLocaleString()} bars: optimized ${currentMs.toFixed(1)}ms; baseline ${baselineMs.toFixed(1)}ms; speedup ${(baselineMs / currentMs).toFixed(1)}x`);
}

// This measures real ECharts SVG layout, independent of browser/network time.
// Raw JSON/analytics stay complete; only chart inputs change to display samples.
const curve = makeResult(1_000_000).equity_curve;
function renderChart(sampled) {
  const started = performance.now();
  const data = sampled ? current.sampleCurve(curve) : curve.map(([ts, value]) => [ts * 1000, value]);
  const chart = echarts.init(null, undefined, { renderer: 'svg', ssr: true, width: 1120, height: 335 });
  try {
    chart.setOption({ animation: false, xAxis: { type: 'time' }, yAxis: { type: 'value', scale: true },
      series: [{ type: 'line', data, showSymbol: false, ...(sampled ? {} : { sampling: 'lttb' }) }] });
    assert.ok(chart.renderToSVGString().includes('<path'), 'Benchmark chart must render');
    return { ms: performance.now() - started, points: data.length };
  } finally { chart.dispose(); }
}
const renderedCurrent = renderChart(true), renderedBaseline = renderChart(false);
console.log(`1,000,000-bar ECharts SVG layout: optimized ${renderedCurrent.ms.toFixed(1)}ms (${renderedCurrent.points} points); baseline ${renderedBaseline.ms.toFixed(1)}ms (${renderedBaseline.points} points); speedup ${(renderedBaseline.ms / renderedCurrent.ms).toFixed(1)}x`);

console.log('PASS strategy analytics performance and output equivalence');
