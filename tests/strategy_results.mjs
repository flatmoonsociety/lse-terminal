// Run: node tests/strategy_results.mjs (uses the frontend's existing esbuild).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { transform } = require('esbuild');
const source = readFileSync(new URL('../frontend/src/components/backtesting/strategyResults.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { strategyAnalytics, resultNumber, utcTime, tradeCsv } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const ts = date => Date.parse(`${date}T00:00:00Z`) / 1000;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const trade = (pnl, direction = 'long') => ({ entry_ts: 0, exit_ts: 3600, direction, entry_price: 100, exit_price: 110,
  qty: 1, pnl, pnl_pct: pnl, bars_held: 1 });
const result = { engine: 'python', symbol: 'TEST', timeframe: '1d', initial_capital: 100,
  final_equity: 110, net_profit: 10, stats: {}, plots: {},
  equity_curve: [[ts('2026-01-30'), 90], [ts('2026-01-31'), 120], [ts('2026-02-01'), 96], [ts('2026-02-02'), 110]],
  trades: [trade(30), trade(-20, 'short'), trade(0)] };
const a = strategyAnalytics(result);
assert.equal(a.maxDrawdown, 24);
close(a.maxDrawdownPct, 20);
close(a.drawdown[0][1], -10); // Entry loss is measured from initial capital.
close(a.months[0].returnPct, 20);
close(a.months[1].returnPct, (110 / 120 - 1) * 100);
assert.equal(a.months[1].period, '2026-02');
assert.equal(a.wins, 1); assert.equal(a.losses, 1); assert.equal(a.breakeven, 1);
close(a.payoff, 1.5);
assert.equal(a.histogram.reduce((sum, bin) => sum + bin.count, 0), 3);
assert.equal(a.direction[0].net, 30); assert.equal(a.direction[1].net, -20);
assert.equal(a.longestUnderwater, 86400);

const empty = strategyAnalytics({ ...result, equity_curve: [], trades: [] });
assert.deepEqual(empty.histogram, []); assert.equal(empty.payoff, null); assert.equal(empty.maxDrawdown, 0);
const flat = strategyAnalytics({ ...result, trades: [trade(0), trade(0)] });
assert.equal(flat.histogram.length, 1); assert.equal(flat.histogram[0].count, 2);
const ruined = strategyAnalytics({ ...result, equity_curve: [[ts('2026-01-31'), 0], [ts('2026-02-01'), -10]] });
assert.equal(ruined.months[0].returnPct, -100); assert.equal(ruined.months[1].returnPct, null);
const daily = strategyAnalytics({ ...result, equity_curve: [[ts('2026-01-01'), 90], [ts('2026-01-01') + 3600, 95], [ts('2026-01-03'), 100]] });
assert.equal(daily.days.length, 2); close(daily.days[0].returnPct, -5); // Last daily close, no invented missing day.
assert.equal(resultNumber('__+Inf__'), '∞'); assert.equal(resultNumber(null), '—'); assert.equal(resultNumber(NaN), '—');
assert.equal(utcTime(0), '1970-01-01 00:00:00'); assert.equal(utcTime(null), '—');
const csv = tradeCsv([trade(-20, '=HYPERLINK("bad")')]);
assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"')); assert.ok(csv.includes('"-20"'));
assert.ok(tradeCsv([{ ...trade(1), id: 42 }]).split('\r\n')[1].startsWith('"42",')); // Keep ledger IDs in filtered exports.
console.log('PASS strategy report analytics: drawdown, period returns, outcomes, histogram, empty/ruined equity, formatting and CSV.');
