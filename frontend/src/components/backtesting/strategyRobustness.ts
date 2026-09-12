import type { ReturnPeriod, StrategyTrade } from './strategyResults';

export type RobustnessPeriod = {
  label: string; start: string; end: string; days: number;
  startingEquity: number; endingEquity: number; netProfit: number;
  returnPct: number | null; maxDrawdownPct: number | null;
};

const DAY = 86400000;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function dailyInputError(days: ReturnPeriod[], initial: number): string | null {
  if (!finite(initial) || initial <= 0) return 'Starting capital must be positive and finite.';
  if (!days.length) return 'Daily equity observations are unavailable.';
  let previous = '';
  for (const day of days) {
    const time = Date.parse(day.period + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.period) || !finite(time) ||
        new Date(time).toISOString().slice(0, 10) !== day.period ||
        day.period <= previous || !finite(day.equity)) {
      return 'Daily equity must have finite values and unique, increasing UTC dates.';
    }
    previous = day.period;
  }
  return null;
}

function periodSummary(label: string, days: ReturnPeriod[], initial: number): RobustnessPeriod {
  let peak = initial, maxDrawdownPct = 0;
  for (const day of days) {
    peak = Math.max(peak, day.equity);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - day.equity) / peak * 100);
  }
  const final = days[days.length - 1].equity;
  return { label, start: days[0].period, end: days[days.length - 1].period, days: days.length,
    startingEquity: initial, endingEquity: final, netProfit: final - initial,
    returnPct: initial > 0 ? (final / initial - 1) * 100 : null,
    maxDrawdownPct: initial > 0 ? maxDrawdownPct : null };
}

// Daily closes include observed flat days, but do not invent data for missing dates.
// These are retrospective partitions of one backtest, never an out-of-sample test.
export function robustnessSummary(days: ReturnPeriod[], trades: StrategyTrade[], initial: number,
  extraCostPerUnitPerSide = 0) {
  const error = dailyInputError(days, initial);
  const periods: RobustnessPeriod[] = [], yearly: RobustnessPeriod[] = [];
  let zeroPnlDays = 0;
  if (!error) {
    let previous = initial;
    for (const day of days) { if (day.equity === previous) zeroPnlDays++; previous = day.equity; }
    // Split elapsed calendar time (including the last date), not the number of trades.
    const first = Date.parse(days[0].period + 'T00:00:00Z');
    const last = Date.parse(days[days.length - 1].period + 'T00:00:00Z');
    const cutoff = first + (last - first + DAY) * .7;
    const late = days.findIndex(day => Date.parse(day.period + 'T00:00:00Z') >= cutoff);
    const split = late < 0 ? days.length : late;
    if (split) periods.push(periodSummary('Earlier 70% of calendar time', days.slice(0, split), initial));
    if (split < days.length) periods.push(periodSummary('Later 30% of calendar time', days.slice(split), days[split - 1].equity));
    let start = 0;
    for (let i = 1; i <= days.length; i++) {
      if (i < days.length && days[i].period.slice(0, 4) === days[start].period.slice(0, 4)) continue;
      yearly.push(periodSummary(days[start].period.slice(0, 4), days.slice(start, i), start ? days[start - 1].equity : initial));
      start = i;
    }
  }
  const closed = trades.filter(trade => finite(trade.entry_ts) && finite(trade.exit_ts) &&
    trade.exit_ts >= trade.entry_ts && finite(trade.pnl) && finite(trade.qty) && trade.qty !== 0);
  // Runner pnl is already net of entry and exit fees. Apply only the EXTRA cash cost.
  const realizedNetProfit = closed.reduce((sum, trade) => sum + trade.pnl, 0);
  const chargedUnits = closed.reduce((sum, trade) => sum + 2 * Math.abs(trade.qty), 0);
  const winners = closed.map(trade => trade.pnl).filter(pnl => pnl > 0).sort((a, b) => b - a);
  const concentration = [1, 5, 10].map(removedPct => {
    const removedTrades = Math.min(winners.length, Math.ceil(closed.length * removedPct / 100));
    const removedProfit = winners.slice(0, removedTrades).reduce((sum, pnl) => sum + pnl, 0);
    return { removedPct, removedTrades, removedProfit, remainingNetProfit: realizedNetProfit - removedProfit };
  });
  const costError = !finite(extraCostPerUnitPerSide) || extraCostPerUnitPerSide < 0
    ? 'Extra cost must be a nonnegative cash amount per unit per side.' : null;
  const extraCost = costError ? null : chargedUnits * extraCostPerUnitPerSide;
  return { error, observedDays: days.length, zeroPnlDays, periods, yearly,
    closedTrades: closed.length, excludedTrades: trades.length - closed.length, realizedNetProfit, concentration,
    costs: { extraCostPerUnitPerSide, chargedUnits, extraCost,
      adjustedNetProfit: extraCost == null ? null : realizedNetProfit - extraCost,
      breakEvenCostPerUnitPerSide: chargedUnits > 0 && realizedNetProfit > 0 ? realizedNetProfit / chargedUnits : null,
      error: costError } };
}

export type BootstrapOptions = { simulations?: number; blockLength?: number; seed?: number; drawdownThresholdPct?: number };
export type BootstrapResult = {
  error: string | null; simulations: number; blockLength: number; seed: number;
  observedDays: number; initialCapital: number; drawdownThresholdPct: number;
  terminal: { p5: number; p50: number; p95: number } | null;
  maxDrawdownPct: { p50: number; p95: number } | null;
  losingPct: number | null; drawdownBreachPct: number | null; zeroEquityPct: number | null;
  fan: { day: number; period: string | null; p5: number; p50: number; p95: number }[];
  warnings: string[];
};

// Linear interpolation between adjacent ranks. Call with ascending values.
function quantile(sorted: number[], probability: number): number {
  const index = (sorted.length - 1) * probability, lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}

export function bootstrapDailyEquity(days: ReturnPeriod[], initial: number, options: BootstrapOptions = {}): BootstrapResult {
  const { simulations = 1000, blockLength = 5, seed = 42, drawdownThresholdPct = 20 } = options;
  const result: BootstrapResult = { error: dailyInputError(days, initial), simulations, blockLength, seed,
    observedDays: days.length, initialCapital: initial, drawdownThresholdPct,
    terminal: null, maxDrawdownPct: null, losingPct: null, drawdownBreachPct: null, zeroEquityPct: null,
    fan: [], warnings: [
      'Resamples observed daily cash P&L in contiguous blocks; retains historical monetary sizing, without rebalancing or resimulating orders.',
      'Simulation frequencies are conditional on this history and block length; they do not establish live profitability or rule out overfitting.',
      'Drawdown uses daily closes and can understate intraday risk. Missing dates are not filled; observed zero-P&L days remain in the sample.',
      'Percentile bands are pointwise summaries, not individual simulated paths. Equity paths continue arithmetically after reaching zero; margin and liquidation rules are not modeled.',
    ] };
  if (result.error) return result;
  if (days.length < 30) result.error = 'At least 30 observed daily equity values are required.';
  else if (days.length > 10000) result.error = 'This report supports up to 10,000 observed days; the full horizon was not simulated.';
  else if (!Number.isInteger(simulations) || simulations < 1 || simulations > 1000) result.error = 'Choose between 1 and 1,000 simulations.';
  else if (!Number.isInteger(blockLength) || blockLength < 1 || blockLength > days.length) result.error = 'Block length must be a whole number between 1 and the observed day count.';
  else if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) result.error = 'Seed must be an integer between 0 and 4,294,967,295.';
  else if (!finite(drawdownThresholdPct) || drawdownThresholdPct <= 0 || drawdownThresholdPct > 100) result.error = 'Drawdown threshold must be above 0% and at most 100%.';
  if (result.error) return result;

  let previous = initial;
  const changes = days.map(day => { const change = day.equity - previous; previous = day.equity; return change; });
  if (changes.some(change => !finite(change))) {
    result.error = 'Daily equity changes exceed the supported numeric range.';
    return result;
  }
  // Mulberry32: stable local seed, without changing the application's random state.
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const n = days.length;
  // ponytail: cap the browser workload at 10m day steps; longer histories need a worker/backend.
  const sampleDays = Array.from({ length: Math.min(n, 100) + 1 }, (_, i) => Math.round(i * n / Math.min(n, 100)));
  const samples = sampleDays.map(() => [] as number[]);
  const endings: number[] = [], drawdowns: number[] = [];
  let losing = 0, breached = 0, zero = 0;
  for (let run = 0; run < simulations; run++) {
    let equity = initial, peak = initial, maxDrawdown = 0, reachedZero = false;
    let day = 0, sampled = 1;
    samples[0].push(initial);
    while (day < n) {
      // No circular wrap: a block never joins the history's end to its beginning.
      const start = Math.floor(random() * (n - blockLength + 1));
      for (let offset = 0; offset < blockLength && day < n; offset++) {
        equity += changes[start + offset];
        peak = Math.max(peak, equity);
        maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak * 100);
        reachedZero ||= equity <= 0;
        day++;
        if (sampleDays[sampled] === day) { samples[sampled].push(equity); sampled++; }
      }
    }
    if (!finite(equity) || !finite(maxDrawdown)) {
      result.error = 'Simulated equity exceeds the supported numeric range.';
      return result;
    }
    endings.push(equity); drawdowns.push(maxDrawdown);
    if (equity < initial) losing++;
    if (maxDrawdown >= drawdownThresholdPct) breached++;
    if (reachedZero) zero++;
  }
  const percentiles = (values: number[]) => {
    values.sort((a, b) => a - b);
    return { p5: quantile(values, .05), p50: quantile(values, .5), p95: quantile(values, .95) };
  };
  result.terminal = percentiles(endings);
  const dd = percentiles(drawdowns);
  result.maxDrawdownPct = { p50: dd.p50, p95: dd.p95 };
  result.losingPct = losing / simulations * 100;
  result.drawdownBreachPct = breached / simulations * 100;
  result.zeroEquityPct = zero / simulations * 100;
  result.fan = sampleDays.map((day, index) => ({ day, period: day ? days[day - 1].period : null, ...percentiles(samples[index]) }));
  return result;
}
