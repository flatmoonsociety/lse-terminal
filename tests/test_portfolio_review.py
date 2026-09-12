"""Independent API checks for empty activity, invalid input, and window failures."""

import copy

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from lse_terminal.engine.server import create_app


def leg(id="idle", **changes):
    return {"id": id, "label": f"Leg {id}", "strategy": "idle.py", "script": "trades = []",
            "symbol": "NQ", "timeframe": "1m", "allocation_pct": 40, "params": {},
            "commission_pct": .5, "currency": "USD", **changes}


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("LSE_TERMINAL_CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("LSE_API_KEY", raising=False)
    monkeypatch.delenv("LSE_TERMINAL_HOSTED", raising=False)
    app = create_app()
    calls = []
    stamps = pd.to_datetime(["2024-01-01T23:59:00Z", "2024-01-02T00:00:00Z",
                             "2024-01-02T00:01:00Z", "2024-01-02T00:02:00Z"])
    frame = pd.DataFrame({"ts": stamps.as_unit("s").asi8, "open": [100, 101, 102, 103],
                          "high": [100, 101, 102, 103], "low": [100, 101, 102, 103],
                          "close": [100, 101, 102, 103], "volume": [1] * 4})

    def candles(symbol, timeframe, *, limit):
        calls.append((symbol, timeframe, limit))
        if symbol != "NQ":
            raise ValueError(f"No dataset {symbol}")
        return frame.copy()

    monkeypatch.setattr(app.state.registry.get("userdata"), "candles", candles)
    return TestClient(app, base_url="http://127.0.0.1"), calls, frame


def test_idle_sleeves_have_no_fabricated_trades_or_fees(api):
    client, calls, frame = api
    response = client.post("/api/backtest/portfolio", json={"name": "Idle", "capital": 1000,
        "components": [leg(), leg("second", allocation_pct=30)]})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["trades"] == []
    assert result["stats"]["totalTrades"] == result["stats"]["maxDrawdown"] == 0
    assert result["stats"]["extended"]["exposurePct"] == 0
    assert result["final_equity"] == 1000 and result["net_profit"] == 0
    assert result["equity_curve"] == [[int(ts), 1000] for ts in frame.ts]
    assert result["benchmark_curve"][-1][1] == pytest.approx(300 + 700 * 103 / 100)
    assert result["portfolio"]["unallocated_capital"] == pytest.approx(300)
    assert all(component["total_trades"] == 0 for component in result["portfolio"]["components"])
    assert calls == [("NQ", "1m", 0), ("NQ", "1m", 0)]


@pytest.mark.parametrize("patch,status", [
    ({"capital": "Infinity"}, 400),
    ({"capital": "NaN"}, 400),
    ({"components": [leg(allocation_pct="NaN")]}, 400),
    ({"components": [leg(allocation_pct=1e308), leg("second", allocation_pct=1e308)]}, 400),
    ({"components": [leg(params=[])]}, 422),
    ({"components": [leg(commission_pct="Infinity")]}, 400),
    ({"components": [leg(currency="EUR")]}, 400),
    ({"components": [leg(), leg()]}, 400),
    ({"components": [leg(script=" ")]}, 400),
    ({"from": "2024-02-30"}, 400),
])
def test_bad_api_input_fails_before_any_strategy_data_load(api, patch, status):
    client, calls, _ = api
    response = client.post("/api/backtest/portfolio", json={"name": "Invalid", "capital": 1000,
        "components": [leg()], **patch})
    assert response.status_code == status, response.text
    assert "detail" in response.json()
    assert calls == []


def test_timezone_window_and_failure_of_later_component_never_return_partial_result(api):
    client, calls, frame = api
    script = "assert symbol == 'NQ' and timeframe == '1m'\nassert params['length'] == 3\nassert len(df) == 3\ntrades = []"
    body = {"name": "Windowed", "capital": 1000, "from": "2024-01-02T01:00:00+01:00",
            "to": "2024-01-02T01:02:00+01:00", "components": [leg(script=script, params={"length": 3})]}
    response = client.post("/api/backtest/portfolio", json=body)
    assert response.status_code == 200, response.text
    assert [point[0] for point in response.json()["equity_curve"]] == list(frame.ts[1:])
    failed = copy.deepcopy(body)
    failed["components"].append(leg("later", symbol="MISSING", allocation_pct=10))
    response = client.post("/api/backtest/portfolio", json=failed)
    assert response.status_code == 400, response.text
    assert "Leg later" in response.json()["detail"] and "MISSING" in response.json()["detail"]
    assert set(response.json()) == {"detail"}  # The first successful component is not published alone.
    assert calls[-2:] == [("NQ", "1m", 0), ("MISSING", "1m", 0)]


def test_empty_date_window_is_a_named_failure_not_an_idle_component(api):
    client, _, _ = api
    response = client.post("/api/backtest/portfolio", json={"name": "No coverage", "capital": 1000,
        "from": "2030-01-01", "to": "2030-01-02", "components": [leg()]})
    assert response.status_code == 400, response.text
    assert "Leg idle" in response.json()["detail"] and "no candles" in response.json()["detail"]
    assert "equity_curve" not in response.json()
