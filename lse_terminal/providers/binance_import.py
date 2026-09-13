"""Public Binance Spot, USD-M and COIN-M candles in resumable checkpoints.

API contracts:
https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md
https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Kline-Candlestick-Data
https://developers.binance.com/docs/derivatives/coin-margined-futures/market-data/Kline-Candlestick-Data
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

MARKET_NAMES = {"spot": "Spot", "usdm": "USD-M Futures", "coinm": "COIN-M Futures"}
_URLS = {"spot": "https://data-api.binance.vision/api/v3/",
         "usdm": "https://fapi.binance.com/fapi/v1/",
         "coinm": "https://dapi.binance.com/dapi/v1/"}
_DAY = 86_400_000
_MAX_FUTURES_WINDOW = 200 * _DAY
TIMEFRAMES = ("1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w")
_MILLISECONDS = dict(zip(TIMEFRAMES, (60_000, 300_000, 900_000, 1_800_000,
                                    3_600_000, 14_400_000, 86_400_000, 604_800_000)))
# ponytail: one request/import lock per process. Per-symbol locks are unnecessary
# until concurrent download throughput matters; Binance quotas are shared by IP.
_REQUEST_LOCK = threading.Lock()
_DOWNLOAD_LOCK = threading.Lock()
_NEXT_REQUEST = dict.fromkeys(MARKET_NAMES, 0.0)
_WEIGHT_LIMITS = {market: {60: 6000 if market == "spot" else 2400} for market in MARKET_NAMES}
_EXCHANGE_CACHE = {}
_EXCHANGE_AT = {}
_METADATA_CACHE = {}


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


def _request(path: str, params=None, progress=lambda **_: None, dataset="spot"):
    """GET with process-wide throttling and bounded, resumable retries."""
    dataset = _dataset(dataset)
    url = _URLS[dataset] + path
    if params:
        url += "?" + urlencode(params)
    with _REQUEST_LOCK:
        for attempt in range(6):
            wait = max(0, _NEXT_REQUEST[dataset] - time.monotonic())
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
                _NEXT_REQUEST[dataset] = time.monotonic() + 0.2
                # Read the IP's actual consumption, including other programs.
                units = {"S": 1, "M": 60, "H": 3600, "D": 86400}
                for key, value in headers.items():
                    suffix = key.lower().removeprefix("x-mbx-used-weight-")
                    if key.lower().startswith("x-mbx-used-weight-") and suffix[:-1].isdigit():
                        interval = int(suffix[:-1]) * units.get(suffix[-1:].upper(), 0)
                        cap = _WEIGHT_LIMITS[dataset].get(interval)
                        if cap and int(value) >= cap * 0.9:
                            until_reset = interval - time.time() % interval + 1
                            _NEXT_REQUEST[dataset] = max(_NEXT_REQUEST[dataset], time.monotonic() + until_reset)
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
                _NEXT_REQUEST[dataset] = time.monotonic() + delay
                if attempt == 5 or delay > 600:
                    raise BinanceError(f"Binance HTTP {exc.code}: {message}; retry in "
                                       f"{math.ceil(delay)} seconds. Download progress is saved",
                                       exc.code) from exc
            except (URLError, TimeoutError, OSError) as exc:
                _NEXT_REQUEST[dataset] = time.monotonic() + 2 ** attempt
                if attempt == 5:
                    raise BinanceError("Binance connection failed; download progress is saved: "
                                       + str(exc)) from exc
            except (ValueError, TypeError) as exc:
                raise BinanceError("Binance returned an invalid response") from exc


def _dataset(dataset):
    if dataset not in MARKET_NAMES:
        raise ValueError("choose a Binance market: " + ", ".join(MARKET_NAMES))
    return dataset


def _symbol(symbol):
    symbol = str(symbol).strip().upper()
    if not symbol or len(symbol) > 40 or not symbol[0].isalnum() or not symbol.replace("_", "").isalnum():
        raise ValueError("choose a Binance symbol such as BTCUSDT or BTCUSD_PERP")
    return symbol


def _exchange_info(dataset="spot"):
    dataset = _dataset(dataset)
    if dataset not in _EXCHANGE_CACHE or time.monotonic() - _EXCHANGE_AT[dataset] > 600:
        params = {"permissions": "SPOT", "showPermissionSets": "false"} if dataset == "spot" else None
        data = _request("exchangeInfo", params, dataset=dataset)
        if not isinstance(data, dict) or not isinstance(data.get("symbols"), list):
            raise BinanceError("Binance returned an invalid symbol catalog")
        units = {"SECOND": 1, "MINUTE": 60, "HOUR": 3600, "DAY": 86400}
        limits = {units[r["interval"]] * int(r["intervalNum"]): int(r["limit"])
                  for r in data.get("rateLimits", [])
                  if r.get("rateLimitType") == "REQUEST_WEIGHT" and r.get("interval") in units}
        _WEIGHT_LIMITS[dataset] = limits or _WEIGHT_LIMITS[dataset]
        _EXCHANGE_CACHE[dataset], _EXCHANGE_AT[dataset] = data, time.monotonic()
    return _EXCHANGE_CACHE[dataset]


def overview():
    return {"meta": {"candle_classes": list(MARKET_NAMES), "synth_candle_classes": [],
                     "series_classes": [], "timeframes": list(TIMEFRAMES)},
            "reference": [], "usage": None}


def catalog(query="", limit=300, dataset="spot"):
    dataset = _dataset(dataset)
    query = query.strip().upper()
    rows = []
    for r in _exchange_info(dataset)["symbols"]:
        contract = r.get("contractType", "")
        name = f"{r['baseAsset']} / {r['quoteAsset']}"
        if contract:
            name += " · " + contract.replace("_", " ").title()
        rows.append({"symbol": r["symbol"], "name": name,
                     "base_asset": r["baseAsset"], "quote_asset": r["quoteAsset"],
                     "margin_asset": r.get("marginAsset"), "contract_type": contract or None,
                     "contract_size": r.get("contractSize"),
                     "status": r.get("contractStatus", r.get("status", "")), "dataset": dataset,
                     "onboard_date": _iso(r["onboardDate"]) if r.get("onboardDate") else None,
                     "delivery_date": _iso(r["deliveryDate"]) if r.get("deliveryDate") else None,
                     "volume_unit": "contracts" if dataset == "coinm" else "base asset"})
    matches = [r for r in rows if query in r["symbol"].upper() or query in r["name"].upper()]
    matches.sort(key=lambda r: (not r["symbol"].upper().startswith(query),
                               r["quote_asset"] != "USDT", r["symbol"]))
    return {"total": len(rows), "rows": matches[:max(1, min(int(limit), 1000))]}


def _instrument(symbol, dataset):
    row = next((r for r in catalog(symbol, 1000, dataset)["rows"] if r["symbol"] == symbol), None)
    if row is None:
        raise ValueError(f"unknown Binance {MARKET_NAMES[dataset]} symbol: {symbol}")
    return row


def _time_ms(progress=lambda **_: None, dataset="spot"):
    value = _request("time", progress=progress, dataset=dataset)
    if not isinstance(value, dict) or not isinstance(value.get("serverTime"), int):
        raise BinanceError("Binance returned invalid server time")
    return value["serverTime"]


def _iso(timestamp):
    return datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc).isoformat()


def _delivery_end(row, finish):
    # Binance can emit flat, zero-volume candles long after a contract settles.
    # Contract history ends at delivery, even if the API still emits those rows.
    return min(finish, int(pd.Timestamp(row["delivery_date"]).timestamp() * 1000)) if row.get("delivery_date") else finish


def _first_candle(symbol, timeframe, start, finish, dataset, progress=lambda **_: None):
    interval = _MILLISECONDS[timeframe]
    if dataset != "coinm":
        rows = _request("klines", {"symbol": symbol, "interval": timeframe,
                                  "startTime": start, "endTime": finish - 1, "limit": 1},
                        progress, dataset=dataset)
        return _parse_rows(rows, start, finish, interval)
    # COIN-M documentation permits the *last* `limit` rows of <=200-day ranges.
    # Find the first populated day in complete daily windows, then inspect at
    # most two bounded minute pages. No onboard-date assumption (it can differ
    # from the actual first candle). Binance did not exist before 2017.
    day = max(start // _DAY * _DAY, 1483228800000)
    while day < finish:
        stop = min(finish, day + _MAX_FUTURES_WINDOW)
        raw = _request("klines", {"symbol": symbol, "interval": "1d", "startTime": day,
                                 "endTime": stop - 1, "limit": 1000}, progress, dataset=dataset)
        coarse = _parse_rows(raw, day, stop + _DAY, _DAY)
        if any(r[0] >= stop for r in coarse):
            raise BinanceError("Binance returned candles outside the requested window")
        if coarse:
            # Weekly bars open on Monday, potentially before the first daily bar.
            cursor = max(start, coarse[0][0] - (6 * _DAY if timeframe == "1w" else 0))
            while cursor < min(finish, coarse[0][0] + _DAY):
                stop = min(finish, cursor + min(1000 * interval, _MAX_FUTURES_WINDOW))
                raw = _request("klines", {"symbol": symbol, "interval": timeframe, "startTime": cursor,
                                         "endTime": stop - 1, "limit": 1000}, progress, dataset=dataset)
                page = _parse_rows(raw, cursor, finish, interval)
                if any(r[0] >= stop for r in page):
                    raise BinanceError("Binance returned candles outside the requested window")
                if page:
                    return page[:1]
                cursor = stop
            # A custom start can fall after the last bar of this day. Continue
            # looking at later populated days instead of declaring no history.
            day = coarse[0][0] + _DAY
            continue
        day = stop
    return []


def _last_candle(symbol, timeframe, start, finish, dataset, progress=lambda **_: None):
    rows = _request("klines", {"symbol": symbol, "interval": timeframe,
                              "endTime": finish - 1, "limit": 2}, progress, dataset=dataset)
    return [r for r in _parse_rows(rows, 0, finish, _MILLISECONDS[timeframe]) if r[0] >= start][-1:]


def metadata(symbol, dataset="spot", timeframe="1m"):
    dataset, symbol = _dataset(dataset), _symbol(symbol)
    if timeframe not in TIMEFRAMES:
        raise ValueError("unsupported Binance interval; choose " + ", ".join(TIMEFRAMES))
    key = (dataset, symbol, timeframe)
    cached = _METADATA_CACHE.get(key)
    if cached and time.monotonic() - cached[0] < 60:
        return dict(cached[1])
    row = _instrument(symbol, dataset)
    now = _delivery_end(row, _time_ms(dataset=dataset))
    first = _first_candle(symbol, timeframe, 0, now, dataset)
    last = _last_candle(symbol, timeframe, 0, now, dataset)
    available = bool(first and last)
    span = last[-1][0] - first[0][0] + _MILLISECONDS[timeframe] if available else 0
    result = {**row, "first_tick": _iso(first[0][0]) if available else None,
              "last_tick": _iso(last[-1][0]) if available else None,
              "timeframes": list(TIMEFRAMES), "timeframe": timeframe,
              "available_history": available, "days": span / _DAY, "years": span / (_DAY * 365.25),
              "estimated_bars": span // _MILLISECONDS[timeframe],
              "estimate_note": "Estimate from first/last closed candle; exchange gaps may reduce the actual count."}
    _METADATA_CACHE[key] = (time.monotonic(), result)
    return dict(result)


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


def download(symbol, timeframe, start, end, cache_dir: Path, progress=lambda **_: None, dataset="spot"):
    """Return closed OHLCV bars. Date-only ends include that entire UTC day.

    The cache holds one SQLite file per symbol/interval/requested range; every
    verified page is committed atomically. A retry with blank end extends the
    same file as new bars close. Library replacement is the caller's job.
    Volume is native base-asset quantity for Spot/USD-M, contracts for COIN-M.
    These are individual contract candles; funding and inverse P&L are not modeled.
    """
    dataset, symbol = _dataset(dataset), _symbol(symbol)
    if timeframe not in TIMEFRAMES:
        raise ValueError("unsupported Binance interval; choose " + ", ".join(TIMEFRAMES))
    now = _time_ms(progress, dataset)
    first, finish = _bounds(start, end, now)
    if dataset != "spot":
        finish = _delivery_end(_instrument(symbol, dataset), finish)
        if first >= finish:
            raise ValueError("Binance has no closed candles in this date range (contract has already expired)")
    interval = _MILLISECONDS[timeframe]
    # Keep existing Spot checkpoints; futures can never share their identity.
    identity_parts = [1, symbol, timeframe, first, end or ""]
    if dataset != "spot":
        identity_parts.insert(1, dataset)
    identity = json.dumps(identity_parts, ensure_ascii=True)
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
        head = _first_candle(symbol, timeframe, first, finish, dataset, progress) if dataset != "spot" else None
        cursor = latest + interval if latest is not None else head[0][0] if head else first
        if dataset != "spot" and not head:
            cursor = finish
        progress(rows=count, detail=f"resuming {count:,} verified candles" if count else "downloading Binance candles")
        pages = 0
        while cursor < finish:
            # At most 1,000 possible opens per window: safe whether the futures
            # API returns the earliest or most recent rows when a limit applies.
            stop = min(finish, cursor + min(1000 * interval, _MAX_FUTURES_WINDOW)) if dataset != "spot" else finish
            rows = _request("klines", {"symbol": symbol, "interval": timeframe,
                                      "startTime": cursor, "endTime": stop - 1, "limit": 1000},
                            progress, dataset=dataset)
            page = _parse_rows(rows, cursor, finish, interval)
            if any(r[0] >= stop for r in page):
                raise BinanceError("Binance returned candles outside the requested window")
            if not page:
                if dataset == "spot" or stop == finish:
                    break
                cursor = stop
                continue  # Empty futures windows can precede later real candles.
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
        head = _first_candle(symbol, timeframe, first, finish, dataset, progress)
        tail = _last_candle(symbol, timeframe, first, finish, dataset, progress)
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
