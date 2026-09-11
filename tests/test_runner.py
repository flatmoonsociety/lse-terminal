"""The plain-Python strategy contract: `df` in, `trades` out.

These lock the contract itself, because it is the only thing a user has to
match. Everything else (sizing, commission, equity, stats) is ours and must
stay correct without them thinking about it.
"""

import math

import numpy as np
import pandas as pd
import pytest

from lse_terminal.backtest.contract import BacktestError
from lse_terminal.backtest.runner import TEMPLATE, PythonRunner


def candles(n=300, start=100.0, drift=0.05, seed=0):
    rng = np.random.default_rng(seed)
    close = start + np.cumsum(rng.normal(drift, 0.8, n))
    # Daily bars: the starter template thinks in day-horizons (fast/slow in
    # DAYS scaled by bar spacing), so 300 daily bars give it room to trade;
    # 300 hourly bars would not even cover its slow lookback.
    ts = np.arange(n) * 86400 + 1700000000
    return pd.DataFrame({"ts": ts, "open": close, "high": close + 0.5,
                         "low": close - 0.5, "close": close,
                         "volume": np.full(n, 1000.0)})


@pytest.fixture()
def runner():
    return PythonRunner()


# ── the contract ─────────────────────────────────────────────────────────

def test_template_runs_and_trades(runner):
    res = runner.run(TEMPLATE, candles(), "T", "1d")
    assert len(res.trades) > 0
    assert res.stats["totalTrades"] == len(res.trades)


def test_nothing_of_ours_is_imported():
    """The shipped starter must not teach an import of ours; that was the
    whole reason the previous Strategy API was deleted."""
    assert "lse_terminal" not in TEMPLATE
    code = [ln for ln in TEMPLATE.splitlines() if not ln.lstrip().startswith("#")]
    imports = [ln for ln in code if ln.startswith(("import ", "from "))]
    # numpy/pandas are the ambient vocabulary of the contract (`df` IS a
    # DataFrame); what must never appear is an import of our own package.
    allowed = {"numpy", "pandas", "math"}
    assert all(ln.split()[1].split(".")[0] in allowed for ln in imports)


def test_df_is_injected(runner):
    res = runner.run(
        'trades = [{"entry_i": 0, "exit_i": len(df) - 1}]', candles(), "T", "1d")
    assert len(res.trades) == 1


def test_params_are_injected_and_default_empty(runner):
    script = ('n = int(params.get("n", 5))\n'
              'trades = [{"entry_i": 0, "exit_i": n}]')
    assert runner.run(script, candles(), "T", "1d").trades[0].bars_held == 5
    res = runner.run(script, candles(), "T", "1d", options={"params": {"n": 9}})
    assert res.trades[0].bars_held == 9


def test_missing_trades_is_a_clear_error(runner):
    with pytest.raises(BacktestError, match="without leaving a `trades` list"):
        runner.run("x = 1", candles(), "T", "1d")


def test_syntax_error_reports_the_line(runner):
    with pytest.raises(BacktestError, match="syntax error at line"):
        runner.run("trades = [", candles(), "T", "1d")


def test_runtime_error_reports_the_line(runner):
    with pytest.raises(BacktestError, match=r"ZeroDivisionError.*line 2"):
        runner.run("x = 1\ny = 1 / 0\ntrades = []", candles(), "T", "1d")


# ── trade dict handling ──────────────────────────────────────────────────

def test_bar_index_and_timestamp_agree(runner):
    df = candles()
    by_index = runner.run(
        'trades = [{"entry_i": 5, "exit_i": 20}]', df, "T", "1d")
    by_ts = runner.run(
        f'trades = [{{"entry_ts": {df.ts[5]}, "exit_ts": {df.ts[20]}}}]',
        df, "T", "1d")
    assert by_index.net_profit == by_ts.net_profit


def test_price_defaults_to_the_bar_open(runner):
    """A decision taken on the previous bar fills at this bar's open, so an
    omitted price must be that open and never the close."""
    df = candles()
    res = runner.run('trades = [{"entry_i": 5, "exit_i": 20}]', df, "T", "1d")
    assert res.trades[0].entry_price == pytest.approx(df.open[5])
    assert res.trades[0].exit_price == pytest.approx(df.open[20])


def test_short_is_the_mirror_of_long(runner):
    df = candles()
    long_ = runner.run('trades = [{"entry_i": 5, "exit_i": 20}]', df, "T", "1d")
    short = runner.run(
        'trades = [{"entry_i": 5, "exit_i": 20, "dir": "short"}]', df, "T", "1d")
    assert short.net_profit == pytest.approx(-long_.net_profit)


@pytest.mark.parametrize("spelling", [
    '{"entry_i": 5, "exit_i": 20, "dir": "long"}',
    '{"entry_i": 5, "exit_i": 20, "direction": "long"}',
    '{"entry_i": 5, "exit_i": 20, "side": "buy"}',
    '{"entry_bar": 5, "exit_bar": 20}',
])
def test_key_spellings_are_accepted(runner, spelling):
    res = runner.run(f"trades = [{spelling}]", candles(), "T", "1d")
    assert res.trades[0].direction == "long"


def test_explicit_prices_and_qty_are_honoured(runner):
    res = runner.run(
        'trades = [{"entry_i": 5, "exit_i": 20, "entry": 100, "exit": 110, '
        '"qty": 3}]', candles(), "T", "1d")
    assert res.net_profit == pytest.approx(30.0)


def test_futures_point_value_scales_pnl_mark_to_market_and_notional(runner):
    """A one-contract futures trade pays its contract point value per price
    point, including sizing, fees and the open-position mark."""
    df = candles(n=4)
    df["open"] = [100.0, 101.0, 103.0, 104.0]
    df["close"] = [100.0, 102.0, 103.0, 104.0]
    result = runner.run(
        'trades = [{"entry_i": 0, "exit_i": 3, "qty": 1, "point_value": 2}]',
        df, "MNQ", "1m", options={"commission_pct": 1.0})
    # 4 points * 2 dollars/point, less 1% commission on the 200-dollar
    # entry notional and 208-dollar exit notional.
    assert result.trades[0].pnl == pytest.approx(3.92)
    assert result.net_profit == pytest.approx(3.92)
    assert result.equity_curve[1][1] == pytest.approx(100_002.0)
    assert result.trades[0].point_value == 2.0
    assert result.to_json()["trades"][0]["point_value"] == 2.0


def test_default_futures_size_uses_contract_notional(runner):
    result = runner.run(
        'trades = [{"entry_i": 0, "exit_i": 2, "entry": 100, "exit": 110, '
        '"point_value": 20}]', candles(n=3), "NQ", "1m",
        options={"capital": 10_000})
    assert result.trades[0].qty == pytest.approx(5.0)
    assert result.net_profit == pytest.approx(1_000.0)


def test_same_bar_round_trip_realizes_fees_and_releases_capital(runner):
    result = runner.run(
        'trades = ['
        '{"entry_i": 0, "exit_i": 1, "entry": 100, "exit": 110, "point_value": 2},'
        '{"entry_i": 1, "exit_i": 1, "entry": 100, "exit": 105, "point_value": 2},'
        '{"entry_i": 1, "exit_i": 2, "entry": 100, "exit": 100, "point_value": 2}'
        ']', candles(n=3), "MNQ", "1m",
        options={"capital": 1_000, "commission_pct": 1.0})
    # Existing position closes for 1,079; the same-bar trade pays both fees,
    # earns 5%, and leaves 1,110.8305 available for the following entry.
    assert [t.qty for t in result.trades] == pytest.approx(
        [5.0, 5.395, 5.5541525])
    assert [t.pnl for t in result.trades] == pytest.approx(
        [79.0, 31.8305, -22.21661])
    assert result.final_equity == pytest.approx(1_088.61389)
    assert sum(t.pnl for t in result.trades) == pytest.approx(result.net_profit)
    assert result.equity_curve[-1][1] == pytest.approx(result.final_equity)


@pytest.mark.parametrize("value", ["0", "-1", "float('nan')", "float('inf')"])
def test_point_value_must_be_finite_and_positive(runner, value):
    script = f'trades = [{{"entry_i": 0, "exit_i": 1, "point_value": {value}}}]'
    with pytest.raises(BacktestError, match="point_value.*finite.*> 0"):
        runner.run(script, candles(), "MNQ", "1m")


def test_strategy_receives_selected_symbol_and_timeframe(runner):
    script = ('assert symbol == "MNQ"\n'
              'assert timeframe == "1m"\n'
              'trades = []')
    runner.run(script, candles(), "MNQ", "1m")


def test_trades_may_be_a_dataframe(runner):
    res = runner.run(
        'import pandas as pd\n'
        'trades = pd.DataFrame([{"entry_i": 5, "exit_i": 20}])',
        candles(), "T", "1d")
    assert len(res.trades) == 1


def test_empty_trades_is_valid(runner):
    res = runner.run("trades = []", candles(), "T", "1d")
    assert res.stats["totalTrades"] == 0
    assert res.net_profit == 0.0
    assert len(res.equity_curve) == 300


@pytest.mark.parametrize("bad,message", [
    ('trades = 42', "must be a list of dicts"),
    ('trades = [5]', "expected a dict"),
    ('trades = [{"entry_i": 20, "exit_i": 5}]', "before its entry"),
    ('trades = [{"entry_i": 5, "exit_i": 9999}]', "outside the"),
    ('trades = [{"entry": 100, "exit": 110}]', "no entry_i"),
    ('trades = [{"entry_i": 5, "exit_i": 20, "dir": "sideways"}]', "direction"),
])
def test_bad_trades_give_plain_english_errors(runner, bad, message):
    with pytest.raises(BacktestError, match=message):
        runner.run(bad, candles(), "T", "1d")


# ── the accounting we own ────────────────────────────────────────────────

def test_ledger_sums_to_the_equity_change(runner):
    """The invariant that catches every accounting bug: the trade ledger must
    account for the entire change in the account."""
    res = runner.run(TEMPLATE, candles(n=500, seed=3), "T", "1d",
                     options={"commission_pct": 0.1})
    assert sum(t.pnl for t in res.trades) == pytest.approx(res.net_profit)
    assert res.final_equity == pytest.approx(
        res.initial_capital + res.net_profit)


def test_commission_is_charged_on_both_sides(runner):
    df = candles()
    free = runner.run('trades = [{"entry_i": 5, "exit_i": 20, "qty": 10}]',
                      df, "T", "1d")
    charged = runner.run('trades = [{"entry_i": 5, "exit_i": 20, "qty": 10}]',
                         df, "T", "1d", options={"commission_pct": 1.0})
    expected_fee = (df.open[5] + df.open[20]) * 10 * 0.01
    assert free.net_profit - charged.net_profit == pytest.approx(expected_fee)


def test_equity_curve_marks_open_positions_to_market(runner):
    """Drawdown measured only at exits understates what the account actually
    went through, so open positions must be marked on every bar."""
    df = candles(n=200, seed=9)
    res = runner.run('trades = [{"entry_i": 0, "exit_i": 199}]', df, "T", "1d")
    mid = [e for _, e in res.equity_curve[1:-1]]
    assert len(set(mid)) > 1, "equity was flat while a position was open"


def test_benchmark_curve_is_normalized_buy_and_hold(runner):
    df = candles(n=4, start=100.0, drift=0.0, seed=2)
    # Make the close path explicit; the benchmark must use closes rather than
    # the strategy's fills or the bar opens.
    df["close"] = [100.0, 110.0, 90.0, 125.0]
    result = runner.run("trades = []", df, "T", "1d",
                        options={"capital": 10_000})
    assert result.benchmark_curve == [
        [int(df.ts[0]), 10_000.0],
        [int(df.ts[1]), 11_000.0],
        [int(df.ts[2]), 9_000.0],
        [int(df.ts[3]), 12_500.0],
    ]


def test_the_account_cannot_be_spent_twice(runner):
    """Default sizing is the whole account; a second concurrent trade sizes
    off what is actually free, so equity can never be double counted."""
    res = runner.run(
        'trades = [{"entry_i": 5, "exit_i": 50}, {"entry_i": 10, "exit_i": 40}]',
        candles(), "T", "1d")
    assert res.trades[1].qty == 0.0


def test_window_options_select_bars(runner):
    df = candles()
    res = runner.run('trades = [{"entry_i": 0, "exit_i": len(df) - 1}]', df,
                     "T", "1d", options={"to": str(int(df.ts[99]))})
    assert res.trades[0].exit_ts == int(df.ts[99])


def test_empty_window_errors(runner):
    with pytest.raises(BacktestError, match="leaves no candles"):
        runner.run("trades = []", candles(), "T", "1d",
                   options={"from": "2099-01-01"})


def test_extended_stats_present_when_asked(runner):
    res = runner.run(TEMPLATE, candles(), "T", "1d",
                     options={"extended_stats": True})
    ext = res.stats["extended"]
    for key in ("var95", "sortino", "calmar", "annualizedReturn",
                "exposurePct", "avgBarsHeld"):
        assert key in ext


# ── research modes ───────────────────────────────────────────────────────

def test_montecarlo_is_deterministic_per_seed(runner):
    df = candles(n=500, seed=5)
    a = runner.montecarlo(TEMPLATE, df, runs=200, seed=7)
    b = runner.montecarlo(TEMPLATE, df, runs=200, seed=7)
    assert a == b
    assert a["type"] == "monte_carlo" and a["runs"] == 200
    assert a["finalEquity"]["p5"] <= a["finalEquity"]["p95"]


def test_montecarlo_refuses_a_strategy_with_no_trades(runner):
    with pytest.raises(BacktestError, match="no closed trades"):
        runner.montecarlo("trades = []", candles(), runs=10)


def test_walkforward_sweeps_params_and_scores_folds(runner):
    script = ('q = float(params.get("q", 1))\n'
              'trades = [{"entry_i": i, "exit_i": i + 1, "qty": q}\n'
              '          for i in range(0, len(df) - 1, 2)]')
    # Rising data: the biggest size always wins, so the sweep must pick it.
    df = candles(n=400, drift=0.5, seed=1)
    wf = runner.walkforward(script, df, params={"q": "1,3,5"}, folds=2)
    assert wf["type"] == "walkforward" and len(wf["folds"]) == 2
    assert all(f["bestParams"]["q"] == 5 for f in wf["folds"])
    assert all(math.isfinite(f["oosNetProfit"]) for f in wf["folds"])


def test_walkforward_needs_params(runner):
    with pytest.raises(BacktestError, match="at least one param grid"):
        runner.walkforward("trades = []", candles(), params={})


# ── the deadline ─────────────────────────────────────────────────────────

def test_runaway_strategy_is_stopped(runner):
    """A loop that never ends must not hold its worker for the life of the
    process.

    Measured against a real uvicorn before this existed: 45
    runaway backtests took /api/health from 4.7ms to a hard timeout and no
    worker was ever freed. Users write the loop by hand now, so an endless
    one is a matter of when, not if.
    """
    with pytest.raises(BacktestError, match="still running after"):
        runner.run("while True:\n    pass\ntrades = []", candles(),
                   "T", "1d", options={"timeout": 2})


def test_deadline_survives_a_strategy_that_swallows_exceptions(runner):
    """A bare `except:` inside the loop must not defeat the deadline."""
    script = ("import time\n"
              "end = time.time() + 30\n"
              "while time.time() < end:\n"
              "    try:\n"
              "        pass\n"
              "    except Exception:\n"
              "        pass\n"
              "trades = []")
    with pytest.raises(BacktestError, match="still running after"):
        runner.run(script, candles(), "T", "1d", options={"timeout": 2})


def test_normal_strategy_is_untouched_by_the_deadline(runner):
    """The guard must be invisible to a strategy that finishes."""
    res = runner.run(TEMPLATE, candles(n=500, seed=4), "T", "1d",
                     options={"timeout": 60})
    assert len(res.trades) > 0
    assert sum(t.pnl for t in res.trades) == pytest.approx(res.net_profit)
