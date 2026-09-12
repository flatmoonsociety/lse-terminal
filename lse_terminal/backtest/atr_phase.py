"""Signal port of ATR_NORMALIZED_PHASE_MOMENTUM_MULTI_SESSION_VWAP_v2.

Input timestamps are aware minute *opens*. Only ten contiguous minutes starting
on a UTC ten-minute boundary update the indicator. Execution and order lifecycle
belong to the caller; ``target_position`` is a requested final position, never an
assumed fill. Calendar preflight is an explicit, retrospective data-quality step.
"""

from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from hashlib import sha256
from math import isfinite
from typing import Iterable
from zoneinfo import ZoneInfo


UTC = timezone.utc
EASTERN = ZoneInfo("America/New_York")
MINUTE = timedelta(minutes=1)
TEN_MINUTES = timedelta(minutes=10)
FROZEN_CALENDAR_SHA256 = "1e462b463e6420a2f15fe7fd3a80482ccdbb2f9f796f65ec8938f88728c36833"
FROZEN_INCOMPLETE_DATE_KEYS = (
    20200120, 20200217, 20200309, 20200312, 20200313, 20200316, 20200318, 20200525,
    20200611, 20200703, 20200907, 20200910, 20201126, 20201127, 20201224, 20210118,
    20210215, 20210402, 20210531, 20210705, 20210906, 20211125, 20211126, 20220117,
    20220221, 20220530, 20220620, 20220704, 20220905, 20221124, 20221125, 20230116,
    20230220, 20230407, 20230529, 20230619, 20230703, 20230704, 20230904, 20231123,
    20231124, 20240115, 20240219, 20240527, 20240619, 20240703, 20240704, 20240902,
    20241128, 20241129, 20241224, 20250109, 20250120, 20250217, 20250526, 20250619,
    20250703, 20250704, 20250901, 20251127, 20251128, 20251224, 20260119, 20260216,
    20260403, 20260525, 20260619, 20260703,
)
INSTRUMENT_ECONOMICS = {
    "ES": (0.25, 50.0), "MES": (0.25, 5.0),
    "NQ": (0.25, 20.0), "MNQ": (0.25, 2.0),
    "GC": (0.10, 100.0), "MGC": (0.10, 10.0),
}


def _date(value: date | int | str) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return datetime.strptime(str(value), "%Y%m%d").date()


def _hhmm(value: int) -> int:
    if not isinstance(value, int) or value < 0 or value // 100 > 23 or value % 100 > 59:
        raise ValueError(f"Invalid New York HHmm value: {value!r}")
    return value // 100 * 60 + value % 100


def _utc_minute(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Minute-open timestamps must include a timezone")
    value = value.astimezone(UTC)
    if value.second or value.microsecond:
        raise ValueError("Minute-open timestamps must align to an exact minute")
    return value


def _minute(value: datetime) -> int:
    return value.hour * 60 + value.minute


@dataclass(frozen=True, slots=True)
class SessionClocks:
    profile: str
    entry_start: int
    entry_end: int
    vwap_start: int
    vwap_end: int
    cash_close: int
    electronic_start: int

    @property
    def required_start(self) -> int:
        return min(self.vwap_start, self.entry_start - 10)

    @property
    def required_count(self) -> int:
        return self.cash_close - self.required_start

    def session_date(self, minute_open: datetime) -> date:
        eastern = minute_open.astimezone(EASTERN)
        return eastern.date() + timedelta(days=_minute(eastern) >= self.electronic_start)


@dataclass(frozen=True, slots=True)
class Config:
    instrument: str = "MNQ"
    session_profile: str = "Automatic"
    tick_size: float | None = None
    point_value: float | None = None
    start_trading_date: int = 20200203
    reset_gap_threshold_ticks: int = 400
    # strict reproduces the supplied NinjaTrader source. causal keeps bars
    # already observed, drops only a broken ten-minute bucket, and resumes at
    # the next aligned bucket without fabricating OHLCV.
    session_gap_policy: str = "strict"
    custom_entry_start_time: int = 930
    custom_entry_end_time: int = 1100
    custom_vwap_start_time: int = 930
    custom_vwap_end_time: int = 1600
    custom_cash_close_time: int = 1600
    custom_electronic_session_start_time: int = 1800
    session: SessionClocks = field(init=False)

    def __post_init__(self) -> None:
        instrument = self.instrument.upper().strip()
        if not instrument:
            raise ValueError("Instrument master name is required")
        object.__setattr__(self, "instrument", instrument)
        if self.session_gap_policy not in ("strict", "causal"):
            raise ValueError("session_gap_policy must be 'strict' or 'causal'")
        profile = self.session_profile
        if profile == "Automatic":
            if instrument in ("ES", "MES", "NQ", "MNQ"):
                profile = "USIndex"
            elif instrument in ("GC", "MGC"):
                profile = "ComexGold"
            else:
                raise ValueError("Automatic supports ES, MES, NQ, MNQ, GC, MGC; use Custom otherwise")
        if profile == "USIndex":
            if instrument not in ("ES", "MES", "NQ", "MNQ"):
                raise ValueError("USIndex requires ES, MES, NQ, or MNQ")
            clocks = (570, 660, 570, 960, 960, 1080)
        elif profile == "ComexGold":
            if instrument not in ("GC", "MGC"):
                raise ValueError("ComexGold requires GC or MGC")
            clocks = (500, 590, 500, 810, 810, 1080)
        elif profile == "Custom":
            clocks = tuple(_hhmm(value) for value in (
                self.custom_entry_start_time, self.custom_entry_end_time,
                self.custom_vwap_start_time, self.custom_vwap_end_time,
                self.custom_cash_close_time, self.custom_electronic_session_start_time,
            ))
        else:
            raise ValueError(f"Unsupported session profile: {profile}")
        session = SessionClocks(profile, *clocks)
        if not 10 <= session.entry_start < session.entry_end <= session.cash_close:
            raise ValueError("Entry window must be ordered and end by cash close")
        if not 0 <= session.vwap_start < session.vwap_end <= session.cash_close:
            raise ValueError("VWAP window must be ordered and end by cash close")
        if session.cash_close >= session.electronic_start or any(value % 10 for value in clocks):
            raise ValueError("Cash close must precede electronic start; all boundaries must align to ten minutes")
        first_fill = max(session.entry_start, session.vwap_start + 10)
        if profile == "Custom" and (first_fill >= session.entry_end or first_fill > session.vwap_end):
            raise ValueError("Custom clocks must permit at least one VWAP-qualified fill")
        object.__setattr__(self, "session", session)
        expected = INSTRUMENT_ECONOMICS.get(instrument)
        for index, name in enumerate(("tick_size", "point_value")):
            value = getattr(self, name)
            if value is None and expected is not None:
                value = expected[index]
            if value is None or not isfinite(value) or value <= 0:
                raise ValueError(f"Positive {name} required")
            if expected is not None and abs(value - expected[index]) > 1e-7:
                raise ValueError(f"{instrument} {name} must be {expected[index]}")
            object.__setattr__(self, name, float(value))
        if not 19000101 <= self.start_trading_date <= 29991231:
            raise ValueError("Start trading date must be a yyyyMMdd date between 1900 and 2999")
        _date(self.start_trading_date)
        if not isinstance(self.reset_gap_threshold_ticks, int) or not 1 <= self.reset_gap_threshold_ticks <= 1_000_000:
            raise ValueError("Reset gap threshold must be 1 through 1,000,000 ticks")
        if len(FROZEN_INCOMPLETE_DATE_KEYS) != 68 or sha256(
            ",".join(map(str, FROZEN_INCOMPLETE_DATE_KEYS)).encode()
        ).hexdigest() != FROZEN_CALENDAR_SHA256:
            raise ValueError("Frozen 68-date MNQ calendar checksum differs from the source")


@dataclass(frozen=True, slots=True)
class MinuteBar:
    open_time: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass(frozen=True, slots=True)
class Decision:
    bar_open: datetime
    bar_close: datetime
    session_date: date | None
    target_position: int | None = None
    reason: str = "NoCross"
    administrative: bool = False
    fail_closed: bool = False
    completed_bar: bool = False
    open: float | None = None
    high: float | None = None
    low: float | None = None
    close: float | None = None
    volume: float | None = None
    ema21: float | None = None
    atr14: float | None = None
    oscillator: float | None = None
    vwap: float | None = None
    vwap_distance_atr: float | None = None
    cross: int = 0
    admitted: bool = False
    shadow_position: int = 0


def audit_incomplete_sessions(
    minute_opens: Iterable[datetime], config: Config,
) -> set[date]:
    """Reproduce the source's loaded-history scan, using future availability.

    This is intentionally opt-in. It excludes an entire incomplete session
    before it can alter recursive state, including its earlier valid minutes.
    A final still-open cash window is not blocked solely for a missing tail.
    """
    session = config.session
    incomplete: set[date] = set()
    current = None
    count = 0
    broken = ended = False
    previous_open = None
    for timestamp in minute_opens:
        timestamp = _utc_minute(timestamp)
        if previous_open is not None and timestamp < previous_open:
            raise ValueError("Preflight timestamps must be in ascending UTC order")
        previous_open = timestamp
        eastern = timestamp.astimezone(EASTERN)
        day = session.session_date(timestamp)
        if current != day:
            if current is not None:
                if day <= current:
                    raise ValueError("Preflight session dates must increase")
                if broken or count != session.required_count:
                    incomplete.add(current)
            current, count, broken, ended = day, 0, False, False
        if eastern.date() != day:
            continue
        minute = _minute(eastern)
        ended |= minute >= session.cash_close
        if session.required_start <= minute < session.cash_close:
            broken |= minute != session.required_start + count
            count += 1
    if current is not None and (broken or (ended and count != session.required_count)):
        incomplete.add(current)
    return incomplete


class Kernel:
    """Stateful signal calculation; actual position and order status are inputs."""

    def __init__(
        self, config: Config,
        incomplete_session_dates: Iterable[date | int] = (),
        schedule_blocked_dates: Iterable[date | int] = (),
    ) -> None:
        self.config = config
        self.session = config.session
        self.incomplete_session_dates = {_date(value) for value in incomplete_session_dates}
        self.schedule_blocked_dates = {_date(value) for value in schedule_blocked_dates}
        self.frozen_dates = (
            {_date(value) for value in FROZEN_INCOMPLETE_DATE_KEYS}
            if config.instrument == "MNQ" and self.session.profile == "USIndex" else set()
        )
        self.start_date = _date(config.start_trading_date)
        self.stats: Counter = Counter()
        self.current_session_date: date | None = None
        self.session_blocked = False
        self.causal_gaps = config.session_gap_policy == "causal"
        self._causal_session_counted = False
        self.required_minute_count = 0
        self.cash_close_exit_requested = False
        self.fail_closed = False
        self.fail_reason = ""
        self._last_open: datetime | None = None
        self._previous_eligible: MinuteBar | None = None
        self._bucket: list[MinuteBar] = []
        self._bucket_contains_reset = False
        self._reset_indicator(False)

    def _reset_indicator(self, after_reset: bool) -> None:
        self.ema21: float | None = None
        self.atr14: float | None = None
        self.oscillator: float | None = None
        self._previous_close: float | None = None
        self._initial_tr_count = 0
        self._initial_tr_sum = 0.0
        self.segment_bar_number = 0
        self.post_reset_segment = after_reset
        self.shadow_position = 0
        self._vwap_date: date | None = None
        self._vwap_valid = True
        self._price_volume = self._volume = 0.0
        self.current_vwap: float | None = None
        self.current_vwap_distance_atr: float | None = None

    def halt(self, reason: str) -> None:
        """Let execution/order failures permanently disable new signal orders."""
        if not self.fail_closed:
            self.fail_reason = reason
        self.fail_closed = True
        self._bucket.clear()

    def _admin(self, bar: MinuteBar, position: int, reason: str) -> Decision:
        return Decision(
            bar.open_time, bar.open_time + MINUTE, self.current_session_date,
            target_position=0 if position else None, reason=reason,
            administrative=True, fail_closed=self.fail_closed,
            shadow_position=self.shadow_position,
        )

    def _block(self, bar: MinuteBar, position: int, reason: str) -> Decision:
        if not self.session_blocked:
            self.stats["blocked_sessions"] += 1
        self.session_blocked = True
        self.halt(reason)
        return self._admin(bar, position, "DataIntegrityExit")

    def on_minute(
        self, bar: MinuteBar, position: int = 0, unresolved_order: bool = False,
    ) -> Decision | None:
        """Consume a completed minute and return a signal or safety event.

        ``position`` is -1/0/+1 from confirmed fills. Set ``unresolved_order``
        while a control or administrative order has not reached a terminal state.
        Even an administrative result with no target must cancel pending entries.
        """
        timestamp = _utc_minute(bar.open_time)
        if timestamp != bar.open_time or bar.open_time.tzinfo != UTC:
            bar = MinuteBar(timestamp, bar.open, bar.high, bar.low, bar.close, bar.volume)
        if self.fail_closed:
            return self._admin(bar, position, "FailClosedFollowup")
        values = (bar.open, bar.high, bar.low, bar.close, bar.volume)
        if (not all(isfinite(value) for value in values) or bar.volume < 0
                or bar.low > min(bar.open, bar.close) or bar.high < max(bar.open, bar.close)
                or bar.low > bar.high):
            self.halt("Invalid minute OHLCV")
            return self._admin(bar, position, "DataIntegrityExit")
        if position not in (-1, 0, 1):
            self.halt("Position exceeds the one-contract strategy limit")
            return self._admin(bar, position, "FailClosedFollowup")
        if self._last_open is not None and timestamp <= self._last_open:
            self.halt("Source minute timestamps must increase strictly")
            return self._admin(bar, position, "DataIntegrityExit")
        self._last_open = timestamp
        eastern = timestamp.astimezone(EASTERN)
        day = self.session.session_date(timestamp)
        if self.current_session_date != day:
            if (self.current_session_date is not None and not self.session_blocked
                    and self.required_minute_count != self.session.required_count):
                if not self.causal_gaps:
                    return self._block(bar, position, "Prior session ended without all required cash-window minutes")
                if not self._causal_session_counted:
                    self.stats["causal_incomplete_sessions"] += 1
                    self._causal_session_counted = True
            if self._bucket:
                self.stats["omitted_incomplete_buckets"] += 1
                self._bucket.clear()
            self.current_session_date = day
            if position or self.shadow_position or unresolved_order:
                if self.causal_gaps and not unresolved_order:
                    # A sparse/early-close session may not have produced the
                    # normal 16:00 bucket. Exit any carried exposure at the
                    # first next-session bar rather than halting the whole
                    # history; strict mode retains source parity.
                    self.shadow_position = 0
                    self.stats["causal_boundary_exits"] += position != 0
                    return self._admin(bar, position, "CausalSessionBoundaryExit")
                self.halt("Exposure, shadow, or unresolved order crossed the electronic-session boundary")
                return self._admin(bar, position, "UnexpectedSessionCarry")
            self.required_minute_count = 0
            self.cash_close_exit_requested = False
            self._causal_session_counted = False
            frozen = day in self.frozen_dates
            preflight = day in self.incomplete_session_dates and not self.causal_gaps
            schedule = day in self.schedule_blocked_dates
            self.session_blocked = frozen or preflight or schedule
            if self.session_blocked:
                self.stats["blocked_sessions"] += 1
                self.stats["frozen_blocked_sessions" if frozen else
                           "preflight_blocked_sessions" if preflight else "schedule_blocked_sessions"] += 1
        if self.session_blocked:
            self._bucket.clear()
            return None
        minute = _minute(eastern)
        if eastern.date() == day:
            if minute >= self.session.cash_close and self.required_minute_count != self.session.required_count:
                if not self.causal_gaps:
                    return self._block(bar, position, "Cash window ended without all required minutes")
                if not self._causal_session_counted:
                    self.stats["causal_incomplete_sessions"] += 1
                    self._causal_session_counted = True
                if position or unresolved_order:
                    self.cash_close_exit_requested = True
                    return self._admin(bar, position, "ConfiguredCashClose")
            if self.session.required_start <= minute < self.session.cash_close:
                if minute != self.session.required_start + self.required_minute_count:
                    if not self.causal_gaps:
                        return self._block(bar, position, "Missing or duplicated required cash-window minute")
                    self.stats["causal_missing_required_minutes"] += 1
                    self.required_minute_count = minute - self.session.required_start
                self.required_minute_count += 1
        previous = self._previous_eligible
        reset = (
            previous is not None and timestamp - previous.open_time == MINUTE
            and timestamp.hour == 0 and timestamp.minute == 0
            and abs(bar.open - previous.close) > self.config.reset_gap_threshold_ticks * self.config.tick_size
        )
        if reset:
            if position or self.shadow_position or unresolved_order:
                self.halt("Roll-like reset with exposure, active shadow, or unresolved order")
                return self._admin(bar, position, "ResetExposureExit")
            self._reset_indicator(True)
            self.stats["indicator_resets"] += 1
        self._previous_eligible = bar
        wanted_open = timestamp.replace(minute=timestamp.minute // 10 * 10)
        if self._bucket and (wanted_open != self._bucket[0].open_time
                             or timestamp != self._bucket[-1].open_time + MINUTE):
            self.stats["omitted_incomplete_buckets"] += 1
            self._bucket.clear()
        if not self._bucket:
            if timestamp != wanted_open:
                return self._admin(bar, position, "CashCloseFollowup") if self.cash_close_exit_requested and (position or unresolved_order) else None
            self._bucket_contains_reset = False
        self._bucket.append(bar)
        self._bucket_contains_reset |= reset
        if len(self._bucket) < 10:
            return self._admin(bar, position, "CashCloseFollowup") if self.cash_close_exit_requested and (position or unresolved_order) else None
        components = self._bucket
        self._bucket = []
        return self._completed(components, position, unresolved_order)

    def _update_indicator(self, high: float, low: float, close: float) -> bool:
        alpha = 2.0 / 22.0
        self.ema21 = close if self.ema21 is None else alpha * close + (1.0 - alpha) * self.ema21
        true_range = high - low if self._previous_close is None else max(
            high - low, abs(high - self._previous_close), abs(low - self._previous_close),
        )
        self._previous_close = close
        if self.atr14 is None:
            self._initial_tr_count += 1
            self._initial_tr_sum += true_range
            if self._initial_tr_count == 14:
                self.atr14 = self._initial_tr_sum / 14
        else:
            self.atr14 = (13.0 * self.atr14 + true_range) / 14.0
        if self.atr14 is None or not isfinite(self.atr14) or self.atr14 <= 0:
            return False
        raw = 100.0 * (close - self.ema21) / (3.0 * self.atr14)
        self.oscillator = raw if self.oscillator is None else 0.5 * raw + 0.5 * self.oscillator
        return True

    def _update_vwap(self, opened: datetime, high: float, low: float, close: float, volume: float) -> bool:
        self.current_vwap = self.current_vwap_distance_atr = None
        eastern = opened.astimezone(EASTERN)
        if (eastern.date() != self.current_session_date
                or not self.session.vwap_start <= _minute(eastern) < self.session.vwap_end):
            return False
        if self._vwap_date != eastern.date():
            self._vwap_date = eastern.date()
            self._vwap_valid = True
            self._price_volume = self._volume = 0.0
        typical = (high + low + close) / 3.0
        if not all(isfinite(value) for value in (high, low, close, typical, volume)) or volume < 0:
            self._vwap_valid = False
        if not self._vwap_valid:
            return False
        price_volume, total_volume = self._price_volume + typical * volume, self._volume + volume
        if not isfinite(price_volume) or not isfinite(total_volume):
            self._vwap_valid = False
            return False
        self._price_volume, self._volume = price_volume, total_volume
        if total_volume <= 0 or self.atr14 is None or not isfinite(self.atr14) or self.atr14 <= 0:
            return False
        vwap = price_volume / total_volume
        if not isfinite(vwap):
            return False
        self.current_vwap = vwap
        self.current_vwap_distance_atr = abs(close - vwap) / self.atr14
        return abs(close - vwap) < 2.5 * self.atr14

    def _apply_cross(self, side: int, inside: bool, admitted: bool, position: int, unresolved: bool) -> tuple[int | None, str]:
        if unresolved:
            self.halt("New cross while a prior order remains unresolved")
            return (0 if position else None), "FailClosedFollowup"
        prior = self.shadow_position
        if prior and position and position != prior:
            self.halt("Filtered position diverged from control shadow")
            return 0, "FailClosedFollowup"
        if prior == side:
            return None, "SameShadowSide"
        if prior == 0:
            if not inside:
                return None, "OutsideEntryWindow"
            if position:
                self.halt("Exposure existed while control shadow was flat")
                return 0, "FailClosedFollowup"
        elif not inside:
            self.shadow_position = 0
            if position == prior:
                self.stats["opposite_exit_requests"] += 1
                return 0, "OppositeCrossExit"
            return None, "OutsideEntryWindow"
        self.shadow_position = side
        self.stats["vwap_admitted_intents" if admitted else "vwap_rejected_intents"] += 1
        if not admitted:
            self.stats["vwap_unavailable_intents"] += self.current_vwap is None
            self.stats["vwap_rejected_reversals"] += prior != 0
            if prior and position == prior:
                self.stats["opposite_exit_requests"] += 1
                return 0, "RejectedReversalExit"
            return None, "VwapRejected"
        self.stats["long_entry_requests" if side == 1 else "short_entry_requests"] += 1
        reversal = prior != 0 and position == prior
        self.stats["reversal_requests"] += reversal
        return side, "Reversal" if reversal else "Entry"

    def _completed(self, bars: list[MinuteBar], position: int, unresolved: bool) -> Decision:
        opened = bars[0].open_time
        closed = opened + TEN_MINUTES
        close = bars[-1].close
        high, low, volume = max(bar.high for bar in bars), min(bar.low for bar in bars), sum(bar.volume for bar in bars)
        if self._bucket_contains_reset and (not self.post_reset_segment or self.segment_bar_number != 0):
            self.halt("Roll reset bucket lost its reset state")
            return self._admin(bars[-1], position, "FailClosedFollowup")
        previous = self.oscillator
        current_available = self._update_indicator(high, low, close)
        admitted = self._update_vwap(opened, high, low, close, volume)
        self.segment_bar_number += 1
        self.stats["exact_decision_bars"] += 1
        eastern_close = closed.astimezone(EASTERN)
        minute = _minute(eastern_close)
        target, reason, cross, admin = None, "NoCross", 0, False
        if eastern_close.date() == self.current_session_date and minute == self.session.cash_close:
            self.shadow_position = 0
            self.cash_close_exit_requested = True
            target, reason, admin = (0 if position else None), "ConfiguredCashClose", True
            self.stats["cash_exit_requests"] += position != 0
        elif self.cash_close_exit_requested:
            target, reason, admin = (0 if position else None), "CashCloseFollowup", bool(position or unresolved)
        elif (self.current_session_date < self.start_date or previous is None or not current_available
              or (self.post_reset_segment and self.segment_bar_number < 21)):
            reason = "Warmup"
        else:
            if previous <= 100.0 and self.oscillator > 100.0:
                cross = 1
            elif previous >= -100.0 and self.oscillator < -100.0:
                cross = -1
            if cross:
                target, reason = self._apply_cross(
                    cross, self.session.entry_start <= minute < self.session.entry_end,
                    admitted, position, unresolved,
                )
                admin = self.fail_closed
        return Decision(
            bar_open=opened, bar_close=closed, session_date=self.current_session_date,
            target_position=target, reason=reason, administrative=admin,
            fail_closed=self.fail_closed, completed_bar=True,
            open=bars[0].open, high=high, low=low, close=close, volume=volume,
            ema21=self.ema21, atr14=self.atr14, oscillator=self.oscillator,
            vwap=self.current_vwap, vwap_distance_atr=self.current_vwap_distance_atr,
            cross=cross, admitted=admitted, shadow_position=self.shadow_position,
        )


# LSE workspace starter source; kept here so frozen builds ship it.
STARTER = r'''# ATR phase strategy: run on one-minute data; signals use ten-minute bars.
# Default: trade from the first selected date. For the original C# date filter,
# set params['start_trading_date'] = 20200203. Results exclude execution costs.
import re
from datetime import datetime, timezone
import numpy as np
from lse_terminal.backtest.atr_phase import Config, Kernel, MinuteBar, audit_incomplete_sessions

raw_symbol = str(globals().get('symbol') or '').upper().split(':')[-1]
# Accept LSE aliases such as NQ_F_1M, NQ.F, and dated futures symbols.
_master = re.match(r'(MNQ|NQ|MES|ES|MGC|GC)', raw_symbol.replace('_', ''))
_symbol_instrument = _master.group(1) if _master else ''
# An explicit instrument override controls contract economics.
_instrument = str(params.get('instrument') or _symbol_instrument or raw_symbol or 'MNQ').upper()
_profile = str(params.get('session_profile', 'Automatic'))
if _instrument not in ('ES','MES','NQ','MNQ','GC','MGC') and _profile != 'Custom':
    raise ValueError(f'Unsupported instrument {raw_symbol!r}; set params.instrument and session_profile="Custom"')
config = Config(
    instrument=_instrument,
    session_profile=_profile,
    tick_size=float(params['tick_size']) if 'tick_size' in params else None,
    point_value=float(params['point_value']) if 'point_value' in params else None,
    start_trading_date=int(params.get('start_trading_date') or
                           datetime.fromtimestamp(int(df.ts.iloc[0]), timezone.utc).strftime('%Y%m%d')),
    reset_gap_threshold_ticks=int(params.get('reset_gap_threshold_ticks', 400)),
    session_gap_policy=str(params.get('session_gap_policy', 'causal')).lower(),
)
required = ('ts', 'open', 'high', 'low', 'close', 'volume')
missing = [name for name in required if name not in df]
if missing:
    raise ValueError(f'Missing OHLCV columns: {missing}')
frame = df[list(required)].reset_index(drop=True)
if frame.ts.duplicated().any() or (np.diff(frame.ts.to_numpy('int64')) <= 0).any():
    raise ValueError('Source minute timestamps must be strictly increasing with no duplicates')
if len(frame) < 2 or float(np.median(np.diff(frame.ts.to_numpy('int64')[:20000]))) != 60.0:
    raise ValueError('This source-faithful port requires one-minute OHLCV data')
opens = [datetime.fromtimestamp(int(t), timezone.utc) for t in frame.ts]
incomplete = audit_incomplete_sessions(opens, config)
kernel = Kernel(config, incomplete_session_dates=incomplete)
position = 0
pending = None
entry_ts = None
trades = []
plot_rows = []
for row, opened in zip(frame.itertuples(index=False), opens):
    # A completed decision at the prior ten-minute close is filled at this
    # minute's open, matching the terminal's next-available-minute model.
    if pending is not None:
        target = pending; pending = None
        if target != position:
            if position and entry_ts is not None:
                trades.append({'entry_ts': int(entry_ts), 'exit_ts': int(opened.timestamp()),
                               'dir': 'long' if position > 0 else 'short', 'qty': float(params.get('qty', 1.0)),
                               'point_value': float(config.point_value)})
                entry_ts = None
            position = int(target)
            if position:
                entry_ts = int(opened.timestamp())
    decision = kernel.on_minute(MinuteBar(opened, float(row.open), float(row.high),
                                          float(row.low), float(row.close), float(row.volume)), position)
    if kernel.fail_closed:
        raise ValueError(f'Strategy halted at {opened.isoformat()}: {kernel.fail_reason}. '
                         'A partial backtest is not a complete-history result.')
    if decision is None:
        continue
    if decision.completed_bar:
        plot_rows.append((int(decision.bar_close.timestamp()), decision))
    if decision.target_position is not None and decision.target_position != position:
        pending = int(decision.target_position)
# Close any still-open position at the final available minute.
if position and entry_ts is not None:
    trades.append({'entry_ts': int(entry_ts), 'exit_ts': int(frame.ts.iloc[-1]),
                   'dir': 'long' if position > 0 else 'short', 'qty': float(params.get('qty', 1.0)),
                   'point_value': float(config.point_value)})

def series(name):
    return [[ts, float(getattr(decision, name)) if getattr(decision, name) is not None else float('nan')]
            for ts, decision in plot_rows]
plots = {'phase oscillator': series('oscillator'), 'ATR14': series('atr14'),
         'session VWAP': series('vwap'), 'VWAP distance (ATR)': series('vwap_distance_atr')}
'''
