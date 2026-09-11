"""The strategies a fresh install finds in its workspace.

The workspace used to seed ONE file, an EMA 9/21
crossover, which is the toy every charting package ships and says nothing
about what this terminal is for. The bundled quant strategies each
state the effect they are trying to harvest, measure the regime they need, and
size or gate themselves accordingly.

They are held as source STRINGS rather than .py files in the package because
the engine ships frozen (PyInstaller): code in the PYZ always travels, loose
data files only travel if the spec lists them.

House rules for the original quant starters, because a starter people copy is a
house style whether you meant it or not:

  * Decide on bar i, fill at bar i+1's open. Nothing reads a price it could
    not have known. The one exception is an intrabar stop, which fills at
    the stop level (or the open, if the bar gapped through it) because the
    level was fixed before the bar began.
  * Every rolling statistic is causal: .rolling()/.ewm() only, never a
    centred window, never a full-sample fit.
  * Parameters live in `params` with defaults, so the same file can be swept
    from the UI without editing code.
  * Horizons are stated in DAYS and converted to bars from the dataset's own
    spacing. A lookback written in bars means eight days on hourly gold and
    eight months on daily Apple, which is how one file quietly becomes two
    different strategies; every starter measures the bar first.

The imported ATR phase strategy preserves its NinjaTrader bar-based periods.
"""

VOL_TARGET_TREND = '''# Volatility-Targeted Trend
#
# The effect: trend following makes its money in the fat right tail, a few
# large moves a year, and gives it back in chop. The raw P&L of a fixed-size
# trend rule therefore swings with the volatility regime rather than with the
# quality of the signal.
#
# The fix: size every entry so its notional targets a CONSTANT annualised
# volatility. In calm markets you carry more, in turbulent markets less, and
# the risk taken per trade stops depending on when the trade happened. Most
# of the Sharpe difference between a naive trend rule and a managed-futures
# one lives in this single line of sizing.
import numpy as np

target_vol = float(params.get("target_vol", 0.15))  # annualised vol target
lev_cap = float(params.get("lev_cap", 3.0))         # max notional / capital
CAPITAL = 100_000.0

# Horizons below are in DAYS, converted to bars with this dataset's own
# spacing. A parameter written in bars silently means something different on
# every timeframe: "200" is eight days of hourly gold and eight MONTHS of
# daily Apple, and the same file then behaves like two different strategies.
# Measure the bar, state the horizon in time.
_ts = df["ts"].to_numpy()
_bar_s = float(np.median(np.diff(_ts[:20000]))) if len(_ts) > 2 else 3600.0
_bpd = max(1.0, 86400.0 / max(_bar_s, 1.0))       # bars per day
def _bars(days, floor=3):
    return max(floor, int(round(float(days) * _bpd)))

fast = _bars(params.get("fast_days", 5))            # fast EMA span
slow = _bars(params.get("slow_days", 20))           # slow EMA span
vol_n = _bars(params.get("vol_days", 20))           # realised-vol lookback

close = df["close"]
ema_f = close.ewm(span=fast, adjust=False).mean()
ema_s = close.ewm(span=slow, adjust=False).mean()
up = (ema_f > ema_s).to_numpy()

# Annualise realised vol with a bars-per-year figure measured from the data
# itself, so the same file is correct on 1h gold (24h market) and on daily
# equities without a hardcoded session length.
ret = close.pct_change()
bar_vol = ret.rolling(vol_n).std().to_numpy()
elapsed_years = (df["ts"] - df["ts"].iloc[0]) / (365.25 * 86400.0)
bars_per_year = (np.arange(len(df)) + 1.0) / np.maximum(elapsed_years.to_numpy(), 1e-9)
ann_vol = bar_vol * np.sqrt(bars_per_year)
with np.errstate(divide="ignore", invalid="ignore"):
    leverage = np.minimum(target_vol / ann_vol, lev_cap)

px = close.to_numpy()
n = len(df)
warmup = max(slow, vol_n) + 1

trades = []
in_pos = False
entry_i = 0
qty = 0.0

for i in range(warmup, n - 1):
    if not in_pos:
        if up[i] and np.isfinite(leverage[i]) and leverage[i] > 0:
            in_pos = True
            entry_i = i + 1                     # fill at the next bar's open
            qty = CAPITAL * leverage[i] / px[i]  # size fixed by vol known now
    elif not up[i]:
        trades.append({"entry_i": entry_i, "exit_i": i + 1,
                       "dir": "long", "qty": float(qty)})
        in_pos = False

if in_pos and entry_i < n - 1:
    trades.append({"entry_i": entry_i, "exit_i": n - 1,
                   "dir": "long", "qty": float(qty)})

# The sizing regime IS the strategy: chart what it saw.
plots = {"annualised vol": ann_vol, "leverage": leverage}
'''


OU_HALF_LIFE = '''# Ornstein-Uhlenbeck Half-Life Reversion
#
# The effect: over short horizons many price series are not random walks but
# mean-reverting around a slow-moving level. Fit a rolling AR(1) to price,
# close_t = a + b*close_(t-1); b maps onto an OU process whose half-life is
# -ln(2)/ln(b). A SHORT half-life is direct evidence that the series is
# reverting right now, which is the only regime where fading a stretch pays.
#
# Three details do the work:
#   * trade only when the measured half-life is short (a regime filter that
#     is estimated, not assumed),
#   * enter with a resting limit BEYOND the signal price, so the market has
#     to come to you and the extra displacement pays the spread,
#   * exit on a clock set by the half-life itself, because that is how long
#     the estimated reversion is expected to take.
import numpy as np

z_in = float(params.get("z_in", 2.5))         # stretch that triggers a look
extra = float(params.get("extra", 0.5))       # extra sigmas the limit demands
k_hl = float(params.get("k_hl", 1.0))         # hold this many half-lives

# Horizons below are in DAYS, converted to bars with this dataset's own
# spacing. A parameter written in bars silently means something different on
# every timeframe: "200" is eight days of hourly gold and eight MONTHS of
# daily Apple, and the same file then behaves like two different strategies.
# Measure the bar, state the horizon in time.
_ts = df["ts"].to_numpy()
_bar_s = float(np.median(np.diff(_ts[:20000]))) if len(_ts) > 2 else 3600.0
_bpd = max(1.0, 86400.0 / max(_bar_s, 1.0))       # bars per day
def _bars(days, floor=3):
    return max(floor, int(round(float(days) * _bpd)))

# A z-score over n points is bounded by (n-1)/sqrt(n): over 3 bars the
# largest |z| that can EXIST is 1.15, so a 2.5-sigma trigger on a 3-bar
# window never fires, at any price, in any market. That is what a 2-day
# lookback becomes on daily bars, and it is why this file used to report
# zero trades on the daily sets while looking perfectly reasonable. Floor
# the window at the length the threshold actually needs.
_z_floor = int(z_in * z_in) + 8
n = max(_z_floor, _bars(params.get("z_days", 2)))     # z-score lookback
w = _bars(params.get("fit_days", 10))         # AR(1) fit window
# A ceiling in days becomes 1.5 BARS on a daily series, which nothing
# ever clears; floor it so the filter still selects fast reverters
# rather than silently rejecting every trade (it did: zero trades on
# the daily sets until this floor went in).
hl_max = max(4.0, float(params.get("hl_max_days", 1.5)) * _bpd)
hold_cap = _bars(params.get("hold_cap_days", 3))        # absolute holding cap
# The primary-trend window has to be MUCH longer than the stretch being
# faded, or the two tests contradict each other by construction: "price is
# 2.5 sigma below its 14-bar mean" and "price is above its 20-bar mean" are
# almost mutually exclusive, so the filter rejected every candidate on the
# daily sets (24 signals in, 0 out). Four times the z window is the floor.
trend_w = max(4 * n, _bars(params.get("trend_days", 20)))   # primary trend

# The resting limit exists to make an intraday fade pay for its own spread:
# a few bars of reversion is worth basis points, so the entry has to be
# better than the touch. On daily bars the expected move is worth far more
# than the spread, and demanding a further half-sigma the very next day
# turns a rare setup into no setup at all (measured on daily Apple: 3
# candidate signals in 23 years, 0 fills). Coarse bars take the open.
if _bpd < 2:
    extra = 0.0

c = df["close"]
mean = c.rolling(n).mean()
sd = c.rolling(n).std()
z = ((c - mean) / sd).to_numpy()
sd_a = sd.to_numpy()

# Rolling AR(1) slope b = cov(c_t, c_{t-1}) / var(c_{t-1}). Only 0 < b < 1 is
# a stationary reverting process; anything else is masked out and skipped.
lag = c.shift(1)
beta = c.rolling(w).cov(lag) / lag.rolling(w).var()
half_life = (-np.log(2.0) / np.log(beta.where((beta > 0) & (beta < 1)))).to_numpy()

trend = c.rolling(trend_w).mean().to_numpy()
o, h, l = df["open"].to_numpy(), df["high"].to_numpy(), df["low"].to_numpy()
px = c.to_numpy()
N = len(df)

trades = []
i = max(n, w, trend_w)
while i < N - 2:
    ok = np.isfinite(z[i]) and np.isfinite(half_life[i]) and np.isfinite(trend[i])
    if not (ok and half_life[i] <= hl_max and abs(z[i]) >= z_in):
        i += 1
        continue
    direction = "long" if z[i] < 0 else "short"
    # A fade against the primary trend is the trade that gets run over.
    if (direction == "long" and px[i] < trend[i]) or \\
       (direction == "short" and px[i] > trend[i]):
        i += 1
        continue
    # The limit rests `extra` sigmas beyond the signal close and is good for
    # one bar. Every price here is fixed at bar i, so testing the fill
    # against bar i+1 is causal.
    limit = px[i] - extra * sd_a[i] if direction == "long" else px[i] + extra * sd_a[i]
    if direction == "long" and l[i + 1] <= limit:
        fill = min(o[i + 1], limit)      # opened through the limit: fill at open
    elif direction == "short" and h[i + 1] >= limit:
        fill = max(o[i + 1], limit)
    else:
        i += 1
        continue
    entry_i = i + 1
    hold = min(int(np.ceil(k_hl * half_life[i])), hold_cap)
    exit_i = min(entry_i + hold, N - 1)
    trades.append({"entry_i": entry_i, "exit_i": exit_i,
                   "dir": direction, "entry": float(fill)})
    i = exit_i

# The two estimated quantities every entry depends on. The half-life is
# clipped for display only: near a random walk the estimate explodes, and a
# handful of 10,000-bar readings would flatten the whole pane.
plots = {"stretch z": z,
         "half-life (bars)": np.clip(half_life, 0.0, 4.0 * hl_max)}
'''


VARIANCE_RATIO_SWITCH = '''# Variance-Ratio Gated Trend
#
# The effect being tested: whether trend following pays is not a fixed
# property of an instrument, it is a property of the CURRENT regime, and that
# regime is measurable before you trade it. The Lo-MacKinlay variance ratio
# compares the variance of q-bar returns with q times the variance of 1-bar
# returns:
#
#     VR(q) = Var(r_t + ... + r_(t-q+1)) / (q * Var(r_t))
#
# Under a random walk VR = 1. VR > 1 means returns extend each other, which
# is the statistical signature of a trending regime; VR < 1 means they
# reverse. So: run an ordinary trend rule, but ONLY while the variance ratio
# says the market is in the regime that rule needs, and sit in cash the rest
# of the time.
#
# This file is deliberately the twin of vol_targeted_trend.py: same trend
# signal, same vol sizing, one extra gate. Run both on the same dataset and
# the difference IS the value of the regime test. That comparison is worth
# more than either number on its own, and it is the honest way to find out
# whether a filter earns its complexity.
#
# On the bundled data, measured with 2bp a side, the gate LOSES: hourly gold
# -11k against +178k ungated, hourly EUR/USD -40k against +15k, hourly S&P
# -22k against +154k, daily Apple +124k against +343k. That is the result,
# not a bug to tune away. A variance ratio measured over one window is a
# noisy estimate of a regime that may not persist long enough to trade, and
# every bar it holds you out of a live trend costs you the trend. Keep the
# file as the control experiment it is: change vr_hi, vr_days or q_days and
# watch whether the gate can be made to pay anywhere. If it cannot, that is
# worth knowing before you build something bigger on top of it.
#
# An earlier version of this file also traded a mean-reversion leg whenever
# VR < 1, so it was in the market in every regime. It lost on every bundled
# dataset: two strategies stapled together trade twice as often for no extra
# edge, and the costs are what is left. Standing aside is a position.
import numpy as np

vr_hi = float(params.get("vr_hi", 1.05))            # gate: trend regime above
mom_k = float(params.get("mom_k", 0.5))             # deadband, in vol units
target_vol = float(params.get("target_vol", 0.15))  # annualised vol target
lev_cap = float(params.get("lev_cap", 3.0))
allow_short = bool(params.get("allow_short", True))
CAPITAL = 100_000.0

# Horizons below are in DAYS, converted to bars with this dataset's own
# spacing. A parameter written in bars silently means something different on
# every timeframe: "200" is eight days of hourly gold and eight MONTHS of
# daily Apple, and the same file then behaves like two different strategies.
# Measure the bar, state the horizon in time.
_ts = df["ts"].to_numpy()
_bar_s = float(np.median(np.diff(_ts[:20000]))) if len(_ts) > 2 else 3600.0
_bpd = max(1.0, 86400.0 / max(_bar_s, 1.0))       # bars per day
def _bars(days, floor=3):
    return max(floor, int(round(float(days) * _bpd)))

q = _bars(params.get("q_days", 1), floor=2)       # VR aggregation horizon
vr_win = _bars(params.get("vr_days", 60))         # window the VR is measured on
mom_n = _bars(params.get("mom_days", 20))         # trend lookback
vol_n = _bars(params.get("vol_days", 20))         # vol lookback

c = df["close"]
r = np.log(c).diff()
vr = (r.rolling(q).sum().rolling(vr_win).var() /
      (q * r.rolling(vr_win).var())).to_numpy()

# Trend scored in units of its own noise, with a deadband: raw sign(return)
# flips every time the lookback return crosses zero, and each flip is a round
# trip paid for nothing.
mom = c / c.shift(mom_n) - 1.0
mom_score = (mom / mom.rolling(vr_win).std()).to_numpy()

ret = c.pct_change()
elapsed_years = (df["ts"] - df["ts"].iloc[0]) / (365.25 * 86400.0)
bars_per_year = (np.arange(len(df)) + 1.0) / np.maximum(elapsed_years.to_numpy(), 1e-9)
ann_vol = ret.rolling(vol_n).std().to_numpy() * np.sqrt(bars_per_year)
with np.errstate(divide="ignore", invalid="ignore"):
    leverage = np.minimum(target_vol / ann_vol, lev_cap)

px = c.to_numpy()
N = len(df)
trades = []
pos = 0
entry_i = 0
qty = 0.0

for i in range(max(vr_win + q, mom_n, vol_n) + 1, N - 1):
    gated_on = np.isfinite(vr[i]) and vr[i] >= vr_hi
    m = mom_score[i] if np.isfinite(mom_score[i]) else 0.0

    # The trend signal alone decides direction and exit. The gate decides
    # only whether a NEW position may be opened. Gating the exit as well
    # makes the position flicker every time the variance ratio crosses the
    # threshold, which on hourly data is constantly: that version took 753
    # round trips where this one takes a fraction of them, and the
    # difference was pure cost.
    want = 0
    if abs(m) >= mom_k:
        want = 1 if m > 0 else -1
        if want < 0 and not allow_short:
            want = 0

    if pos != 0 and want != pos:
        trades.append({"entry_i": entry_i, "exit_i": i + 1,
                       "dir": "long" if pos == 1 else "short", "qty": float(qty)})
        pos = 0
    if (pos == 0 and want != 0 and gated_on
            and np.isfinite(leverage[i]) and leverage[i] > 0):
        pos, entry_i = want, i + 1
        qty = CAPITAL * leverage[i] / px[i]

if pos != 0 and entry_i < N - 1:
    trades.append({"entry_i": entry_i, "exit_i": N - 1,
                   "dir": "long" if pos == 1 else "short", "qty": float(qty)})

# The gate and the signal it gates: above vr_hi is the regime the trend rule
# is allowed to trade. Compare this pane against the trades it let through.
plots = {"variance ratio": vr, "trend / noise": mom_score}
'''


CURVE_REGIME = '''# Yield-Curve Regime Overlay
#
# This one reads a second dataset next to the traded bars: the bundled US
# Treasury curve, USYIELDS under MY DATA. Every imported series dataset is
# available on the `data` dict automatically, so this runs as-is on a fresh
# install. If the curve was deleted from the library, this file says so and
# stops, rather than quietly backtesting a different strategy from the one
# you read.
#
# The effect: gold, and real assets generally, are a position on the FRONT
# END of the curve. Gold pays no coupon, so its opportunity cost is the short
# real rate; when the market prices cuts, that cost falls and the metal
# re-rates. The curve says this before the spot price does:
#
#   * 2s10s slope (10Y - 2Y) steepening from an inverted level is the market
#     pricing an easing cycle,
#   * a falling 2Y level is the front end actually delivering it.
#
# So: hold the traded instrument only while the curve is in that regime, and
# stand aside otherwise. This is a macro OVERLAY, not a timing signal; it
# should cut time in market roughly in half and leave the trend intact.
#
# Causality note: a daily yield print is stamped at that day's date but is
# only known after the session closes, so every observation is shifted one
# day forward before it is joined to the bars. Nothing here reads a yield on
# the day it was set.
import numpy as np
import pandas as pd

slope_n = int(params.get("slope_n", 20))     # slope change lookback, days
front_n = int(params.get("front_n", 20))     # 2Y change lookback, days

# Horizons below are in DAYS, converted to bars with this dataset's own
# spacing. A parameter written in bars silently means something different on
# every timeframe: "200" is eight days of hourly gold and eight MONTHS of
# daily Apple, and the same file then behaves like two different strategies.
# Measure the bar, state the horizon in time.
_ts = df["ts"].to_numpy()
_bar_s = float(np.median(np.diff(_ts[:20000]))) if len(_ts) > 2 else 3600.0
_bpd = max(1.0, 86400.0 / max(_bar_s, 1.0))       # bars per day
def _bars(days, floor=3):
    return max(floor, int(round(float(days) * _bpd)))

trend_n = _bars(params.get("trend_days", 20))       # price trend filter
max_hold = _bars(params.get("max_hold_days", 60))   # safety time stop

yields = data.get("USYIELDS", data.get("usyields"))
if yields is None:
    raise ValueError(
        "This strategy needs the US Treasury curve, the bundled series "
        "dataset named USYIELDS. It is not in your library any more; "
        "re-import it under MY DATA (a table with ts, us2y and us10y "
        "columns), then run again."
    )

y = yields.copy()
y = y.dropna(subset=["us2y", "us10y"]).sort_values("ts")
# Publication lag: a close-of-day yield is knowable the NEXT day.
y["ts"] = y["ts"].astype("int64") + 86_400
y["slope"] = y["us10y"] - y["us2y"]
y["slope_chg"] = y["slope"].diff(slope_n)
y["front_chg"] = y["us2y"].diff(front_n)
y = y.dropna(subset=["slope_chg", "front_chg"])

# As-of join: each bar carries the most recent curve reading published
# before it. merge_asof is backward by default, which is exactly causal.
bars = pd.DataFrame({"ts": df["ts"].astype("int64")})
joined = pd.merge_asof(bars, y[["ts", "slope_chg", "front_chg"]], on="ts")

easing = ((joined["slope_chg"] > 0) & (joined["front_chg"] < 0)).to_numpy()
trend_ok = (df["close"] > df["close"].rolling(trend_n).mean()).to_numpy()

n = len(df)
trades = []
in_pos = False
entry_i = 0
for i in range(trend_n + 1, n - 1):
    if not in_pos:
        if easing[i] and trend_ok[i]:
            in_pos, entry_i = True, i + 1
    elif not easing[i] or (i + 1 - entry_i) >= max_hold:
        trades.append({"entry_i": entry_i, "exit_i": i + 1, "dir": "long"})
        in_pos = False

if in_pos and entry_i < n - 1:
    trades.append({"entry_i": entry_i, "exit_i": n - 1, "dir": "long"})

# The curve readings the regime is built from, and the regime itself (0/1).
plots = {"2s10s slope change": joined["slope_chg"],
         "2y change": joined["front_chg"],
         "easing regime": easing.astype(float)}
'''


TSMOM_MULTI = '''# Multi-Horizon Time-Series Momentum
#
# The effect: time-series momentum (Moskowitz, Ooi & Pedersen 2012) is the
# observation that an instrument's own past return predicts its next return
# across horizons from a month to a year, in every asset class tested. It is
# not a single lookback; the same sign shows up at many speeds.
#
# So do not pick one lookback and overfit it. Score three horizons, take the
# position only when they AGREE (a vote), and scale the size by the strength
# of the agreement over realised vol. Disagreement between horizons is
# exactly the turning-point noise that kills single-lookback momentum.
import numpy as np

target_vol = float(params.get("target_vol", 0.12))  # annualised vol target
lev_cap = float(params.get("lev_cap", 2.5))
min_votes = int(params.get("min_votes", 3))         # 3 = unanimous
CAPITAL = 100_000.0

# Horizons below are in DAYS, converted to bars with this dataset's own
# spacing. A parameter written in bars silently means something different on
# every timeframe: "200" is eight days of hourly gold and eight MONTHS of
# daily Apple, and the same file then behaves like two different strategies.
# Measure the bar, state the horizon in time.
_ts = df["ts"].to_numpy()
_bar_s = float(np.median(np.diff(_ts[:20000]))) if len(_ts) > 2 else 3600.0
_bpd = max(1.0, 86400.0 / max(_bar_s, 1.0))       # bars per day
def _bars(days, floor=3):
    return max(floor, int(round(float(days) * _bpd)))

h1 = _bars(params.get("fast_days", 5))              # fast horizon
h2 = _bars(params.get("mid_days", 20))              # medium horizon
h3 = _bars(params.get("slow_days", 60))             # slow horizon
vol_n = _bars(params.get("vol_days", 20))           # vol lookback
rebal = _bars(params.get("rebal_days", 1))          # min spacing of decisions

c = df["close"]
votes = np.zeros(len(df))
for h in (h1, h2, h3):
    votes += np.sign((c / c.shift(h) - 1.0).fillna(0.0).to_numpy())

ret = c.pct_change()
elapsed_years = (df["ts"] - df["ts"].iloc[0]) / (365.25 * 86400.0)
bars_per_year = (np.arange(len(df)) + 1.0) / np.maximum(elapsed_years.to_numpy(), 1e-9)
ann_vol = ret.rolling(vol_n).std().to_numpy() * np.sqrt(bars_per_year)
with np.errstate(divide="ignore", invalid="ignore"):
    leverage = np.minimum(target_vol / ann_vol, lev_cap)

px = c.to_numpy()
n = len(df)
warmup = max(h3, vol_n) + 1

# HOLD while the vote holds. The obvious way to write this is to close and
# re-open every `rebal` bars, and it is wrong: on hourly bars that pays the
# spread ~250 times a year for a signal that changes a handful of times, and
# the costs alone swamp the edge (measured: 3,236 round trips on hourly
# EUR/USD, which is a commission bill of more than twice the account). A
# position is only touched when the vote CHANGES; `rebal` is the minimum
# spacing between decisions, not a forced exit.
trades = []
pos = 0            # -1 short, 0 flat, +1 long
entry_i = 0
qty = 0.0
i = warmup
while i < n - 1:
    v = votes[i]
    want = 0
    if abs(v) >= min_votes and np.isfinite(leverage[i]) and leverage[i] > 0:
        want = 1 if v > 0 else -1
    if want != pos:
        if pos != 0:
            trades.append({"entry_i": entry_i, "exit_i": i + 1,
                           "dir": "long" if pos == 1 else "short",
                           "qty": float(qty)})
        if want != 0:
            entry_i = i + 1
            qty = CAPITAL * leverage[i] / px[i]
        pos = want
        i += rebal        # decisions are spaced, so one wobble is not a churn
    else:
        i += 1

if pos != 0 and entry_i < n - 1:
    trades.append({"entry_i": entry_i, "exit_i": n - 1,
                   "dir": "long" if pos == 1 else "short", "qty": float(qty)})

# The vote the position follows (-3..+3), and the sizing that scales it.
plots = {"votes": votes, "leverage": leverage}
'''


KALMAN_SLOPE = '''# Kalman Constant-Velocity Trend
#
# The effect: every moving average trades lag against smoothness, and picks
# that trade-off once, for all regimes. A Kalman filter picks it CONTINUOUSLY:
# model log price as a level moving at a latent velocity, and the filter
# weights each new observation by how surprising it is relative to the noise
# it has been seeing. The result tracks a real trend faster than an EMA of
# equal smoothness, and ignores single-bar shocks better.
#
# The tradeable output is the velocity itself, not the level. A real trend
# keeps the filtered slope pinned above its own noise band; chop leaves it
# oscillating around zero. Hysteresis (enter high, exit low) stops the
# position flickering on the boundary.
import numpy as np
import pandas as pd

q = float(params.get("q", 1e-6))          # process noise, with R fixed at 1
entry_z = float(params.get("entry_z", 1.0))
exit_z = float(params.get("exit_z", 0.0))
allow_short = bool(params.get("allow_short", False))

# Horizons below are in DAYS, converted to bars with this dataset's own
# spacing. A parameter written in bars silently means something different on
# every timeframe: "200" is eight days of hourly gold and eight MONTHS of
# daily Apple, and the same file then behaves like two different strategies.
# Measure the bar, state the horizon in time.
_ts = df["ts"].to_numpy()
_bar_s = float(np.median(np.diff(_ts[:20000]))) if len(_ts) > 2 else 3600.0
_bpd = max(1.0, 86400.0 / max(_bar_s, 1.0))       # bars per day
def _bars(days, floor=3):
    return max(floor, int(round(float(days) * _bpd)))

std_n = _bars(params.get("noise_days", 20))   # window for the slope noise band

z = np.log(df["close"].to_numpy())
n = len(z)
slope = np.zeros(n)

# State [level, velocity]; F = [[1,1],[0,1]]; we observe the level with
# variance R = 1. R is only a scale here: the gain depends on the ratio q/R.
level, velocity = z[0], 0.0
p11, p12, p22 = 1.0, 0.0, 1.0
for i in range(n):
    # Predict: x = F x, P = F P F' + Q, with Q = q*I on both states.
    level += velocity
    p11 += 2.0 * p12 + p22 + q
    p12 += p22
    p22 += q
    # Update against the observed log close.
    s = p11 + 1.0                       # innovation variance H P H' + R
    k1, k2 = p11 / s, p12 / s
    resid = z[i] - level
    level += k1 * resid
    velocity += k2 * resid
    # P = (I - K H) P with H = [1, 0]; right-hand side uses pre-update values.
    p22 -= k2 * p12
    p12 -= k1 * p12
    p11 -= k1 * p11
    slope[i] = velocity

# Significance: the slope measured against its own recent variability, so the
# threshold means the same thing on gold at $500 and gold at $4,000.
sd = pd.Series(slope).rolling(std_n, min_periods=std_n).std().to_numpy()
score = np.where(sd > 0, slope / sd, 0.0)

trades = []
entry_i = None
direction = "long"
for i in range(n - 1):                  # decide at i, fill at i+1's open
    if entry_i is None:
        if score[i] > entry_z:
            entry_i, direction = i + 1, "long"
        elif allow_short and score[i] < -entry_z:
            entry_i, direction = i + 1, "short"
    else:
        done = score[i] < exit_z if direction == "long" else score[i] > -exit_z
        if done:
            trades.append({"entry_i": entry_i, "exit_i": i + 1, "dir": direction})
            entry_i = None

if entry_i is not None and entry_i < n - 1:
    trades.append({"entry_i": entry_i, "exit_i": n - 1, "dir": direction})

# What the filter found: the latent velocity, and that velocity measured
# against its own noise. The second pane is the traded signal; a real trend
# holds it above entry_z, chop leaves it oscillating around zero.
plots = {"kalman slope": slope, "slope / noise": score}
'''


ENSEMBLE_KILL_SWITCH = '''# Signal Ensemble with an Equity Kill Switch
#
# Two ideas, both about survival rather than entry quality.
#
# 1. ENSEMBLE. Three uncorrelated-ish signals vote: a trend filter, a
#    breakout, and a stretch fade. Any single rule spends long stretches
#    wrong; requiring agreement cuts trade count hard but removes the trades
#    taken for one rule's idiosyncratic reason. This is diversification
#    across MODELS, which is the only free lunch left once you have
#    diversified across assets.
#
# 2. KILL SWITCH. The strategy tracks its own equity curve and stands down
#    while that curve is below its moving average, resuming when it recovers.
#    A rule that has stopped working usually keeps not working for a while,
#    and the equity curve is the earliest honest evidence you have. It cannot
#    look ahead: the switch reads only trades that have already closed.
import numpy as np

z_max = float(params.get("z_max", 1.5))       # do not buy a blow-off top
eq_n = int(params.get("eq_n", 10))            # kill-switch MA, closed trades
CAPITAL = 100_000.0

# Horizons below are in DAYS, converted to bars with this dataset's own
# spacing. A parameter written in bars silently means something different on
# every timeframe: "200" is eight days of hourly gold and eight MONTHS of
# daily Apple, and the same file then behaves like two different strategies.
# Measure the bar, state the horizon in time.
_ts = df["ts"].to_numpy()
_bar_s = float(np.median(np.diff(_ts[:20000]))) if len(_ts) > 2 else 3600.0
_bpd = max(1.0, 86400.0 / max(_bar_s, 1.0))       # bars per day
def _bars(days, floor=3):
    return max(floor, int(round(float(days) * _bpd)))

trend_n = _bars(params.get("trend_days", 20))    # trend filter
break_n = _bars(params.get("break_days", 10))    # breakout lookback
# Same (n-1)/sqrt(n) bound as the OU file: floor the window so the
# stretch test can reach its own threshold.
z_n = max(int(z_max * z_max) + 8, _bars(params.get("z_days", 5)))
hold = _bars(params.get("hold_days", 5))         # holding period

c = df["close"]
sma = c.rolling(trend_n).mean().to_numpy()
prior_high = c.rolling(break_n).max().shift(1).to_numpy()
z = ((c - c.rolling(z_n).mean()) / c.rolling(z_n).std()).to_numpy()
px = c.to_numpy()
o = df["open"].to_numpy()
n = len(df)

trades = []
equity = [CAPITAL]          # equity after each CLOSED trade, nothing pending
eq_pts = []                 # the same track with timestamps, for the report
i = max(trend_n, break_n, z_n) + 1
while i < n - 1:
    votes = 0
    if np.isfinite(sma[i]) and px[i] > sma[i]:
        votes += 1                                   # with the trend
    if np.isfinite(prior_high[i]) and px[i] > prior_high[i]:
        votes += 1                                   # breaking out
    if np.isfinite(z[i]) and z[i] < z_max:
        votes += 1                                   # not already stretched
    if votes < 3:
        i += 1
        continue

    # Kill switch: only trade while the realised equity curve is above its
    # own moving average. Both sides are built from closed trades only.
    if len(equity) > eq_n:
        recent_ma = float(np.mean(equity[-eq_n:]))
        if equity[-1] < recent_ma:
            i += 1
            continue

    entry_i = i + 1
    exit_i = min(entry_i + hold, n - 1)
    qty = CAPITAL / px[i]
    trades.append({"entry_i": entry_i, "exit_i": exit_i,
                   "dir": "long", "qty": float(qty)})
    # Mark the closed trade into the equity track the switch reads.
    equity.append(equity[-1] + qty * (o[exit_i] - o[entry_i]))
    eq_pts.append([float(_ts[exit_i]), float(equity[-1])])
    i = exit_i

# The stretch measure the third vote reads, and the equity track the kill
# switch stands down on. The second pane is [ts, value] pairs because it
# ticks once per CLOSED trade, not once per bar.
plots = {"stretch z": z, "kill-switch equity": eq_pts}
'''


from lse_terminal.backtest.atr_phase import STARTER as ATR_PHASE


# Seeded into workspace strategies/ on first open, in this order.
STARTERS = (
    ("vol_targeted_trend.py", VOL_TARGET_TREND),
    ("ou_half_life_reversion.py", OU_HALF_LIFE),
    ("variance_ratio_gated_trend.py", VARIANCE_RATIO_SWITCH),
    ("curve_regime_overlay.py", CURVE_REGIME),
    ("tsmom_multi_horizon.py", TSMOM_MULTI),
    ("kalman_slope_trend.py", KALMAN_SLOPE),
    ("ensemble_kill_switch.py", ENSEMBLE_KILL_SWITCH),
    ("atr_normalized_phase_momentum.py", ATR_PHASE),
)
