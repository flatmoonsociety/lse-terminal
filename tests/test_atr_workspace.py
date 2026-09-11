import pytest
import numpy as np
import pandas as pd
from fastapi.testclient import TestClient

from lse_terminal.backtest.atr_phase import STARTER
from lse_terminal.backtest.starters import STARTERS
from lse_terminal.engine.server import create_app
from lse_terminal.backtest.runner import PythonRunner
from lse_terminal.backtest.contract import BacktestError


ATR_PATH = "strategies/atr_normalized_phase_momentum.py"


def test_fresh_workspace_includes_atr_strategy(tmp_path, monkeypatch):
    monkeypatch.setenv("LSE_TERMINAL_CONFIG_DIR", str(tmp_path))
    client = TestClient(create_app(), base_url="http://127.0.0.1")
    response = client.get("/api/ws-files")
    assert response.status_code == 200
    paths = {item["path"] for item in response.json()["files"]}
    assert paths == {f"strategies/{name}" for name, _ in STARTERS}
    assert client.get("/api/ws-files/read", params={"path": ATR_PATH}).json()["content"] == STARTER


@pytest.mark.parametrize("edited_atr", [False, True])
def test_existing_workspace_gets_atr_once_without_overwriting(tmp_path, monkeypatch, edited_atr):
    monkeypatch.setenv("LSE_TERMINAL_CONFIG_DIR", str(tmp_path))
    strategies = tmp_path / "workspace" / "strategies"
    strategies.mkdir(parents=True)
    custom = strategies / "my_strategy.py"
    custom.write_text("# my existing strategy\n", encoding="utf-8")
    atr = tmp_path / "workspace" / ATR_PATH
    if edited_atr:
        atr.write_text("# my edited ATR strategy\n", encoding="utf-8")
    expected = "# my edited ATR strategy\n" if edited_atr else STARTER

    client = TestClient(create_app(), base_url="http://127.0.0.1")
    response = client.get("/api/ws-files")
    assert response.status_code == 200
    assert {item["path"] for item in response.json()["files"]} == {
        "strategies/my_strategy.py", ATR_PATH,
    }
    assert custom.read_text(encoding="utf-8") == "# my existing strategy\n"
    assert atr.read_text(encoding="utf-8") == expected

    atr.write_text("# edited after installation\n", encoding="utf-8")
    assert client.get("/api/ws-files").status_code == 200
    assert atr.read_text(encoding="utf-8") == "# edited after installation\n"

    # Even an intentionally emptied workspace stays empty on the next open.
    for path in (ATR_PATH, "strategies/my_strategy.py"):
        assert client.post("/api/ws-files/delete", json={"path": path}).status_code == 200
    reopened = TestClient(create_app(), base_url="http://127.0.0.1")
    assert reopened.get("/api/ws-files").json()["files"] == []


def test_atr_aggregated_minute_plots_use_their_own_clock():
    """Ten-minute aggregation shortens the source frame; plots must therefore
    be explicit timestamp/value pairs rather than arrays sized like df."""
    count = 1_200
    # Source kernel consumes exact minute opens; 1_700_000_040 is UTC-minute aligned.
    ts = np.arange(count, dtype="int64") * 60 + 1_700_000_040
    close = 17_000 + np.cumsum(np.sin(np.arange(count) / 11.0))
    candles = pd.DataFrame({"ts": ts, "open": close, "high": close + 1,
                            "low": close - 1, "close": close,
                            "volume": np.ones(count)})
    result = PythonRunner().run(STARTER, candles, "NQ", "1m")
    assert all(len(points) < count for points in result.plots.values())
    assert all(points and len(points[0]) == 2 for points in result.plots.values())


def test_atr_nq_and_mnq_share_signals_but_use_contract_economics():
    # A complete, non-excluded cash session: warm up flat, jump at 09:30 ET
    # to cross the threshold with a valid VWAP, then hold until the cash exit.
    clock = pd.date_range("2024-07-16 06:00", "2024-07-16 16:01",
                          freq="min", tz="America/New_York")
    minute = clock.hour * 60 + clock.minute
    close = 17_000.0 + 30 * (minute >= 570) + 10 * (minute >= 720)
    candles = pd.DataFrame({"ts": clock.as_unit("s").asi8,
                            "open": close, "high": close + 1,
                            "low": close - 1, "close": close, "volume": 1.0})
    runner = PythonRunner()
    nq = runner.run(STARTER, candles, "NQ_F_1M", "1m")
    mnq = runner.run(STARTER, candles, "MNQ", "1m")
    override = runner.run(STARTER, candles, "NQ_F_1M", "1m",
                          {"params": {"instrument": "MNQ"}})

    assert len(nq.trades) == len(mnq.trades) == len(override.trades) == 1
    expected_entry = int(pd.Timestamp("2024-07-16 09:40", tz=clock.tz).timestamp())
    expected_exit = int(pd.Timestamp("2024-07-16 16:00", tz=clock.tz).timestamp())
    for result in (nq, mnq, override):
        trade = result.trades[0]
        assert (trade.entry_ts, trade.exit_ts, trade.direction, trade.qty) == (
            expected_entry, expected_exit, "long", 1.0)
    assert nq.trades[0].point_value == 20.0
    assert mnq.trades[0].point_value == override.trades[0].point_value == 2.0
    assert mnq.net_profit > 0
    assert nq.net_profit == pytest.approx(10 * mnq.net_profit)
    assert override.net_profit == pytest.approx(mnq.net_profit)


def test_atr_full_history_default_trades_before_original_2020_cutoff():
    clock = pd.date_range("2016-07-12 06:00", "2016-07-12 16:01",
                          freq="min", tz="America/New_York")
    close = 4500.0 + 30 * (clock.hour * 60 + clock.minute >= 570)
    candles = pd.DataFrame({"ts": clock.as_unit("s").asi8,
                            "open": close, "high": close + 1,
                            "low": close - 1, "close": close, "volume": 1.0})
    runner = PythonRunner()
    full = runner.run(STARTER, candles, "NQ_F_1M", "1m")
    original = runner.run(STARTER, candles, "NQ_F_1M", "1m",
                          {"params": {"start_trading_date": 20200203}})
    assert len(full.trades) == 1
    assert original.trades == []


def test_atr_integrity_halt_cannot_silently_return_partial_backtest():
    clock = pd.date_range("2024-07-16 06:00", "2024-07-16 16:01",
                          freq="min", tz="America/New_York")
    candles = pd.DataFrame({"ts": clock.as_unit("s").asi8,
                            "open": 17000.0, "high": 17001.0,
                            "low": 16999.0, "close": 17000.0, "volume": 1.0})
    candles.loc[60, "high"] = 16999.99
    with pytest.raises(BacktestError, match="Strategy halted.*Invalid minute OHLCV"):
        PythonRunner().run(STARTER, candles, "NQ_F_1M", "1m")
