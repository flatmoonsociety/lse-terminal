import json

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from lse_terminal.backtest.contract import BacktestError, BacktestResult, Trade
from lse_terminal.backtest.runner import PythonRunner
from lse_terminal.engine.server import create_app


def candles(prices):
    return pd.DataFrame({"ts": [1700000040 + 60 * i for i in range(len(prices))],
                         "open": prices, "high": prices, "low": prices, "close": prices,
                         "volume": 1.0})


@pytest.mark.parametrize("point_value,direction,entry,exit,qty,pct,fixed,entry_fee,exit_fee,gross", [
    (20, "long", 20000, 20010, 3, 0, 1.25, 3.75, 3.75, 600),
    (2, "long", 20000, 20010, 3, 0, 1.25, 3.75, 3.75, 60),
    (20, "short", 20000, 19990, 3, 0, 1.25, 3.75, 3.75, 600),
    (2, "short", 20000, 19990, 3, 0, 1.25, 3.75, 3.75, 60),
    (20, "long", 100, 110, 2, .1, 1.5, 7, 7.4, 400),
    # Negative settlement prices must never turn percentage fees into a rebate.
    (1000, "short", 10, -5, 2, .1, 2, 24, 14, 30000),
    (20, "long", 100, 110, 0, .1, 1.5, 0, 0, 0),
])
def test_cash_commissions_use_actual_quantity_and_both_sides(
        point_value, direction, entry, exit, qty, pct, fixed, entry_fee, exit_fee, gross):
    frame = candles([entry, entry, exit])
    script = f"trades = [{{'entry_i': 0, 'exit_i': 2, 'dir': {direction!r}, 'qty': {qty}, 'point_value': {point_value}}}]"
    result = PythonRunner().run(script, frame, "NQ" if point_value == 20 else "MNQ", "1m",
                                options={"commission_pct": pct, "commission_per_unit": fixed})
    trade = result.trades[0]
    total_fee = entry_fee + exit_fee
    assert trade.entry_commission == pytest.approx(entry_fee)
    assert trade.exit_commission == pytest.approx(exit_fee)
    assert trade.commission == pytest.approx(total_fee)
    assert trade.gross_pnl == gross
    assert trade.pnl == pytest.approx(gross - total_fee)
    assert result.gross_profit == gross
    assert result.total_commission == pytest.approx(total_fee)
    assert result.commission_pct == pct and result.commission_per_unit == fixed
    assert result.net_profit == pytest.approx(gross - total_fee)
    assert result.final_equity == pytest.approx(100000 + gross - total_fee)
    assert result.equity_curve[0][1] == pytest.approx(100000 - entry_fee)
    assert result.equity_curve[-1][1] == pytest.approx(result.final_equity)
    assert result.stats["maxDrawdown"] >= entry_fee - 1e-8
    encoded = result.to_json()
    assert encoded["trades"][0]["commission"] == pytest.approx(total_fee)
    json.dumps(encoded, allow_nan=False)


def test_fixed_commission_uses_automatic_actual_size_and_same_bar_accounting():
    script = '''trades = [
    {'entry_i': 0, 'exit_i': 1, 'entry': 100, 'exit': 110, 'point_value': 2},
    {'entry_i': 1, 'exit_i': 1, 'entry': 100, 'exit': 105, 'point_value': 2},
    {'entry_i': 1, 'exit_i': 2, 'entry': 100, 'exit': 100, 'point_value': 2}]
'''
    result = PythonRunner().run(script, candles([100, 100, 100]), "MNQ", "1m",
                                options={"capital": 1000, "commission_pct": 1, "commission_per_unit": 2})
    assert [trade.qty for trade in result.trades] == pytest.approx([5, 5.295, 5.3453025])
    assert [trade.pnl for trade in result.trades] == pytest.approx([59, 10.0605, -42.76242])
    assert result.final_equity == pytest.approx(1026.29808)
    assert result.total_commission == pytest.approx(41 + 42.8895 + 42.76242)
    assert result.gross_profit == pytest.approx(100 + 52.95)
    assert sum(trade.pnl for trade in result.trades) == pytest.approx(result.net_profit)
    assert result.gross_profit - result.total_commission == pytest.approx(result.net_profit)


def test_gross_pnl_includes_losing_trades_and_zero_fee_default_is_explicit():
    frame = candles([100, 120, 120, 110])
    script = "trades = [{'entry_i': 0, 'exit_i': 1, 'qty': 1}, {'entry_i': 2, 'exit_i': 3, 'qty': 1}]"
    charged = PythonRunner().run(script, frame, "T", "1m", options={"commission_per_unit": 2})
    assert charged.gross_profit == 10  # 20 - 10, not only winning trades.
    assert charged.stats["grossProfit"] == 16  # Existing winner statistic stays net of fees.
    assert charged.total_commission == 8
    assert charged.net_profit == 2
    free = PythonRunner().run(script, frame, "T", "1m")
    assert free.total_commission == free.commission_pct == free.commission_per_unit == 0
    assert all(trade.commission == 0 for trade in free.trades)
    assert free.gross_profit == free.net_profit == 10
    idle = PythonRunner().run("trades = []", frame, "T", "1m", options={"commission_per_unit": 100})
    assert idle.total_commission == idle.gross_profit == idle.net_profit == 0


@pytest.mark.parametrize("option", ["commission_pct", "commission_per_unit"])
@pytest.mark.parametrize("bad", [-1, float("nan"), float("inf"), "not-a-fee", []])
def test_bad_commission_is_rejected_before_strategy_execution(option, bad):
    with pytest.raises(BacktestError, match=option + ".*finite nonnegative"):
        PythonRunner().run("raise AssertionError('strategy must not run')", candles([100, 101, 102]),
                           "T", "1m", options={option: bad})


def test_legacy_contract_retains_unknown_costs_instead_of_claiming_zero():
    trade = Trade(0, 60, "long", 100, 101, 1, 1, 1, 1)
    result = BacktestResult("external", "T", "1m", 1000, 1001, 1, trades=[trade]).to_json()
    assert result["total_commission"] is result["gross_profit"] is None
    assert result["commission_pct"] is result["commission_per_unit"] is None
    assert result["trades"][0]["commission"] is result["trades"][0]["gross_pnl"] is None


def test_single_backtest_api_rejects_invalid_fees_and_serializes_cash_fees(tmp_path, monkeypatch):
    monkeypatch.setenv("LSE_TERMINAL_CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("LSE_TERMINAL_HOSTED", raising=False)
    client = TestClient(create_app(), base_url="http://127.0.0.1")
    imported = client.post("/api/data/import", json={"symbol": "NQ", "csv_text": candles([100, 100, 110]).to_csv(index=False)})
    assert imported.status_code == 200, imported.text
    body = {"provider": "userdata", "symbol": "NQ", "timeframe": "1m",
            "script": "trades = [{'entry_i': 0, 'exit_i': 2, 'qty': 2, 'point_value': 20}]",
            "options": {"commission_per_unit": 2.5}}
    result = client.post("/api/backtest", json=body)
    assert result.status_code == 200, result.text
    assert result.json()["total_commission"] == 10
    assert result.json()["gross_profit"] == 400
    assert result.json()["net_profit"] == 390
    body["script"] = "raise AssertionError('strategy must not run')"
    for option in ("commission_pct", "commission_per_unit"):
        for bad in (-1, "NaN", "Infinity", "invalid"):
            body["options"] = {option: bad}
            rejected = client.post("/api/backtest", json=body)
            assert rejected.status_code == 400
            assert option in rejected.json()["detail"]
