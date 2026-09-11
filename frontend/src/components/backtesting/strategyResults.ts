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
  pnl_pct: number;
  bars_held: number;
};

export type StrategyResult = {
  engine: string;
  symbol: string;
  timeframe: string;
  initial_capital: number;
  final_equity: number;
  net_profit: number;
  stats: Record<string, any>;
  equity_curve: [number, number][];
  benchmark_curve?: [number, number][];
  trades: StrategyTrade[];
  plots?: Record<string, [number, number][]>;
};

export const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

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

export function tradeCsv(trades: (StrategyTrade & { id?: number })[]): string {
  // Quoting alone does not stop spreadsheet formulas in a strategy-controlled
  // direction field. Keep literal text literal when exporting to spreadsheets.
  const cell = (value: unknown) => {
    let text = String(value ?? '');
    if (typeof value === 'string' && /^[=+@\-\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  return [
    ['Trade', 'Direction', 'Entry UTC', 'Exit UTC', 'Entry price', 'Exit price', 'Quantity', 'P&L', 'P&L %', 'Bars held'],
    ...trades.map((t, index) => [t.id ?? index + 1, t.direction, utcTime(t.entry_ts), t.exit_ts == null ? '' : utcTime(t.exit_ts),
      t.entry_price, t.exit_price ?? '', t.qty, t.pnl, t.pnl_pct, t.bars_held]),
  ].map(row => row.map(cell).join(',')).join('\r\n');
}

export type ReturnPeriod = { period: string; equity: number; returnPct: number | null };

// Period returns use the last observed equity in UTC; the first partial period
// starts at initial capital. No synthetic zero-return days fill market closures.
export function returnPeriods(equity: [number, number][], initial: number, length: number): ReturnPeriod[] {
  const closes = new Map<string, number>();
  for (const [ts, value] of equity) closes.set(utcTime(ts).slice(0, length), value);
  let previous = initial;
  return Array.from(closes, ([period, value]) => {
    const returnPct = previous > 0 ? (value / previous - 1) * 100 : null;
    previous = value;
    return { period, equity: value, returnPct };
  });
}

export function strategyAnalytics(result: StrategyResult) {
  const equity = (result.equity_curve || []).filter(([ts, value]) => finite(ts) && finite(value));
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
  const trades = (result.trades || []).filter(t => finite(t.pnl));
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const grossWin = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = losses.reduce((sum, t) => sum + t.pnl, 0);
  const pnls = trades.map(t => t.pnl);
  const min = pnls.reduce((a, b) => Math.min(a, b), Infinity);
  const max = pnls.reduce((a, b) => Math.max(a, b), -Infinity);
  const bins = Math.min(20, Math.max(1, Math.ceil(Math.sqrt(pnls.length))));
  const width = min === max ? Math.max(1, Math.abs(min) * .1) : (max - min) / bins;
  const start = min === max ? min - width / 2 : min;
  const histogram = pnls.length ? Array.from({ length: min === max ? 1 : bins }, (_, i) => ({
    low: start + i * width, high: start + (i + 1) * width, count: 0,
  })) : [];
  for (const pnl of pnls) histogram[Math.min(histogram.length - 1, Math.floor((pnl - start) / width))].count++;
  const direction = ['long', 'short'].map(side => {
    const rows = trades.filter(t => t.direction === side);
    const wins = rows.filter(t => t.pnl > 0);
    const net = rows.reduce((sum, t) => sum + t.pnl, 0);
    return { side, count: rows.length, net, winRate: rows.length ? wins.length / rows.length * 100 : null,
      average: rows.length ? net / rows.length : null };
  });
  return { equity, drawdown, maxDrawdown, maxDrawdownPct, longestUnderwater,
    days: returnPeriods(equity, result.initial_capital, 10), months: returnPeriods(equity, result.initial_capital, 7),
    trades, wins: wins.length, losses: losses.length, breakeven: trades.length - wins.length - losses.length,
    grossWin, grossLoss, histogram, direction,
    averageWin: wins.length ? grossWin / wins.length : null,
    averageLoss: losses.length ? grossLoss / losses.length : null,
    payoff: wins.length && losses.length ? (grossWin / wins.length) / Math.abs(grossLoss / losses.length) : null,
  };
}
