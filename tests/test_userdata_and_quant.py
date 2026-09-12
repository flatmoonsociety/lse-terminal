"""My Data provider (CSV import) + the quant backtest modes end to end."""

import pytest
from fastapi.testclient import TestClient

from lse_terminal.engine.server import create_app

@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("LSE_TERMINAL_CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("LSE_API_KEY", raising=False)
    return TestClient(create_app(), base_url="http://127.0.0.1")


def rising_csv(n=120, start_ts=1700000000, step=3600):
    lines = ["time,open,high,low,close,volume"]
    for i in range(n):
        p = 100 + i
        lines.append(f"{start_ts + i * step},{p},{p + 0.5},{p - 0.5},{p + 0.2},1000")
    return "\n".join(lines) + "\n"


# ── import / list / delete ────────────────────────────────────────────────

def test_import_lists_and_serves_candles(client):
    r = client.post("/api/data/import",
                    json={"symbol": "MY:TEST", "name": "My Test", "csv_text": rising_csv()})
    assert r.status_code == 200, r.text
    entry = r.json()
    assert entry["rows"] == 120
    assert entry["timeframe"] == "1h"

    listed = client.get("/api/data").json()
    assert any(d["symbol"] == "MY:TEST" for d in listed)

    inst = client.get("/api/instruments",
                      params={"provider": "userdata", "query": "test"}).json()
    assert any(i["symbol"] == "MY:TEST" for i in inst)

    candles = client.get("/api/candles", params={
        "provider": "userdata", "symbol": "MY:TEST", "timeframe": "1h", "limit": 50,
    })
    assert candles.status_code == 200, candles.text
    rows = candles.json()["candles"]
    assert len(rows) == 50


def test_import_flexible_headers_and_datetimes(client):
    csv_text = (
        "Date,Open,High,Low,Close\n"
        "2024-01-01 00:00:00,1,2,0.5,1.5\n"
        "2024-01-01 01:00:00,1.5,2.5,1.0,2.0\n"
        "2024-01-01 02:00:00,2.0,3.0,1.5,2.5\n"
    )
    r = client.post("/api/data/import",
                    json={"symbol": "MY:DT", "csv_text": csv_text})
    assert r.status_code == 200, r.text
    entry = r.json()
    assert entry["rows"] == 3
    assert entry["first_ts"] == 1704067200  # 2024-01-01 00:00 UTC
    assert entry["timeframe"] == "1h"


def test_import_rejects_garbage(client):
    r = client.post("/api/data/import",
                    json={"symbol": "MY:BAD", "csv_text": "a,b\n1,2\n"})
    assert r.status_code == 400
    assert "time column" in r.json()["detail"]


def test_resamples_to_higher_timeframe(client):
    client.post("/api/data/import",
                json={"symbol": "MY:RS", "csv_text": rising_csv(48)})
    candles = client.get("/api/candles", params={
        "provider": "userdata", "symbol": "MY:RS", "timeframe": "4h", "limit": 500,
    })
    assert candles.status_code == 200, candles.text
    rows = candles.json()["candles"]
    assert 11 <= len(rows) <= 13  # 48 hourly bars -> ~12 4h buckets


def test_delete_removes_dataset(client):
    client.post("/api/data/import",
                json={"symbol": "MY:DEL", "csv_text": rising_csv(10)})
    assert client.delete("/api/data/MY:DEL").status_code == 200
    assert client.delete("/api/data/MY:DEL").status_code == 404
    assert not any(d["symbol"] == "MY:DEL" for d in client.get("/api/data").json())


FLIP = """
qty = float(params.get("q", 1))
trades = []
for i in range(0, len(df) - 1, 2):
    trades.append({"entry_i": i, "exit_i": i + 1, "qty": qty})
"""

HOLD = """
trades = [{"entry_i": 0, "exit_i": len(df) - 1, "qty": 1}]
"""


# ── quant modes through the API ──────────────────────────────────────

def test_backtest_on_imported_data_with_extended_stats(client):
    client.post("/api/data/import",
                json={"symbol": "MY:BT", "csv_text": rising_csv()})
    r = client.post("/api/backtest", json={
        "engine": "python", "provider": "userdata", "symbol": "MY:BT",
        "timeframe": "1h", "script": FLIP,
        "options": {"extended_stats": True},
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["stats"]["totalTrades"] > 10
    ext = body["stats"]["extended"]
    assert "var95" in ext and "sortino" in ext and "exposurePct" in ext


def test_backtest_window_option_flattens_at_edge(client):
    # The trade window is a RUN parameter: entries only inside [from, to]
    # (the gate briefly vanished when the legacy entry() verb was deleted
    # and was restored in the engine's v2 order path), and --to flattens
    # whatever is open on the first bar past the window. A buy-and-hold
    # script shows the flatten; the from-past-the-data case shows the gate.
    client.post("/api/data/import",
                json={"symbol": "MY:WIN", "csv_text": rising_csv()})
    full = client.post("/api/backtest", json={
        "engine": "python", "provider": "userdata", "symbol": "MY:WIN",
        "timeframe": "1h", "script": HOLD,
    }).json()
    # window = only the first ~24 bars of the series
    edge = 1700000000 + 24 * 3600
    windowed = client.post("/api/backtest", json={
        "engine": "python", "provider": "userdata", "symbol": "MY:WIN",
        "timeframe": "1h", "script": HOLD,
        "options": {"to": str(edge * 1000)},
    }).json()
    assert full["stats"]["totalTrades"] == windowed["stats"]["totalTrades"] == 1
    assert windowed["trades"][-1]["exit_ts"] <= edge + 2 * 3600
    assert windowed["trades"][-1]["exit_ts"] < full["trades"][-1]["exit_ts"]
    # A `from` past the end of the data now ERRORS rather than returning a
    # silent zero-trade result. The old Brue engine ran every bar and gated
    # which ones could TRADE; the runner windows the DATA, so an empty window
    # means the user asked for a backtest that cannot exist, and saying so is
    # more useful than a clean-looking empty result.
    gated = client.post("/api/backtest", json={
        "engine": "python", "provider": "userdata", "symbol": "MY:WIN",
        "timeframe": "1h", "script": HOLD,
        "options": {"from": str((1700000000 + 500 * 3600) * 1000)},
    })
    assert gated.status_code == 400
    assert "leaves no candles" in gated.json()["detail"]


def test_montecarlo_endpoint(client):
    client.post("/api/data/import",
                json={"symbol": "MY:MC", "csv_text": rising_csv()})
    r = client.post("/api/backtest/montecarlo", json={
        "engine": "python", "provider": "userdata", "symbol": "MY:MC",
        "timeframe": "1h", "script": FLIP, "runs": 200, "seed": 7,
    })
    assert r.status_code == 200, r.text
    mc = r.json()
    assert mc["type"] == "monte_carlo"
    assert mc["runs"] == 200
    assert mc["finalEquity"]["p5"] <= mc["finalEquity"]["p95"]
    # deterministic per seed
    again = client.post("/api/backtest/montecarlo", json={
        "engine": "python", "provider": "userdata", "symbol": "MY:MC",
        "timeframe": "1h", "script": FLIP, "runs": 200, "seed": 7,
    }).json()
    assert again == mc


def test_walkforward_endpoint(client):
    client.post("/api/data/import",
                json={"symbol": "MY:WF", "csv_text": rising_csv(200)})
    r = client.post("/api/backtest/walkforward", json={
        "engine": "python", "provider": "userdata", "symbol": "MY:WF",
        "timeframe": "1h", "script": FLIP,
        "params": {"q": "1,3,5"}, "folds": 2, "train": 0.7,
    })
    assert r.status_code == 200, r.text
    wf = r.json()
    assert wf["type"] == "walkforward"
    assert len(wf["folds"]) == 2
    # rising data: bigger qty always wins
    assert all(f["bestParams"]["q"] == 5 for f in wf["folds"])


def test_walkforward_requires_params(client):
    client.post("/api/data/import",
                json={"symbol": "MY:WF2", "csv_text": rising_csv(100)})
    r = client.post("/api/backtest/walkforward", json={
        "engine": "python", "provider": "userdata", "symbol": "MY:WF2",
        "timeframe": "1h", "script": FLIP, "params": {},
    })
    assert r.status_code == 400


@pytest.mark.parametrize("mode", ["montecarlo", "walkforward"])
@pytest.mark.parametrize("instrument,point_value", [("NQ", 20), ("MNQ", 2)])
def test_research_preserves_futures_context_and_fixed_params(client, mode, instrument, point_value):
    symbol = f"{instrument}_F_1M"
    imported = client.post("/api/data/import", json={
        "symbol": symbol, "csv_text": rising_csv(200, step=60),
    })
    assert imported.status_code == 200, imported.text
    script = f'''from lse_terminal.backtest.atr_phase import Config
assert symbol == {symbol!r} and timeframe == '1m'
assert params['fixed_setting'] == 7
config = Config(instrument=symbol.split('_')[0])
trades = [{{'entry_i': 0, 'exit_i': len(df) - 1,
           'qty': params.get('qty', 1), 'point_value': config.point_value}}]
'''
    body = {"engine": "python", "provider": "userdata", "symbol": symbol,
            "timeframe": "1m", "script": script,
            "options": {"params": {"fixed_setting": 7, "qty": 9}}}
    if mode == "walkforward":
        body.update(params={"qty": "1,2"}, folds=2, train=0.7)
    else:
        body.update(runs=2, seed=7)
    response = client.post(f"/api/backtest/{mode}", json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    if mode == "montecarlo":
        assert result["baseNetProfit"] == pytest.approx(199 * 9 * point_value)
    else:
        assert all(fold["bestParams"]["qty"] == 2 for fold in result["folds"])
        assert result["totalOosNetProfit"] == pytest.approx(2 * 29 * 2 * point_value)


# ── hosted mode lockdown ─────────────────────────────────────────────────

def test_hosted_mode_blocks_writes(tmp_path, monkeypatch):
    monkeypatch.setenv("LSE_TERMINAL_CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("LSE_TERMINAL_HOSTED", "1")
    c = TestClient(create_app(), base_url="http://127.0.0.1")
    assert c.get("/api/config").json()["hosted"] is True
    # every host-mutating endpoint refuses
    assert c.post("/api/data/import",
                  json={"symbol": "X", "csv_text": "time,open,high,low,close,volume\n1,1,1,1,1,1"}
                  ).status_code == 403
    assert c.delete("/api/data/X").status_code == 403
    assert c.post("/api/user-indicators/evil.py",
                  json={"source": "import os"}).status_code == 403
    assert c.delete("/api/user-indicators/x.py").status_code == 403
    assert c.post("/api/config/lse_key", json={"key": "k"}).status_code == 403
    # read-only surface still works
    assert c.get("/api/health").json()["ok"] is True
    assert c.get("/api/indicators").status_code == 200


def test_hosted_mode_refuses_every_code_execution_path(tmp_path, monkeypatch):
    """The hosted instance is shared by every visitor, so nothing that runs
    user-supplied code may be reachable on it.

    A backtest script can import subprocess and act as the server user, so
    every exec path must be refused inside the app itself: an upstream edge
    or proxy blocking POSTs is not a control this app owns, and the app
    ships for others to self-host without one.
    """
    monkeypatch.setenv("LSE_TERMINAL_CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("LSE_TERMINAL_HOSTED", "1")
    c = TestClient(create_app(), base_url="http://127.0.0.1")

    payload = "import subprocess\ntrades = []"
    for path, body in (
        ("/api/backtest", {}),
        ("/api/backtest/montecarlo", {"runs": 10}),
        ("/api/backtest/walkforward", {"params": {"a": "1,2"}}),
    ):
        r = c.post(path, json={"engine": "python", "provider": "userdata",
                               "symbol": "GOLD", "timeframe": "1h",
                               "script": payload, **body})
        assert r.status_code == 403, f"{path} executed user code: {r.status_code}"

    # Websockets cannot raise HTTPException, so they refuse with a message
    # and a close instead. A handshake that yields anything but an error is
    # a shell (or pip) exposed to whoever can reach the socket.
    for path in ("/api/term/pty", "/api/ai/pty", "/api/ai/chat",
                 "/api/ai/install", "/api/ai/login", "/api/ml/install"):
        with c.websocket_connect(path) as ws:
            msg = ws.receive_json()
            assert msg.get("type") == "error", f"{path} accepted in hosted mode"


def test_local_mode_still_runs_user_code(tmp_path, monkeypatch):
    """The mirror of the test above: the lockdown must not reach the local
    app, where running the user's own Python on their own machine is the
    entire product."""
    monkeypatch.setenv("LSE_TERMINAL_CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("LSE_TERMINAL_HOSTED", raising=False)
    c = TestClient(create_app(), base_url="http://127.0.0.1")
    c.post("/api/data/import",
           json={"symbol": "MY:LOCAL", "csv_text": rising_csv(60)})
    r = c.post("/api/backtest", json={
        "engine": "python", "provider": "userdata", "symbol": "MY:LOCAL",
        "timeframe": "1h", "script": HOLD})
    assert r.status_code == 200, r.text
    assert r.json()["stats"]["totalTrades"] == 1


# ── data system v2: preview, series/alternative data, folders ────────────

SENTIMENT_CSV = (
    "date,Sentiment Score,Fear Index\n"
    "2023-11-14 22:00:00,0.5,30\n"
    "2023-11-15 10:00:00,0.8,25\n"
    "2023-11-16 10:00:00,-0.2,60\n"
)


def test_preview_detects_ohlcv_and_series(client):
    p1 = client.post("/api/data/preview", json={"csv_text": rising_csv(10)}).json()
    assert p1["kind"] == "ohlcv" and p1["rows"] == 10 and p1["timeframe"] == "1h"
    p2 = client.post("/api/data/preview", json={"csv_text": SENTIMENT_CSV}).json()
    assert p2["kind"] == "series"
    assert p2["columns"] == ["sentiment_score", "fear_index"]


def test_series_import_folders_and_update(client):
    e = client.post("/api/data/import", json={
        "symbol": "ALT:SENT", "csv_text": SENTIMENT_CSV, "folder": "Alt/Sentiment",
    }).json()
    assert e["kind"] == "series" and e["folder"] == "Alt/Sentiment"
    assert e["columns"] == ["sentiment_score", "fear_index"]
    # series data must NOT appear as a chartable instrument
    inst = client.get("/api/instruments", params={"provider": "userdata", "query": ""}).json()
    assert not any(i["symbol"] == "ALT:SENT" for i in inst)
    # rename + move
    u = client.patch("/api/data/ALT:SENT", json={"name": "News Sentiment", "folder": "Alt"}).json()
    assert u["name"] == "News Sentiment" and u["folder"] == "Alt"


def test_backtest_with_attached_series_dataset(client):
    client.post("/api/data/import", json={"symbol": "MY:PX", "csv_text": rising_csv(50, start_ts=1700000000)})
    client.post("/api/data/import", json={"symbol": "SENT", "csv_text": (
        "time,score\n" + "\n".join(f"{(1700000000 + i * 3600) * 1000},{0.1 * (i % 5)}" for i in range(50))
    )})
    # Attached datasets arrive as `data[<name>]`, plain DataFrames, so the
    # gate is written in ordinary pandas like everything else.
    script = (
        'sent = data["SENT"]\n'
        'score = sent.score.values\n'
        'trades = []\n'
        'entry = None\n'
        'for i in range(min(len(df), len(score))):\n'
        '    if entry is None and score[i] > 0.3:\n'
        '        entry = i\n'
        '    elif entry is not None and score[i] <= 0.3:\n'
        '        trades.append({"entry_i": entry, "exit_i": i})\n'
        '        entry = None\n'
        'if entry is not None:\n'
        '    trades.append({"entry_i": entry, "exit_i": len(df) - 1})\n'
    )
    r = client.post("/api/backtest", json={
        "engine": "python", "provider": "userdata", "symbol": "MY:PX",
        "timeframe": "1h", "script": script, "datasets": ["SENT"],
    })
    assert r.status_code == 200, r.text
    assert r.json()["stats"]["totalTrades"] > 0, "sentiment-gated strategy should trade"


def test_backtest_missing_dataset_404s(client):
    r = client.post("/api/backtest", json={
        "engine": "python", "provider": "demo", "symbol": "DEMO:BTC",
        "timeframe": "1h", "script": FLIP, "datasets": ["NOPE"],
    })
    assert r.status_code == 404


# ── folders (explorer-style CRUD) ────────────────────────────────────────

def test_folder_crud_and_dataset_moves(client):
    # explicit empty folder exists before any dataset lives in it
    r = client.post("/api/data/folders", json={"path": "Research/FX"})
    assert r.status_code == 200 and "Research/FX" in r.json() and "Research" in r.json()
    # dataset lands in a folder; rename cascades
    client.post("/api/data/import", json={"symbol": "F:ONE", "csv_text": rising_csv(10), "folder": "Research/FX"})
    r = client.patch("/api/data/folders", json={"path": "Research", "new_path": "Quant"})
    assert "Quant/FX" in r.json() and not any(f.startswith("Research") for f in r.json())
    entry = [d for d in client.get("/api/data").json() if d["symbol"] == "F:ONE"][0]
    assert entry["folder"] == "Quant/FX"
    # delete moves contents up, never destroys datasets
    r = client.delete("/api/data/folders", params={"path": "Quant/FX"})
    assert r.status_code == 200
    entry = [d for d in client.get("/api/data").json() if d["symbol"] == "F:ONE"][0]
    assert entry["folder"] == "Quant"
    assert client.get("/api/candles", params={
        "provider": "userdata", "symbol": "F:ONE", "timeframe": "1h"}).status_code == 200


def test_folder_validation(client):
    assert client.post("/api/data/folders", json={"path": "  "}).status_code == 400
    assert client.patch("/api/data/folders", json={"path": "A"}).status_code == 400


def test_float32_damage_is_repaired_on_import(client):
    # Real values from a vendor-damaged file: float32 turned 209.53 into
    # 209.529999 and the half-cent close 210.175 into 210.175003. The
    # importer detects the damage, finds the smallest decimal grid that
    # explains every value (here 3, because of the half-cent closes), snaps
    # to it, and records the repair in the manifest.
    csv_text = (
        "ts,open,high,low,close,volume\n"
        "1752067800,209.529999,210.300003,209.350006,210.175003,922271\n"
        "1752067860,210.220001,210.270004,209.690002,209.919998,215638\n"
    )
    r = client.post("/api/data/import",
                    json={"symbol": "F32:FIX", "csv_text": csv_text})
    assert r.status_code == 200, r.text
    entry = r.json()
    assert entry["source"] == "user-import"
    assert entry["price_repair"] == {"decimals": 3,
                                     "reason": "float32 artifacts detected"}
    import pandas as pd
    from lse_terminal.providers import userdata
    df = pd.read_csv(userdata.data_dir() / entry["file"])
    assert list(df["open"]) == [209.53, 210.22]
    assert list(df["close"]) == [210.175, 209.92]
    assert list(df["high"]) == [210.3, 210.27]


def test_clean_prices_left_untouched(client):
    # A genuinely clean 5-decimal FX file must import byte-exact: the
    # repair only fires on provable float32 damage, never on good data.
    csv_text = (
        "ts,open,high,low,close,volume\n"
        "1752067800,1.08123,1.0813,1.0811,1.08125,0\n"
        "1752067860,1.08125,1.0814,1.0812,1.08133,0\n"
    )
    r = client.post("/api/data/import",
                    json={"symbol": "CLEAN:FX", "csv_text": csv_text})
    assert r.status_code == 200, r.text
    entry = r.json()
    assert "price_repair" not in entry
    import pandas as pd
    from lse_terminal.providers import userdata
    df = pd.read_csv(userdata.data_dir() / entry["file"])
    assert list(df["open"]) == [1.08123, 1.08125]
    assert list(df["close"]) == [1.08125, 1.08133]


@pytest.mark.parametrize("table", [False, True], ids=["csv", "table"])
@pytest.mark.parametrize("kind", ["ohlcv", "series"])
def test_failed_reimport_preserves_dataset(tmp_path, monkeypatch, table, kind):
    from io import StringIO

    import pandas as pd
    from lse_terminal.providers import userdata

    monkeypatch.setenv("LSE_TERMINAL_CONFIG_DIR", str(tmp_path))

    def import_rows(count):
        raw = pd.read_csv(StringIO(rising_csv(count)))
        if kind == "series":
            raw = raw[["time", "close"]]
        if table:
            return userdata.import_table("NQ_F_1M", raw, kind=kind)
        return userdata.import_csv("NQ_F_1M", raw.to_csv(index=False), kind=kind)

    entry = import_rows(3)
    path = userdata.data_dir() / entry["file"]
    original = path.read_bytes()
    manifest = userdata.load_manifest()
    to_csv = pd.DataFrame.to_csv

    def fail_while_writing(frame, destination=None, *args, **kwargs):
        if destination is None:  # The CSV API still needs its input string.
            return to_csv(frame, destination, *args, **kwargs)
        destination.write("partially serialized replacement")
        assert path.read_bytes() == original
        raise OSError("disk full")

    with monkeypatch.context() as patch:
        patch.setattr(pd.DataFrame, "to_csv", fail_while_writing)
        with pytest.raises(OSError, match="disk full"):
            import_rows(6)

    assert path.read_bytes() == original
    assert userdata.load_manifest() == manifest
    assert not list(path.parent.glob(f".{path.name}.*.tmp"))

    replacement = import_rows(6)
    assert replacement["rows"] == len(pd.read_csv(path)) == 6
    assert userdata.load_manifest()["NQ_F_1M"] == replacement
