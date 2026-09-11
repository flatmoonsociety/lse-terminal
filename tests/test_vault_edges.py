"""Export coverage checks use only fake candle probes, never provider jobs."""

from unittest.mock import Mock

import pandas as pd
import pytest

from lse_terminal.providers import vault_import


PAYLOAD = {"dataset": "futures", "symbol": "NQ.F", "timeframe": "1m",
           "start": "2024-01-02T14:30:00", "end": "2024-01-02T14:34:00"}


def frame(*values):
    return pd.DataFrame({"ts": list(values)})


def test_rejects_truncated_interior_chunk_even_when_later_chunk_is_complete():
    # A global final-date check would accept this combined download. The first
    # chunk has its last minute missing, so validation must stop before merge.
    client = Mock()
    client.candles.side_effect = [
        [{"timestamp": "2024-01-02T14:30:00Z"}],
        [{"timestamp": "2024-01-02T14:33:00Z"}],
    ]
    raw = frame("2024-01-02T14:30:00Z", "2024-01-02T14:31:00Z")
    with pytest.raises(ValueError, match="last row.*14:31:00.*14:33:00"):
        vault_import.validate_chunk_edges(client, PAYLOAD, raw)
    assert client.candles.call_count == 2
    for call, order in zip(client.candles.call_args_list, ("asc", "desc")):
        assert call.args == ("NQ.F",)
        assert call.kwargs == {key: PAYLOAD[key] for key in
                               ("dataset", "timeframe", "start", "end")} | {
                                   "order": order, "limit": 1}


@pytest.mark.parametrize("numeric_unit", ["s", "ms"])
def test_accepts_numeric_epoch_and_sdk_timestamp_responses(numeric_unit):
    stamps = pd.to_datetime(["2024-01-02T14:30:00Z", "2024-01-02T14:33:00Z"])
    scale = 1 if numeric_unit == "s" else 1000
    epochs = [int(stamp.timestamp()) * scale for stamp in stamps]
    client = Mock()
    client.candles.side_effect = [[{"timestamp": epochs[0]}], [{"ts": epochs[1]}]]
    vault_import.validate_chunk_edges(client, PAYLOAD, frame(*epochs))


def test_empty_holiday_requires_both_endpoints_empty():
    client = Mock()
    client.candles.side_effect = [[], []]
    vault_import.validate_chunk_edges(client, PAYLOAD, frame())
    assert client.candles.call_count == 2
    client.candles.side_effect = [[], [{"timestamp": "2024-01-02T14:33:00Z"}]]
    with pytest.raises(ValueError, match="incomplete futures candle chunk"):
        vault_import.validate_chunk_edges(client, PAYLOAD, frame())


def test_leading_truncation_and_unexpected_export_rows_fail():
    client = Mock()
    client.candles.return_value = [{"timestamp": "2024-01-02T14:30:00Z"}]
    with pytest.raises(ValueError, match="first row"):
        vault_import.validate_chunk_edges(client, PAYLOAD,
                                          frame("2024-01-02T14:31:00Z"))
    client.candles.return_value = []
    with pytest.raises(ValueError, match="first row"):
        vault_import.validate_chunk_edges(client, PAYLOAD,
                                          frame("2024-01-02T14:30:00Z"))


def test_probe_retries_are_transient_only_and_finite(monkeypatch):
    pause = Mock()
    monkeypatch.setattr(vault_import, "_pause", pause)
    client = Mock()
    client.candles.side_effect = [OSError("network"), [], []]
    vault_import.validate_chunk_edges(client, PAYLOAD, frame())
    assert pause.call_args.args[-1] == 1

    pause.reset_mock()
    client.candles.reset_mock(side_effect=True)
    client.candles.side_effect = OSError("offline")
    with pytest.raises(OSError, match="offline"):
        vault_import.validate_chunk_edges(client, PAYLOAD, frame())
    assert client.candles.call_count == 3
    assert [call.args[-1] for call in pause.call_args_list] == [1, 2]

    pause.reset_mock()
    client.candles.reset_mock(side_effect=True)
    client.candles.side_effect = ValueError("bad request")
    with pytest.raises(ValueError, match="bad request"):
        vault_import.validate_chunk_edges(client, PAYLOAD, frame())
    assert client.candles.call_count == 1
    pause.assert_not_called()
