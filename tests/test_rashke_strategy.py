from pathlib import Path

import numpy as np
import pandas as pd

from lse_terminal.backtest.runner import PythonRunner


def test_rashke_quantconnect_port_runs_on_lse_minute_contract():
    source = (Path(__file__).parents[1] / "rashke_lse.py").read_text(encoding="utf-8")
    clock = pd.date_range("2024-07-01 09:30", "2024-08-02 15:59",
                          freq="min", tz="America/New_York")
    clock = clock[
        (clock.weekday < 5)
        & (clock.time >= pd.Timestamp("09:30").time())
        & (clock.time < pd.Timestamp("16:00").time())
    ]
    ts = clock.astype("int64") // 1_000_000
    close = 18_000 + np.sin(np.arange(len(clock)) / 30.0) * 20
    candles = pd.DataFrame({
        "ts": ts, "open": close, "high": close + 1,
        "low": close - 1, "close": close, "volume": 1_000.0,
    })
    runner = PythonRunner()
    result = runner.run(source, candles, "NQ_F_1M", "1m")
    mnq = runner.run(source, candles, "MNQ_F_1M", "1m")

    assert result.engine == "python"
    assert result.plots["20-bar EMA"]
    assert all(len(point) == 2 for point in result.plots["20-bar EMA"])
    assert all(trade.point_value == 20.0 for trade in result.trades)
    assert all(trade.point_value == 2.0 for trade in mnq.trades)
    assert [(t.entry_ts, t.exit_ts) for t in result.trades] == [(t.entry_ts, t.exit_ts) for t in mnq.trades]
    assert len(result.trades) < 30  # prior-day qualification must gate entries
