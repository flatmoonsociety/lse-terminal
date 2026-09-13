"""Public Binance jobs land complete, identifiable candles in the library."""

import threading
import time
from types import SimpleNamespace

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from lse_terminal.engine.server import create_app
from lse_terminal.providers import binance_import, userdata


@pytest.fixture
def bank(tmp_path, monkeypatch):
    monkeypatch.setenv("LSE_TERMINAL_CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("LSE_TERMINAL_HOSTED", raising=False)
    monkeypatch.delenv("LSE_API_KEY", raising=False)
    userdata._save_manifest({})
    state = SimpleNamespace(gate=threading.Event(), entered=threading.Event(), fail=False, calls=[])
    state.gate.set()
    state.frame = pd.DataFrame({
        "ts": [pd.Timestamp("2024-01-01", tz="UTC")],
        "open": [42000.0], "high": [42100.0], "low": [41900.0],
        "close": [42050.0], "volume": [1.25],
    })

    def download(symbol, timeframe, start, end, *, cache_dir, progress):
        state.calls.append((symbol, timeframe, start, end))
        state.entered.set()
        assert state.gate.wait(5)
        progress(rows=1, detail="downloaded one candle")
        if state.fail:
            raise ValueError("Binance temporarily unavailable; retry to resume")
        return state.frame

    monkeypatch.setattr(binance_import, "download", download)
    monkeypatch.setattr(binance_import, "catalog", lambda **kw: {
        "total": 1, "rows": [{"symbol": "BTCUSDT", "name": "BTC / USDT"}],
    })
    baseline = set(threading.enumerate())
    state.client = TestClient(create_app(), base_url="http://127.0.0.1")
    yield state
    state.gate.set()
    for thread in set(threading.enumerate()) - baseline:
        if thread.name.startswith("binance-databank-"):
            thread.join(timeout=10)
            assert not thread.is_alive()


REQUEST = {"symbol": "btcusdt", "timeframe": "1m", "start": "2024-01-01", "end": "2024-01-01"}


def start(bank, request=None):
    response = bank.client.post("/api/binance/databank/import", json=request or REQUEST)
    assert response.status_code == 200, response.text
    return response.json()["job_id"]


def finished(bank, job_id):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        job = bank.client.get(f"/api/binance/databank/import/{job_id}").json()
        if job["status"] in {"done", "failed"}:
            return job
        time.sleep(0.01)
    pytest.fail("Binance import did not settle")


def test_public_catalog_and_import_do_not_require_lse_key(bank):
    overview = bank.client.get("/api/binance/databank")
    assert overview.status_code == 200
    assert overview.json()["meta"]["candle_classes"] == ["spot"]
    assert bank.client.get("/api/binance/databank/catalog?query=BTC").json()["rows"][0]["symbol"] == "BTCUSDT"
    job = finished(bank, start(bank))
    assert job["status"] == "done", job
    entry = job["entry"]
    assert entry["source"] == "binance"
    assert entry["symbol"] == "BINANCE_SPOT_BTCUSDT_1M"
    assert entry["folder"] == "Binance" and entry["rows"] == 1
    assert entry["timeframe"] == "1m"  # Even a single bar preserves its native interval.
    stored = pd.read_csv(userdata.dataset_path(entry["symbol"]))
    assert stored["ts"].tolist() == [1704067200]
    assert stored["volume"].tolist() == [1.25]
    assert bank.client.get("/api/data").status_code == 200


def test_duplicate_and_conflicting_downloads(bank):
    bank.gate.clear()
    job_id = start(bank)
    assert bank.entered.wait(5)
    try:
        assert start(bank) == job_id
        conflict = bank.client.post("/api/binance/databank/import", json={**REQUEST, "end": "2024-01-02"})
        assert conflict.status_code == 409
    finally:
        bank.gate.set()
    assert finished(bank, job_id)["status"] == "done"
    assert len(bank.calls) == 1


def test_failed_download_preserves_the_existing_file(bank):
    first = finished(bank, start(bank))
    path = userdata.dataset_path(first["entry"]["symbol"])
    original = path.read_bytes()
    manifest = userdata.load_manifest()
    bank.fail = True
    failed = finished(bank, start(bank))
    assert failed["status"] == "failed" and "resume" in failed["error"]
    assert path.read_bytes() == original
    assert userdata.load_manifest() == manifest


@pytest.mark.parametrize("change", [
    {"dataset": "futures"}, {"symbol": "../BTCUSDT"}, {"timeframe": "tick"},
    {"start": "bad-date"}, {"start": "2024-01-02", "end": "2024-01-01"},
])
def test_invalid_import_rejected_before_starting_work(bank, change):
    response = bank.client.post("/api/binance/databank/import", json={**REQUEST, **change})
    assert response.status_code == 400, response.text
    assert not bank.calls


def test_hosted_guard_and_missing_job(bank, monkeypatch):
    monkeypatch.setenv("LSE_TERMINAL_HOSTED", "1")
    hosted_client = TestClient(create_app(), base_url="http://127.0.0.1")
    assert hosted_client.post("/api/binance/databank/import", json=REQUEST).status_code == 403
    assert bank.client.get("/api/binance/databank/import/missing").status_code == 404
