"""Saved strategy reports, independent of editor tabs and source/data files.

SQLite transactions keep the summary and compressed result together. Listing
history reads only summaries, even when a run contains millions of curve points.
"""

from __future__ import annotations

from contextlib import contextmanager
import gzip
import json
import math
import re
import sqlite3
import time
import uuid

from lse_terminal.engine import config


@contextmanager
def _database():
    directory = config.config_dir()
    directory.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(directory / "saved-backtests.sqlite3", timeout=30)
    try:
        db.execute("PRAGMA auto_vacuum = FULL")  # deleting a large run returns its disk space
        with db:
            db.execute("""CREATE TABLE IF NOT EXISTS backtests (
                id TEXT PRIMARY KEY, created_at REAL NOT NULL,
                summary TEXT NOT NULL, payload BLOB NOT NULL
            )""")
            yield db
    finally:
        db.close()


def _validate_id(report_id: str) -> None:
    if not re.fullmatch(r"[a-f0-9]{32}", report_id):
        raise KeyError(report_id)


def create(name: str, result: dict, context: dict) -> dict:
    name = name.strip()
    if not name or len(name) > 200:
        raise ValueError("report name must contain 1 to 200 characters")
    for key in ("engine", "symbol", "timeframe"):
        if not isinstance(result.get(key), str) or not result[key]:
            raise ValueError(f"result.{key} is required")
    for key in ("initial_capital", "final_equity", "net_profit"):
        value = result.get(key)
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
            raise ValueError(f"result.{key} must be a finite number")
    for key, kind in (("stats", dict), ("trades", list), ("equity_curve", list)):
        if not isinstance(result.get(key), kind):
            raise ValueError(f"result.{key} must be a {kind.__name__}")
    for key, kind in (("benchmark_curve", list), ("plots", dict)):
        if key in result and not isinstance(result[key], kind):
            raise ValueError(f"result.{key} must be a {kind.__name__}")

    report_id, created_at = uuid.uuid4().hex, time.time()
    doc = {"schema_version": 1, "id": report_id, "name": name,
           "created_at": created_at, "result": result, "context": context}
    curve = result["equity_curve"]
    if curve and any(not isinstance(p, list) or len(p) != 2 for p in (curve[0], curve[-1])):
        raise ValueError("equity_curve must contain [timestamp, equity] pairs")
    summary = {
        "id": report_id, "name": name, "created_at": created_at,
        "strategy": context.get("strategy", ""),
        **{key: result[key] for key in ("engine", "symbol", "timeframe",
                                        "initial_capital", "final_equity", "net_profit")},
        "total_trades": len(result["trades"]),
        "win_rate": result["stats"].get("winRate"),
        "start_ts": curve[0][0] if curve else None,
        "end_ts": curve[-1][0] if curve else None,
        "elapsed_ms": context.get("elapsedMs"),
    }
    # Compression preserves every point and reduces long-run disk usage.
    payload = gzip.compress(json.dumps(doc, separators=(",", ":"),
                                       allow_nan=False).encode("utf-8"), compresslevel=1)
    with _database() as db:
        db.execute("INSERT INTO backtests VALUES (?, ?, ?, ?)",
                   (report_id, created_at, json.dumps(summary, allow_nan=False), payload))
    return summary


def listing() -> list[dict]:
    with _database() as db:
        return [json.loads(row[0]) for row in db.execute(
            "SELECT summary FROM backtests ORDER BY created_at DESC, id DESC")]


def read(report_id: str) -> dict:
    _validate_id(report_id)
    with _database() as db:
        row = db.execute("SELECT payload FROM backtests WHERE id = ?", (report_id,)).fetchone()
    if row is None:
        raise KeyError(report_id)
    return json.loads(gzip.decompress(row[0]))


def delete(report_id: str) -> None:
    _validate_id(report_id)
    with _database() as db:
        deleted = db.execute("DELETE FROM backtests WHERE id = ?", (report_id,))
        if not deleted.rowcount:
            raise KeyError(report_id)
