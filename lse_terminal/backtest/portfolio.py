"""Fixed-capital portfolios of independently accounted local Python strategies."""

from __future__ import annotations

import math
import re

import numpy as np
import pandas as pd

from lse_terminal.backtest.contract import BacktestError, BacktestResult
from lse_terminal.backtest.runner import PythonRunner, _commission_options


def _bound(value: str | None, *, end: bool = False) -> float | None:
    if not value:
        return None
    try:
        timestamp = pd.Timestamp(value)
        timestamp = timestamp.tz_localize("UTC") if timestamp.tzinfo is None else timestamp.tz_convert("UTC")
        if end and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            timestamp += pd.Timedelta(days=1) - pd.Timedelta(seconds=1)
        seconds = timestamp.timestamp()
        if not math.isfinite(seconds):
            raise ValueError()
        return seconds
    except (TypeError, ValueError, OverflowError):
        raise BacktestError(f"Invalid portfolio {'to' if end else 'from'} date: {value!r}") from None


def _aligned(clock: np.ndarray, values: np.ndarray, union: np.ndarray, initial: float) -> np.ndarray:
    """Cash before the first observation, then the latest available mark."""
    indices = np.searchsorted(clock, union, side="right") - 1
    aligned = np.full(len(union), initial, dtype="float64")
    seen = indices >= 0
    aligned[seen] = values[indices[seen]]
    return aligned


def _daily_curve(clock: np.ndarray, values: np.ndarray) -> list[list[float]]:
    # Last observed mark on each UTC date; never invent missing observations.
    last = np.r_[np.flatnonzero(np.diff(clock // 86400)), len(clock) - 1]
    return [[int(clock[i]), float(values[i])] for i in last]


def _exposure_pct(trades, start: int, end: int) -> float:
    if end <= start:
        return 0.0
    intervals = sorted((max(start, t.entry_ts), min(end, t.exit_ts))
                       for t in trades if t.qty > 0 and t.exit_ts is not None)
    seconds = 0
    previous_end = start
    for entry, exit in intervals:
        seconds += max(0, exit - max(entry, previous_end))
        previous_end = max(previous_end, exit)
    return seconds / (end - start) * 100.0


def run_portfolio(*, name: str, capital: float, currency: str,
                  components: list[dict], provider, start: str | None = None,
                  end: str | None = None, data_files: dict | None = None) -> dict:
    """Run each allocation once and sum its actual P&L on the union clock.

    Merging each component immediately avoids retaining an instrument-by-time
    matrix or multiple copies of every component's Python curve lists.
    """
    name, currency = name.strip(), currency.strip().upper()
    if not name or len(name) > 200:
        raise BacktestError("Portfolio name must contain 1 to 200 characters")
    if not math.isfinite(capital) or capital <= 0:
        raise BacktestError("Portfolio capital must be positive and finite")
    if not re.fullmatch(r"[A-Z]{3}", currency):
        raise BacktestError("Portfolio currency must be a three-letter currency code")
    if not 1 <= len(components) <= 12:
        raise BacktestError("A portfolio requires 1 to 12 components")
    ids, allocations = set(), []
    for component in components:
        label = component.get("label") or component.get("id") or "unnamed"
        for field in ("id", "label", "strategy", "script", "symbol", "timeframe"):
            if not isinstance(component.get(field), str) or not component[field].strip():
                raise BacktestError(f"Component {label!r}: {field} is required")
        if component["id"] in ids:
            raise BacktestError(f"Duplicate portfolio component ID: {component['id']!r}")
        ids.add(component["id"])
        allocation = component["allocation_pct"]
        if not math.isfinite(allocation) or not 0 < allocation <= 100:
            raise BacktestError(f"Component {label!r}: allocation must be positive and finite, at most 100%")
        allocations.append(allocation)
        if component.get("currency", "USD").strip().upper() != currency:
            raise BacktestError(f"Component {label!r}: currency must match {currency}; FX conversion is not supported")
        try:
            _commission_options(component)
        except BacktestError as exc:
            raise BacktestError(f"Component {label!r}: {exc}") from None
    total_allocation = math.fsum(allocations)
    if total_allocation > 100:
        raise BacktestError("Portfolio allocations must sum to 100% or less")
    first, last = _bound(start), _bound(end, end=True)
    if first is not None and last is not None and first > last:
        raise BacktestError("Portfolio from date must not be after its to date")

    runner = PythonRunner()
    clock = np.array([], dtype="int64")
    equity = benchmark = np.array([], dtype="float64")
    summaries, trades, tagged_trades = [], [], []
    reserve = capital * (1.0 - total_allocation / 100.0)
    for component in components:
        allocated = capital * (component["allocation_pct"] / 100.0)
        label = component["label"]
        try:
            candles = provider.candles(component["symbol"], component["timeframe"], limit=0)
            options = {"capital": allocated, "params": dict(component.get("params") or {}),
                       "commission_pct": component.get("commission_pct", 0.0),
                       "commission_per_unit": component.get("commission_per_unit", 0.0),
                       "extended_stats": True, "from": first, "to": last}
            result = runner.run(component["script"], candles, component["symbol"],
                                component["timeframe"], options=options, data_files=data_files)
            del candles
            curve = np.asarray(result.equity_curve, dtype="float64")
            held = np.asarray(result.benchmark_curve, dtype="float64")
            if (curve.ndim != 2 or curve.shape[1] != 2 or not len(curve)
                    or not np.isfinite(curve).all() or np.any(np.diff(curve[:, 0]) <= 0)):
                raise BacktestError("No finite, strictly ordered equity curve")
            if held.shape != curve.shape or not np.isfinite(held).all() or not np.array_equal(held[:, 0], curve[:, 0]):
                raise BacktestError("No complete finite price benchmark for this dataset")
            if not math.isfinite(result.final_equity):
                raise BacktestError("Final equity is not finite")
            leg_clock = curve[:, 0].astype("int64")
            leg_equity = curve[:, 1]
            union = np.union1d(clock, leg_clock)
            equity = _aligned(clock, equity, union, capital)
            equity += _aligned(leg_clock, leg_equity, union, allocated) - allocated
            benchmark = _aligned(clock, benchmark, union, capital)
            benchmark += _aligned(leg_clock, held[:, 1], union, allocated) - allocated
            clock = union
            leg_peak = np.maximum.accumulate(np.maximum(leg_equity, allocated))
            leg_dd = float(np.max((leg_peak - leg_equity) / leg_peak) * 100.0)
            summaries.append({
                **{key: component[key] for key in ("id", "label", "strategy", "symbol", "timeframe", "allocation_pct")},
                "currency": currency, "commission_pct": result.commission_pct,
                "commission_per_unit": result.commission_per_unit,
                "total_commission": result.total_commission, "gross_profit": result.gross_profit,
                "initial_capital": allocated, "final_equity": result.final_equity,
                "net_profit": result.net_profit, "total_trades": len(result.trades),
                "max_drawdown_pct": leg_dd, "start_ts": int(leg_clock[0]), "end_ts": int(leg_clock[-1]),
                "daily_equity_curve": _daily_curve(leg_clock, leg_equity),
            })
            tags = {"component_id": component["id"], "component_label": label, **{
                key: component[key] for key in ("strategy", "symbol", "timeframe")}}
            trades.extend(result.trades)
            # Reuse the standard trade serialization; large curve lists are
            # merely referenced by to_json and are released with this result.
            tagged_trades.extend({**trade, **tags} for trade in result.to_json()["trades"])
            del result, curve, held, leg_clock, leg_equity
        except Exception as exc:
            raise BacktestError(f"Component {label!r} ({component['symbol']}): {exc}") from None

    if not np.isfinite(equity).all() or not np.isfinite(benchmark).all():
        raise BacktestError("Portfolio values overflowed; reduce capital or position sizes")
    trades.sort(key=lambda trade: (trade.exit_ts, trade.entry_ts))
    tagged_trades.sort(key=lambda trade: (trade["exit_ts"], trade["entry_ts"], trade["component_id"]))
    equity_curve = [[int(ts), float(value)] for ts, value in zip(clock, equity)]
    final = float(equity[-1])
    stats = runner._stats(trades, equity_curve, capital, final, 0, True)
    extended = stats["extended"]
    extended["avgBarsHeld"] = None  # Different component bar sizes cannot be averaged.
    extended["exposurePct"] = _exposure_pct(trades, int(clock[0]), int(clock[-1]))
    total_commission = float(sum(leg["total_commission"] for leg in summaries))
    gross_profit = float(sum(leg["gross_profit"] for leg in summaries))
    if not math.isfinite(total_commission) or not math.isfinite(gross_profit):
        raise BacktestError("Portfolio accounting totals overflowed; reduce commission rates or quantities")
    portfolio = BacktestResult(engine="portfolio", symbol=name, timeframe="mixed",
                              initial_capital=capital, final_equity=final, net_profit=final - capital,
                              stats=stats, equity_curve=equity_curve,
                              benchmark_curve=[[int(ts), float(value)] for ts, value in zip(clock, benchmark)],
                              total_commission=total_commission, gross_profit=gross_profit)
    # A single rate is meaningful only when every component used that rate.
    for field in ("commission_pct", "commission_per_unit"):
        rates = {leg[field] for leg in summaries}
        setattr(portfolio, field, next(iter(rates)) if len(rates) == 1 else None)
    payload = portfolio.to_json()
    payload["trades"] = tagged_trades
    payload["portfolio"] = {
        "name": name, "currency": currency, "allocation_model": "fixed",
        "unallocated_capital": reserve, "components": summaries,
        "methodology": [
            "Each strategy runs independently with its fixed initial capital allocation; unused allocation remains cash. No shared margin, position netting, transfers or rebalancing.",
            "Strategy quantity rules and contract multipliers are preserved. Explicit quantities can exceed an allocation's notional value; margin limits and borrowing costs are not simulated.",
            "Only declared matching account currencies are combined; no FX conversion is performed.",
            "Full component equity curves are summed on the union of observed timestamps. Before a component starts its allocation is cash; gaps use only its last known mark, and after it ends its final cash is retained.",
            "The benchmark is allocated normalized close prices plus reserve cash. Each holding ends at that component's final data date and its final value is retained; dividends and futures roll costs are not modeled.",
            "Percentage fees on absolute contract notional and cash fees per actual unit are additive and charged on each side. Cash fees do not use the contract multiplier. Both are included once in component P&L; aggregate rates are null when components differ. Slippage is included only if the strategy models it in its fills.",
            "Drawdown and return statistics are recalculated from combined equity; Sharpe and volatility use the union's observed return intervals per calendar year, not a regular daily series.",
            "Exposure is elapsed calendar time with any component position open. Trade streaks use exit order; average bars held is undefined across different timeframes.",
            "All runs start fresh inside the requested UTC window. A date-only end includes its full UTC day; component histories may have different coverage and gaps.",
        ],
    }
    return payload
