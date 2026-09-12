// Run: node tests/portfolio_backtesting.mjs (uses installed frontend tooling).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { build } = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const compiled = await build({ entryPoints: [fileURLToPath(new URL('../frontend/src/components/backtesting/PortfolioBacktesting.tsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react'] });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { default: Builder, buildPortfolioRequest } = module.exports;

const datasets = [{ symbol: 'NQ.F', timeframe: '1m', kind: 'ohlcv' }, { symbol: 'ES.F', timeframe: '5m' },
  { symbol: 'ALTERNATIVE', timeframe: '1d', kind: 'series' }];
const sources = { 'alpha.py': '# run userdata:MNQ 1m\ntrades = []', 'folder/beta.py': 'trades = []' };
const leg = (patch = {}) => ({ id: 'a', strategy: 'alpha.py', symbol: 'NQ.F', allocation: '40', params: '{}', commission: '0.02', currency: '', ...patch });
const draft = { name: '  Diversified portfolio  ', capital: '100000', currency: 'usd', from: '2016-01-01', to: '2026-09-12',
  components: [leg(), leg({ id: 'b', symbol: 'ES.F', allocation: '30', params: '{"quantity":2,"period":20}', currency: 'USD' })] };
const original = JSON.stringify({ draft, sources, datasets });
const body = buildPortfolioRequest(draft, datasets, sources);
assert.equal(body.name, 'Diversified portfolio'); assert.equal(body.capital, 100000); assert.equal(body.currency, 'USD');
assert.equal(body.from, '2016-01-01'); assert.equal(body.to, '2026-09-12');
assert.equal(body.components.length, 2); assert.equal(body.components[0].allocation_pct + body.components[1].allocation_pct, 70); // 30% remains cash.
assert.deepEqual(body.components.map(component => component.symbol), ['NQ.F', 'ES.F']); // Explicit instruments override # run comment.
assert.deepEqual(body.components.map(component => component.timeframe), ['1m', '5m']); // Native dataset timeframes.
assert.deepEqual(body.components.map(component => component.currency), ['USD', 'USD']);
assert.equal(body.components[0].commission_pct, .02);
assert.equal(body.components[0].commission_per_unit, 0, 'Legacy drafts remain percentage fees');
assert.equal(body.components[0].script, sources['alpha.py']); assert.equal(body.components[1].script, sources['alpha.py']); // Same file snapshot can serve multiple legs.
assert.equal(body.components[0].strategy, 'alpha.py'); assert.deepEqual(body.components[1].params, { quantity: 2, period: 20 });
assert.equal(JSON.stringify({ draft, sources, datasets }), original);
assert.deepEqual(Object.keys(body).sort(), ['capital', 'components', 'currency', 'from', 'name', 'to']);
assert.deepEqual(Object.keys(body.components[0]).sort(), ['allocation_pct', 'commission_pct', 'commission_per_unit', 'currency', 'id', 'label', 'params', 'script', 'strategy', 'symbol', 'timeframe']);
const cashFees = buildPortfolioRequest({ ...draft, components: [leg({ commissionMode: 'per_unit', commission: '2.50' }),
  leg({ id: 'b', symbol: 'ES.F', commissionMode: 'percent', commission: '0.01' })] }, datasets, sources);
assert.deepEqual(cashFees.components.map(({ commission_pct, commission_per_unit }) => ({ commission_pct, commission_per_unit })),
  [{ commission_pct: 0, commission_per_unit: 2.5 }, { commission_pct: .01, commission_per_unit: 0 }]);
const full = buildPortfolioRequest({ ...draft, from: '', to: '', components: [leg({ allocation: '100' })] }, datasets, sources);
assert.ok(!('from' in full) && !('to' in full)); // Full history remains uncapped; no invented dates.
const sameInstrument = buildPortfolioRequest({ ...draft, components: [leg(), leg({ id: 'b', strategy: 'folder/beta.py' })] }, datasets, sources);
assert.deepEqual(sameInstrument.components.map(component => component.symbol), ['NQ.F', 'NQ.F']);

for (const patch of [
  { name: '' }, { capital: '0' }, { capital: '-1' }, { capital: 'Infinity' }, { capital: 'invalid' },
  { currency: 'US' }, { from: '2026-02-30' }, { to: 'bad' }, { from: '2026-10-01' },
  { components: [] }, { components: Array.from({ length: 13 }, (_, i) => leg({ id: String(i), allocation: '1' })) },
  { components: [leg(), leg()] }, { components: [leg({ allocation: '60' }), leg({ id: 'b', allocation: '50' })] },
]) assert.throws(() => buildPortfolioRequest({ ...draft, ...patch }, datasets, sources));
for (const patch of [
  { strategy: '' }, { strategy: 'alpha.js' }, { strategy: 'missing.py' }, { symbol: '' }, { symbol: 'unknown' },
  { symbol: 'ALTERNATIVE' }, { allocation: '0' }, { allocation: '-2' }, { allocation: '101' }, { allocation: 'NaN' },
  { commission: '' }, { commission: '-1' }, { commission: 'NaN' }, { commission: 'Infinity' },
  { commissionMode: 'unknown' }, { commissionMode: 'per_unit', commission: '-1' }, { currency: 'EUR' },
  { params: '' }, { params: '[]' }, { params: 'null' }, { params: '3' }, { id: '' },
]) assert.throws(() => buildPortfolioRequest({ ...draft, components: [leg(patch)] }, datasets, sources), /Component 1:/);
assert.throws(() => buildPortfolioRequest(draft, datasets, { ...sources, 'alpha.py': '  ' }), /saved strategy source/);
assert.throws(() => buildPortfolioRequest(draft, [{ symbol: 'NQ.F', timeframe: '?' }], sources), /known native timeframe/);
assert.equal(buildPortfolioRequest({ ...draft, components: [leg({ params: '{"signal":"breakout","enabled":true}' })] }, datasets, sources).components[0].params.enabled, true);

const html = renderToStaticMarkup(React.createElement(Builder, { onResult() {} }));
assert.ok(html.includes('Portfolio backtest')); assert.ok(html.includes('Run portfolio backtest'));
assert.equal((html.match(/aria-label="Portfolio component /g) || []).length, 2);
assert.equal((html.match(/value="50"/g) || []).length, 2);
for (const label of ['Saved strategy', 'Dataset / native timeframe', 'Allocation (%)', 'Commission basis', 'Per contract / unit', 'Percentage of notional', 'P&amp;L currency',
  'Strategy parameters (JSON)', 'Add component', 'Equal allocations', 'Unallocated cash:', 'Refresh strategies and datasets']) assert.ok(html.includes(label), label);
assert.ok(html.includes('one shared source snapshot')); assert.ok(html.includes('not an exposure or leverage cap'));
assert.ok(html.includes('does not perform FX conversion')); assert.ok(html.includes('Gaps use the last known equity mark'));
assert.ok(html.includes('Loading saved strategies and datasets'));
assert.equal((html.match(/value="per_unit" selected=""/g) || []).length, 2, 'New portfolios default to per-unit fees');
assert.ok(html.includes('USD per side') || html.includes('USD<!-- --> per side'), 'Cash fee inputs identify the account currency');
assert.ok(html.includes('round trip costs 5.00 USD'));
console.log('PASS portfolio builder: exact allocation/request contract, source snapshots, repeated strategies/instruments, native timeframes, full history, currency/date/input validation, and accessible initial controls.');
