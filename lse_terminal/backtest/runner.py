"""Runs a plain-Python strategy script and measures what it did.

There is no framework here and nothing for the user to import. Their file is
ordinary Python; we execute it with the candles already in scope and read the
result back out of the namespace:

    # df is already defined. No imports of ours, no base class, no self.
    fast = df.close.ewm(span=9).mean()
    slow = df.close.ewm(span=21).mean()

    trades = []
    entry = None
    for i in range(1, len(df)):
        if entry is None and fast[i] > slow[i]:
            entry = i
        elif entry is not None and fast[i] < slow[i]:
            trades.append({"entry_i": entry, "exit_i": i, "dir": "long"})
            entry = None

Injected names:

* ``df``      the selected candles, a plain pandas DataFrame
  (ts, open, high, low, close, volume, plus any extra columns the dataset has)
* ``params``  a dict of overrides, empty on a normal run. Read defaults out of
  it (``fast = params.get("fast", 9)``) and walk-forward can then sweep the
  value without the script changing. This is the only reason it exists.
* ``data``    {name: DataFrame} of side datasets. The app attaches every
  imported series dataset (the bundled USYIELDS curve included), so a script
  can read data["USYIELDS"] with no setup; a file only loads if its name is
  actually read.

Read back:

* ``trades``  a list of dicts, the one required output.
* ``plots``   optional: a dict of name -> series, charted with the report so a
  run can SHOW what its filter saw. A value is a pandas Series / numpy array /
  list with one number per bar, or explicit [ts, value] pairs for a series on
  its own clock (a closed-trade equity track). Everything else in the
  namespace is ignored.

A trade dict needs an entry, an exit, and where in time each happened:

    {"entry_i": 10, "exit_i": 25, "dir": "long"}          bar indexes
    {"entry_ts": 1700000000, "exit_ts": 1700086400}       epoch seconds
    {"entry": 101.5, "exit": 104.0, "entry_i": 10, "exit_i": 25}

Keys are read liberally because this is the one place the user has to match us:
``dir``/``direction``/``side``; ``entry``/``entry_price``; ``exit``/
``exit_price``; ``qty``/``size``. Direction defaults to long. Prices default to
the open of the named bar, which is the honest fill for a decision made on the
bar before. Size defaults to the full account, compounding trade to trade;
give ``qty`` for an absolute quantity instead. ``point_value`` (default 1)
sets the monetary value of one price point per contract for futures.

We do the part after the run: sizing, commission, the per-bar equity curve,
drawdown, sharpe and the rest. That is deliberately ours, because it is the
part nobody wants to write twice and the part that is easy to get quietly wrong.
"""

from __future__ import annotations

import ctypes
import math
import os
import threading
import traceback
from collections.abc import Mapping

import numpy as np
import pandas as pd

from lse_terminal.backtest import research
from lse_terminal.backtest.contract import (
    BacktestEngine,
    BacktestError,
    BacktestResult,
    Trade,
)

_SCRIPT_FILENAME = "<strategy>"


class _DatasetMap(Mapping):
    """The `data` name a strategy sees: {name: DataFrame}, each file read
    on first access, then cached for the run. Lazy because the app now
    attaches the user's ENTIRE library to every run, candle datasets
    included (so the seeded starters and the assistant's cross-asset
    strategies work with zero attach steps); loading eagerly would tax
    every backtest with every file the user has ever imported, when a
    strategy typically reads one name or none."""

    def __init__(self, files: dict):
        self._files = dict(files)
        self._frames: dict = {}

    def __getitem__(self, name):
        if name not in self._frames:
            path = self._files[name]        # unknown name -> KeyError, as a dict would
            try:
                frame = pd.read_csv(path)
            except Exception as e:
                raise BacktestError(
                    f"dataset {name!r} failed to load: {e}") from e
            if "time" in frame.columns and "ts" not in frame.columns:
                frame["ts"] = (pd.to_numeric(frame["time"], errors="coerce")
                               // 1000).astype("int64")
            self._frames[name] = frame
        return self._frames[name]

    def __iter__(self):
        return iter(self._files)

    def __len__(self):
        return len(self._files)

# A strategy is now a hand-written loop, so a loop that never ends is a
# question of when, not if. Without a deadline the exec holds its worker
# thread for the life of the process: measured against a real
# uvicorn, 45 runaway backtests took /api/health from 4.7ms to a hard
# timeout, and nothing ever freed a worker. A subprocess with a hard
# timeout would solve this too, but the backtest needs the candles already
# in memory, so it gets a deadline in-thread instead.
_DEFAULT_TIMEOUT = float(os.environ.get("LSE_BACKTEST_TIMEOUT", "120"))


class _StrategyTimeout(Exception):
    """Raised INTO the executing thread when its deadline passes."""


# Explicit signature: the second argument is a PyObject*, and passing None
# for it means NULL, which is how a pending async exception is cleared.
_SET_ASYNC_EXC = ctypes.pythonapi.PyThreadState_SetAsyncExc
_SET_ASYNC_EXC.argtypes = (ctypes.c_ulong, ctypes.py_object)
_SET_ASYNC_EXC.restype = ctypes.c_int


def _raise_in_thread(thread_id: int, exc) -> int:
    """Deliver an exception to a thread at its next bytecode boundary.

    The only way CPython lets you interrupt a pure-Python loop. It cannot
    break into a long C call (a big numpy op finishes first), which is fine:
    those terminate on their own. Returns the number of threads modified.
    """
    return _SET_ASYNC_EXC(ctypes.c_ulong(thread_id), exc)


class _Deadline:
    """Interrupts the calling thread if the strategy outlives its deadline.

    Re-arms, because a strategy wrapping its loop in a bare `except:` would
    otherwise swallow the interrupt and carry on holding the worker forever.
    After the retries are spent the thread is left alone rather than spun on;
    the run is reported as failed either way.

    The lock is what makes teardown safe: __exit__ takes it and sets _done,
    so a timer thread either fires entirely before that point or sees _done
    and does nothing. No attempt is made to CLEAR an already-delivered
    exception (an earlier version tried, via a second ctypes binding, and
    segfaulted the interpreter); instead the caller catches _StrategyTimeout
    around the whole run, so a shot delivered at the boundary still lands as
    a clean timeout error rather than leaking into unrelated work.
    """

    def __init__(self, seconds: float, retries: int = 5):
        self.seconds = float(seconds)
        self.retries = retries
        self.thread_id = threading.get_ident()
        self.fired = False
        self._timer = None
        self._lock = threading.Lock()
        self._done = False

    def _fire(self):
        with self._lock:
            if self._done:
                return
            self.fired = True
            _raise_in_thread(self.thread_id, _StrategyTimeout)
            self.retries -= 1
            if self.retries > 0:
                self._arm(2.0)

    def _arm(self, seconds):
        self._timer = threading.Timer(seconds, self._fire)
        self._timer.daemon = True
        self._timer.start()

    def __enter__(self):
        if self.seconds > 0:
            self._arm(self.seconds)
        return self

    def __exit__(self, *exc):
        with self._lock:
            self._done = True
            if self._timer is not None:
                self._timer.cancel()
        return False


# One year in seconds, for annualizing per-bar statistics.
_YEAR_SECONDS = 365.25 * 86400

# The blank-file starter. It is deliberately the smallest thing that is still
# a real strategy rather than a demo: a trend signal is two lines, and the
# other four are the ones that decide whether it makes money (next-bar fills,
# a horizon measured in time, and size set by volatility). Anyone who copies
# this scaffold inherits those three habits. The seven worked examples in the
# workspace go further; this is the empty page.
TEMPLATE = '''# Plain Python. `df` is already here: a pandas DataFrame with
# ts, open, high, low, close, volume. Nothing to import from us.
#
# Leave a list called `trades` and the terminal does the rest: sizing,
# commission, equity curve, drawdown, sharpe, walk-forward, monte carlo.
import numpy as np

target_vol = float(params.get("target_vol", 0.15))   # annualised vol target
lev_cap = float(params.get("lev_cap", 3.0))
CAPITAL = 100_000.0

# Horizons in DAYS, converted with this dataset's own bar spacing: a lookback
# written in bars means one thing on hourly gold and something else entirely
# on daily stocks.
bar_s = float(np.median(np.diff(df["ts"].to_numpy()[:20000])))
bars_per_day = max(1.0, 86400.0 / bar_s)
fast = max(3, int(round(float(params.get("fast_days", 5)) * bars_per_day)))
slow = max(3, int(round(float(params.get("slow_days", 20)) * bars_per_day)))

close = df["close"]
up = (close.ewm(span=fast, adjust=False).mean()
      > close.ewm(span=slow, adjust=False).mean()).to_numpy()

# Size so each entry targets a constant annualised volatility: the same
# signal risks the same amount in a calm market and a violent one.
ret = close.pct_change()
years = (df["ts"] - df["ts"].iloc[0]) / (365.25 * 86400.0)
bars_per_year = (np.arange(len(df)) + 1.0) / np.maximum(years.to_numpy(), 1e-9)
ann_vol = ret.rolling(slow).std().to_numpy() * np.sqrt(bars_per_year)
with np.errstate(divide="ignore", invalid="ignore"):
    leverage = np.minimum(target_vol / ann_vol, lev_cap)

px = close.to_numpy()
trades = []
entry_i = None
qty = 0.0

for i in range(slow + 1, len(df) - 1):
    if entry_i is None:
        if up[i] and np.isfinite(leverage[i]) and leverage[i] > 0:
            entry_i = i + 1                  # decide at i, fill at i+1's open
            qty = CAPITAL * leverage[i] / px[i]
    elif not up[i]:
        trades.append({"entry_i": entry_i, "exit_i": i + 1,
                       "dir": "long", "qty": float(qty)})
        entry_i = None

# Still open at the end? Close it on the last bar so it counts.
if entry_i is not None and entry_i < len(df) - 1:
    trades.append({"entry_i": entry_i, "exit_i": len(df) - 1,
                   "dir": "long", "qty": float(qty)})

# Optional: leave `plots` next to `trades` (one value per bar) and the run
# report charts each series, so you SEE the sizing regime you traded.
plots = {"annualised vol": ann_vol, "leverage": leverage}
'''


def _parse_when(value) -> float | None:
    """from/to option -> epoch seconds. Accepts YYYY-MM-DD (anything pandas
    can parse) or epoch milliseconds, unchanged from the previous engine so
    saved UI date ranges keep working."""
    if value is None or value == "":
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        try:
            return pd.Timestamp(str(value), tz="UTC").timestamp()
        except (ValueError, TypeError):
            raise BacktestError(f"bad date in options: {value!r}") from None
    # Anything past the year 5138 in seconds has to be milliseconds.
    return num / 1000.0 if num > 1e11 else num


def _user_lineno(exc: BaseException) -> int | None:
    """Deepest frame belonging to the user's script, for the error message."""
    lineno = None
    for frame in traceback.extract_tb(exc.__traceback__):
        if frame.filename == _SCRIPT_FILENAME:
            lineno = frame.lineno
    return lineno


def _pick(d: dict, *names, default=None):
    """First present key out of several spellings; see the module docstring
    for why the trade dict accepts more than one name per field."""
    for n in names:
        if n in d and d[n] is not None:
            return d[n]
    return default


class PythonRunner(BacktestEngine):
    """Executes the user's script and measures the trades it produced."""

    name = "python"
    title = "Python"
    language = "python"

    def template(self) -> str:
        return TEMPLATE

    # ── the run ───────────────────────────────────────────────────────

    def run(self, script: str, candles: pd.DataFrame, symbol: str,
            timeframe: str, options: dict | None = None,
            data_files: dict | None = None) -> BacktestResult:
        options = options or {}
        if candles is None or len(candles) == 0:
            raise BacktestError("no candles to backtest on")

        df = self._window(candles, options)
        if len(df) == 0:
            raise BacktestError("the from/to window leaves no candles")

        capital = float(options.get("capital",
                                    options.get("initial_capital", 100_000)))
        commission_pct = float(options.get("commission_pct", 0) or 0)

        # Per-run deadline; walk-forward therefore bounds each fold, not the
        # whole sweep, which is the behaviour a param grid needs.
        timeout = float(options.get("timeout") or _DEFAULT_TIMEOUT)
        raw, plots = self._execute(
            script, df, options.get("params") or {},
            self._load_datasets(data_files), timeout,
            symbol=symbol, timeframe=timeframe)
        trades = self._normalize(raw, df)
        equity_curve, final_equity, bars_in_market = self._account(
            trades, df, capital, commission_pct / 100.0)
        benchmark_curve = self._benchmark_curve(df, capital)

        stats = self._stats(trades, equity_curve, capital, final_equity,
                            bars_in_market, bool(options.get("extended_stats")))
        return BacktestResult(
            engine=self.name, symbol=symbol, timeframe=timeframe,
            initial_capital=capital, final_equity=final_equity,
            net_profit=final_equity - capital,
            stats=stats, trades=trades, equity_curve=equity_curve,
            benchmark_curve=benchmark_curve, plots=plots,
        )

    @staticmethod
    def _benchmark_curve(df: pd.DataFrame, capital: float) -> list[list[float]]:
        """Normalize a buy-and-hold close series to the starting capital.

        The first close is the baseline and each later point is marked at its
        close. This is a visual comparison only; it never affects strategy
        accounting, fees, or the reported final equity.
        """
        if df is None or len(df) == 0:
            return []
        closes = df["close"].to_numpy(dtype="float64")
        first = float(closes[0])
        if not math.isfinite(first) or first == 0.0:
            return []
        ts = df["ts"].to_numpy(dtype="int64")
        return [[int(t), float(capital * (close / first))]
                for t, close in zip(ts, closes)
                if math.isfinite(float(close))]

    def _execute(self, script: str, df: pd.DataFrame, params: dict,
                 datasets: dict,
                 timeout: float = _DEFAULT_TIMEOUT,
                 symbol: str | None = None,
                 timeframe: str | None = None) -> tuple[list, dict]:
        """Run the script with the data in scope; hand back its `trades`
        and its optional `plots`, chart-ready.

        Same trust model as custom indicators: this is the user's own Python
        on the user's own machine, so a plain exec is the honest thing to do.
        """
        try:
            code = compile(script, _SCRIPT_FILENAME, "exec")
        except SyntaxError as e:
            raise BacktestError(
                f"syntax error at line {e.lineno}: {e.msg}") from None

        # A fresh __main__-ish namespace so `if __name__ == "__main__"` blocks
        # in a script the user also runs standalone still fire here.
        ns: dict = {
            "__name__": "__main__",
            "df": df,
            "params": dict(params),
            "data": datasets,
            # Selected chart context, available to instrument-aware strategy
            # wrappers.  Optional args preserve direct _execute callers.
            "symbol": symbol,
            "timeframe": timeframe,
        }
        try:
            # The deadline is the only thing standing between a `while True`
            # and a worker thread lost for the life of the process.
            with _Deadline(timeout):
                exec(code, ns)
        except _StrategyTimeout:
            raise BacktestError(
                f"the strategy was still running after {timeout:.0f}s and was "
                "stopped. A loop that never ends is the usual cause: check "
                "that every `while` can finish and that an index always "
                "advances. Raise the limit with the LSE_BACKTEST_TIMEOUT "
                "environment variable if the run is genuinely this long."
            ) from None
        except Exception as e:
            line = _user_lineno(e)
            where = f" (line {line})" if line else ""
            raise BacktestError(f"{type(e).__name__}: {e}{where}") from e

        if "trades" not in ns:
            raise BacktestError(
                "the script finished without leaving a `trades` list. Append "
                "a dict per trade, e.g. "
                'trades.append({"entry_i": 10, "exit_i": 25, "dir": "long"})')
        out = ns["trades"]
        if isinstance(out, pd.DataFrame):
            out = out.to_dict("records")
        if not isinstance(out, (list, tuple)):
            raise BacktestError(
                f"`trades` must be a list of dicts, got {type(out).__name__}")
        return list(out), self._collect_plots(ns, df)

    _MAX_PLOT_PANES = 8
    _MAX_PLOT_POINTS = 20_000

    @classmethod
    def _collect_plots(cls, ns: dict, df: pd.DataFrame) -> dict:
        """Optional `plots` dict -> {name: [[ts, value], ...]}, chart-ready.

        A value is a pandas Series / numpy array / list with one number per
        bar (paired with the bars' own timestamps), or explicit [ts, value]
        pairs for a series on its own clock. Non-finite points are dropped
        and long series strided down to _MAX_PLOT_POINTS: these panes are
        diagnostic charts, not data export, and eight full-length hourly
        series would put megabytes of JSON in every run's response.
        """
        raw = ns.get("plots")
        if raw is None:
            return {}
        if not isinstance(raw, dict):
            raise BacktestError(
                f"`plots` must be a dict of name -> series, "
                f"got {type(raw).__name__}")
        if len(raw) > cls._MAX_PLOT_PANES:
            raise BacktestError(
                f"plots: {len(raw)} panes declared, the report shows at most "
                f"{cls._MAX_PLOT_PANES}; drop the ones you are not reading")
        ts = df["ts"].to_numpy(dtype="float64")
        out: dict = {}
        for name, val in raw.items():
            if isinstance(val, pd.Series):
                val = val.to_numpy()
            try:
                arr = np.asarray(val, dtype=float)
            except (TypeError, ValueError):
                raise BacktestError(
                    f"plots[{name!r}]: values must be numbers") from None
            if arr.size == 0:
                # A pair series with nothing in it yet (no closed trades) is
                # an empty pane, not a shape error.
                out[str(name)[:60]] = []
                continue
            if arr.ndim == 2 and arr.shape[1] == 2:
                pairs = arr                      # [ts, value], own clock
            elif arr.ndim == 1 and len(arr) == len(df):
                pairs = np.column_stack([ts, arr])
            else:
                raise BacktestError(
                    f"plots[{name!r}]: give one value per bar ({len(df)}) "
                    f"or [ts, value] pairs; got shape {arr.shape}")
            pairs = pairs[np.isfinite(pairs).all(axis=1)]
            # Charts need ascending unique timestamps; a series appended out
            # of order should still plot, not error.
            pairs = pairs[np.argsort(pairs[:, 0], kind="stable")]
            if len(pairs) > 1:
                keep = np.ones(len(pairs), dtype=bool)
                keep[1:] = np.diff(pairs[:, 0]) > 0
                pairs = pairs[keep]
            stride = max(1, math.ceil(len(pairs) / cls._MAX_PLOT_POINTS))
            out[str(name)[:60]] = [[int(t), float(v)]
                                   for t, v in pairs[::stride]]
        return out

    # ── trades in, trades normalized ──────────────────────────────────

    def _normalize(self, raw: list, df: pd.DataFrame) -> list[Trade]:
        """User dicts -> Trade records, with bar indexes resolved.

        Prices are optional: a trade that names only its bars fills at those
        bars' opens, which is the correct price for a decision taken on the
        previous bar's close.
        """
        n = len(df)
        ts = df["ts"].to_numpy(dtype="int64")
        opens = df["open"].to_numpy(dtype="float64")
        out: list[Trade] = []

        for k, t in enumerate(raw):
            if not isinstance(t, dict):
                raise BacktestError(
                    f"trade {k} is a {type(t).__name__}, expected a dict")

            entry_i = self._bar_index(t, "entry", ts, n, k)
            exit_i = self._bar_index(t, "exit", ts, n, k)
            if exit_i < entry_i:
                raise BacktestError(
                    f"trade {k} exits at bar {exit_i}, before its entry at "
                    f"bar {entry_i}")

            direction = str(_pick(t, "dir", "direction", "side",
                                  default="long")).lower()
            if direction in ("buy", "l", "1"):
                direction = "long"
            elif direction in ("sell", "s", "-1"):
                direction = "short"
            if direction not in ("long", "short"):
                raise BacktestError(
                    f"trade {k} has direction {direction!r}; use "
                    '"long" or "short"')

            entry_price = float(_pick(t, "entry", "entry_price",
                                      default=opens[entry_i]))
            exit_price = float(_pick(t, "exit", "exit_price",
                                     default=opens[exit_i]))
            if not (math.isfinite(entry_price) and math.isfinite(exit_price)):
                raise BacktestError(f"trade {k} has a non-finite price")
            if entry_price <= 0:
                raise BacktestError(
                    f"trade {k} has entry price {entry_price}; must be > 0")

            raw_point_value = _pick(t, "point_value", "pointValue",
                                    "multiplier", default=1.0)
            try:
                point_value = float(raw_point_value)
            except (TypeError, ValueError):
                raise BacktestError(
                    f"trade {k} has point_value {raw_point_value!r}; must be a finite value > 0") from None
            if not math.isfinite(point_value) or point_value <= 0:
                raise BacktestError(
                    f"trade {k} has point_value {point_value}; must be a finite value > 0")

            qty = _pick(t, "qty", "size")
            out.append(Trade(
                entry_ts=int(ts[entry_i]), exit_ts=int(ts[exit_i]),
                direction=direction,
                entry_price=entry_price, exit_price=exit_price,
                qty=float(qty) if qty is not None else float("nan"),
                pnl=0.0, pnl_pct=0.0,          # filled by _account
                bars_held=int(exit_i - entry_i),
                point_value=point_value,
            ))
            # The bar indexes are needed by the accounting pass and are not
            # part of the public Trade shape, so they ride alongside.
            out[-1]._entry_i = entry_i        # type: ignore[attr-defined]
            out[-1]._exit_i = exit_i          # type: ignore[attr-defined]

        # Time order, so the account compounds in the order things happened.
        out.sort(key=lambda tr: (tr._entry_i, tr._exit_i))  # type: ignore
        return out

    @staticmethod
    def _bar_index(t: dict, side: str, ts: np.ndarray, n: int, k: int) -> int:
        """Resolve a trade's bar from an index or a timestamp."""
        idx = _pick(t, f"{side}_i", f"{side}_bar", f"{side}_index")
        if idx is not None:
            i = int(idx)
            if not 0 <= i < n:
                raise BacktestError(
                    f"trade {k} {side}_i is {i}, outside the {n} bars tested")
            return i

        when = _pick(t, f"{side}_ts", f"{side}_time")
        if when is None:
            raise BacktestError(
                f"trade {k} has no {side}_i (bar index) or {side}_ts "
                "(epoch seconds); one of them is needed to place the trade "
                "in time")
        w = float(when)
        if w > 1e11:            # milliseconds, same rule as the date options
            w /= 1000.0
        # Nearest bar at or before the timestamp: a fill cannot happen on a
        # bar that has not started yet.
        i = int(np.searchsorted(ts, w, side="right")) - 1
        return max(0, min(n - 1, i))

    # ── the accounting ────────────────────────────────────────────────

    def _account(self, trades: list[Trade], df: pd.DataFrame, capital: float,
                 commission_rate: float) -> tuple[list[list[float]], float, int]:
        """Size the trades, charge commission, and build the equity curve.

        Sizing default is the whole account, compounding trade to trade, so a
        strategy's result does not silently depend on a quantity the user never
        chose. An explicit qty overrides it.

        Overlapping trades are allowed (the script may hold several at once);
        each is sized off the cash free at its own entry, so the account can
        never be spent twice.
        """
        n = len(df)
        ts = df["ts"].to_numpy(dtype="int64")
        close = df["close"].to_numpy(dtype="float64")

        # Per-bar realized cash change and open exposure, walked once.
        realized = np.zeros(n + 1, dtype="float64")
        open_at = [[] for _ in range(n)]     # trades live on each bar

        cash = capital
        # Entry order is already sorted; committed tracks capital tied up in
        # positions that have not closed yet, so a second concurrent trade
        # sizes off what is actually free.
        events: list[tuple[int, int, str]] = []
        for k, t in enumerate(trades):
            events.append((t._entry_i, k, "entry"))    # type: ignore
            events.append((t._exit_i, k, "exit"))      # type: ignore
        # Close existing positions first so their capital can be reused. A
        # same-bar round trip must still enter before its own exit.
        events.sort(key=lambda e: (
            e[0], 0 if e[2] == "exit" and trades[e[1]]._entry_i < e[0] else 1,
            e[1], 0 if e[2] == "entry" else 1))

        committed = 0.0
        sized: dict[int, float] = {}
        for bar, k, kind in events:
            t = trades[k]
            if kind == "entry":
                free = max(0.0, cash - committed)
                if math.isnan(t.qty):
                    qty = free / (t.entry_price * t.point_value)
                else:
                    qty = t.qty
                if not math.isfinite(qty) or qty <= 0:
                    qty = 0.0
                sized[k] = qty
                notional = t.entry_price * qty * t.point_value
                committed += notional
                fee = notional * commission_rate
                cash -= fee
                realized[bar] -= fee
            else:
                qty = sized.get(k, 0.0)
                if t.direction == "long":
                    gross = (t.exit_price - t.entry_price) * qty * t.point_value
                else:
                    gross = (t.entry_price - t.exit_price) * qty * t.point_value
                fee = t.exit_price * qty * t.point_value * commission_rate
                entry_fee = t.entry_price * qty * t.point_value * commission_rate
                cash += gross - fee
                realized[bar] += gross - fee
                committed -= t.entry_price * qty * t.point_value
                notional = t.entry_price * qty * t.point_value
                t.qty = float(qty)
                t.pnl = float(gross - fee - entry_fee)
                t.pnl_pct = float(t.pnl / notional * 100.0) if notional else 0.0

        for k, t in enumerate(trades):
            for b in range(t._entry_i, t._exit_i):       # type: ignore
                open_at[b].append(k)

        # Equity per bar: realized cash so far, plus every open position marked
        # to that bar's close. Mark to market matters because drawdown measured
        # only at trade exits understates what the account actually went through.
        equity_curve: list[list[float]] = []
        running = capital
        bars_in_market = 0
        for i in range(n):
            running += realized[i]
            unreal = 0.0
            for k in open_at[i]:
                t = trades[k]
                qty = sized.get(k, 0.0)
                if t.direction == "long":
                    unreal += (close[i] - t.entry_price) * qty * t.point_value
                else:
                    unreal += (t.entry_price - close[i]) * qty * t.point_value
            if open_at[i]:
                bars_in_market += 1
            equity_curve.append([int(ts[i]), float(running + unreal)])

        final_equity = float(running)
        return equity_curve, final_equity, bars_in_market

    # ── research modes ────────────────────────────────────────────────
    # These are why the terminal exists rather than a bare python file. A
    # single backtest is one sample of one ordering; these two say how much
    # of it was luck.

    def montecarlo(self, script: str, candles: pd.DataFrame,
                   runs: int = 1000, seed: int = 42,
                   options: dict | None = None,
                   data_files: dict | None = None) -> dict:
        res = self.run(script, candles, "", "", options=options,
                       data_files=data_files)
        pnls = [t.pnl for t in res.trades if t.pnl is not None]
        try:
            return research.monte_carlo(pnls, res.initial_capital, int(runs),
                                        int(seed), res.net_profit)
        except ValueError as e:
            raise BacktestError(f"montecarlo: {e}") from None

    def walkforward(self, script: str, candles: pd.DataFrame,
                    params: dict[str, str], folds: int = 4, train: float = 0.7,
                    metric: str = "netProfit",
                    options: dict | None = None,
                    data_files: dict | None = None) -> dict:
        """Re-fit on each training window, measure on the untouched window
        after it. The script reads its knobs from `params`, which is the only
        reason that name is injected."""
        import itertools

        options = dict(options or {})
        if candles is None or len(candles) == 0:
            raise BacktestError("no candles to backtest on")
        # from/to bounds WHICH BARS the analysis sees; folds are built inside
        # that window, so the keys are stripped before the per-fold runs.
        df = self._window(candles, options)
        options.pop("from", None)
        options.pop("to", None)

        n = len(df)
        folds = int(folds)
        train = float(train)
        if folds < 1:
            raise BacktestError("folds must be >= 1")
        if not 0.0 < train < 1.0:
            raise BacktestError("train must be between 0 and 1 (exclusive)")
        if metric not in ("netProfit", "profitFactor", "winRate", "avgTrade"):
            raise BacktestError(f"unknown metric {metric!r}: netProfit, "
                                "profitFactor, winRate, avgTrade")
        if not params:
            raise BacktestError(
                "walkforward needs at least one param grid, and the script "
                'must read that name out of `params`, e.g. '
                'fast = params.get("fast", 9)')
        try:
            grids = [(name, research.expand_param_spec(str(spec)))
                     for name, spec in params.items()]
        except ValueError as e:
            raise BacktestError(f"param grid: {e}") from None

        combo_count = 1
        for _, vals in grids:
            combo_count *= len(vals)
        if combo_count > 500:
            raise BacktestError(f"{combo_count} combos exceeds the cap of "
                                "500; widen your steps")
        names = [g[0] for g in grids]
        combos = [list(zip(names, vs))
                  for vs in itertools.product(*[g[1] for g in grids])]

        oos_len = int(math.floor(n * (1.0 - train) / folds))
        if oos_len < 1:
            raise BacktestError("not enough bars for that many folds")
        train_len = int(math.floor(oos_len * train / (1.0 - train) + 0.5))
        first_test_start = n - folds * oos_len
        if train_len < 1 or first_test_start < train_len:
            raise BacktestError(
                "not enough bars for the requested train fraction")

        def one(window: pd.DataFrame, combo):
            opts = {**options, "params": dict(combo)}
            res = self.run(script, window.reset_index(drop=True), "", "",
                           options=opts, data_files=data_files)
            pf = res.stats.get("profitFactor")
            vals = {"netProfit": res.net_profit,
                    "profitFactor": (math.inf if pf == "__+Inf__"
                                     else float(pf or 0.0)),
                    "winRate": float(res.stats.get("winRate") or 0.0),
                    "avgTrade": float(res.stats.get("avgTrade") or 0.0)}
            return (vals[metric], res.net_profit,
                    int(res.stats.get("totalTrades") or 0))

        out_folds, effs = [], []
        total_oos, total_oos_trades = 0.0, 0
        for k in range(folds):
            test_start = first_test_start + k * oos_len
            test_end = test_start + oos_len - 1
            train_start = test_start - train_len
            train_end = test_start - 1
            best = None
            last_err = None
            for ci, combo in enumerate(combos):
                try:
                    m, net, _ = one(df.iloc[train_start:train_end + 1], combo)
                except BacktestError as e:
                    if len(combos) == 1:
                        raise
                    last_err = e     # a contract error fails every combo the
                    continue         # same way; surface it, not a generic line
                if math.isnan(m):
                    continue
                if best is None or m > best[1]:
                    best = (ci, m, net)
            if best is None:
                raise BacktestError(
                    f"fold {k}: every combo failed or produced no usable "
                    "metric" + (f" (last error: {last_err})" if last_err else ""))
            best_ci, train_metric, train_net = best
            _, oos_net, oos_trades = one(df.iloc[test_start:test_end + 1],
                                         combos[best_ci])
            # Efficiency: out-of-sample profit per bar against in-sample profit
            # per bar. Below ~1 means the fit did not survive contact with
            # unseen data, which is the whole point of running this.
            eff = ((oos_net / oos_len) / (train_net / train_len)
                   if train_net > 0.0 else math.nan)
            if math.isfinite(eff):
                effs.append(eff)
            total_oos += oos_net
            total_oos_trades += oos_trades
            out_folds.append({
                "fold": k,
                "trainStart": train_start, "trainEnd": train_end,
                "testStart": test_start, "testEnd": test_end,
                "bestParams": {name: v for name, v in combos[best_ci]},
                "trainMetric": research.jnum(train_metric),
                "trainNetProfit": train_net,
                "oosNetProfit": oos_net, "oosTrades": oos_trades,
                "efficiency": research.jnum(eff),
            })
        return {"type": "walkforward", "metric": metric,
                "combosPerFold": len(combos), "folds": out_folds,
                "totalOosNetProfit": total_oos,
                "totalOosTrades": total_oos_trades,
                "meanEfficiency": research.jnum(sum(effs) / len(effs)
                                                if effs else math.nan)}

    # ── options ───────────────────────────────────────────────────────

    @staticmethod
    def _window(candles: pd.DataFrame, options: dict) -> pd.DataFrame:
        df = candles
        start = _parse_when(options.get("from"))
        end = _parse_when(options.get("to"))
        if start is not None:
            df = df[df["ts"] >= start]
        if end is not None:
            df = df[df["ts"] <= end]
        return df.reset_index(drop=True)

    @staticmethod
    def _load_datasets(data_files: dict | None) -> "_DatasetMap":
        """Attached side datasets -> {name: DataFrame} on the `data` name."""
        return _DatasetMap(data_files or {})

    # ── stats (key names unchanged, the UI strip reads these) ─────────

    @staticmethod
    def _stats(trades: list[Trade], equity_curve: list[list[float]],
               capital: float, final_equity: float, bars_in_market: int,
               extended: bool) -> dict:
        pnls = [t.pnl for t in trades]
        wins = [p for p in pnls if p > 0]
        losses = [p for p in pnls if p <= 0]
        gross_profit = float(sum(wins))
        gross_loss = float(sum(losses))     # negative sum, kept for continuity

        eq = np.array([e for _, e in equity_curve], dtype="float64")
        peak = np.maximum.accumulate(eq) if len(eq) else eq
        dd_abs = float((peak - eq).max()) if len(eq) else 0.0
        with np.errstate(divide="ignore", invalid="ignore"):
            dd_pct_series = np.where(peak > 0, (peak - eq) / peak, 0.0)
        dd_pct = float(dd_pct_series.max() * 100.0) if len(eq) else 0.0

        # Per-bar returns annualized off the median bar spacing, so any
        # timeframe (or irregular imported data) gets a sane Sharpe.
        rets = np.diff(eq) / eq[:-1] if len(eq) > 1 else np.array([])
        rets = rets[np.isfinite(rets)]
        ts_arr = np.array([t for t, _ in equity_curve], dtype="float64")
        bar_s = float(np.median(np.diff(ts_arr))) if len(ts_arr) > 1 else 3600.0
        bars_per_year = _YEAR_SECONDS / bar_s if bar_s > 0 else 8760.0
        if len(rets) > 1 and rets.std(ddof=1) > 0:
            sharpe = float(rets.mean() / rets.std(ddof=1)
                           * math.sqrt(bars_per_year))
        else:
            sharpe = 0.0

        max_consec_wins = max_consec_losses = cw = cl = 0
        for p in pnls:
            if p > 0:
                cw, cl = cw + 1, 0
            else:
                cl, cw = cl + 1, 0
            max_consec_wins = max(max_consec_wins, cw)
            max_consec_losses = max(max_consec_losses, cl)

        if gross_loss < 0:
            profit_factor = gross_profit / abs(gross_loss)
        elif gross_profit > 0:
            profit_factor = "__+Inf__"      # JSON-safe infinity marker
        else:
            profit_factor = 0.0

        stats = {
            "grossProfit": gross_profit,
            "grossLoss": gross_loss,
            "totalTrades": len(trades),
            "winningTrades": len(wins),
            "losingTrades": len(losses),
            "winRate": (len(wins) / len(trades) * 100.0) if trades else 0.0,
            "profitFactor": profit_factor,
            "maxDrawdown": dd_abs,
            "maxDrawdownPct": dd_pct,
            "sharpeRatio": sharpe,
            "avgTrade": (sum(pnls) / len(pnls)) if pnls else 0.0,
            "avgWin": (gross_profit / len(wins)) if wins else 0.0,
            "avgLoss": (gross_loss / len(losses)) if losses else 0.0,
            "largestWin": max(wins) if wins else 0.0,
            "largestLoss": min(losses) if losses else 0.0,
            "maxConsecWins": max_consec_wins,
            "maxConsecLosses": max_consec_losses,
        }

        if extended:
            years = (len(eq) / bars_per_year) if bars_per_year else 0.0
            if years > 0 and capital > 0 and final_equity > 0:
                ann_return = ((final_equity / capital) ** (1 / years) - 1) * 100.0
            else:
                ann_return = 0.0
            neg = rets[rets < 0]
            if len(rets) > 1 and len(neg) and neg.std(ddof=1) > 0:
                sortino = float(rets.mean() / neg.std(ddof=1)
                                * math.sqrt(bars_per_year))
            else:
                sortino = 0.0
            stats["extended"] = {
                "var95": float(-np.percentile(rets, 5)) if len(rets) else 0.0,
                "var99": float(-np.percentile(rets, 1)) if len(rets) else 0.0,
                "cvar95": (float(-rets[rets <= np.percentile(rets, 5)].mean())
                           if len(rets) else 0.0),
                "cvar99": (float(-rets[rets <= np.percentile(rets, 1)].mean())
                           if len(rets) else 0.0),
                "sortino": sortino,
                "calmar": (ann_return / dd_pct) if dd_pct > 0 else 0.0,
                "annualizedReturn": ann_return,
                "annualizedVol": (float(rets.std(ddof=1)
                                        * math.sqrt(bars_per_year) * 100.0)
                                  if len(rets) > 1 else 0.0),
                "exposurePct": (round(bars_in_market / len(eq) * 100)
                                if len(eq) else 0),
                "avgBarsHeld": (sum(t.bars_held for t in trades) / len(trades)
                                if trades else 0.0),
            }
        return stats
