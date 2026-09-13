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

    def download(symbol, timeframe, start, end, *, cache_dir, progress, dataset="spot"):
        state.calls.append((symbol, timeframe, start, end, dataset))
        state.entered.set()
        assert state.gate.wait(5)
        progress(rows=1, detail="downloaded one candle")
        if state.fail:
            raise ValueError("Binance temporarily unavailable; retry to resume")
        return state.frame

    monkeypatch.setattr(binance_import, "download", download)
    def catalog(**kw):
        dataset = kw.get("dataset", "spot")
        coin = dataset == "coinm"
        return {"total": 1, "rows": [{
            "symbol": "BTCUSD_PERP" if coin else "BTCUSDT", "name": "BTC / USD" if coin else "BTC / USDT",
            "dataset": dataset, "base_asset": "BTC", "quote_asset": "USD" if coin else "USDT",
            "margin_asset": "BTC" if coin else "USDT", "volume_unit": "contracts" if coin else "base asset",
            "contract_size": 100 if coin else None,
            "contract_type": "PERPETUAL" if dataset != "spot" else "",
        }]}
    monkeypatch.setattr(binance_import, "catalog", catalog)
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
    assert overview.json()["meta"]["candle_classes"] == ["spot", "usdm", "coinm"]
    assert bank.client.get("/api/binance/databank/catalog?query=BTC").json()["rows"][0]["symbol"] == "BTCUSDT"
    job = finished(bank, start(bank))
    assert job["status"] == "done", job
    entry = job["entry"]
    assert entry["source"] == "binance"
    assert entry["instrument"]["dataset"] == "spot"
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


@pytest.mark.parametrize("dataset,symbol", [("usdm", "BTCUSDT"), ("coinm", "BTCUSD_PERP")])
def test_futures_contract_metadata_is_retained(bank, dataset, symbol):
    job = finished(bank, start(bank, {**REQUEST, "dataset": dataset, "symbol": symbol}))
    assert job["status"] == "done", job
    entry = job["entry"]
    assert entry["symbol"] == f"BINANCE_{dataset.upper()}_{symbol}_1M"
    assert entry["instrument"]["contract_type"] == "PERPETUAL"
    assert entry["instrument"]["dataset"] == dataset
    if dataset == "coinm":
        assert entry["instrument"]["contract_size"] == 100
        assert entry["instrument"]["volume_unit"] == "contracts"
        assert entry["instrument"]["margin_asset"] == "BTC"
    assert bank.calls[0][-1] == dataset
    assert userdata.load_manifest()[entry["symbol"]]["instrument"] == entry["instrument"]


def test_same_pair_across_spot_and_futures_cannot_collide(bank):
    bank.gate.clear()
    spot = start(bank)
    assert bank.entered.wait(5)
    futures = start(bank, {**REQUEST, "dataset": "usdm"})
    assert spot != futures
    bank.gate.set()
    assert finished(bank, spot)["status"] == "done"
    assert finished(bank, futures)["status"] == "done"
    manifest = userdata.load_manifest()
    assert {"BINANCE_SPOT_BTCUSDT_1M", "BINANCE_USDM_BTCUSDT_1M"} <= manifest.keys()
    assert manifest["BINANCE_SPOT_BTCUSDT_1M"]["file"] != manifest["BINANCE_USDM_BTCUSDT_1M"]["file"]


def test_coverage_metadata_uses_selected_market_and_interval(bank, monkeypatch):
    calls = []
    def metadata(symbol, dataset="spot", timeframe="1m"):
        calls.append((symbol, dataset, timeframe))
        return {"symbol": symbol, "dataset": dataset, "timeframe": timeframe,
                "first_tick": "2020-08-11T10:00:00Z", "last_tick": "2024-01-01T23:00:00Z",
                "estimated_bars": 29774, "available_history": True}
    monkeypatch.setattr(binance_import, "metadata", metadata)
    response = bank.client.get("/api/binance/databank/metadata?symbol=BTCUSD_PERP&dataset=coinm&timeframe=1h")
    assert response.status_code == 200
    assert response.json()["estimated_bars"] == 29774
    assert calls == [("BTCUSD_PERP", "coinm", "1h")]

    def unavailable(*args, **kwargs):
        raise binance_import.BinanceError("Binance unavailable from this location", 451)
    monkeypatch.setattr(binance_import, "metadata", unavailable)
    response = bank.client.get("/api/binance/databank/metadata?symbol=BTCUSDT")
    assert response.status_code == 451 and "location" in response.json()["detail"]


def test_unicode_tickers_have_distinct_files_and_retain_original_symbol(bank, monkeypatch):
    monkeypatch.setattr(binance_import, "catalog", lambda **kw: {
        "rows": [{"symbol": kw["query"], "dataset": kw["dataset"]}],
    })
    entries = []
    for symbol, price in [("哈基米USDT", 1.0), ("币安人生USDT", 2.0)]:
        bank.frame[["open", "high", "low", "close"]] = price
        job = finished(bank, start(bank, {**REQUEST, "dataset": "usdm", "symbol": symbol}))
        assert job["status"] == "done", job
        entry = job["entry"]
        assert entry["instrument"]["symbol"] == symbol
        assert symbol in entry["name"]
        entries.append(entry)
    assert entries[0]["file"] != entries[1]["file"]
    for entry, price in zip(entries, [1.0, 2.0]):
        assert pd.read_csv(userdata.data_dir() / entry["file"])["close"].tolist() == [price]
