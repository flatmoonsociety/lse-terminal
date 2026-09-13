"""Measure full-fidelity backtest JSON transport without user data or a server.

Run: .venv/Scripts/python.exe tools/benchmark_backtest_transport.py
"""

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from time import perf_counter
from unittest.mock import patch

from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from lse_terminal.engine import saved_backtests


def main():
    points = [[1700000000 + i * 60, 100000 + i / 7] for i in range(300000)]
    result = {"engine": "python", "symbol": "BENCHMARK", "timeframe": "1m",
              "initial_capital": 100000, "final_equity": points[-1][1],
              "net_profit": points[-1][1] - 100000, "stats": {}, "trades": [],
              "equity_curve": points, "benchmark_curve": points}
    start = perf_counter()
    before = JSONResponse(jsonable_encoder(result)).body
    baseline = perf_counter() - start
    start = perf_counter()
    after = JSONResponse(result).body
    optimized = perf_counter() - start
    assert before == after
    print(f"New result JSON: {baseline:.3f}s -> {optimized:.3f}s "
          f"({baseline / optimized:.1f}x); identical bytes, {len(points):,} bars")

    with TemporaryDirectory(prefix="lse-report-benchmark-") as directory:
        with patch.object(saved_backtests.config, "config_dir", lambda: Path(directory)):
            summary = saved_backtests.create("Benchmark", result, {})
            start = perf_counter()
            before = JSONResponse(jsonable_encoder(saved_backtests.read(summary["id"]))).body
            baseline = perf_counter() - start
            start = perf_counter()
            after = saved_backtests.read_json(summary["id"])
            optimized = perf_counter() - start
            assert json.loads(before) == json.loads(after)
            print(f"Saved result JSON: {baseline:.3f}s -> {optimized:.3f}s "
                  f"({baseline / optimized:.1f}x); identical document")


if __name__ == "__main__":
    main()
