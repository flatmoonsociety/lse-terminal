import copy

import pytest
from fastapi.testclient import TestClient

from lse_terminal.engine import saved_backtests
from lse_terminal.engine.server import create_app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("LSE_TERMINAL_CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("LSE_TERMINAL_HOSTED", raising=False)
    return TestClient(create_app(), base_url="http://127.0.0.1")


def report():
    return {
        "name": "Raschke / NQ full history",
        "context": {"strategy": "strategies/rashke.py", "elapsedMs": 1234,
                    "request": {"script": "def strategy(data): return []",
                                "options": {"params": {"trend_ratio_threshold": 0.45}},
                                "provider": "userdata", "symbol": "NQ_F_1M"}},
        "result": {"engine": "python", "symbol": "NQ_F_1M", "timeframe": "1m",
                   "initial_capital": 100000, "final_equity": 100200, "net_profit": 200,
                   "stats": {"winRate": 100, "profitFactor": "__+Inf__"},
                   "equity_curve": [[1000, 100000], [1060, 100200]],
                   "benchmark_curve": [[1000, 100000], [1060, 100100]],
                   "plots": {"EMA": [[1000, 19990], [1060, 20000]]},
                   "trades": [{"entry_ts": 1000, "exit_ts": 1060, "direction": "long",
                               "entry_price": 20000, "exit_price": 20010, "qty": 1,
                               "point_value": 20, "pnl": 200}]},
    }


def test_save_reopen_after_restart_and_delete(client, tmp_path):
    assert client.get("/api/backtest/saved").json() == []
    original = report()
    response = client.post("/api/backtest/saved", json=original)
    assert response.status_code == 200, response.text
    summary = response.json()
    url = f"/api/backtest/saved/{summary['id']}"
    assert summary["total_trades"] == 1
    assert summary["net_profit"] == 200
    assert summary["win_rate"] == 100
    assert summary["start_ts"] == 1000
    assert "result" not in summary and "context" not in summary
    assert (tmp_path / "saved-backtests.sqlite3").is_file()

    # A new app instance reconstructs the report without rerunning code or
    # accessing its source/dataset; later edits cannot change this snapshot.
    restarted = TestClient(create_app(), base_url="http://127.0.0.1")
    assert restarted.get("/api/backtest/saved").json() == [summary]
    loaded = restarted.get(url).json()
    assert loaded["result"] == original["result"]
    assert loaded["context"] == original["context"]
    assert loaded["name"] == original["name"]
    assert loaded["schema_version"] == 1

    changed = copy.deepcopy(original)
    changed["name"] = "Modified run"
    changed["result"]["net_profit"] = 100
    newer = restarted.post("/api/backtest/saved", json=changed).json()
    assert restarted.get("/api/backtest/saved").json() == [newer, summary]
    assert restarted.get(url).json() == loaded
    assert restarted.delete(url).json() == {"ok": True}
    assert restarted.get(url).status_code == 404
    assert restarted.delete(url).status_code == 404
    assert client.get("/api/backtest/saved").json() == [newer]


def test_invalid_or_failed_save_preserves_history(client, monkeypatch):
    summary = client.post("/api/backtest/saved", json=report()).json()
    invalid = report()
    invalid["result"] = {}
    assert client.post("/api/backtest/saved", json=invalid).status_code == 400
    invalid = report()
    invalid["name"] = " "
    assert client.post("/api/backtest/saved", json=invalid).status_code == 400
    assert client.get("/api/backtest/saved/not-an-id").status_code == 404

    def fail(*args, **kwargs):
        raise OSError("disk unavailable")

    monkeypatch.setattr(saved_backtests.gzip, "compress", fail)
    failed = client.post("/api/backtest/saved", json=report())
    assert failed.status_code == 507
    assert "could not save backtest" in failed.json()["detail"]
    assert client.get("/api/backtest/saved").json() == [summary]


def test_saved_reports_are_local_only(client, monkeypatch):
    monkeypatch.setenv("LSE_TERMINAL_HOSTED", "1")
    hosted = TestClient(create_app(), base_url="http://127.0.0.1")
    assert hosted.get("/api/backtest/saved").status_code == 403
    assert hosted.post("/api/backtest/saved", json=report()).status_code == 403
    assert hosted.get("/api/backtest/saved/" + "a" * 32).status_code == 403
    assert hosted.delete("/api/backtest/saved/" + "a" * 32).status_code == 403


def test_saved_report_serves_original_json_without_decode_encode_roundtrip(client, monkeypatch):
    original = report()
    original["result"]["equity_curve"] = [[i * 60, 100000 + i / 7] for i in range(10000)]
    summary = client.post("/api/backtest/saved", json=original).json()
    expected = saved_backtests.read_json(summary["id"])
    # The response must reuse stored JSON, without an object-tree decode or
    # FastAPI's per-point recursive copy. Both were expensive for full histories.
    import fastapi.routing

    def fail(*args, **kwargs):
        raise AssertionError("saved report was decoded or recursively encoded")

    with monkeypatch.context() as patch:
        patch.setattr(saved_backtests.json, "loads", fail)
        patch.setattr(fastapi.routing, "jsonable_encoder", fail)
        loaded = client.get(f"/api/backtest/saved/{summary['id']}")
    assert loaded.status_code == 200
    assert loaded.headers["content-type"] == "application/json"
    assert loaded.content == expected
    assert loaded.json()["result"] == original["result"]
