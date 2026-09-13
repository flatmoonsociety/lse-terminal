"""Repeatable backtest accounting benchmark and reference check.

Run with ``.venv\\Scripts\\python.exe tools\\benchmark_backtest.py``.
"""
from __future__ import annotations
import argparse
import subprocess
import time
import types
import numpy as np
import pandas as pd
from lse_terminal.backtest.runner import PythonRunner

def frame(n=300_000):
    ts = np.arange(n, dtype=np.int64) * 60
    close = 100.0 + np.sin(np.arange(n) / 1000.0)
    return pd.DataFrame({"ts": ts, "open": np.full(n, 100.0),
        "high": np.full(n, 101.0), "low": np.full(n, 99.0),
        "close": close, "volume": np.ones(n)})

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-ref", default="1e5992d", help="git ref containing the baseline runner")
    args = parser.parse_args()
    df = frame(); raw = [{"entry_i": i, "exit_i": i + 1000, "qty": 1.0}
                           for i in range(0, len(df) - 1000, 100)]
    runner = PythonRunner(); trades = runner._normalize(raw, df)
    for _ in range(3):
        start = time.perf_counter()
        optimized = runner._account(trades, df, 100_000.0, 0.0, 0.0)
        print(f"optimized={time.perf_counter() - start:.6f}s trades={len(trades)} bars={len(df)}")

    # Load the clean base implementation without modifying the checkout.
    source = subprocess.check_output(["git", "show", f"{args.base_ref}:lse_terminal/backtest/runner.py"], text=True)
    module = types.ModuleType("benchmark_base")
    exec(compile(source, "<baseline runner>", "exec"), module.__dict__)
    base = module.PythonRunner()
    base_trades = base._normalize(raw, df)
    start = time.perf_counter()
    baseline = base._account(base_trades, df, 100_000.0, 0.0, 0.0)
    print(f"base-ref={args.base_ref} {time.perf_counter() - start:.6f}s trades={len(base_trades)} bars={len(df)}")
    np.testing.assert_array_equal(optimized[0], baseline[0])
    assert optimized[1:] == baseline[1:]
    assert [vars(t) for t in trades] == [vars(t) for t in base_trades]
    print("PASS: identical equity curve, exposure, final equity and trades")

if __name__ == "__main__":
    main()
