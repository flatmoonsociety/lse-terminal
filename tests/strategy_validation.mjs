// Run: node tests/strategy_validation.mjs (uses existing frontend tooling).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { build } = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../frontend/src/components/backtesting/StrategyValidation.tsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react'],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { default: Validation, validationRequest } = module.exports;
const request = { engine: 'python', provider: 'local', symbol: 'NQ.F', timeframe: '1m', script: 'trades = []',
  limit: 0, datasets: ['signals.csv'], options: { capital: 100000, commission: .03,
    from: '2020-01-01', to: '2025-12-31', params: { quantity: 1, trend_ratio_threshold: .45 } } };
const before = JSON.stringify(request);
const body = validationRequest(request, '{"trend_ratio_threshold":"0.4,0.45,0.5"}', 4, .7, 'netProfit');
assert.deepEqual(body, { ...request, folds: 4, train: .7, metric: 'netProfit', params: { trend_ratio_threshold: '0.4,0.45,0.5' } });
assert.equal(JSON.stringify(request), before); // Preserve original script, provider, instrument, limit, datasets, and options.
assert.equal(body.options, request.options); assert.equal(body.datasets, request.datasets);
for (const [grid, folds, train, metric] of [
  ['', 4, .7, 'netProfit'], ['{}', 4, .7, 'netProfit'], ['[]', 4, .7, 'netProfit'],
  ['{"period":20}', 4, .7, 'netProfit'], ['{"period":""}', 4, .7, 'netProfit'],
  ['{"period":"20"}', 0, .7, 'netProfit'], ['{"period":"20"}', 11, .7, 'netProfit'],
  ['{"period":"20"}', 1.5, .7, 'netProfit'], ['{"period":"20"}', 4, 0, 'netProfit'],
  ['{"period":"20"}', 4, 1, 'netProfit'], ['{"period":"20"}', 4, NaN, 'netProfit'],
  ['{"period":"20"}', 4, .7, 'unsupported'], ['{"period":"20"}', 4, .7, 'toString'],
]) assert.throws(() => validationRequest(request, grid, folds, train, metric));
assert.throws(() => validationRequest({ ...request, script: '' }, '{"period":"20"}', 4, .7, 'netProfit'));

const render = props => renderToStaticMarkup(React.createElement(Validation,
  { run: null, onRun() {}, printable: false, filename: 'test', ...props }));
const missing = render({});
assert.ok(missing.includes('no original run request')); assert.ok(!missing.includes('<form'));
const interactive = render({ request });
assert.ok(interactive.includes('Run walk-forward validation')); assert.ok(interactive.includes('Validation parameter grid JSON'));
assert.ok(interactive.includes('placeholder=')); assert.ok(interactive.includes('</textarea>'));
assert.ok(!interactive.includes('trend_ratio_threshold&quot;: &quot;'), 'The syntax example must not become a selected parameter grid');

const run = { request: body, completedAt: '2026-09-12T12:00:00Z', result: {
  totalOosNetProfit: 40, totalOosTrades: 2, combosPerFold: 2, folds: [{ fold: 0,
    trainStartTs: 1577836800, trainEndTs: 1609372800, testStartTs: 1609459200, testEndTs: 1640908800,
    bestParams: { period: 20 }, trainNetProfit: 100, oosNetProfit: 40, oosTrades: 2,
    candidates: [{ params: { period: 20 }, metricValue: 100, netProfit: 100, trades: 8 },
      { params: { period: 15 }, metricValue: null, netProfit: null, trades: null, error: '<invalid strategy>' }],
  }] } };
const printed = render({ request, run, printable: true });
assert.ok(printed.includes('2020-01-01 00:00:00 UTC')); assert.ok(printed.includes('2021-01-01 00:00:00 UTC'));
assert.ok(printed.includes('Sum of closed-trade test P&amp;L across independent folds'));
assert.ok(printed.includes('not a compounded portfolio return')); assert.ok(printed.includes('training-only sensitivity'));
assert.ok(printed.includes('20') && printed.includes('15')); assert.ok(printed.includes('&lt;invalid strategy&gt;'));
assert.ok(!printed.includes('<details'), 'Print includes all training candidate rows, without closed disclosures');
assert.ok(!/<(button|input|select|textarea|form)/.test(printed), 'Print has no interaction controls');
assert.ok(printed.includes('they are not an untouched holdout')); assert.ok(printed.includes('may differ from the data'));
assert.ok(printed.includes('Folds reset capital and indicators')); assert.ok(printed.includes('daily block simulation is a separate stress test'));
const saved = render({ run });
assert.ok(saved.includes('Export validation JSON')); assert.ok(saved.includes('<details'));
const oldRun = { ...run, result: { ...run.result, folds: [{ trainStart: 0, trainEnd: 99, testStart: 100, testEnd: 149 }] } };
assert.ok(render({ run: oldRun }).includes('Bars 0–99'));
assert.ok(render({ run: oldRun }).includes('Candidate results were not included'));
console.log('PASS strategy validation: original request preservation, input validation, saved/print results, UTC windows, complete candidate tables, and holdout limitations.');
