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
for (const title of ['Overview', 'Trade analysis', 'Robustness', 'Statistics', 'Strategy plots', 'Strategy signal', 'Monthly returns']) {
  assert.ok(html.includes(title), `Missing full-report section: ${title}`);
}
assert.equal((html.match(/<td>long<\/td>/g) || []).length, 1); // Long/short summary remains; the ledger is CSV-only.
assert.equal((html.match(/<td>short<\/td>/g) || []).length, 1);
assert.ok(html.includes('61 total trades'), 'PDF must include trade totals even though the full ledger is CSV-only');
assert.ok(!html.includes('Complete trade ledger'), 'PDF intentionally omits the CSV-exportable ledger');
assert.ok(html.includes('&lt;test&gt;.py'), 'Strategy names remain escaped');
assert.ok(!html.includes('<button'), 'Printed report must not contain filters, pagination or export controls');
assert.ok(html.includes('A4 landscape'), 'Printable page size is explicit');
assert.ok(html.includes('Cash buy &amp; hold · TEST'), 'Benchmark must name the selected dataset and portfolio interpretation');
assert.ok(html.includes('<tr><td>Starting portfolio</td><td>100.00</td><td>100.00</td></tr>'), 'Both portfolios must display the same starting cash');
assert.ok(html.includes('<tr><td>Ending portfolio</td><td>110.00</td><td>105.00</td></tr>'), 'Comparison must display each final portfolio value');
assert.ok(html.includes('Total return over the full period'));
assert.ok(html.includes('Annualized return (CAGR)'));
assert.ok(html.includes('actual calendar time'));
assert.ok(html.includes('starting capital × (current close ÷ first close)'), 'Report must explain how cash buy-and-hold is valued');
assert.ok(html.includes('fixed number of fractional units'), 'Cash benchmark must disclose its fractional-unit assumption');
assert.ok(html.includes('price-based cash proxy'), 'Futures benchmark must disclose its price-proxy limitation');
assert.ok(html.includes('At least 30 observed daily equity values'), 'Small samples must not produce simulated confidence');
assert.ok(html.includes('not a holdout test'), 'Retrospective splits must not imply untouched validation');
const longResult = { ...result, equity_curve: Array.from({ length: 90 }, (_, i) => [1704067200 + i * 86400, 100 + i]) };
const stressHtml = renderToStaticMarkup(React.createElement(Report, { result: longResult, printable: true,
  initialRobustness: { blockLength: 20, seed: 17, drawdownThresholdPct: 10, extraCost: 2 } }));
assert.ok(stressHtml.includes('20-day blocks') && stressHtml.includes('seed 17'), 'PDF must preserve chosen simulation assumptions');
assert.ok(stressHtml.includes('Paths reaching 10% drawdown'), 'Selected risk threshold must survive PDF export');
assert.ok(stressHtml.includes('244.00'), 'PDF cost stress includes both sides of all 61 unit trades at 2 per side');
assert.ok(stressHtml.includes('Simulated portfolio equity percentiles'));
assert.ok(!stressHtml.includes('<input') && !stressHtml.includes('<select') && !stressHtml.includes('<button'), 'Printed stress report has no controls');
const savedValidationHtml = renderToStaticMarkup(React.createElement(Report, { result: longResult, printable: true,
  analysis: { robustnessSettings: { blockLength: 5, seed: 99, drawdownThresholdPct: 15, extraCost: 3 }, validationRun: {
    request: { params: { period: '5,10' }, folds: 1, train: .7, metric: 'netProfit' }, completedAt: '2026-09-12T12:00:00Z',
    result: { totalOosNetProfit: 123.45, totalOosTrades: 2, combosPerFold: 2, folds: [
      { bestParams: { period: 5 }, trainNetProfit: 150, oosNetProfit: 123.45, oosTrades: 2, candidates: [] },
    ] },
  } } }));
assert.ok(savedValidationHtml.includes('seed 99') && savedValidationHtml.includes('123.45'), 'Saved validation and stress assumptions must render in the complete PDF');
const interactive = renderToStaticMarkup(React.createElement(Report, { result }));
const portfolio = { ...result, engine: 'portfolio', timeframe: 'mixed', portfolio: {
  name: 'Multi strategy', currency: 'USD', allocation_model: 'fixed', unallocated_capital: 50,
  methodology: ['No shared margin or rebalancing.'], components: [{ id: 'leg-1', label: 'ATR NQ', strategy: 'atr.py', symbol: 'NQ', timeframe: '1m',
    allocation_pct: 50, initial_capital: 50, final_equity: 60, net_profit: 10, total_trades: 1, max_drawdown_pct: 2,
    start_ts: 1704067200, end_ts: 1704153600, daily_equity_curve: [[1704067200, 50], [1704153600, 60]] }],
} };
const portfolioHtml = renderToStaticMarkup(React.createElement(Report, { result: portfolio, printable: true }));
for (const text of ['Portfolio backtest results', 'Allocated buy &amp; hold basket', 'Strategy and instrument contributions',
  'ATR NQ', 'atr.py', 'Unallocated cash', 'Validate each component', 'Hours elapsed', 'No shared margin or rebalancing.']) {
  assert.ok(portfolioHtml.includes(text), `Portfolio report missing ${text}`);
}
assert.ok(!portfolioHtml.includes('first observed TEST close'), 'Portfolio must explain the allocation basket rather than a fictitious single symbol');
assert.ok(interactive.includes('Export PDF'));
assert.ok(!interactive.includes('Complete trade ledger'), 'Interactive view keeps the existing sections');
assert.ok(html.includes('This result did not record a commission breakdown'), 'Legacy reports must not present unknown fees as zero');
const charged = { ...result, gross_profit: 15, total_commission: 5, commission_per_unit: 2.5, commission_pct: 0 };
const chargedHtml = renderToStaticMarkup(React.createElement(Report, { result: charged, printable: true }));
assert.ok(chargedHtml.includes('Gross P&amp;L before commission</dt><dd>15.00</dd>'));
assert.ok(chargedHtml.includes('Total commission</dt><dd>5.00</dd>'));
assert.ok(chargedHtml.includes('Net P&amp;L after commission</dt><dd>10.00</dd>'));
assert.ok(chargedHtml.includes('2.50 account currency per contract / unit per side'));
assert.ok(chargedHtml.includes('Winning trades P&amp;L (net)'), 'Winning-trade sum must not be mislabeled as pre-commission P&L');
assert.ok(!chargedHtml.includes('This result did not record a commission breakdown'));
const chargedPortfolio = { ...portfolio, gross_profit: 15, total_commission: 5, portfolio: { ...portfolio.portfolio,
  components: portfolio.portfolio.components.map(c => ({ ...c, gross_profit: 15, total_commission: 5, commission_per_unit: 2.5, commission_pct: .01 })) } };
const chargedPortfolioHtml = renderToStaticMarkup(React.createElement(Report, { result: chargedPortfolio, printable: true }));
assert.ok(chargedPortfolioHtml.includes('2.50 USD per contract / unit per side + 0.01% of traded notional per side'));
assert.ok(chargedPortfolioHtml.includes('<td>15.00</td><td>5.00</td>'), 'Portfolio component commission must be visible separately');
console.log('PASS complete report print: summary sections, trade totals, escaped names, no interactive controls or ledger.');
