// Run: node tests/strategy_report_print.mjs (no browser or new test dependencies).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { build } = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../frontend/src/components/backtesting/StrategyBacktestResults.tsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
  external: ['react', 'react-dom/client', 'echarts'],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const Report = module.exports.default;
const result = { engine: 'python', symbol: 'TEST', timeframe: '1d', initial_capital: 100,
  final_equity: 110, net_profit: 10, stats: {},
  equity_curve: [[1704067200, 100], [1704153600, 110]],
  benchmark_curve: [[1704067200, 100], [1704153600, 105]],
  plots: { 'Strategy signal': [[1704067200, 1], [1704153600, 2]] },
  trades: Array.from({ length: 61 }, (_, i) => ({ entry_ts: 1704067200, exit_ts: 1704153600,
    direction: i % 2 ? 'short' : 'long', entry_price: 100, exit_price: 110, qty: 1, pnl: i % 2 ? -10 : 10,
    pnl_pct: i % 2 ? -10 : 10, bars_held: 1 })),
};
const html = renderToStaticMarkup(React.createElement(Report, { result, strategy: '<test>.py', printable: true }));
for (const title of ['Overview', 'Trade analysis', 'Statistics', 'Strategy plots', 'Strategy signal', 'Monthly returns']) {
  assert.ok(html.includes(title), `Missing full-report section: ${title}`);
}
assert.equal((html.match(/<td>long<\/td>/g) || []).length, 1); // Long/short summary remains; the ledger is CSV-only.
assert.equal((html.match(/<td>short<\/td>/g) || []).length, 1);
assert.ok(html.includes('61 total trades'), 'PDF must include trade totals even though the full ledger is CSV-only');
assert.ok(!html.includes('Complete trade ledger'), 'PDF intentionally omits the CSV-exportable ledger');
assert.ok(html.includes('&lt;test&gt;.py'), 'Strategy names remain escaped');
assert.ok(!html.includes('<button'), 'Printed report must not contain filters, pagination or export controls');
assert.ok(html.includes('A4 landscape'), 'Printable page size is explicit');
const interactive = renderToStaticMarkup(React.createElement(Report, { result }));
assert.ok(interactive.includes('Export PDF'));
assert.ok(!interactive.includes('Complete trade ledger'), 'Interactive view keeps the existing sections');
console.log('PASS complete report print: summary sections, trade totals, escaped names, no interactive controls or ledger.');
