// The Python engine's result contract. Keep the manual replay Trade type separate:
// it describes orders placed by the user, rather than the engine's closed fills.
export type StrategyTrade = {
  entry_ts: number;
  exit_ts: number | null;
  direction: string;
  entry_price: number;
  exit_price: number | null;
  qty: number;
  pnl: number;
  gross_pnl?: number | null;
  commission?: number | null;
  entry_commission?: number | null;
  exit_commission?: number | null;
  pnl_pct: number;
  bars_held: number;
  component_id?: string;
  component_label?: string;
  strategy?: string;
  symbol?: string;
  timeframe?: string;
};

export type PortfolioComponent = {
  id: string;
  label: string;
  strategy: string;
  symbol: string;
  timeframe: string;
  allocation_pct: number;
  initial_capital: number;
  final_equity: number;
  net_profit: number;
  gross_profit?: number | null;
  total_commission?: number | null;
  commission_pct?: number | null;
  commission_per_unit?: number | null;
  total_trades: number;
  max_drawdown_pct: number;
  start_ts: number;
  end_ts: number;
  daily_equity_curve: [number, number][];
};

export type StrategyResult = {
  engine: string;
  symbol: string;
  timeframe: string;
  initial_capital: number;
  final_equity: number;
  net_profit: number;
  gross_profit?: number | null;
  total_commission?: number | null;
  commission_pct?: number | null;
  commission_per_unit?: number | null;
  stats: Record<string, any>;
  equity_curve: [number, number][];
  benchmark_curve?: [number, number][];
  trades: StrategyTrade[];
  plots?: Record<string, [number, number][]>;
  daily_equity_curve?: [number, number][];
  portfolio?: {
    name: string;
    currency: string;
    allocation_model: 'fixed';
    unallocated_capital: number;
    components: PortfolioComponent[];
    methodology: string[];
  };
};

export const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

// Calendar-time CAGR must include weekends, holidays and missing observations.
export function calendarCagr(curve: [number, number][], initial: number, final: number): number | null {
  if (curve.length < 2 || !finite(initial) || initial <= 0 || !finite(final) || final <= 0 ||
      curve.some(([, value]) => value <= 0)) return null;
  const years = (curve[curve.length - 1][0] - curve[0][0]) / (365.25 * 86400);
  if (!finite(years) || years <= 0) return null;
  const value = Math.expm1(Math.log(final / initial) / years) * 100;
  return finite(value) ? value : null;
}

export function resultNumber(value: unknown, digits = 2): string {
  if (value === '__+Inf__') return '∞';
  if (value === '__-Inf__') return '−∞';
  return finite(value)
    ? value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—';
}

export function utcTime(seconds: number | null | undefined): string {
  if (!finite(seconds)) return '—';
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 19).replace('T', ' ') : '—';
}

// Chart lines are sampled independently. Compare their original observations
// at the same instant, rather than the potentially different sampled points.
export function curveValueAt(curve: [number, number][], ts: number): number | null {
  let low = 0, high = curve.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (curve[middle][0] === ts) return curve[middle][1];
    if (curve[middle][0] < ts) low = middle + 1;
    else high = middle - 1;
  }
  return null;
}

// Bound the chart's work before ECharts copies/processes data. Keep exact extrema,
// endpoints and missing-data boundaries; a zoomed window is sampled from the raw
// observations again, so small windows retain every bar.
export function sampleCurve(curve: [number, number | null][], maxPoints = 2000,
  start = -Infinity, end = Infinity): [number, number | null][] {
  if (!curve.length || end < start) return [];
  const lowerBound = (time: number) => {
    let low = 0, high = curve.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (curve[middle][0] < time) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const first = Math.max(0, lowerBound(start) - 1);
  const last = Math.min(curve.length - 1, lowerBound(end));
  const point = (index: number): [number, number | null] =>
    [curve[index][0] * 1000, finite(curve[index][1]) ? curve[index][1] : null];
  if (last - first + 1 <= maxPoints) return curve.slice(first, last + 1).map((_, i) => point(first + i));
  const indices = new Set([first, last]);
  const bucketSize = Math.ceil((last - first - 1) / Math.max(1, Math.floor((maxPoints - 2) / 2)));
  for (let from = first + 1; from < last; from += bucketSize) {
    const until = Math.min(last, from + bucketSize);
    let minimum = -1, maximum = -1;
    for (let i = from; i < until; i++) {
      const value = curve[i][1];
      if (finite(value)) {
        if (minimum < 0 || value < curve[minimum][1]!) minimum = i;
        if (maximum < 0 || value > curve[maximum][1]!) maximum = i;
      }
      if (finite(value) !== finite(curve[i - 1][1])) { indices.add(i - 1); indices.add(i); }
    }
    if (minimum >= 0) indices.add(minimum);
    if (maximum >= 0) indices.add(maximum);
  }
  if (finite(curve[last][1]) !== finite(curve[last - 1][1])) indices.add(last - 1);
  return Array.from(indices).sort((a, b) => a - b).map(point);
}

export function tradeCsv(trades: (StrategyTrade & { id?: number })[]): string {
  // Quoting alone does not stop spreadsheet formulas in a strategy-controlled
  // direction field. Keep literal text literal when exporting to spreadsheets.
  const cell = (value: unknown) => {
    let text = String(value ?? '');
    if (typeof value === 'string' && /^[=+@\-\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const attributed = trades.some(t => t.component_id != null);
  return [
    ['Trade', 'Direction', 'Entry UTC', 'Exit UTC', 'Entry price', 'Exit price', 'Quantity', 'Gross P&L', 'Entry commission', 'Exit commission', 'Commission', 'Net P&L', 'Net P&L %', 'Bars held',
      ...(attributed ? ['Component', 'Strategy', 'Symbol', 'Timeframe'] : [])],
    ...trades.map((t, index) => [t.id ?? index + 1, t.direction, utcTime(t.entry_ts), t.exit_ts == null ? '' : utcTime(t.exit_ts),
      t.entry_price, t.exit_price ?? '', t.qty, t.gross_pnl ?? '', t.entry_commission ?? '', t.exit_commission ?? '', t.commission ?? '', t.pnl, t.pnl_pct, t.bars_held,
      ...(attributed ? [t.component_label || t.component_id, t.strategy, t.symbol, t.timeframe] : [])]),
  ].map(row => row.map(cell).join(',')).join('\r\n');
}

export type ReturnPeriod = { period: string; equity: number; returnPct: number | null };

// Period returns use the last observed equity in UTC; the first partial period
// starts at initial capital. No synthetic zero-return days fill market closures.
export function returnPeriods(equity: [number, number][], initial: number, length: number): ReturnPeriod[] {
  // Intraday histories can contain millions of bars but only thousands of days.
  // Bucket numerically before formatting dates, retaining the last observed close.
  const dailyCloses = new Map<number, number>();
  for (const [ts, value] of equity) dailyCloses.set(Math.floor(ts / 86400), value);
  const closes = new Map<string, number>();
  for (const [day, value] of dailyCloses) closes.set(utcTime(day * 86400).slice(0, length), value);
  return periodReturns(closes, initial);
}

function periodReturns(closes: Map<string, number>, initial: number): ReturnPeriod[] {
  let previous = initial;
  return Array.from(closes, ([period, value]) => {
    const returnPct = previous > 0 ? (value / previous - 1) * 100 : null;
    previous = value;
    return { period, equity: value, returnPct };
  });
}

export function strategyAnalytics(result: StrategyResult) {
  const equity = (result.equity_curve || []).filter(([ts, value]) => finite(ts) && finite(value));
  const dailyEquity = result.daily_equity_curve
    ? result.daily_equity_curve.filter(([ts, value]) => finite(ts) && finite(value)) : equity;
  const benchmark = (result.benchmark_curve || []).filter(([ts, value]) => finite(ts) && finite(value));
  const benchmarkInitial = benchmark[0]?.[1];
  const benchmarkFinal = benchmark[benchmark.length - 1]?.[1];
  const benchmarkReturn = finite(benchmarkInitial) && benchmarkInitial > 0 && finite(benchmarkFinal)
    ? (benchmarkFinal / benchmarkInitial - 1) * 100 : null;
  let peak = result.initial_capital;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let underwaterStart: number | null = null;
  let longestUnderwater = 0;
  const drawdown = equity.map(([ts, value]) => {
    peak = Math.max(peak, value);
    const amount = peak - value;
    const percent = peak > 0 ? -amount / peak * 100 : null;
    maxDrawdown = Math.max(maxDrawdown, amount);
    if (percent != null) maxDrawdownPct = Math.max(maxDrawdownPct, -percent);
    if (amount > 0) underwaterStart ??= ts;
    if (underwaterStart != null) longestUnderwater = Math.max(longestUnderwater, ts - underwaterStart);
    if (amount === 0) underwaterStart = null;
    return [ts, percent] as [number, number | null];
  });
  const trades: StrategyTrade[] = [];
  const pnls: number[] = [];
  let wins = 0;
  let losses = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let min = Infinity;
  let max = -Infinity;
  const directionStats = { long: { count: 0, wins: 0, net: 0 }, short: { count: 0, wins: 0, net: 0 } };
  for (const trade of result.trades || []) {
    if (!finite(trade.pnl)) continue;
    const pnl = trade.pnl;
    trades.push(trade);
    pnls.push(pnl);
    min = Math.min(min, pnl);
    max = Math.max(max, pnl);
    if (pnl > 0) { wins++; grossWin += pnl; }
    else if (pnl < 0) { losses++; grossLoss += pnl; }
    const direction = trade.direction === 'long' ? directionStats.long : trade.direction === 'short' ? directionStats.short : null;
    if (direction) {
      direction.count++;
      direction.net += pnl;
      if (pnl > 0) direction.wins++;
    }
  }
  const bins = Math.min(20, Math.max(1, Math.ceil(Math.sqrt(pnls.length))));
  const width = min === max ? Math.max(1, Math.abs(min) * .1) : (max - min) / bins;
  const start = min === max ? min - width / 2 : min;
  const histogram = pnls.length ? Array.from({ length: min === max ? 1 : bins }, (_, i) => ({
    low: start + i * width, high: start + (i + 1) * width, count: 0,
  })) : [];
  for (const pnl of pnls) histogram[Math.min(histogram.length - 1, Math.floor((pnl - start) / width))].count++;
  const direction = (['long', 'short'] as const).map(side => {
    const row = directionStats[side];
    return { side, count: row.count, net: row.net, winRate: row.count ? row.wins / row.count * 100 : null,
      average: row.count ? row.net / row.count : null };
  });
  const days = returnPeriods(dailyEquity, result.initial_capital, 10);
  const monthCloses = new Map<string, number>();
  for (const day of days) monthCloses.set(day.period.slice(0, 7), day.equity);
  return { equity, benchmark, benchmarkReturn,
    cagr: calendarCagr(equity, result.initial_capital, result.final_equity),
    benchmarkCagr: calendarCagr(benchmark, benchmarkInitial, benchmarkFinal),
    drawdown, maxDrawdown, maxDrawdownPct, longestUnderwater,
    days, months: periodReturns(monthCloses, result.initial_capital),
    trades, wins, losses, breakeven: trades.length - wins - losses,
    grossWin, grossLoss, histogram, direction,
    averageWin: wins ? grossWin / wins : null,
    averageLoss: losses ? grossLoss / losses : null,
    payoff: wins && losses ? (grossWin / wins) / Math.abs(grossLoss / losses) : null,
  };
}
