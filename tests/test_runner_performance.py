import math
import numpy as np
import pandas as pd
from lse_terminal.backtest.runner import PythonRunner


def _reference(result, df, capital, rate, per_unit):
    """Straight nested mark-to-market reference for semantic regression."""
    n = len(df); ts = df.ts.to_numpy(); close = df.close.to_numpy(float)
    events = []
    for k, t in enumerate(result.trades):
        events.extend([(t._entry_i, k, "entry"), (t._exit_i, k, "exit")])
    events.sort(key=lambda e: (e[0], 0 if e[2] == "exit" and result.trades[e[1]]._entry_i < e[0] else 1, e[1], 0 if e[2] == "entry" else 1))
    realized = np.zeros(n); cash = capital; active = []
    bybar = {}
    for event in events: bybar.setdefault(event[0], []).append(event)
    for i in range(n):
        for _, k, kind in bybar.get(i, ()):
            t = result.trades[k]
            if kind == "entry":
                fee = t.entry_commission or 0.0; cash -= fee; realized[i] -= fee; active.append(k)
            else:
                fee = t.exit_commission or 0.0; cash += t.gross_pnl - fee; realized[i] += t.gross_pnl - fee
                if k in active: active.remove(k)
        unreal = 0.0
        for k in active:
            t = result.trades[k]
            signed = t.qty * t.point_value * (1.0 if t.direction == "long" else -1.0)
            unreal += (close[i] - t.entry_price) * signed
        # realized is accumulated cash; this mirrors the production ledger.
        yield [int(ts[i]), float(capital + realized[:i + 1].sum() + unreal)]


def test_accounting_matches_nested_reference_for_mixed_deterministic_trades():
    rng = np.random.default_rng(12345); n = 400; close = 100 + rng.normal(0, .03, n).cumsum()
    df = pd.DataFrame({"ts": np.arange(n, dtype=np.int64) * 60, "open": close + .01,
                       "high": close + .2, "low": close - .2, "close": close, "volume": 1.})
    raw = []
    for i in range(0, 300, 7):
        exit_i = i if i % 5 == 0 else min(n - 1, i + int(rng.integers(1, 70)))
        raw.append({"entry_i": i, "exit_i": exit_i, "qty": 0.0 if i % 11 == 0 else float(rng.uniform(.01, 3)),
                    "dir": "short" if i % 3 == 0 else "long", "point_value": float(rng.uniform(.5, 20)),
                    "entry": float(close[i] + .01), "exit": float(close[exit_i] + .01)})
    runner = PythonRunner()
    trades = runner._normalize(raw, df)
    # The reference consumes the same normalized trades after accounting fills
    # quantities and commissions, then checks every marked bar.
    curve, final, held = runner._account(trades, df, 25_000, .0017, .03)
    class Result:
        pass
    result = Result(); result.trades = trades
    expected = list(_reference(result, df, 25_000, .0017, .03))
    assert np.allclose(np.asarray(curve), np.asarray(expected), rtol=0, atol=1e-8)
    assert held == sum(any(t._entry_i <= i < t._exit_i for t in trades) for i in range(n))
    assert math.isfinite(final)


def test_high_notional_tiny_pnl_keeps_precision_during_marking():
    # A coefficient-times-close plus constant formulation loses this movement
    # to cancellation. Per-trade slices retain the subtraction order.
    close = np.array([1e12, 1e12 + 0.125, 1e12 + 0.25, 1e12 + 0.375])
    df = pd.DataFrame({"ts": np.arange(4, dtype=np.int64), "open": close,
                       "high": close, "low": close, "close": close, "volume": 1.})
    runner = PythonRunner(); trades = runner._normalize(
        [{"entry_i": 0, "exit_i": 3, "entry": close[0], "exit": close[3], "qty": 1_000_000}], df)
    curve, _, _ = runner._account(trades, df, 1e15, 0.0, 0.0)
    assert curve[1][1] - 1e15 == 125_000.0
    assert curve[2][1] - 1e15 == 250_000.0
