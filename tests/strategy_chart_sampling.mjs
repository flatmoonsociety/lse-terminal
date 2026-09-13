// Run: node tests/strategy_chart_sampling.mjs
// Exercise the production Chart effect and zoom handler without a browser.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { build } = require('esbuild');
const React = require('react');
const path = fileURLToPath(new URL('../frontend/src/components/backtesting/StrategyBacktestResults.tsx', import.meta.url));
const compiled = await build({
  stdin: { contents: readFileSync(path, 'utf8') + '\nexport { Chart, line };', loader: 'tsx', resolveDir: dirname(path) },
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
  external: ['react', 'react-dom/client', 'echarts'],
});
let printable = false, cleanup, disposed = false;
const options = [], events = new Map();
const host = { closest: () => printable, ownerDocument: { documentElement: {} } };
const chart = { setOption: option => options.push(option), on: (name, listener) => events.set(name, listener),
  resize() {}, dispose() { disposed = true; } };
const mocks = name => name === 'react' ? { ...React, useRef: () => ({ current: host }), useEffect: effect => { cleanup = effect(); } }
  : name === 'echarts' ? { init: () => chart } : require(name);
class Observer { observe() {} disconnect() {} }
const module = { exports: {} };
new Function('require', 'module', 'exports', 'ResizeObserver', 'MutationObserver', 'getComputedStyle', compiled.outputFiles[0].text)(
  mocks, module, module.exports, Observer, Observer, () => ({ getPropertyValue: () => '' }));
const { Chart, line } = module.exports;
const curve = Array.from({ length: 100_000 }, (_, i) => [1700000000 + i * 60, 100000 + Math.sin(i / 10) * 100]);
const result = Chart({ title: 'Equity', option: { dataZoom: [{ type: 'inside' }], series: [line('Equity', curve)] } });
assert.equal(result.props.role, 'img');
assert.equal(result.props['aria-label'], 'Equity');
assert.ok(options[0].series[0].data.length <= 2000, 'ECharts must receive display points, not the complete history');
assert.equal(options[0].xAxis.min, curve[0][0] * 1000);
assert.equal(options[0].xAxis.max, curve.at(-1)[0] * 1000, 'Zoom percentages use the exact source domain');
events.get('datazoom')({ batch: [{ start: 40, end: 40.05 }] });
const zoomed = options.at(-1).series[0].data;
for (let i = 40000; i <= 40048; i++) {
  assert.ok(zoomed.some(([ts, value]) => ts === curve[i][0] * 1000 && value === curve[i][1]), `Zoom must restore observation ${i}`);
}
assert.equal(zoomed[0][0], curve[0][0] * 1000, 'Zoom retains the full slider domain');
assert.equal(zoomed.at(-1)[0], curve.at(-1)[0] * 1000);
assert.ok(zoomed.length <= 4000, 'Zoomed rendering stays bounded');
assert.equal(curve.length, 100_000, 'Full data remains available to exports');
cleanup();
assert.ok(disposed, 'Closing the report releases its chart');
printable = true;
options.length = 0; events.clear();
Chart({ title: 'Printable equity', option: { series: [line('Equity', curve)] } });
assert.ok(options[0].series[0].data.length <= 2000, 'PDF curves must also stay bounded');
assert.deepEqual(options[0].dataZoom, []);
assert.equal(events.size, 0);
cleanup();
console.log('PASS report chart: bounded overview/PDF, raw-detail zoom, retained range, accessible image and disposal');
