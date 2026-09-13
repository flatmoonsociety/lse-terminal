"""Public Binance Spot candles, paginated into a resumable local checkpoint.

API contract: https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md
No credentials, trading endpoints, synthetic candles, or total-history row cap.
"""

from __future__ import annotations

import hashlib
import json
import math
import sqlite3
import threading
import time
from contextlib import closing
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
import pandas as pd

BASE_URL = "https://data-api.binance.vision"
TIMEFRAMES = ("1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w")
_MILLISECONDS = dict(zip(TIMEFRAMES, (60_000, 300_000, 900_000, 1_800_000,
                                    3_600_000, 14_400_000, 86_400_000, 604_800_000)))
# ponytail: one request/import lock per process. Per-symbol locks are unnecessary
# until concurrent download throughput matters; Binance quotas are shared by IP.
_REQUEST_LOCK = threading.Lock()
_DOWNLOAD_LOCK = threading.Lock()
_NEXT_REQUEST = 0.0
_WEIGHT_LIMITS = {60: 6000}
_EXCHANGE_CACHE = None
_EXCHANGE_AT = 0.0


class BinanceError(RuntimeError):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def _pause(progress, detail, seconds):
    progress(detail=detail, retry_at=time.time() + seconds)
    while seconds > 0:
        step = min(seconds, 30)
        time.sleep(step)
        seconds -= step


def _retry_after(value, fallback):
    try:
        seconds = float(value)
    except (ValueError, TypeError):
        try:
            seconds = parsedate_to_datetime(value).timestamp() - time.time()
        except (ValueError, TypeError, OverflowError):
            seconds = fallback
    return max(0.0, seconds) if math.isfinite(seconds) else fallback


def _request(path: str, params=None, progress=lambda **_: None):
    """GET with process-wide throttling and bounded, resumable retries."""
    global _NEXT_REQUEST
    url = BASE_URL + "/api/v3/" + path
    if params:
        url += "?" + urlencode(params)
    with _REQUEST_LOCK:
        for attempt in range(6):
            wait = max(0, _NEXT_REQUEST - time.monotonic())
            if wait > 600:
                raise BinanceError(f"Binance cooldown: retry in {math.ceil(wait)} seconds; "
                                   "download progress is saved", 429)
            if wait:
                _pause(progress, "waiting for Binance request allowance", wait)
            try:
                with urlopen(Request(url, headers={"User-Agent": "LSE-Terminal/0.0.15"}),
                             timeout=30) as response:
                    payload = json.load(response)
                    headers = response.headers
                _NEXT_REQUEST = time.monotonic() + 0.2
                # Read the IP's actual consumption, including other programs.
                units = {"S": 1, "M": 60, "H": 3600, "D": 86400}
                for key, value in headers.items():
                    suffix = key.lower().removeprefix("x-mbx-used-weight-")
                    if key.lower().startswith("x-mbx-used-weight-") and suffix[:-1].isdigit():
                        interval = int(suffix[:-1]) * units.get(suffix[-1:].upper(), 0)
                        cap = _WEIGHT_LIMITS.get(interval)
                        if cap and int(value) >= cap * 0.9:
                            until_reset = interval - time.time() % interval + 1
                            _NEXT_REQUEST = max(_NEXT_REQUEST, time.monotonic() + until_reset)
                progress(retry_at=None)
                return payload
            except HTTPError as exc:
                try:
                    payload = json.loads(exc.read())
                    message = str(payload.get("msg") or exc.reason)
                except (ValueError, AttributeError):
                    message = str(exc.reason)
                if exc.code not in (418, 429, 408, 500, 502, 503, 504):
                    if exc.code in (403, 451):
                        message = "public market data is unavailable from this location/network: " + message
                    raise BinanceError("Binance: " + message, exc.code) from exc
                delay = _retry_after(exc.headers.get("Retry-After"),
                                     60 * 2 ** attempt if exc.code in (418, 429) else 2 ** attempt)
                _NEXT_REQUEST = time.monotonic() + delay
                if attempt == 5 or delay > 600:
                    raise BinanceError(f"Binance HTTP {exc.code}: {message}; retry in "
                                       f"{math.ceil(delay)} seconds. Download progress is saved",
                                       exc.code) from exc
            except (URLError, TimeoutError, OSError) as exc:
                _NEXT_REQUEST = time.monotonic() + 2 ** attempt
                if attempt == 5:
                    raise BinanceError("Binance connection failed; download progress is saved: "
                                       + str(exc)) from exc
            except (ValueError, TypeError) as exc:
                raise BinanceError("Binance returned an invalid response") from exc


def _symbol(symbol):
    symbol = str(symbol).strip().upper()
    if not symbol or len(symbol) > 40 or not symbol.isalnum():
        raise ValueError("choose a Binance Spot symbol such as BTCUSDT")
    return symbol


def _exchange_info():
    global _EXCHANGE_CACHE, _EXCHANGE_AT, _WEIGHT_LIMITS
    if _EXCHANGE_CACHE is None or time.monotonic() - _EXCHANGE_AT > 600:
        data = _request("exchangeInfo", {"permissions": "SPOT", "showPermissionSets": "false"})
        if not isinstance(data, dict) or not isinstance(data.get("symbols"), list):
            raise BinanceError("Binance returned an invalid symbol catalog")
        units = {"SECOND": 1, "MINUTE": 60, "HOUR": 3600, "DAY": 86400}
        limits = {units[r["interval"]] * int(r["intervalNum"]): int(r["limit"])
                  for r in data.get("rateLimits", [])
                  if r.get("rateLimitType") == "REQUEST_WEIGHT" and r.get("interval") in units}
        _WEIGHT_LIMITS = limits or _WEIGHT_LIMITS
        _EXCHANGE_CACHE, _EXCHANGE_AT = data, time.monotonic()
    return _EXCHANGE_CACHE


def overview():
    return {"meta": {"candle_classes": ["spot"], "synth_candle_classes": [],
                     "series_classes": [], "timeframes": list(TIMEFRAMES)},
            "reference": [], "usage": None}


def catalog(query="", limit=300):
    query = query.strip().upper()
    rows = [{"symbol": r["symbol"], "name": f"{r['baseAsset']} / {r['quoteAsset']}",
             "base_asset": r["baseAsset"], "quote_asset": r["quoteAsset"],
             "status": r.get("status", ""), "dataset": "spot"}
            for r in _exchange_info()["symbols"]]
    matches = [r for r in rows if query in r["symbol"].upper() or query in r["name"].upper()]
    matches.sort(key=lambda r: (not r["symbol"].upper().startswith(query),
                               r["quote_asset"] != "USDT", r["symbol"]))
    return {"total": len(rows), "rows": matches[:max(1, min(int(limit), 1000))]}


def _time_ms(progress=lambda **_: None):
    value = _request("time", progress=progress)
    if not isinstance(value, dict) or not isinstance(value.get("serverTime"), int):
        raise BinanceError("Binance returned invalid server time")
    return value["serverTime"]


def _iso(timestamp):
    return datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc).isoformat()


def metadata(symbol):
    symbol = _symbol(symbol)
    row = next((r for r in catalog(symbol, 1000)["rows"] if r["symbol"] == symbol), None)
    if row is None:
        raise ValueError("unknown Binance Spot symbol: " + symbol)
    now = _time_ms()
    first = _request("klines", {"symbol": symbol, "interval": "1m", "startTime": 0, "limit": 1})
    last = _request("klines", {"symbol": symbol, "interval": "1m", "endTime": now - 1, "limit": 2})
    first = _parse_rows(first, 0, now, 60_000)
    last = _parse_rows(last, 0, now, 60_000)
    return {**row, "first_tick": _iso(first[0][0]) if first else None,
            "last_tick": _iso(last[-1][0]) if last else None,
            "timeframes": list(TIMEFRAMES)}


def _bounds(start, end, now):
    def parse(value):
        try:
            stamp = pd.Timestamp(value)
            stamp = stamp.tz_localize("UTC") if stamp.tzinfo is None else stamp.tz_convert("UTC")
            if pd.isna(stamp):
                raise ValueError()
            return stamp
        except (ValueError, TypeError, OverflowError) as exc:
            raise ValueError("use valid UTC dates or ISO timestamps for the Binance date range") from exc
    first = int(parse(start).timestamp() * 1000) if start else 0
    finish = now
    if end:
        stamp = parse(end)
        if len(end) == 10:
            stamp += pd.Timedelta(days=1)
        finish = min(now, int(stamp.timestamp() * 1000))
    if first < 0 or first >= finish:
        raise ValueError("Binance start must precede the end and the current time")
    return first, finish


def _parse_rows(rows, start, finish, interval):
    if not isinstance(rows, list) or len(rows) > 1000:
        raise BinanceError("Binance returned an invalid candle page")
    parsed, previous = [], -1
    for row in rows:
        try:
            if not isinstance(row, list) or len(row) < 7:
                raise ValueError()
            ts, close_ts = int(row[0]), int(row[6])
            o, h, l, c, v = map(float, row[1:6])
            if (ts != row[0] or close_ts != row[6] or ts < start or ts >= finish
                    or ts <= previous or not ts <= close_ts < ts + interval
                    or not all(math.isfinite(x) for x in (o, h, l, c, v))
                    or min(o, h, l, c) <= 0 or v < 0 or l > min(o, c) or h < max(o, c)):
                raise ValueError()
            previous = ts
            # Historical exchange interruptions can produce shortened candles
            # (for example BTCUSDT 1d on 2018-02-08). Keep the provider's bar,
            # but require its full scheduled interval to have elapsed.
            if ts + interval <= finish:
                parsed.append((ts, o, h, l, c, v, close_ts))
        except (ValueError, TypeError, OverflowError) as exc:
            raise BinanceError("Binance returned invalid, unordered or duplicate OHLCV candles") from exc
    return parsed


def download(symbol, timeframe, start, end, cache_dir: Path, progress=lambda **_: None):
    """Return closed OHLCV bars. Date-only ends include that entire UTC day.

    The cache holds one SQLite file per symbol/interval/requested range; every
    verified page is committed atomically. A retry with blank end extends the
    same file as new bars close. Library replacement is the caller's job.
    """
    symbol = _symbol(symbol)
    if timeframe not in TIMEFRAMES:
        raise ValueError("unsupported Binance interval; choose " + ", ".join(TIMEFRAMES))
    now = _time_ms(progress)
    first, finish = _bounds(start, end, now)
    interval = _MILLISECONDS[timeframe]
    identity = json.dumps([1, symbol, timeframe, first, end or ""], ensure_ascii=True)
    path = Path(cache_dir) / (hashlib.sha256(identity.encode()).hexdigest() + ".sqlite3")
    path.parent.mkdir(parents=True, exist_ok=True)
    progress(detail="waiting for the current Binance download")
    with _DOWNLOAD_LOCK, closing(sqlite3.connect(path)) as db:
        db.execute("CREATE TABLE IF NOT EXISTS candles "
                   "(ts INTEGER PRIMARY KEY, open REAL, high REAL, low REAL, close REAL, "
                   "volume REAL, close_ts INTEGER)")
        if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise BinanceError("Binance download checkpoint is damaged; remove " + str(path))
        count, latest = db.execute("SELECT COUNT(*), MAX(ts) FROM candles").fetchone()
        cursor = latest + interval if latest is not None else first
        progress(rows=count, detail=f"resuming {count:,} verified candles" if count else "downloading Binance candles")
        pages = 0
        while cursor < finish:
            rows = _request("klines", {"symbol": symbol, "interval": timeframe,
                                      "startTime": cursor, "endTime": finish - 1, "limit": 1000}, progress)
            page = _parse_rows(rows, cursor, finish, interval)
            if not page:
                break
            db.executemany("INSERT INTO candles VALUES (?, ?, ?, ?, ?, ?, ?)", page)
            db.commit()
            count += len(page)
            pages += 1
            cursor = page[-1][0] + interval
            progress(rows=count, pages_done=pages, last_timestamp=_iso(page[-1][0]),
                     detail=f"downloaded {count:,} candles through {_iso(page[-1][0])}", retry_at=None)
            if len(page) != len(rows):
                break  # The final open candle is deliberately not cached.

        # Independent edge checks prevent a silent truncated success, including
        # a damaged checkpoint that lost its earliest rows.
        head = _request("klines", {"symbol": symbol, "interval": timeframe, "startTime": first,
                                  "endTime": finish - 1, "limit": 1}, progress)
        head = _parse_rows(head, first, finish, interval)
        tail = _request("klines", {"symbol": symbol, "interval": timeframe,
                                  "endTime": finish - 1, "limit": 2}, progress)
        tail = [r for r in _parse_rows(tail, 0, finish, interval) if r[0] >= first]
        actual = db.execute("SELECT MIN(ts), MAX(ts) FROM candles").fetchone()
        if actual != (head[0][0] if head else None, tail[-1][0] if tail else None):
            raise BinanceError("Binance history is incomplete; retry to resume the saved download")
        frame = pd.read_sql_query("SELECT * FROM candles ORDER BY ts", db)
    if frame.empty:
        raise ValueError("Binance has no closed candles in this date range")
    values = frame[["open", "high", "low", "close", "volume"]].to_numpy()
    if (not np.isfinite(values).all() or (values[:, :4] <= 0).any() or (values[:, 4] < 0).any()
            or (frame.low > frame[["open", "close"]].min(axis=1)).any()
            or (frame.high < frame[["open", "close"]].max(axis=1)).any()
            or (frame.ts < first).any() or (frame.ts + interval > finish).any()
            or (frame.close_ts < frame.ts).any() or (frame.close_ts >= frame.ts + interval).any()):
        raise BinanceError("Binance download checkpoint contains invalid candles; remove " + str(path))
    frame["ts"] = pd.to_datetime(frame["ts"], unit="ms", utc=True)
    progress(rows=len(frame), first_timestamp=str(frame.ts.iloc[0]), last_timestamp=str(frame.ts.iloc[-1]),
             detail=f"validated {len(frame):,} closed Binance candles", retry_at=None)
    return frame.drop(columns="close_ts")
