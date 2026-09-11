"""Quota-aware vault exports with on-disk checkpoints for interrupted imports."""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from datetime import timedelta
from pathlib import Path

import pandas as pd

# ponytail: serialize this terminal's exports; use per-account locks only if
# multiple-account throughput becomes necessary. Polls never create new jobs.
_EXPORT_LOCK = threading.Lock()
_SECONDS = {"1s": 1, "5s": 5, "15s": 15, "30s": 30, "1m": 60,
            "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
            "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800,
            "1mo": 2678400}


def candle_ranges(first: str, last: str, timeframe: str):
    """Inclusive UI dates or exact half-open timestamps -> bounded ranges."""
    cursor, finish = pd.to_datetime(first, utc=True), pd.to_datetime(last, utc=True)
    if len(last) == 10:
        finish += timedelta(days=1)
    if cursor >= finish:
        raise ValueError("the requested futures date range is reversed")
    # At most one candle per interval, even for a 24/7 instrument. Leave room
    # below the observed 2.5m ceiling; longer candles need no more than 4 years.
    days = min(1461, max(1, 2_000_000 * _SECONDS[timeframe] // 86400))
    while cursor < finish:
        end = min(cursor + timedelta(days=days), finish)
        # The gate expects UTC without a timezone suffix.
        yield cursor.tz_localize(None).isoformat(), end.tz_localize(None).isoformat()
        cursor = end


def validate_candles(raw, start: str, end: str, timeframe: str):
    if "ts" not in raw or len(raw) >= 2_500_000:
        raise ValueError("vault candle chunk is missing timestamps or hit the export row ceiling")
    stamps = pd.to_datetime(raw["ts"], utc=True)
    if (stamps.isna().any() or stamps.duplicated().any()
            or (stamps < pd.Timestamp(start, tz="UTC")).any()
            or (stamps >= pd.Timestamp(end, tz="UTC")).any()):
        raise ValueError("vault candle chunk has invalid, duplicate or out-of-range timestamps")
    minimum_seconds = 28 * 86400 if timeframe == "1mo" else _SECONDS[timeframe]
    if len(stamps) > ((pd.Timestamp(end) - pd.Timestamp(start)).total_seconds()
                      // minimum_seconds + 1):
        raise ValueError("vault candle chunk has more rows than its requested resolution allows")


def validate_coverage(raw, catalog: dict, timeframe: str, start: str, end: str):
    """Unbounded ends must reach the catalog to within one candle interval."""
    stamps = pd.to_datetime(raw["ts"], utc=True)
    for field, actual, requested in (
            ("first_tick", stamps.min(), start), ("last_tick", stamps.max(), end)):
        if requested or not catalog.get(field):
            continue
        expected = pd.to_datetime(catalog[field], utc=True)
        # The catalog can lag live candles. Extra coverage is valid; reject
        # only an export that starts later or ends earlier than advertised.
        missing = ((actual - expected).total_seconds() if field == "first_tick"
                   else (expected - actual).total_seconds())
        if pd.isna(actual) or missing >= _SECONDS[timeframe]:
            raise ValueError(f"incomplete futures history: {field} is {actual}; catalog reports {expected}")


def validate_chunk_edges(client, payload: dict, raw):
    """Check each exported range against the candle endpoint, including holidays.

    Endpoint checks detect export truncation; they do not assert that the
    provider recorded every interval inside the range.
    """
    from numbers import Real

    def timestamp(value):
        if isinstance(value, Real):
            unit = "ms" if abs(value) >= 1e11 else "s"
            result = pd.to_datetime(value, unit=unit, utc=True)
        else:
            result = pd.to_datetime(value, utc=True)
        if pd.isna(result):
            raise ValueError("vault candle coverage probe has no valid timestamp")
        return result

    if "ts" not in raw:
        raise ValueError("vault candle chunk is missing timestamps")
    stamps = raw["ts"]
    if pd.api.types.is_numeric_dtype(stamps):
        unit = "ms" if stamps.abs().max() >= 1e11 else "s"
        stamps = pd.to_datetime(stamps, unit=unit, utc=True)
    else:
        stamps = pd.to_datetime(stamps, utc=True)
    if stamps.isna().any():
        raise ValueError("vault candle chunk has invalid timestamps")

    for order, actual in (("asc", stamps.min()), ("desc", stamps.max())):
        for attempt in range(3):
            try:
                rows = client.candles(
                    payload["symbol"], dataset=payload["dataset"],
                    timeframe=payload["timeframe"], start=payload["start"],
                    end=payload["end"], order=order, limit=1,
                )
                break
            except Exception as exc:
                if attempt == 2 or not _transient(exc):
                    raise
                _pause(lambda **_: None, "retrying candle coverage probe", 2 ** attempt)
        if len(rows) > 1:
            raise ValueError("vault candle coverage probe ignored its one-row limit")
        expected = None
        if rows:
            row = rows[0]
            value = row.get("timestamp")
            expected = timestamp(row.get("ts") if value is None else value)
        if (expected is None and not stamps.empty) or (expected is not None and
                (stamps.empty or actual != expected)):
            edge = "first" if order == "asc" else "last"
            raise ValueError(
                f"incomplete futures candle chunk {payload['start']} to {payload['end']}: "
                f"{edge} row is {actual}; candle endpoint reports {expected}"
            )


def _save(path: Path, state: dict):
    staged = path.with_suffix(".tmp")
    staged.write_text(json.dumps(state), encoding="utf-8")
    os.replace(staged, path)


def _sha256(path: Path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _pause(progress, detail: str, seconds: float):
    progress(detail=detail, retry_at=time.time() + seconds)
    # Keep waits interruptible by process shutdown and progress observable.
    while seconds > 0:
        interval = min(seconds, 60)
        time.sleep(interval)
        seconds -= interval


def _transient(exc):
    return (getattr(exc, "status", None) in (0, 408, 429, 500, 502, 503, 504)
            or isinstance(exc, OSError))


def export_file(client, payload: dict, root: Path, progress, *, snapshot: str = "") -> Path:
    """Reuse a checked file or provider job before spending another export slot.

    The SDK drops HTTP response headers; /usage is the service's authoritative
    hourly quota. 429 also covers other clients racing us, so it stays retryable.
    Failed transfers retain the SDK's .part and the job checkpoint on disk.
    """
    identity = json.dumps([getattr(client, "_api_key", ""), payload, snapshot], sort_keys=True)
    directory = root / hashlib.sha256(identity.encode()).hexdigest()
    progress(detail="waiting for the current vault export")
    with _EXPORT_LOCK:
        directory.mkdir(parents=True, exist_ok=True)
        checkpoint = directory / "job.json"
        path = directory / "data.parquet"
        state = json.loads(checkpoint.read_text()) if checkpoint.exists() else {}
        if path.exists() and state.get("sha256") == _sha256(path):
            progress(detail="reusing verified downloaded chunk", retry_at=None)
            return path
        if state.get("submitting"):
            raise RuntimeError("previous export submission has an unknown outcome; "
                               "no duplicate export was submitted")
        # A corrupt completed file must be fetched again from the SAME job.
        path.unlink(missing_ok=True)
        failures = 0
        while True:
            if not state.get("job_id"):
                try:
                    usage = client._vault_call("/usage")
                except Exception as exc:
                    if not _transient(exc):
                        raise
                    _pause(progress, "waiting to read the vault export quota", 60)
                    continue
                used, cap = usage.get("exports_this_hour", 0), usage.get("exports_cap_hour", -1)
                if cap is not None and cap >= 0 and used >= cap:
                    if cap == 0:
                        raise RuntimeError("this account has no vault export allowance")
                    progress(exports_used=used, exports_cap=cap)
                    _pause(progress, f"vault hourly export quota is full ({used}/{cap}); "
                           "checking again in 60s", 60)
                    continue
                state = {"payload": payload, "submitting": True}
                _save(checkpoint, state)
                try:
                    submitted = client._vault_call("/export", payload)
                except Exception as exc:
                    # An explicit 4xx means no job was created. A transport or
                    # 5xx response is ambiguous; do not blindly duplicate POSTs.
                    status = getattr(exc, "status", None)
                    if status is not None and 400 <= status < 500:
                        state = {}
                        _save(checkpoint, state)
                    if status != 429:
                        raise
                    failures += 1
                    delay = min(600, 60 * 2 ** min(failures - 1, 4))
                    _pause(progress, f"vault is busy; retrying in {delay}s", delay)
                    continue
                state = {"payload": payload, "job_id": submitted["job_id"]}
                _save(checkpoint, state)
                failures = 0
            provider_id = state["job_id"]
            progress(provider_job_id=provider_id, detail="the vault is building your chunk", retry_at=None)
            try:
                info = client._vault_call(f"/export/{provider_id}")
                status = info.get("status")
                if status == "expired":
                    state = {}
                    _save(checkpoint, state)
                    path.with_suffix(".parquet.part").unlink(missing_ok=True)
                    continue
                if status == "failed":
                    raise RuntimeError(f"vault export failed: {info.get('error') or provider_id}")
                if status != "ready":
                    _pause(progress, f"vault export {status or 'pending'}", 3)
                    continue
                progress(detail="downloading the completed vault chunk")
                part = path.with_suffix(".parquet.part")
                # A process may stop after the last byte but before rename.
                # Avoid a Range request starting at EOF (HTTP 416).
                if (part.exists() and info.get("sha256")
                        and part.stat().st_size == info.get("bytes")
                        and _sha256(part) == info["sha256"]):
                    os.replace(part, path)
                else:
                    client._vault_download(provider_id, path.name, str(directory), info)
                checksum = _sha256(path)
                if info.get("sha256") and info["sha256"] != checksum:
                    raise RuntimeError("vault download checksum mismatch; existing library file preserved")
                if info.get("rows") is not None:
                    import pyarrow.parquet as pq
                    if pq.ParquetFile(path).metadata.num_rows != int(info["rows"]):
                        raise RuntimeError("vault artifact row count differs from its job metadata")
                state.update(sha256=checksum, bytes=path.stat().st_size, rows=info.get("rows"))
                _save(checkpoint, state)
                return path
            except Exception as exc:
                if getattr(exc, "status", None) == 404:
                    state = {}
                    _save(checkpoint, state)
                    path.with_suffix(".parquet.part").unlink(missing_ok=True)
                    continue
                if not _transient(exc):
                    raise
                failures += 1
                if failures >= 8:
                    raise
                delay = min(300, 10 * 2 ** (failures - 1))
                _pause(progress, f"connection interrupted; resuming the same vault job in {delay}s", delay)
