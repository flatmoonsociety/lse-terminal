import io
import json
import sqlite3
from urllib.error import HTTPError, URLError

import pandas as pd
import pytest

from lse_terminal.providers import binance_import as b


FIRST = int(pd.Timestamp("2024-01-01", tz="UTC").timestamp() * 1000)


def candles(count, first=FIRST, step=60_000):
    return [[first + i * step, "100", "103", "98", "101", "5.5",
             first + (i + 1) * step - 1, "0", 1, "0", "0", "0"] for i in range(count)]


class Market:
    def __init__(self, rows, now=None):
        self.rows = rows
        self.now = now if now is not None else rows[-1][6] + 1
        self.calls = []

    def __call__(self, path, params=None, progress=lambda **_: None):
        self.calls.append((path, params))
        if path == "time":
            return {"serverTime": self.now}
        assert path == "klines"
        rows = [r for r in self.rows if r[0] >= params.get("startTime", 0)
                and r[0] <= params.get("endTime", self.now)]
        return (rows[:params["limit"]] if "startTime" in params else rows[-params["limit"]:])


def test_download_pages_all_history_in_one_resumable_file(tmp_path, monkeypatch):
    market = Market(candles(2501))
    monkeypatch.setattr(b, "_request", market)
    updates = []
    result = b.download("btcusdt", "1m", "", "", tmp_path, lambda **kw: updates.append(kw))
    assert len(result) == 2501
    assert list(result) == ["ts", "open", "high", "low", "close", "volume"]
    assert str(result.ts.dt.tz) == "UTC"
    assert result.ts.is_unique and result.ts.is_monotonic_increasing
    assert result.volume.sum() == 2501 * 5.5
    page_calls = [params for path, params in market.calls if path == "klines" and params["limit"] == 1000]
    assert [p["startTime"] for p in page_calls] == [0, FIRST + 1000 * 60000, FIRST + 2000 * 60000]
    assert len(list(tmp_path.glob("*.sqlite3"))) == 1
    assert not list(tmp_path.glob("*.parquet"))
    assert updates[-1]["rows"] == 2501


def test_interrupted_import_reuses_committed_pages_then_extends_closed_tail(tmp_path, monkeypatch):
    market = Market(candles(2200))
    def interrupted(path, params=None, progress=lambda **_: None):
        if path == "klines" and params.get("startTime") == FIRST + 1000 * 60000:
            raise b.BinanceError("connection stopped")
        return market(path, params, progress)
    monkeypatch.setattr(b, "_request", interrupted)
    with pytest.raises(b.BinanceError, match="connection stopped"):
        b.download("BTCUSDT", "1m", "", "", tmp_path)
    with sqlite3.connect(next(tmp_path.glob("*.sqlite3"))) as db:
        assert db.execute("SELECT COUNT(*) FROM candles").fetchone()[0] == 1000
    market.calls.clear()
    monkeypatch.setattr(b, "_request", market)
    result = b.download("BTCUSDT", "1m", "", "", tmp_path)
    assert len(result) == 2200
    assert market.calls[1][1]["startTime"] == FIRST + 1000 * 60000
    market.rows += candles(3, first=market.now)
    market.now += 150_000  # Two new closed bars, one still open.
    assert len(b.download("BTCUSDT", "1m", "", "", tmp_path)) == 2202
    market.now += 30_000
    assert len(b.download("BTCUSDT", "1m", "", "", tmp_path)) == 2203


def test_date_only_end_is_inclusive_and_exact_end_excludes_partial_bar(tmp_path, monkeypatch):
    market = Market(candles(3000))
    monkeypatch.setattr(b, "_request", market)
    assert len(b.download("BTCUSDT", "1m", "2024-01-01", "2024-01-01", tmp_path)) == 1440
    result = b.download("BTCUSDT", "1m", "2024-01-01T00:05:00Z", "2024-01-01T00:07:30Z", tmp_path)
    assert list(result.ts.dt.minute) == [5, 6]


def test_shortened_historical_exchange_candle_is_preserved(tmp_path, monkeypatch):
    # Binance BTCUSDT daily bar for 2018-02-08 ends at 00:28:14.788 UTC.
    first = 1518048000000
    rows = candles(3, first=first, step=86_400_000)
    rows[0][6] = 1518049694788
    market = Market(rows)
    monkeypatch.setattr(b, "_request", market)
    result = b.download("BTCUSDT", "1d", "", "", tmp_path)
    assert len(result) == 3
    assert result.ts.iloc[0] == pd.Timestamp("2018-02-08", tz="UTC")
    assert result.open.iloc[0] == float(rows[0][1])
    pd.testing.assert_frame_equal(result, b.download("BTCUSDT", "1d", "", "", tmp_path))

    market.now = first + 60_000
    with pytest.raises(ValueError, match="no closed candles"):
        b.download("BTCUSDT", "1d", "", "", tmp_path / "unfinished")


@pytest.mark.parametrize("symbol,interval,start,end", [
    ("../BTC", "1m", "", ""), ("BTCUSDT", "tick", "", ""),
    ("BTCUSDT", "1M", "", ""), ("BTCUSDT", "1m", "bad-date", ""),
    ("BTCUSDT", "1m", "NaT", ""), ("BTCUSDT", "1m", "2024-01-02", "2024-01-01T00:00:00Z"),
    ("BTCUSDT", "1m", "1960-01-01", ""),
])
def test_invalid_requests_do_not_create_checkpoints(tmp_path, monkeypatch, symbol, interval, start, end):
    monkeypatch.setattr(b, "_request", Market(candles(3)))
    with pytest.raises(ValueError):
        b.download(symbol, interval, start, end, tmp_path)
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("change", ["duplicate", "reverse", "negative", "nan", "high", "timestamp", "duration"])
def test_rejects_corrupt_pages_before_checkpoint_commit(tmp_path, monkeypatch, change):
    rows = candles(3)
    if change == "duplicate":
        rows[1] = rows[0]
    elif change == "reverse":
        rows.reverse()
    else:
        column, value = {"negative": (5, "-1"), "nan": (1, "NaN"),
                         "high": (2, "90"), "timestamp": (0, "bad"),
                         "duration": (6, FIRST + 600_000)}[change]
        rows[1][column] = value
    def request(path, params=None, progress=lambda **_: None):
        return {"serverTime": FIRST + 300_000} if path == "time" else rows
    monkeypatch.setattr(b, "_request", request)
    with pytest.raises(b.BinanceError, match="invalid, unordered or duplicate"):
        b.download("BTCUSDT", "1m", "", "", tmp_path)
    with sqlite3.connect(next(tmp_path.glob("*.sqlite3"))) as db:
        assert db.execute("SELECT COUNT(*) FROM candles").fetchone()[0] == 0


def test_empty_or_truncated_pages_never_return_success(tmp_path, monkeypatch):
    market = Market(candles(1500))
    def truncated(path, params=None, progress=lambda **_: None):
        if path == "klines" and params.get("startTime") == FIRST + 1000 * 60000:
            return []
        return market(path, params, progress)
    monkeypatch.setattr(b, "_request", truncated)
    with pytest.raises(b.BinanceError, match="incomplete"):
        b.download("BTCUSDT", "1m", "", "", tmp_path)
    monkeypatch.setattr(b, "_request", Market([], now=FIRST + 60_000))
    with pytest.raises(ValueError, match="no closed candles"):
        b.download("ETHUSDT", "1m", "", "", tmp_path)


def test_invalid_cached_prices_and_missing_first_bar_are_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(b, "_request", Market(candles(10)))
    b.download("BTCUSDT", "1m", "", "", tmp_path)
    path = next(tmp_path.glob("*.sqlite3"))
    with sqlite3.connect(path) as db:
        db.execute("UPDATE candles SET low=-1 WHERE ts=?", (FIRST,))
    with pytest.raises(b.BinanceError, match="checkpoint contains invalid"):
        b.download("BTCUSDT", "1m", "", "", tmp_path)
    with sqlite3.connect(path) as db:
        db.execute("DELETE FROM candles WHERE ts=?", (FIRST,))
    with pytest.raises(b.BinanceError, match="incomplete"):
        b.download("BTCUSDT", "1m", "", "", tmp_path)


class Response(io.BytesIO):
    def __init__(self, payload, headers=None):
        super().__init__(json.dumps(payload).encode())
        self.headers = headers or {}


@pytest.fixture
def transport(monkeypatch):
    events, sleeps, calls = [], [], []
    monkeypatch.setattr(b, "_NEXT_REQUEST", 0)
    monkeypatch.setattr(b, "_pause", lambda progress, detail, seconds: sleeps.append(seconds))
    def send(request, timeout):
        calls.append(request)
        event = events.pop(0)
        if isinstance(event, Exception):
            raise event
        return event
    monkeypatch.setattr(b, "urlopen", send)
    return events, sleeps, calls


def error(status, seconds=None):
    return HTTPError("https://data-api.binance.vision/api/v3/klines", status, "Limited",
                     {"Retry-After": str(seconds)} if seconds is not None else {},
                     io.BytesIO(b'{"msg":"Test API response"}'))


def test_rate_limit_honors_retry_after_without_switching_host(transport):
    events, sleeps, calls = transport
    events.extend([error(429, 42), Response({"serverTime": FIRST})])
    assert b._request("time")["serverTime"] == FIRST
    assert 41 <= sleeps[0] <= 42
    assert len(calls) == 2
    assert all(c.full_url == "https://data-api.binance.vision/api/v3/time" for c in calls)


def test_long_ban_stops_with_shared_cooldown_and_saved_progress(transport):
    events, sleeps, calls = transport
    events.append(error(418, 3600))
    with pytest.raises(b.BinanceError, match="Download progress is saved"):
        b._request("time")
    with pytest.raises(b.BinanceError, match="cooldown"):
        b._request("time")
    assert len(calls) == 1 and sleeps == []


def test_transient_retries_are_bounded_and_invalid_symbol_is_not_retried(transport):
    events, sleeps, calls = transport
    events.extend(URLError("offline") for _ in range(6))
    with pytest.raises(b.BinanceError, match="connection failed"):
        b._request("time")
    assert len(calls) == 6
    events.append(error(400))
    with pytest.raises(b.BinanceError, match="Test API response") as exc:
        b._request("klines", {"symbol": "BOGUS"})
    assert exc.value.status == 400 and len(calls) == 7


def test_quota_response_headers_trigger_wait_before_next_request(transport, monkeypatch):
    events, sleeps, calls = transport
    monkeypatch.setattr(b, "_WEIGHT_LIMITS", {60: 100})
    events.extend([Response({}, {"X-MBX-USED-WEIGHT-1M": "95"}), Response({})])
    b._request("time")
    b._request("time")
    assert 1 <= sleeps[0] <= 61 and len(calls) == 2


def test_catalog_uses_public_spot_info_and_metadata_closed_edges(monkeypatch):
    market = Market(candles(3), now=FIRST + 150_000)
    calls = []
    def request(path, params=None, progress=lambda **_: None):
        calls.append((path, params))
        if path == "exchangeInfo":
            assert params == {"permissions": "SPOT", "showPermissionSets": "false"}
            return {"symbols": [{"symbol": symbol, "baseAsset": base, "quoteAsset": quote,
                                 "status": "TRADING"} for symbol, base, quote in
                                [("ETHBTC", "ETH", "BTC"), ("BTCUSDT", "BTC", "USDT"),
                                 ("BTCEUR", "BTC", "EUR")]],
                    "rateLimits": [{"rateLimitType": "REQUEST_WEIGHT", "interval": "MINUTE",
                                    "intervalNum": 1, "limit": 6000}]}
        return market(path, params, progress)
    monkeypatch.setattr(b, "_EXCHANGE_CACHE", None)
    monkeypatch.setattr(b, "_WEIGHT_LIMITS", {60: 6000})
    monkeypatch.setattr(b, "_request", request)
    assert [r["symbol"] for r in b.catalog("BTC")["rows"]] == ["BTCUSDT", "BTCEUR", "ETHBTC"]
    meta = b.metadata("BTCUSDT")
    assert meta["first_tick"] == "2024-01-01T00:00:00+00:00"
    assert meta["last_tick"] == "2024-01-01T00:01:00+00:00"
    assert meta["timeframes"] == list(b.TIMEFRAMES)
    assert len([c for c in calls if c[0] == "exchangeInfo"]) == 1
