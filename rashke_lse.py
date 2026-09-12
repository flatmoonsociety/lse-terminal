# run: NQ_F_1M 1m
"""LSE-compatible port of the QuantConnect Raschke NQ strategy.

The QC version used SPY only to identify full NYSE sessions and used the
mapped NQ contract for execution. LSE receives the selected one-minute NQ
series directly, so this script keeps the 15-minute EMA, trend-ratio, EMA
target, slippage, and 15:58 flatten rules in the normal LSE trade contract.
"""
from datetime import date, datetime, time
from math import ceil, floor
from zoneinfo import ZoneInfo
import numpy as np

ET = ZoneInfo("America/New_York")
# Same contract/session profiles as the ATR strategy. The signal is price
# normalized, while these values control target rounding and one-contract P&L.
INSTRUMENTS = {
    "ES": (0.25, 50.0, time(9, 30), time(16, 0), time(15, 58)),
    "MES": (0.25, 5.0, time(9, 30), time(16, 0), time(15, 58)),
    "NQ": (0.25, 20.0, time(9, 30), time(16, 0), time(15, 58)),
    "MNQ": (0.25, 2.0, time(9, 30), time(16, 0), time(15, 58)),
    "GC": (0.10, 100.0, time(8, 20), time(13, 30), time(13, 28)),
    "MGC": (0.10, 10.0, time(8, 20), time(13, 30), time(13, 28)),
}
# The later Raschke update used 0.45 and is the active default. It remains a
# run parameter so the earlier 0.75 research variant is easy to compare.
EMA_WINDOW, BUCKET, DEFAULT_THRESHOLD = 20, 15, 0.45
SLIPPAGE = 0.25

raw_symbol = str(globals().get("symbol") or "NQ").upper().split(":")[-1]
symbol_master = next((name for name in ("MNQ", "MGC", "MES", "NQ", "GC", "ES")
                      if name in raw_symbol.replace("_", "")), "")
instrument = str(params.get("instrument") or symbol_master or "NQ").upper()
if instrument in INSTRUMENTS:
    tick_size, point_value, OPEN, CLOSE, FLATTEN = INSTRUMENTS[instrument]
else:
    # Other repository instruments can opt in with explicit economics and
    # regular-session clocks; never guess a multiplier for an unknown symbol.
    required_custom = ("tick_size", "point_value", "session_open",
                       "session_close", "flatten_time")
    missing_custom = [name for name in required_custom if name not in params]
    if missing_custom:
        raise ValueError("Unknown instrument requires params: " + ", ".join(missing_custom))
    tick_size = float(params["tick_size"])
    point_value = float(params["point_value"])
    def hhmm(value):
        text = str(value).replace(":", "")
        return time(int(text[:2]), int(text[2:]))
    OPEN, CLOSE, FLATTEN = (hhmm(params[name]) for name in
                            ("session_open", "session_close", "flatten_time"))
    if tick_size <= 0 or point_value <= 0:
        raise ValueError("tick_size and point_value must be positive")
trend_threshold = float(params.get("trend_ratio_threshold", DEFAULT_THRESHOLD))
if not 0.0 < trend_threshold <= 1.0:
    raise ValueError("trend_ratio_threshold must be between 0 and 1")
gap_policy = str(params.get("session_gap_policy", "strict")).lower()
if gap_policy not in ("strict", "causal"):
    raise ValueError("session_gap_policy must be 'strict' or 'causal'")
def date_param(name, default):
    value = str(params.get(name, default)).replace("-", "")
    return datetime.strptime(value, "%Y%m%d").date()
start_day = date_param("start_date", 20160629)
end_day = date_param("end_date", 20260828)
if end_day < start_day:
    raise ValueError("end_date must be on or after start_date")

required = ("ts", "open", "high", "low", "close", "volume")
missing = [name for name in required if name not in df]
if missing:
    raise ValueError(f"Missing OHLCV columns: {missing}")
frame = df[list(required)].reset_index(drop=True)
timestamps = frame.ts.to_numpy(dtype="int64")
if len(frame) < 2 or np.any(np.diff(timestamps) <= 0) or np.any(timestamps % 60):
    raise ValueError("Raschke requires strictly increasing minute-open timestamps")

def local(epoch):
    return datetime.fromtimestamp(int(epoch), ET)

def target_price(ema, side):
    scaled = ema / tick_size
    return (ceil(scaled - 1e-10) if side > 0 else floor(scaled + 1e-10)) * tick_size

def index_of(epoch):
    return int(np.searchsorted(timestamps, int(epoch)))

days = {}
for row in frame.itertuples(index=False):
    dt = local(row.ts)
    if start_day <= dt.date() <= end_day and OPEN <= dt.time() < CLOSE:
        days.setdefault(dt.date(), []).append(row)

seed, ema, pending = [], None, None
position = 0
entry_i = entry_price = target = None
trades, ema_plot = [], []
stats = {"complete_sessions": 0, "qualified_sessions": 0,
         "gap_sessions": 0, "gap_buckets": 0}

def update_ema(value):
    global ema
    if ema is None:
        seed.append(value)
        if len(seed) == EMA_WINDOW:
            ema = sum(seed) / EMA_WINDOW
    else:
        alpha = 2.0 / (EMA_WINDOW + 1.0)
        ema = alpha * value + (1.0 - alpha) * ema

def close_trade(exit_i, exit_price):
    global position, entry_i, entry_price, target
    if position and entry_i is not None:
        trades.append({"entry_i": entry_i, "exit_i": exit_i,
                       "dir": "long" if position > 0 else "short", "qty": 1.0,
                       "entry": entry_price, "exit": exit_price,
                       "point_value": point_value})
    position = 0
    entry_i = entry_price = target = None

for day in sorted(days):
    rows = days[day]
    by_minute = {local(row.ts).hour * 60 + local(row.ts).minute: row for row in rows}
    open_minute = OPEN.hour * 60 + OPEN.minute
    close_minute = CLOSE.hour * 60 + CLOSE.minute
    expected = range(open_minute, close_minute)
    complete = all(minute in by_minute for minute in expected)
    if not complete:
        stats["gap_sessions"] += 1
        if gap_policy == "strict":
            seed, ema, pending = [], None, None
            if position:
                close_trade(index_of(rows[0].ts), float(rows[0].open))
            continue

    first = by_minute.get(open_minute)
    if first is None:
        continue
    if pending is not None and pending[1] and ema is not None and not position:
        side = 1 if first.open < ema else -1 if first.open > ema else 0
        if side:
            # Entry is at the 09:30 regular-session open. The setup's
            # previous-day no-touch rule is the only opening qualification.
            position = side
            entry_i = index_of(first.ts)
            entry_price = float(first.open) + (SLIPPAGE if side > 0 else -SLIPPAGE)
            target = target_price(ema, side)
    pending = None

    session_open = float(first.open)
    session_high, session_low, session_close = -np.inf, np.inf, None
    bucket = []
    valid = True
    buckets = 0
    ema_observable, touch_free = True, True
    force_pending = False
    for row in rows:
        dt = local(row.ts)
        minute = dt.hour * 60 + dt.minute
        high, low, close = float(row.high), float(row.low), float(row.close)
        session_high, session_low, session_close = max(session_high, high), min(session_low, low), close

        if dt.time() == FLATTEN and position:
            force_pending = True
        if force_pending and minute == (FLATTEN.hour * 60 + FLATTEN.minute + 1) and position:
            close_trade(index_of(row.ts), float(row.close) + (SLIPPAGE if position > 0 else -SLIPPAGE))
            force_pending = False
        elif position and target is not None:
            hit = (position > 0 and high >= target) or (position < 0 and low <= target)
            if hit:
                # Long targets are sell limits; short targets are buy limits.
                fill = max(target, row.open) - SLIPPAGE if position > 0 else min(target, row.open) + SLIPPAGE
                close_trade(index_of(row.ts), float(fill))

        offset = minute - open_minute
        bucket_index, bucket_minute = divmod(offset, BUCKET)
        if bucket and (bucket[0][0] != bucket_index or int(row.ts) != bucket[-1][1] + 60):
            valid, bucket = False, []
            stats["gap_buckets"] += 1
        if not bucket:
            if bucket_minute != 0:
                continue
            bucket = [(bucket_index, int(row.ts), high, low, close)]
        else:
            bucket.append((bucket_index, int(row.ts), max(bucket[-1][2], high), min(bucket[-1][3], low), close))
        if len(bucket) < BUCKET:
            continue
        _, _, bucket_high, bucket_low, bucket_close = bucket[-1]
        if not valid or len(bucket) != BUCKET:
            seed, ema, bucket, valid = [], None, [], True
            continue
        if ema is None:
            ema_observable = False
        elif bucket_low <= ema <= bucket_high:
            touch_free = False
        update_ema(bucket_close)
        buckets += 1
        ema_plot.append([int(row.ts) + BUCKET * 60, float(ema) if ema is not None else float("nan")])
        bucket = []
        if position and ema is not None:
            target = target_price(ema, position)

    if position:
        last = rows[-1]
        close_trade(index_of(last.ts), float(last.close) + (SLIPPAGE if position > 0 else -SLIPPAGE))
    complete_signal = complete and buckets == 26 and not bucket and session_close is not None
    price_range = session_high - session_low
    ratio = abs(session_close - session_open) / price_range if price_range > 0 else 0.0
    qualified = complete_signal and ema_observable and touch_free and ratio >= trend_threshold
    if complete_signal:
        stats["complete_sessions"] += 1
        stats["qualified_sessions"] += qualified
    pending = (day, qualified)

plots = {"20-bar EMA": ema_plot}
