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

    def __call__(self, path, params=None, progress=lambda **_: None, dataset="spot"):
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
    def interrupted(path, params=None, progress=lambda **_: None, dataset="spot"):
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
    def request(path, params=None, progress=lambda **_: None, dataset="spot"):
        return {"serverTime": FIRST + 300_000} if path == "time" else rows
    monkeypatch.setattr(b, "_request", request)
    with pytest.raises(b.BinanceError, match="invalid, unordered or duplicate"):
        b.download("BTCUSDT", "1m", "", "", tmp_path)
    with sqlite3.connect(next(tmp_path.glob("*.sqlite3"))) as db:
        assert db.execute("SELECT COUNT(*) FROM candles").fetchone()[0] == 0


def test_empty_or_truncated_pages_never_return_success(tmp_path, monkeypatch):
    market = Market(candles(1500))
    def truncated(path, params=None, progress=lambda **_: None, dataset="spot"):
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
    monkeypatch.setattr(b, "_NEXT_REQUEST", dict.fromkeys(b.MARKET_NAMES, 0))
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
    monkeypatch.setattr(b, "_WEIGHT_LIMITS", {market: {60: 100} for market in b.MARKET_NAMES})
    events.extend([Response({}, {"X-MBX-USED-WEIGHT-1M": "95"}), Response({})])
    b._request("time")
    b._request("time")
    assert 1 <= sleeps[0] <= 61 and len(calls) == 2


def test_catalog_uses_public_spot_info_and_metadata_closed_edges(monkeypatch):
    market = Market(candles(3), now=FIRST + 150_000)
    calls = []
    def request(path, params=None, progress=lambda **_: None, dataset="spot"):
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
    monkeypatch.setattr(b, "_EXCHANGE_CACHE", {})
    monkeypatch.setattr(b, "_METADATA_CACHE", {})
    monkeypatch.setattr(b, "_WEIGHT_LIMITS", {market: {60: 6000} for market in b.MARKET_NAMES})
    monkeypatch.setattr(b, "_request", request)
    assert [r["symbol"] for r in b.catalog("BTC")["rows"]] == ["BTCUSDT", "BTCEUR", "ETHBTC"]
    meta = b.metadata("BTCUSDT")
    assert meta["first_tick"] == "2024-01-01T00:00:00+00:00"
    assert meta["last_tick"] == "2024-01-01T00:01:00+00:00"
    assert meta["timeframes"] == list(b.TIMEFRAMES)
    assert len([c for c in calls if c[0] == "exchangeInfo"]) == 1


class FuturesMarket:
    """Model COIN-M's documented latest-N behavior, unlike Spot's forward pages."""
    def __init__(self, rows, *, now=None, delivery=None, reverse_limit=True):
        self.rows = rows
        self.now = now or rows[-1][6] + 1
        self.delivery = delivery or 4133404800000
        self.reverse_limit = reverse_limit
        self.calls = []

    def __call__(self, path, params=None, progress=lambda **_: None, dataset="spot"):
        self.calls.append((dataset, path, params))
        if path == "time":
            return {"serverTime": self.now}
        if path == "exchangeInfo":
            assert params is None if dataset != "spot" else params["permissions"] == "SPOT"
            symbol = "BTCUSD_PERP" if dataset == "coinm" else "BTCUSDT"
            return {"symbols": [{"symbol": symbol, "baseAsset": "BTC", "quoteAsset": "USD" if dataset == "coinm" else "USDT",
                                 "marginAsset": "BTC" if dataset == "coinm" else "USDT", "contractType": "PERPETUAL",
                                 "contractSize": 100 if dataset == "coinm" else None,
                                 "onboardDate": FIRST + 60000, "deliveryDate": self.delivery,
                                 "contractStatus": "TRADING" if dataset == "coinm" else "SETTLING"}],
                    "rateLimits": [{"rateLimitType": "REQUEST_WEIGHT", "interval": "MINUTE", "intervalNum": 1, "limit": 2400}]}
        assert path == "klines"
        if dataset == "coinm" and "startTime" in params:
            assert params["endTime"] - params["startTime"] < 200 * b._DAY
        rows = self.rows
        if params["interval"] == "1d" and rows and rows[0][6] - rows[0][0] < b._DAY - 1:
            # Daily discovery sees a forming day as well as completed days.
            rows = [candles(1, first=day, step=b._DAY)[0] for day in sorted({r[0] // b._DAY * b._DAY for r in rows})]
        rows = [r for r in rows if params.get("startTime", 0) <= r[0] <= params.get("endTime", self.now)]
        backwards = "startTime" not in params or (dataset == "coinm" and self.reverse_limit)
        return rows[-params["limit"]:] if backwards else rows[:params["limit"]]


@pytest.fixture
def market_cache(monkeypatch):
    monkeypatch.setattr(b, "_EXCHANGE_CACHE", {})
    monkeypatch.setattr(b, "_EXCHANGE_AT", {})
    monkeypatch.setattr(b, "_METADATA_CACHE", {})
    monkeypatch.setattr(b, "_WEIGHT_LIMITS", {market: {60: 6000} for market in b.MARKET_NAMES})


@pytest.mark.parametrize("dataset,symbol", [("usdm", "BTCUSDT"), ("coinm", "BTCUSD_PERP")])
def test_futures_pages_start_at_first_bar_and_preserve_native_volume(tmp_path, monkeypatch, market_cache, dataset, symbol):
    market = FuturesMarket(candles(2501))
    monkeypatch.setattr(b, "_request", market)
    frame = b.download(symbol, "1m", "", "", tmp_path, dataset=dataset)
    assert len(frame) == 2501
    assert frame.ts.iloc[0] == pd.Timestamp(FIRST, unit="ms", tz="UTC")
    assert frame.ts.iloc[-1] == pd.Timestamp(FIRST + 2500 * 60000, unit="ms", tz="UTC")
    assert frame.volume.sum() == 2501 * 5.5
    pd.testing.assert_frame_equal(frame, b.download(symbol, "1m", "", "", tmp_path, dataset=dataset))
    assert {c[0] for c in market.calls} == {dataset}


@pytest.mark.parametrize("reverse_limit", [False, True])
def test_coinm_daily_full_history_crosses_200_day_windows(tmp_path, monkeypatch, market_cache, reverse_limit):
    market = FuturesMarket(candles(821, step=b._DAY), reverse_limit=reverse_limit)
    monkeypatch.setattr(b, "_request", market)
    frame = b.download("BTCUSD_PERP", "1d", "", "", tmp_path, dataset="coinm")
    assert len(frame) == 821  # No lost beginning even when each response returns the last N.
    assert frame.ts.iloc[0] == pd.Timestamp("2024-01-01", tz="UTC")
    assert frame.ts.iloc[-1] == pd.Timestamp(FIRST + 820 * b._DAY, unit="ms", tz="UTC")


def test_futures_empty_windows_do_not_drop_later_real_history(tmp_path, monkeypatch, market_cache):
    market = FuturesMarket(candles(2) + candles(2, first=FIRST + 2002 * 60000))
    monkeypatch.setattr(b, "_request", market)
    frame = b.download("BTCUSD_PERP", "1m", "", "", tmp_path, dataset="coinm")
    assert len(frame) == 4 and frame.volume.sum() == 22
    assert list(frame.ts.dt.as_unit("ms").astype("int64")) == [r[0] for r in market.rows]


def test_settled_contract_metadata_and_download_stop_at_delivery(tmp_path, monkeypatch, market_cache):
    # The real USD-M API keeps returning synthetic-looking zero-volume bars
    # after SETTLING; do not advertise or import past the contract's lifetime.
    market = FuturesMarket(candles(10), delivery=FIRST + 3 * 60000)
    monkeypatch.setattr(b, "_request", market)
    meta = b.metadata("BTCUSDT", dataset="usdm", timeframe="1m")
    assert meta["first_tick"] == "2024-01-01T00:00:00+00:00"  # Before reported onboardDate.
    assert meta["last_tick"] == "2024-01-01T00:02:00+00:00"
    assert meta["estimated_bars"] == 3 and meta["available_history"] is True
    assert meta["volume_unit"] == "base asset" and meta["status"] == "SETTLING"
    frame = b.download("BTCUSDT", "1m", "", "", tmp_path, dataset="usdm")
    assert len(frame) == 3
    with pytest.raises(ValueError, match="already expired"):
        b.download("BTCUSDT", "1m", "2024-01-01T00:05:00Z", "", tmp_path, dataset="usdm")


def test_available_span_estimate_is_interval_specific_cached_and_not_an_exact_count(monkeypatch, market_cache):
    market = FuturesMarket(candles(2) + candles(1, first=FIRST + 5 * 60000), now=FIRST + 5 * 60000 + 30000)
    monkeypatch.setattr(b, "_request", market)
    meta = b.metadata("BTCUSD_PERP", dataset="coinm", timeframe="1m")
    assert meta["estimated_bars"] == 2  # Excludes the still-open final minute.
    assert meta["days"] == 2 / 1440 and meta["years"] == 2 / (1440 * 365.25)
    assert "Estimate" in meta["estimate_note"]
    assert meta["contract_size"] == 100 and meta["volume_unit"] == "contracts"
    calls = len(market.calls)
    assert meta == b.metadata("BTCUSD_PERP", dataset="coinm", timeframe="1m")
    assert len(market.calls) == calls
    market.now += 30000
    b._METADATA_CACHE.clear()
    assert b.metadata("BTCUSD_PERP", dataset="coinm", timeframe="1m")["estimated_bars"] == 6  # Three actual bars; gaps not filled.
    day = b.metadata("BTCUSD_PERP", dataset="coinm", timeframe="1d")
    assert day["timeframe"] == "1d" and day["estimated_bars"] == 0
    assert day["first_tick"] is None and not day["available_history"]


def test_market_catalog_cache_and_checkpoint_identity_are_separate(tmp_path, monkeypatch, market_cache):
    market = FuturesMarket(candles(3))
    monkeypatch.setattr(b, "_request", market)
    for dataset in ("spot", "usdm"):
        b.catalog("BTC", dataset=dataset)
        b.download("BTCUSDT", "1m", "", "", tmp_path, dataset=dataset)
    assert len(list(tmp_path.glob("*.sqlite3"))) == 2
    assert set(b._EXCHANGE_CACHE) == {"spot", "usdm"}
    assert {c[0] for c in market.calls if c[1] == "exchangeInfo"} == {"spot", "usdm"}


def test_market_throttle_and_endpoints_are_independent(transport):
    events, sleeps, calls = transport
    events.extend([error(418, 3600), Response({"serverTime": FIRST}), Response({"serverTime": FIRST})])
    with pytest.raises(b.BinanceError, match="Download progress is saved"):
        b._request("time", dataset="coinm")
    assert b._request("time", dataset="usdm")["serverTime"] == FIRST
    assert b._request("time", dataset="spot")["serverTime"] == FIRST
    assert [c.full_url for c in calls] == ["https://dapi.binance.com/dapi/v1/time",
                                           "https://fapi.binance.com/fapi/v1/time",
                                           "https://data-api.binance.vision/api/v3/time"]
    assert sleeps == []


def test_dataset_and_contract_symbol_validation(monkeypatch, tmp_path):
    assert b._symbol("btcusd_260925") == "BTCUSD_260925"
    assert b._symbol("BTCUSD_PERP") == "BTCUSD_PERP"
    assert b._symbol("币安人生USDT") == "币安人生USDT"
    for symbol in ("BTC/USD", "..", "BTC-USDT", "_BTC", "BTC%3F", "BTC USDT", "BTC\u200bUSDT"):
        with pytest.raises(ValueError):
            b._symbol(symbol)
    for action in (lambda: b.catalog(dataset="futures"), lambda: b.metadata("BTCUSDT", dataset="../spot"),
                   lambda: b.download("BTCUSDT", "1m", "", "", tmp_path, dataset="wrong")):
        with pytest.raises(ValueError, match="market"):
            action()
    assert not list(tmp_path.iterdir())



def test_coinm_custom_start_after_first_days_bars_finds_later_history(tmp_path, monkeypatch, market_cache):
    market = FuturesMarket(candles(2) + candles(2, first=FIRST + 3 * b._DAY))
    monkeypatch.setattr(b, "_request", market)
    frame = b.download("BTCUSD_PERP", "1m", "2024-01-01T23:00:00Z", "", tmp_path, dataset="coinm")
    assert len(frame) == 2 and frame.ts.iloc[0] == pd.Timestamp("2024-01-04", tz="UTC")
