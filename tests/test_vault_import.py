import hashlib
from pathlib import Path

import pandas as pd
import pytest

from lse_terminal.providers import vault_import


PAYLOAD = {
    "dataset": "futures", "symbol": "NQ.F", "timeframe": "1m",
    "start": "2023-08-14", "end": "2023-08-15", "format": "parquet",
}


class VaultError(Exception):
    def __init__(self, status):
        self.status = status
        super().__init__(f"vault HTTP {status}")


class FakeVault:
    _api_key = "test-key"

    def __init__(self, *, usage=(), submissions=(), polls=(), downloads=()):
        self.usage = list(usage)
        self.submissions = list(submissions)
        self.polls = list(polls)
        self.downloads = list(downloads)
        self.calls = []
        self.download_calls = []
        self.partial_reads = []

    @staticmethod
    def outcome(queue, default):
        value = queue.pop(0) if queue else default
        if isinstance(value, Exception):
            raise value
        return value

    def _vault_call(self, path, payload=None):
        self.calls.append((path, payload))
        if path == "/usage":
            return self.outcome(self.usage, {
                "exports_this_hour": 0, "exports_cap_hour": 5,
                "vault_concurrency": 2,
            })
        if path == "/export":
            return self.outcome(self.submissions, {"job_id": "provider-1"})
        assert path == "/export/provider-1"
        return self.outcome(self.polls, {"status": "ready"})

    def _vault_download(self, provider_id, name, dest, info):
        self.download_calls.append(provider_id)
        path = Path(dest) / name
        part = path.with_suffix(".parquet.part")
        self.partial_reads.append(part.read_bytes() if part.exists() else b"")
        try:
            self.outcome(self.downloads, None)
        except Exception:
            part.write_bytes(b"partial")
            raise
        path.write_bytes(b"complete-parquet-fixture")
        part.unlink(missing_ok=True)
        return str(path)


@pytest.fixture
def sleeps(monkeypatch):
    calls = []
    monkeypatch.setattr(vault_import.time, "sleep", calls.append)
    return calls


def export(client, root, progress=lambda **_: None):
    return vault_import.export_file(client, PAYLOAD, root, progress)


def posts(client):
    return [payload for path, payload in client.calls if path == "/export"]


def test_export_waits_for_hourly_quota_before_submitting(tmp_path, sleeps):
    full = {"exports_this_hour": 5, "exports_cap_hour": 5}
    client = FakeVault(usage=[full, full])
    updates = []

    def progress(**update):
        updates.append(update)
        if "checking again" in update.get("detail", ""):
            assert posts(client) == []

    assert export(client, tmp_path, progress).exists()
    assert [path for path, _ in client.calls[:4]] == [
        "/usage", "/usage", "/usage", "/export",
    ]
    assert posts(client) == [PAYLOAD]
    assert sleeps == [60, 60]
    assert sum(update.get("exports_used") == 5 for update in updates) == 2


def test_rejected_429_submission_waits_and_retries(tmp_path, sleeps):
    client = FakeVault(submissions=[VaultError(429)])
    assert export(client, tmp_path).exists()
    assert posts(client) == [PAYLOAD, PAYLOAD]
    assert sleeps == [60]
    assert client.download_calls == ["provider-1"]


def test_poll_and_transfer_errors_resume_one_provider_job(tmp_path, sleeps):
    client = FakeVault(polls=[VaultError(503)], downloads=[OSError("interrupted")])
    assert export(client, tmp_path).exists()
    assert posts(client) == [PAYLOAD]
    assert client.download_calls == ["provider-1", "provider-1"]
    assert client.partial_reads == [b"", b"partial"]
    assert sleeps == [10, 20]


def test_rerun_resumes_checkpoint_and_then_reuses_completed_file(tmp_path, sleeps):
    interrupted = FakeVault(downloads=[RuntimeError("process stopped")])
    with pytest.raises(RuntimeError, match="process stopped"):
        export(interrupted, tmp_path)
    assert posts(interrupted) == [PAYLOAD]

    resumed = FakeVault(usage=[VaultError(401)], submissions=[VaultError(401)])
    path = export(resumed, tmp_path)
    assert resumed.calls == [("/export/provider-1", None)]
    assert resumed.partial_reads == [b"partial"]
    assert path.read_bytes() == b"complete-parquet-fixture"

    completed = FakeVault(usage=[VaultError(401)], polls=[VaultError(401)])
    assert export(completed, tmp_path) == path
    assert completed.calls == []
    assert completed.download_calls == []
    assert sleeps == []


def test_complete_partial_is_verified_and_promoted_without_redownload(tmp_path, sleeps):
    interrupted = FakeVault(downloads=[RuntimeError("process stopped")])
    with pytest.raises(RuntimeError, match="process stopped"):
        export(interrupted, tmp_path)
    complete = b"complete-parquet-fixture"
    partial = next(tmp_path.glob("*/data.parquet.part"))
    partial.write_bytes(complete)
    resumed = FakeVault(polls=[{
        "status": "ready", "bytes": len(complete),
        "sha256": hashlib.sha256(complete).hexdigest(),
    }])

    path = export(resumed, tmp_path)
    assert path.read_bytes() == complete
    assert not partial.exists()
    assert resumed.calls == [("/export/provider-1", None)]
    assert resumed.download_calls == []
    assert sleeps == []

    verified = FakeVault()
    assert export(verified, tmp_path) == path
    assert verified.calls == []


@pytest.mark.parametrize("phase", ["usage", "submissions", "polls", "downloads"])
def test_fatal_authorization_error_is_not_retried(tmp_path, sleeps, phase):
    client = FakeVault(**{phase: [VaultError(401)]})
    with pytest.raises(VaultError) as caught:
        export(client, tmp_path)
    assert caught.value.status == 401
    assert sleeps == []
    if phase == "usage":
        assert client.calls == [("/usage", None)]
    elif phase == "submissions":
        assert posts(client) == [PAYLOAD]
    elif phase == "polls":
        assert sum(path.startswith("/export/") for path, _ in client.calls) == 1
    else:
        assert client.download_calls == ["provider-1"]


@pytest.mark.parametrize("status", [0, 500])
def test_ambiguous_submission_is_not_reposted_after_rerun(tmp_path, sleeps, status):
    client = FakeVault(submissions=[VaultError(status)])
    with pytest.raises(VaultError):
        export(client, tmp_path)
    assert posts(client) == [PAYLOAD]

    rerun = FakeVault()
    with pytest.raises(RuntimeError, match="unknown outcome"):
        export(rerun, tmp_path)
    assert rerun.calls == []
    assert rerun.download_calls == []
    assert sleeps == []


@pytest.mark.parametrize("timeframe,seconds", [("1s", 1), ("5s", 5), ("15s", 15), ("30s", 30), ("1m", 60)])
def test_ranges_cover_every_date_below_export_row_ceiling(timeframe, seconds):
    ranges = list(vault_import.candle_ranges("2016-05-29", "2026-09-11", timeframe))
    assert pd.Timestamp(ranges[0][0]) == pd.Timestamp("2016-05-29")
    assert pd.Timestamp(ranges[-1][1]) == pd.Timestamp("2026-09-12")
    for index, (start, end) in enumerate(ranges):
        duration = (pd.Timestamp(end) - pd.Timestamp(start)).total_seconds()
        assert 0 < duration / seconds <= 2_000_000
        if index:
            assert ranges[index - 1][1] == start


def test_intraday_ranges_preserve_exact_bounds_in_utc():
    ranges = list(vault_import.candle_ranges(
        "2023-08-15T09:35:00-04:00", "2023-08-15T10:25:00-04:00", "1m",
    ))
    assert ranges == [("2023-08-15T13:35:00", "2023-08-15T14:25:00")]
