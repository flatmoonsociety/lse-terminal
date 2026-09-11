"""The backtest engine contract.

A BacktestEngine takes a strategy script + candles and returns a typed
result: the equity curve, the trade ledger, and summary statistics. The
terminal renders these on the same chart stack the live view uses (equity as
a line, trades as markers on the candles) plus a stats strip.
"""

from __future__ import annotations

import hashlib
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

import pandas as pd


class BacktestError(Exception):
    """A strategy that failed to parse or run; message is user-facing."""


# ── The run pin ──────────────────────────────────────────────────────────
# A strategy names its own dataset with a `# run: EURUSD 1h` header line.
# Every runner (IDE RUN, workspace RUN, the assistant's local run_backtest,
# the agent-CLI tools) resolves the target from this line, so the numbers a
# strategy was delivered with are the numbers it reproduces later. Added
# after an assistant strategy tested on EURUSD was RUN on GOLD
# (the ambient chart pick): the cross-correlation degenerated to corr==1
# and it silently produced 0 trades instead of the delivered +$986.
_PIN_RE = re.compile(r"^\s*#\s*run(?:-on)?\s*:\s*(.+?)\s*$", re.IGNORECASE)
# Timeframes as the terminal spells them (1m, 30min, 4h, 1d, 1w, 1mo); a
# trailing token matching this splits off as the timeframe so dataset
# symbols containing spaces ("US Large Caps 20") keep working.
_PIN_TF_RE = re.compile(r"^\d+(?:s|m|min|h|d|w|mo)$", re.IGNORECASE)
# The pin lives in the header; scanning the whole file would let a
# commented-out line deep in the code silently retarget the run.
_PIN_SCAN_LINES = 12


def parse_run_pin(script: str) -> dict | None:
    """The strategy's own `# run:` target, or None if it has no pin."""
    for line in (script or "").splitlines()[:_PIN_SCAN_LINES]:
        m = _PIN_RE.match(line)
        if not m:
            continue
        symbol, timeframe = m.group(1), None
        parts = symbol.rsplit(None, 1)
        if len(parts) == 2 and _PIN_TF_RE.match(parts[1]):
            symbol, timeframe = parts[0], parts[1]
        return {"symbol": symbol, "timeframe": timeframe}
    return None


def run_pin_hash(script: str) -> str:
    """Identity of a strategy's CODE, invariant to its pin line and
    whitespace, so a script matches its tested run whether or not the pin
    was stamped on afterwards."""
    lines = [ln.rstrip() for ln in (script or "").splitlines()
             if not _PIN_RE.match(ln)]
    return hashlib.sha256(
        "\n".join(lines).strip().encode("utf-8", "replace")).hexdigest()[:16]


@dataclass
class Trade:
    entry_ts: int
    exit_ts: int | None
    direction: str          # "long" | "short"
    entry_price: float
    exit_price: float | None
    qty: float
    pnl: float
    pnl_pct: float
    bars_held: int


@dataclass
class BacktestResult:
    engine: str
    symbol: str
    timeframe: str
    initial_capital: float
    final_equity: float
    net_profit: float
    stats: dict = field(default_factory=dict)      # sharpe, drawdown, win_rate, ...
    trades: list[Trade] = field(default_factory=list)
    # Equity curve aligned to bars: [[ts, equity], ...].
    equity_curve: list[list[float]] = field(default_factory=list)
    # Buy-and-hold baseline aligned to the same bars, normalized to the
    # initial capital using the first/each bar close.
    benchmark_curve: list[list[float]] = field(default_factory=list)
    # Series the strategy declared via `plots`: {name: [[ts, value], ...]},
    # already validated and chart-ready (runner._collect_plots).
    plots: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        return {
            "engine": self.engine, "symbol": self.symbol,
            "timeframe": self.timeframe,
            "initial_capital": self.initial_capital,
            "final_equity": self.final_equity, "net_profit": self.net_profit,
            "stats": self.stats,
            "equity_curve": self.equity_curve,
            "benchmark_curve": self.benchmark_curve,
            "plots": self.plots,
            "trades": [
                {"entry_ts": t.entry_ts, "exit_ts": t.exit_ts,
                 "direction": t.direction, "entry_price": t.entry_price,
                 "exit_price": t.exit_price, "qty": t.qty, "pnl": t.pnl,
                 "pnl_pct": t.pnl_pct, "bars_held": t.bars_held}
                for t in self.trades
            ],
        }


class BacktestEngine(ABC):
    name: str = ""
    title: str = ""
    # The strategy language/format this engine speaks, for the UI editor.
    language: str = "text"

    @abstractmethod
    def run(self, script: str, candles: pd.DataFrame, symbol: str,
            timeframe: str, options: dict | None = None) -> BacktestResult:
        """Run ``script`` over ``candles`` (CANDLE_COLUMNS). Raise
        BacktestError on a bad strategy; let real bugs propagate."""

    def configured(self) -> bool:
        """False when the engine binary/runtime isn't available yet."""
        return True

    def template(self) -> str:
        """A starter strategy shown in a fresh editor."""
        return ""
