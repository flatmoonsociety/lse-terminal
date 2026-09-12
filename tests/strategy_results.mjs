// Run: node tests/strategy_results.mjs (uses the frontend's existing esbuild).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { transform } = require('esbuild');
const source = readFileSync(new URL('../frontend/src/components/backtesting/strategyResults.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { calendarCagr, curveValueAt, strategyAnalytics, resultNumber, utcTime, tradeCsv } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const ts = date => Date.parse(`${date}T00:00:00Z`) / 1000;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const trade = (pnl, direction = 'long') => ({ entry_ts: 0, exit_ts: 3600, direction, entry_price: 100, exit_price: 110,
  qty: 1, pnl, pnl_pct: pnl, bars_held: 1 });
const result = { engine: 'python', symbol: 'TEST', timeframe: '1d', initial_capital: 100,
  final_equity: 110, net_profit: 10, stats: {}, plots: {},
  equity_curve: [[ts('2026-01-30'), 90], [ts('2026-01-31'), 120], [ts('2026-02-01'), 96], [ts('2026-02-02'), 110]],
  trades: [trade(30), trade(-20, 'short'), trade(0)] };
const a = strategyAnalytics(result);
const portfolioCsv = tradeCsv([{ ...trade(20), component_id: 'leg-1', component_label: '=formula', strategy: 'atr.py', symbol: 'NQ', timeframe: '1m' }]);
assert.ok(portfolioCsv.includes('"Component","Strategy","Symbol","Timeframe"'));
assert.ok(portfolioCsv.includes('"\'=formula","atr.py","NQ","1m"'), 'Portfolio attribution survives CSV and formula-like labels stay literal');
const dailyResult = strategyAnalytics({ ...result, equity_curve: [result.equity_curve[0], result.equity_curve[3]], daily_equity_curve: result.equity_curve });
assert.equal(dailyResult.days.length, 4, 'Daily analytics retain daily closes if a portfolio display curve is sampled');
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

// The same real period must have the same CAGR, regardless of missing bars.
const first = 1464559260, last = 1789156740;
const sparse = [[first, 100000], [last, 366215]];
const dense = [[first, 100000], [first + 60, 100000], [last - 60, 366215], [last, 366215]];
// A tooltip hit from either independently sampled line must use both original
// portfolio observations at that instant, without selecting a nearby bar.
const originalStrategy = [[first, 100000], [first + 60, 101000], [first + 120, 99500], [last, 196550]];
const originalHold = [[first, 100000], [first + 60, 100250], [first + 120, 100750], [last, 652112.91]];
for (const [timestamp, strategyValue, holdValue] of [
  [first, 100000, 100000], [first + 60, 101000, 100250], [first + 120, 99500, 100750], [last, 196550, 652112.91],
]) {
  assert.equal(curveValueAt(originalStrategy, timestamp), strategyValue);
  assert.equal(curveValueAt(originalHold, timestamp), holdValue);
}
assert.equal(curveValueAt([], first), null);
for (const missing of [first - 60, first + 30, last + 60]) assert.equal(curveValueAt(originalStrategy, missing), null);
close(calendarCagr(sparse, 100000, 366215), 13.4506088911);
close(calendarCagr(dense, 100000, 366215), calendarCagr(sparse, 100000, 366215));
const compared = strategyAnalytics({ ...result, initial_capital: 100000, final_equity: 366215,
  equity_curve: dense, stats: { extended: { annualizedReturn: 20.97059625 } },
  benchmark_curve: [[first, 100000], [last, 100000 * 29397.25 / 4508]] });
close(compared.cagr, 13.4506088911); // Ignore the incorrect CAGR in an older saved result.
close(compared.benchmarkReturn, 552.1129103815439);
close(compared.benchmarkCagr, 19.9966293184);
assert.equal(a.benchmarkReturn, null); assert.equal(a.benchmarkCagr, null);
for (const [curve, initial, final] of [
  [[], 100, 110], [[[first, 100]], 100, 110], [[[first, 100], [first, 110]], 100, 110],
  [sparse, 0, 110], [sparse, 100, 0], [sparse, 100, -1],
  [[[first, 100], [first + 60, 0], [last, 110]], 100, 110],
  [[[first, 100], [first + 1, 200]], 100, 200],
]) assert.equal(calendarCagr(curve, initial, final), null);

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
const feeCsv = tradeCsv([{ ...trade(195), gross_pnl: 200, entry_commission: 2.5, exit_commission: 2.5, commission: 5 }]);
assert.ok(feeCsv.includes('"Gross P&L","Entry commission","Exit commission","Commission","Net P&L"'));
assert.ok(feeCsv.split('\r\n')[1].includes('"200","2.5","2.5","5","195"'), 'Export keeps gross, both fees and net independently auditable');
assert.ok(tradeCsv([trade(10)]).split('\r\n')[1].includes('"1","","","","","10"'), 'Older trade exports leave missing fee data blank');
console.log('PASS strategy report analytics: drawdown, period returns, same-time portfolio lookup, outcomes, histogram, empty/ruined equity, formatting and CSV.');
