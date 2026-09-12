// Run: node tests/strategy_robustness.mjs (uses the frontend's existing esbuild).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { transform } = require('esbuild');
const source = readFileSync(new URL('../frontend/src/components/backtesting/strategyRobustness.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { robustnessSummary, bootstrapDailyEquity } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const date = index => new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10);
const observations = (changes, initial = 100) => {
  let equity = initial;
  return changes.map((change, i) => ({ period: date(i), equity: equity += change, returnPct: null }));
};
const trade = (pnl, qty = 1) => ({ entry_ts: 1, exit_ts: 2, pnl, qty });

// Calendar partitions keep the equity before the boundary as their starting capital.
const history = observations(Array(10).fill(10));
const summary = robustnessSummary(history, [trade(20), trade(-5)], 100);
assert.equal(summary.error, null);
assert.equal(summary.periods[0].days, 7); assert.equal(summary.periods[1].days, 3);
assert.equal(summary.periods[1].startingEquity, 170); assert.equal(summary.periods[1].endingEquity, 200);
near(summary.periods[1].returnPct, 30 / 170 * 100);
assert.equal(summary.periods.reduce((sum, period) => sum + period.netProfit, 0), 100);
assert.equal(summary.yearly.reduce((sum, period) => sum + period.netProfit, 0), 100);
const sparse = robustnessSummary([history[0], history[1], history[9]], [], 100);
assert.equal(sparse.periods[0].days, 2); assert.equal(sparse.periods[1].days, 1); // Calendar days, not row-count 70/30.
const years = robustnessSummary([
  { period: '2019-12-31', equity: 110 }, { period: '2020-01-01', equity: 99 },
  { period: '2020-06-01', equity: 121 }, { period: '2021-01-01', equity: 121 },
], [], 100);
assert.deepEqual(years.yearly.map(year => year.startingEquity), [100, 110, 121]);
assert.deepEqual(years.yearly.map(year => year.netProfit), [10, 11, 0]);
near(years.yearly[1].maxDrawdownPct, 10);
assert.equal(years.zeroPnlDays, 1); assert.equal(years.observedDays, 4); // No artificial dates in gaps.
assert.equal(robustnessSummary(observations([-10, 0, 20]), [], 100).periods[0].maxDrawdownPct, 10);
near(robustnessSummary(observations([-100, -10, 20]), [], 100).periods[0].maxDrawdownPct, 110);

// The input P&L is already net of existing fees. Extra costs use actual absolute quantity, twice per trade.
const cost = robustnessSummary(history, [trade(100), trade(-10, -2.5), trade(0, .5),
  { ...trade(999), exit_ts: null }, { ...trade(999), qty: NaN }, { ...trade(999), exit_ts: 0 }, trade(NaN)], 100, 1.25);
assert.equal(cost.closedTrades, 3); assert.equal(cost.excludedTrades, 4);
const unfilled = robustnessSummary(history, [trade(0, 0), trade(10, 1)], 100);
assert.equal(unfilled.closedTrades, 1); assert.equal(unfilled.excludedTrades, 1); // A zero-sized order is not a fill.
assert.equal(cost.realizedNetProfit, 90); assert.equal(cost.costs.chargedUnits, 8);
assert.equal(cost.costs.extraCost, 10); assert.equal(cost.costs.adjustedNetProfit, 80);
assert.equal(cost.costs.breakEvenCostPerUnitPerSide, 11.25);
assert.equal(robustnessSummary(history, [trade(-10)], 100).costs.breakEvenCostPerUnitPerSide, null);
assert.equal(robustnessSummary(history, [], 100).costs.breakEvenCostPerUnitPerSide, null);
for (const badCost of [-1, NaN, Infinity]) {
  const invalid = robustnessSummary(history, [trade(10)], 100, badCost);
  assert.ok(invalid.costs.error); assert.equal(invalid.costs.extraCost, null); assert.equal(invalid.costs.adjustedNetProfit, null);
}
const concentrated = robustnessSummary(history, [trade(1000), ...Array.from({ length: 99 }, () => trade(-5))], 100);
assert.equal(concentrated.realizedNetProfit, 505);
for (const row of concentrated.concentration) {
  assert.equal(row.removedTrades, 1); assert.equal(row.remainingNetProfit, -495); // Never removes losing trades.
}
const distributed = robustnessSummary(history, Array.from({ length: 101 }, () => trade(10)), 100);
assert.deepEqual(distributed.concentration.map(row => row.removedTrades), [2, 6, 11]);
assert.deepEqual(distributed.concentration.map(row => row.remainingNetProfit), [990, 950, 900]);

// All-win/all-loss/flat inputs have known results for EVERY bootstrap, not just a favored seed.
for (const [change, final, dd, loss, breach, zero] of [[2, 160, 0, 0, 0, 0], [-1, 70, 30, 100, 100, 0],
  [-4, -20, 120, 100, 100, 100], [0, 100, 0, 0, 0, 0]]) {
  const simulation = bootstrapDailyEquity(observations(Array(30).fill(change)), 100, { simulations: 20 });
  assert.equal(simulation.error, null);
  assert.deepEqual(simulation.terminal, { p5: final, p50: final, p95: final });
  assert.deepEqual(simulation.maxDrawdownPct, { p50: dd, p95: dd });
  assert.equal(simulation.losingPct, loss); assert.equal(simulation.drawdownBreachPct, breach); assert.equal(simulation.zeroEquityPct, zero);
  assert.deepEqual(simulation.fan[0], { day: 0, period: null, p5: 100, p50: 100, p95: 100 });
  assert.deepEqual(simulation.fan.at(-1), { day: 30, period: date(29), p5: final, p50: final, p95: final });
}
// A block equal to the full history has just one legal origin: it reproduces that exact path.
// This also checks first-day P&L and daily drawdown that occurs BETWEEN plotted fan points.
const zigzagChanges = [50, -30, ...Array(250).fill(0), 10];
const zigzag = observations(zigzagChanges);
const exact = bootstrapDailyEquity(zigzag, 100, { simulations: 2, blockLength: zigzag.length });
assert.equal(exact.error, null); assert.deepEqual(exact.terminal, { p5: 130, p50: 130, p95: 130 });
near(exact.maxDrawdownPct.p50, 20); near(exact.maxDrawdownPct.p95, 20);
assert.equal(exact.drawdownBreachPct, 100);
assert.ok(exact.fan.length <= 101); assert.equal(exact.fan.at(-1).day, zigzag.length);
for (const point of exact.fan.slice(1)) assert.equal(point.p50, zigzag[point.day - 1].equity);

// Reproducibility, percentile ordering, unchanged inputs, and complete simulated horizon.
const mixed = observations(Array.from({ length: 97 }, (_, i) => i % 9 < 3 ? -8 : i % 4));
const before = JSON.stringify(mixed);
const options = { simulations: 301, blockLength: 7, seed: 9, drawdownThresholdPct: 35 };
const sampled = bootstrapDailyEquity(mixed, 100, options);
assert.deepEqual(bootstrapDailyEquity(mixed, 100, options), sampled);
assert.notDeepEqual(bootstrapDailyEquity(mixed, 100, { ...options, seed: 10 }).terminal, sampled.terminal);
assert.equal(JSON.stringify(mixed), before);
assert.equal(sampled.fan.at(-1).day, mixed.length);
assert.deepEqual(sampled.terminal, (({ p5, p50, p95 }) => ({ p5, p50, p95 }))(sampled.fan.at(-1)));
for (const point of sampled.fan) assert.ok(point.p5 <= point.p50 && point.p50 <= point.p95);
assert.ok(sampled.maxDrawdownPct.p50 <= sampled.maxDrawdownPct.p95);
for (const percent of [sampled.losingPct, sampled.drawdownBreachPct, sampled.zeroEquityPct]) assert.ok(percent >= 0 && percent <= 100);
// Block origin cannot circularly wrap: an impulse on the first day appears only in blocks beginning at zero.
// With n=30 and a 29-day block there are two legal origins; at most two impulses can be sampled per path.
const impulse = bootstrapDailyEquity(observations([10, ...Array(29).fill(0)]), 100, { simulations: 1000, blockLength: 29 });
assert.equal(impulse.terminal.p5, 100); assert.equal(impulse.terminal.p50, 110); assert.equal(impulse.terminal.p95, 120);
// Seed 42 gives endpoints 110 and 100 for these first two paths; percentile ranks interpolate.
const pair = bootstrapDailyEquity(observations([10, ...Array(29).fill(0)]), 100, { simulations: 2, blockLength: 29 });
assert.deepEqual(pair.terminal, { p5: 100.5, p50: 105, p95: 109.5 });

// Invalid/small data refuses a simulation instead of silently trimming or filling history.
for (const [days, capital, opts] of [
  [[], 100, {}], [history, 100, {}], [mixed, 0, {}], [mixed, -1, {}], [mixed, NaN, {}],
  [[...mixed, mixed[0]], 100, {}], [[{ period: '2020-02-30', equity: 100 }, ...mixed], 100, {}],
  [[{ ...mixed[0], equity: NaN }, ...mixed.slice(1)], 100, {}],
  [mixed, 100, { simulations: 1001 }], [mixed, 100, { simulations: 0 }], [mixed, 100, { simulations: 1.5 }],
  [mixed, 100, { blockLength: 0 }], [mixed, 100, { blockLength: 98 }], [mixed, 100, { blockLength: NaN }],
  [mixed, 100, { seed: -1 }], [mixed, 100, { seed: Infinity }], [mixed, 100, { seed: 0x100000000 }],
  [mixed, 100, { drawdownThresholdPct: 0 }], [mixed, 100, { drawdownThresholdPct: 101 }],
  [observations(Array(10001).fill(1)), 100, {}],
]) {
  const invalid = bootstrapDailyEquity(days, capital, opts);
  assert.ok(invalid.error, JSON.stringify(opts)); assert.equal(invalid.terminal, null); assert.deepEqual(invalid.fan, []);
}
assert.equal(bootstrapDailyEquity(mixed, 100, { seed: 0 }).error, null);
console.log('PASS robustness analytics: calendar stability, yearly bases, net trade costs and concentration, deterministic daily cash block bootstrap, full-horizon/daily drawdown, and invalid-input guards.');
