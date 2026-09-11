"""Databank jobs join verified history chunks before changing the library."""

import threading
import time
from types import SimpleNamespace

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from lse_terminal.engine.server import create_app
from lse_terminal.providers import userdata, vault_import
from lse_terminal.providers.lse import LseProvider


REQUEST = {"dataset": "futures", "symbol": "NQ.F", "timeframe": "1m", "folder": "LSE"}


@pytest.fixture
def bank(tmp_path, monkeypatch):
    monkeypatch.setenv("LSE_TERMINAL_CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("LSE_API_KEY", "test-only-key")
    monkeypatch.delenv("LSE_TERMINAL_HOSTED", raising=False)
    userdata._save_manifest({})  # Keep bundled sample seeding out of this fixture.
    catalog = {"symbol": "NQ.F", "name": "Nasdaq futures",
               "first_tick": "2016-05-29T00:00:00Z", "last_tick": "2026-09-11T23:59:00Z"}
    specs = list(vault_import.candle_ranges("2016-05-29", "2026-09-11", "1m"))
    frames = {}
    for start, end in specs:
        frames[start] = pd.DataFrame({
            "ts": [pd.Timestamp(start, tz="UTC"), pd.Timestamp(end, tz="UTC") - pd.Timedelta(minutes=1)],
            "open": [100.0, 101.0], "high": [102.0, 103.0],
            "low": [99.0, 100.0], "close": [101.0, 102.0], "volume": [10.0, 20.0],
        })
    gate, entered = threading.Event(), threading.Event()
    gate.set()
    state = SimpleNamespace(specs=specs, frames=frames, requests=[], gate=gate,
                            entered=entered, empty_start=None)

    def candles(symbol, **kwargs):
        frame = frames[kwargs["start"]]
        stamp = frame["ts"].iloc[0 if kwargs["order"] == "asc" else -1]
        return [{"timestamp": stamp.isoformat()}]

    remote = SimpleNamespace(datasets=lambda _: [catalog], candles=candles,
                             vault_meta=lambda: {"candle_classes": ["futures"]})
    monkeypatch.setattr(LseProvider, "_lse", lambda _: remote)

    def export_file(client, payload, root, progress, **kwargs):
        assert client is remote
        state.requests.append(payload.copy())
        entered.set()
        assert gate.wait(5), "test did not release the export"
        root.mkdir(parents=True, exist_ok=True)
        path = root / f"{payload['start'][:10]}.parquet"
        frame = frames[payload["start"]]
        if payload["start"] == state.empty_start:
            frame = frame.iloc[:0]
        frame.to_parquet(path, index=False)
        return path

    monkeypatch.setattr(vault_import, "export_file", export_file)
    baseline = set(threading.enumerate())
    state.client = TestClient(create_app(), base_url="http://127.0.0.1")
    yield state
    gate.set()
    for thread in set(threading.enumerate()) - baseline:
        if thread.name.startswith("lse-databank-"):
            thread.join(timeout=10)
            assert not thread.is_alive(), "databank test leaked a running import"


def _start(bank):
    response = bank.client.post("/api/lse/databank/import", json=REQUEST)
    assert response.status_code == 200, response.text
    return response.json()["job_id"]


def _finished(bank, job_id):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = bank.client.get(f"/api/lse/databank/import/{job_id}")
        assert response.status_code == 200, response.text
        job = response.json()
        if job["status"] in {"done", "failed", "saved"}:
            return job
        time.sleep(0.01)
    pytest.fail("databank import did not settle")


def test_multichunk_history_imports_one_complete_library_file(bank):
    job = _finished(bank, _start(bank))
    assert job["status"] == "done", job
    assert sorted((r["start"], r["end"]) for r in bank.requests) == bank.specs
    entry = job["entry"]
    assert entry["symbol"] == "NQ_F_1M" and entry["folder"] == "LSE"
    assert entry["rows"] == 2 * len(bank.specs)
    path = userdata.dataset_path(entry["symbol"])
    stored = pd.read_csv(path)
    assert len(stored) == entry["rows"]
    assert stored["ts"].is_monotonic_increasing and stored["ts"].is_unique
    assert stored["ts"].iloc[0] == int(pd.Timestamp("2016-05-29", tz="UTC").timestamp())
    assert stored["ts"].iloc[-1] == int(pd.Timestamp("2026-09-11T23:59:00Z").timestamp())
    assert list(userdata.data_dir().glob("*.csv")) == [path]
    assert not list((userdata.data_dir() / "lse").glob("*-merged.parquet"))


def test_duplicate_active_download_returns_the_existing_job(bank):
    bank.gate.clear()
    first = _start(bank)
    assert bank.entered.wait(5)
    try:
        second = _start(bank)
        assert second == first
    finally:
        bank.gate.set()
    assert _finished(bank, first)["status"] == "done"
    assert len(bank.requests) == len(bank.specs)


def test_missing_interior_chunk_preserves_existing_library_dataset(bank):
    assert len(bank.specs) >= 3
    entry = userdata.import_table("NQ_F_1M", bank.frames[bank.specs[0][0]], folder="LSE")
    path = userdata.dataset_path(entry["symbol"])
    original = path.read_bytes()
    manifest = userdata.load_manifest()
    bank.empty_start = bank.specs[1][0]

    job = _finished(bank, _start(bank))

    assert job["status"] == "failed", job
    assert "incomplete futures candle chunk" in job["error"]
    assert path.read_bytes() == original
    assert userdata.load_manifest() == manifest
