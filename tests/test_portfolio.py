import copy
import json

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from lse_terminal.backtest.contract import BacktestError
from lse_terminal.backtest.portfolio import run_portfolio
from lse_terminal.engine.server import create_app


HOLD = "trades = [{'entry_i': 0, 'exit_i': len(df) - 1}]"


def candles(clock, prices):
    return pd.DataFrame({"ts": clock, "open": prices, "high": prices,
                         "low": prices, "close": prices, "volume": 1.0})


class LocalData:
    def __init__(self, frames):
        self.frames = frames
        self.calls = []

    def candles(self, symbol, timeframe, *, limit):
        self.calls.append((symbol, timeframe, limit))
        return self.frames[symbol].copy()


def component(id="a", allocation=40, **changes):
    return {"id": id, "label": f"Strategy {id}", "strategy": f"{id}.py",
            "script": HOLD, "symbol": id.upper(), "timeframe": "1m",
            "allocation_pct": allocation, "currency": "USD", **changes}


def test_fixed_allocations_union_clock_preserves_reserve_and_prior_marks():
    provider = LocalData({"A": candles([0, 60, 120], [100, 110, 105]),
                          "B": candles([30, 90], [100, 110])})
    result = run_portfolio(name="Two strategies", capital=1000, currency="USD",
                           components=[component(), component("b", 30)], provider=provider)
    expected = [[0, 1000], [30, 1000], [60, 1040], [90, 1070], [120, 1050]]
    assert result["equity_curve"] == expected
    assert result["benchmark_curve"] == expected
    assert result["initial_capital"] == 1000
    assert result["final_equity"] == 1050
    assert result["net_profit"] == sum(t["pnl"] for t in result["trades"]) == 50
    assert result["portfolio"]["unallocated_capital"] == pytest.approx(300)
    assert result["portfolio"]["allocation_model"] == "fixed"
    assert result["stats"]["maxDrawdown"] == 20
    assert result["stats"]["maxDrawdownPct"] == pytest.approx(20 / 1070 * 100)
    assert result["stats"]["extended"]["exposurePct"] == 100
    assert result["stats"]["extended"]["avgBarsHeld"] is None
    # Exit order is used consistently for report rows and streak statistics.
    assert [trade["component_id"] for trade in result["trades"]] == ["b", "a"]
    assert result["trades"][0]["strategy"] == "b.py"
    assert result["trades"][0]["symbol"] == "B"
    assert provider.calls == [("A", "1m", 0), ("B", "1m", 0)]
    assert result["portfolio"]["components"][0]["daily_equity_curve"] == [[120, 420]]
    assert result["portfolio"]["components"][1]["final_equity"] == 330
    assert "equity_curve" not in result["portfolio"]["components"][0]
    json.dumps(result, allow_nan=False)


def test_opposing_positions_offset_without_averaging_component_drawdown():
    provider = LocalData({"A": candles([0, 60, 120], [100, 110, 105])})
    short = "trades = [{'entry_i': 0, 'exit_i': len(df) - 1, 'dir': 'short'}]"
    result = run_portfolio(name="Opposing", capital=1000, currency="USD", provider=provider,
                           components=[component(allocation=50), component("b", 50, symbol="A", script=short)])
    assert result["equity_curve"] == [[0, 1000], [60, 1000], [120, 1000]]
    assert result["stats"]["maxDrawdownPct"] == 0
    assert all(leg["max_drawdown_pct"] > 0 for leg in result["portfolio"]["components"])
    assert result["stats"]["grossProfit"] == 25
    assert result["stats"]["grossLoss"] == -25
    assert result["stats"]["profitFactor"] == 1
    assert result["stats"]["winRate"] == 50


def test_portfolio_exposure_is_union_of_time_intervals_not_sum_of_bars():
    provider = LocalData({"A": candles([0, 60, 120, 180, 240], [100] * 5),
                          "B": candles([0, 30, 60, 90, 120, 180, 240], [100] * 7)})
    first = "trades = [{'entry_i': 1, 'exit_i': 3, 'qty': 1}]"
    second = "trades = [{'entry_i': 3, 'exit_i': 4, 'qty': 1}]"
    result = run_portfolio(name="Exposure", capital=1000, currency="USD", provider=provider,
                           components=[component(script=first), component("b", 40, timeframe="30s", script=second)])
    # [60,180) overlaps [90,120); 120 seconds of the 240-second portfolio window.
    assert result["stats"]["extended"]["exposurePct"] == 50


@pytest.mark.parametrize("changes,match", [
    ({"capital": 0}, "capital must be positive"),
    ({"capital": float("inf")}, "capital must be positive"),
    ({"components": []}, "1 to 12"),
    ({"components": [component(str(i), 1) for i in range(13)]}, "1 to 12"),
    ({"components": [component(), component()]}, "Duplicate"),
    ({"components": [component(allocation=0)]}, "allocation must be positive"),
    ({"components": [component(allocation=float("nan"))]}, "allocation must be positive"),
    ({"components": [component(allocation=60), component("b", 50)]}, "100% or less"),
    ({"currency": "EUR"}, "currency must match EUR"),
    ({"components": [component(currency="EUR")]}, "currency must match USD"),
    ({"components": [component(commission_pct=-1)]}, "commission_pct.*finite nonnegative"),
    ({"components": [component(commission_per_unit=-1)]}, "commission_per_unit.*finite nonnegative"),
    ({"start": "not-a-date"}, "Invalid portfolio from"),
    ({"start": "2024-02-02", "end": "2024-02-01"}, "from date must not be after"),
])
def test_invalid_portfolio_fails_before_loading_components(changes, match):
    provider = LocalData({})
    args = {"name": "Invalid", "capital": 1000, "currency": "USD",
            "components": [component()], "provider": provider, **changes}
    with pytest.raises(BacktestError, match=match):
        run_portfolio(**args)
    assert provider.calls == []


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("LSE_TERMINAL_CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("LSE_TERMINAL_HOSTED", raising=False)
    return TestClient(create_app(), base_url="http://127.0.0.1")


def import_frame(client, symbol, frame):
    response = client.post("/api/data/import", json={"symbol": symbol, "csv_text": frame.to_csv(index=False)})
    assert response.status_code == 200, response.text


def test_portfolio_endpoint_preserves_futures_quantities_fees_and_saved_provenance(client):
    start = 1700000040
    frame = candles([start, start + 60, start + 120], [20000, 20000, 20010])
    legs = []
    for instrument, allocation, fixed_fee in [("NQ", 40, 2.5), ("MNQ", 30, .95)]:
        symbol = f"{instrument}_F_1M"
        import_frame(client, symbol, frame)
        script = f'''# run: WRONG_SYMBOL 1h
from lse_terminal.backtest.atr_phase import Config
assert symbol == {symbol!r} and timeframe == '1m'
assert len(data['NQ_F_1M']) == 3
config = Config(instrument=symbol.split('_')[0])
trades = [{{'entry_i': 0, 'exit_i': len(df)-1, 'qty': params['qty'], 'point_value': config.point_value}}]
'''
        legs.append(component(instrument, allocation, symbol=symbol, script=script,
                              commission_pct=0.01, commission_per_unit=fixed_fee, params={"qty": 1}))
    body = {"name": "Futures portfolio", "capital": 100000, "components": legs}
    response = client.post("/api/backtest/portfolio", json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["engine"] == "portfolio" and result["timeframe"] == "mixed"
    by_symbol = {trade["symbol"]: trade for trade in result["trades"]}
    assert by_symbol["NQ_F_1M"]["point_value"] == 20
    assert by_symbol["MNQ_F_1M"]["point_value"] == 2
    assert all(trade["qty"] == 1 for trade in result["trades"])
    assert by_symbol["NQ_F_1M"]["component_label"] == "Strategy NQ"
    fees = (20000 + 20010) * 22 * 0.0001 + 2 * (2.5 + .95)
    expected = 220 - fees
    assert result["net_profit"] == pytest.approx(expected)
    assert sum(trade["pnl"] for trade in result["trades"]) == pytest.approx(expected)
    assert result["gross_profit"] == 220
    assert result["total_commission"] == pytest.approx(fees)
    assert sum(leg["total_commission"] for leg in result["portfolio"]["components"]) == pytest.approx(fees)
    assert sum(leg["gross_profit"] for leg in result["portfolio"]["components"]) == 220
    assert result["commission_pct"] == .01
    assert result["commission_per_unit"] is None  # Heterogeneous rates are never averaged.
    assert [leg["commission_per_unit"] for leg in result["portfolio"]["components"]] == [2.5, .95]
    # Initial fees are drawdown from initial account cash, even on the first bar.
    assert result["equity_curve"][0][1] == pytest.approx(100000 - 47.45)
    assert result["stats"]["maxDrawdown"] == pytest.approx(47.45)
    assert result["stats"]["maxDrawdownPct"] == pytest.approx(0.04745)
    saved = client.post("/api/backtest/saved", json={"name": body["name"], "result": result,
                                                   "context": {"request": body}})
    assert saved.status_code == 200, saved.text
    loaded = client.get(f"/api/backtest/saved/{saved.json()['id']}").json()
    assert loaded["result"] == result
    assert loaded["context"]["request"] == body


def test_common_utc_dates_include_full_end_day_and_component_failures_are_named(client):
    times = pd.to_datetime(["2024-01-01T23:59Z", "2024-01-02T00:00Z", "2024-01-02T23:59Z", "2024-01-03T00:00Z"])
    frame = candles(times.as_unit("s").asi8, [100, 101, 102, 103])
    import_frame(client, "A", frame)
    # This intentionally sparse one-minute file is explicitly requested at its
    # imported native timeframe; from/to filtering still applies identically.
    native = next(item["timeframe"] for item in client.get("/api/data").json() if item["symbol"] == "A")
    body = {"name": "Dates", "capital": 1000, "from": "2024-01-02", "to": "2024-01-02",
            "components": [component(allocation=100, timeframe=native)]}
    response = client.post("/api/backtest/portfolio", json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    assert [point[0] for point in result["equity_curve"]] == [int(times[1].timestamp()), int(times[2].timestamp())]
    resampled = copy.deepcopy(body)
    resampled["components"][0]["timeframe"] = "1h"
    mismatch = client.post("/api/backtest/portfolio", json=resampled)
    assert mismatch.status_code == 400 and "do not resample" in mismatch.json()["detail"]
    broken = copy.deepcopy(body)
    broken["components"] = [component("missing", 50, symbol="DOES_NOT_EXIST"), component(allocation=50, timeframe=native)]
    error = client.post("/api/backtest/portfolio", json=broken)
    assert error.status_code == 400
    assert "Strategy missing" in error.json()["detail"] and "DOES_NOT_EXIST" in error.json()["detail"]
    broken["components"] = [component("bad-code", 50, symbol="A", timeframe=native, script="raise ValueError('broken test strategy')"), component(allocation=50, timeframe=native)]
    error = client.post("/api/backtest/portfolio", json=broken)
    assert error.status_code == 400 and "Strategy bad-code" in error.json()["detail"]
    assert "broken test strategy" in error.json()["detail"]


def test_portfolio_code_execution_is_refused_when_hosted(client, monkeypatch):
    monkeypatch.setenv("LSE_TERMINAL_HOSTED", "1")
    hosted = TestClient(create_app(), base_url="http://127.0.0.1")
    response = hosted.post("/api/backtest/portfolio", json={"name": "Blocked", "capital": 1000,
                                                          "components": [component(script="raise ValueError('executed')")]})
    assert response.status_code == 403
