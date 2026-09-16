"""smc_ict_system/src/smc_core.py — structural detectors.

Pure functions over a validated OHLCV frame. Nothing here touches the
network, the database, or the clock: given the same candles and the same
config, every detector returns the same zones. That property is what
makes the backtester honest and the live scan reproducible.

Concept families, matching the taxonomy in sql/002_technical_levels.sql:

    STRUCTURE   SWING_HIGH / SWING_LOW   fractal pivots
                BOS / CHoCH / MSS        breaks of structure
    IMBALANCE   FVG (BISI / SIBI)        three-candle gaps
                ORDER_BLOCK              origin candle of a displacement leg
    LIQUIDITY   LIQUIDITY_POOL           equal highs / equal lows
                STOP_HUNT                sweep of a pool then rejection
    EXTREME     PDH / PDL                previous day high / low
                ASIA_HIGH / ASIA_LOW     asia killzone extremes
                DEALING_RANGE            current range premium/discount

Every detector returns ``Zone`` objects. ``Zone`` is deliberately a plain
dataclass with the same field names the collector layer uses, so
``data_loader.build_zone_row`` can map either system's output onto the
shared ``technical_levels`` table without translation.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime
from typing import Any, Iterable, Mapping, Sequence

import numpy as np
import pandas as pd

from .utils import (
    atr,
    cfg_get,
    current_killzone,
    current_session,
    ensure_frame,
    load_config,
    setup_logging,
    to_utc,
    trading_day,
)

log = setup_logging("smc_core")

# ------------------------------------------------------------------
# TAXONOMY
# ------------------------------------------------------------------

BULLISH = "BULLISH"
BEARISH = "BEARISH"
NEUTRAL = "NEUTRAL"

# Concept names, kept as constants so a typo is a NameError not a silent
# mismatch against the SQL CHECK constraints.
SWING_HIGH = "SWING_HIGH"
SWING_LOW = "SWING_LOW"
BOS = "BOS"
CHOCH = "CHoCH"
MSS = "MSS"
FVG = "FVG"
ORDER_BLOCK = "ORDER_BLOCK"
LIQUIDITY_POOL = "LIQUIDITY_POOL"
STOP_HUNT = "STOP_HUNT"
SESSION_HIGH = "SESSION_HIGH"
SESSION_LOW = "SESSION_LOW"
DEALING_RANGE = "DEALING_RANGE"

# Lifecycle states, matching chk_tl_status.
FRESH = "FRESH"
TOUCHED = "TOUCHED"
MITIGATED = "MITIGATED"
VIOLATED = "VIOLATED"
EXPIRED = "EXPIRED"

UNMITIGATED = "UNMITIGATED"
PARTIAL = "PARTIAL"
FULL = "FULL"


@dataclass
class Zone:
    """One detected structural zone.

    Field names mirror ``collectors.yahoo_collector.Zone`` plus the extra
    columns the engine populates (confluence, execution linkage, MTF
    confirmation). ``price_high`` is always the distal edge and
    ``price_low`` the proximal edge, so ``price_high >= price_low`` holds
    for every zone regardless of direction.
    """

    concept: str
    direction: str
    price_high: float
    price_low: float
    formed_at: datetime
    sub_concept: str | None = None
    price_open: float | None = None
    price_close: float | None = None
    atr_at_formation: float | None = None
    ref_price: float | None = None
    displacement_atr: float | None = None
    strength: float | None = None
    polarity: int = 0
    status: str = FRESH
    mitigation_state: str = UNMITIGATED
    tags: tuple[str, ...] = ()
    meta: dict[str, Any] = field(default_factory=dict)

    # Populated by the confluence / MTF passes, not by the detectors.
    confluence: tuple[str, ...] = ()
    mtf_confirmed: bool = False
    mtf_aligned_tfs: tuple[str, ...] = ()
    ltf_trigger_tf: str | None = None
    entry_price: float | None = None
    stop_price: float | None = None
    target_price: float | None = None
    risk_reward: float | None = None

    # ---- derived geometry -------------------------------------------

    @property
    def mid(self) -> float:
        return (self.price_high + self.price_low) / 2.0

    @property
    def height(self) -> float:
        return self.price_high - self.price_low

    @property
    def is_bullish(self) -> bool:
        return self.direction == BULLISH

    @property
    def is_bearish(self) -> bool:
        return self.direction == BEARISH

    @property
    def is_zone(self) -> bool:
        """True when the zone has real height (an OB or FVG, not a line)."""
        return self.height > 0.0

    def contains(self, price: float) -> bool:
        return self.price_low <= price <= self.price_high

    def overlaps(self, other: "Zone", tolerance: float = 0.0) -> bool:
        """True when two zones share price space."""
        return (
            self.price_low - tolerance <= other.price_high
            and other.price_low - tolerance <= self.price_high
        )

    def overlap_ratio(self, other: "Zone") -> float:
        """Fraction of the smaller zone covered by the intersection."""
        top = min(self.price_high, other.price_high)
        bottom = max(self.price_low, other.price_low)
        if top <= bottom:
            return 0.0
        smaller = min(self.height, other.height)
        if smaller <= 0:
            return 0.0
        return (top - bottom) / smaller

    def distance_to(self, price: float) -> float:
        """Signed distance from ``price`` to the nearest edge (0 inside)."""
        if price > self.price_high:
            return price - self.price_high
        if price < self.price_low:
            return price - self.price_low
        return 0.0

    def age_bars(self, frame: pd.DataFrame) -> int:
        """How many bars have closed since this zone formed."""
        formed = to_utc(self.formed_at)
        if formed is None:
            return 0
        return int((frame.index > formed).sum())

    def to_dict(self) -> dict[str, Any]:
        return {
            "concept": self.concept,
            "sub_concept": self.sub_concept,
            "direction": self.direction,
            "price_high": self.price_high,
            "price_low": self.price_low,
            "formed_at": self.formed_at.isoformat(),
            "atr_at_formation": self.atr_at_formation,
            "strength": self.strength,
            "polarity": self.polarity,
            "status": self.status,
            "mitigation_state": self.mitigation_state,
            "tags": list(self.tags),
            "meta": self.meta,
        }


@dataclass(frozen=True)
class DetectorParams:
    """Resolved detector tuning, read once per run from config."""

    pivot_strength: int = 2
    equal_level_tol_pct: float = 0.0006
    min_fvg_atr: float = 0.15
    atr_period: int = 14
    displacement_atr: float = 1.0
    ob_lookback: int = 20
    sweep_lookback: int = 50
    min_rr: float = 2.0
    max_zone_age_bars: int = 300

    @classmethod
    def from_config(cls, config: Mapping[str, Any] | None = None) -> "DetectorParams":
        config = config or load_config()
        return cls(
            pivot_strength=int(cfg_get(config, "detectors.pivot_strength", 2)),
            equal_level_tol_pct=float(
                cfg_get(config, "detectors.equal_level_tol_pct", 0.0006)
            ),
            min_fvg_atr=float(cfg_get(config, "detectors.min_fvg_atr", 0.15)),
            atr_period=int(cfg_get(config, "detectors.atr_period", 14)),
            displacement_atr=float(cfg_get(config, "detectors.displacement_atr", 1.0)),
            ob_lookback=int(cfg_get(config, "detectors.ob_lookback", 20)),
            sweep_lookback=int(cfg_get(config, "detectors.sweep_lookback", 50)),
            min_rr=float(cfg_get(config, "detectors.min_rr", 2.0)),
            max_zone_age_bars=int(cfg_get(config, "detectors.max_zone_age_bars", 300)),
        )

    def as_dict(self) -> dict[str, Any]:
        """Serialised into technical_levels.algo_params for replay."""
        return {
            "pivot_strength": self.pivot_strength,
            "equal_level_tol_pct": self.equal_level_tol_pct,
            "min_fvg_atr": self.min_fvg_atr,
            "atr_period": self.atr_period,
            "displacement_atr": self.displacement_atr,
            "ob_lookback": self.ob_lookback,
            "sweep_lookback": self.sweep_lookback,
            "min_rr": self.min_rr,
            "max_zone_age_bars": self.max_zone_age_bars,
        }


# ------------------------------------------------------------------
# FRAME PREPARATION
# ------------------------------------------------------------------


def prepare(frame: pd.DataFrame, params: DetectorParams | None = None) -> pd.DataFrame:
    """Validate a frame and attach the derived columns detectors need.

    Adds ``atr``, ``body``, ``range``, ``bullish``, ``bearish`` and
    ``displacement``. Called once per timeframe; every detector then reads
    the same arrays instead of recomputing them.
    """
    params = params or DetectorParams()
    out = ensure_frame(frame)
    out["atr"] = atr(out, params.atr_period)
    out["body"] = (out["close"] - out["open"]).abs()
    out["range"] = out["high"] - out["low"]
    out["bullish"] = out["close"] > out["open"]
    out["bearish"] = out["close"] < out["open"]
    out["displacement"] = out["body"] >= out["atr"] * params.displacement_atr
    return out


def _finite(value: Any) -> bool:
    """True when ``value`` is a usable, non-NaN number."""
    if value is None:
        return False
    try:
        return bool(np.isfinite(float(value)))
    except (TypeError, ValueError):
        return False


def _atr_at(frame: pd.DataFrame, index: int) -> float | None:
    value = frame["atr"].iloc[index]
    return float(value) if _finite(value) else None


# ------------------------------------------------------------------
# STRUCTURE — PIVOTS
# ------------------------------------------------------------------


def find_pivots(
    frame: pd.DataFrame, params: DetectorParams | None = None
) -> list[Zone]:
    """Fractal swing highs and lows.

    A bar is a swing high when its high is the strict maximum of the
    ``strength`` bars either side of it. The strictness matters: a flat
    top with two equal highs is a liquidity pool, not a pivot, and
    treating it as one would fabricate structure that is not there.
    """
    params = params or DetectorParams()
    strength = max(1, params.pivot_strength)

    highs = frame["high"].to_numpy(dtype=float)
    lows = frame["low"].to_numpy(dtype=float)
    times = frame.index
    zones: list[Zone] = []

    for i in range(strength, len(frame) - strength):
        window_high = highs[i - strength : i + strength + 1]
        window_low = lows[i - strength : i + strength + 1]

        if highs[i] == window_high.max() and (window_high == highs[i]).sum() == 1:
            zones.append(
                Zone(
                    concept=SWING_HIGH,
                    sub_concept=None,
                    direction=BEARISH,
                    price_high=float(highs[i]),
                    price_low=float(highs[i]),
                    formed_at=times[i].to_pydatetime(),
                    atr_at_formation=_atr_at(frame, i),
                    polarity=1,
                    strength=float(strength),
                    tags=("PIVOT", "STRUCTURE"),
                    meta={"index": int(i), "strength": int(strength)},
                )
            )

        if lows[i] == window_low.min() and (window_low == lows[i]).sum() == 1:
            zones.append(
                Zone(
                    concept=SWING_LOW,
                    sub_concept=None,
                    direction=BULLISH,
                    price_high=float(lows[i]),
                    price_low=float(lows[i]),
                    formed_at=times[i].to_pydatetime(),
                    atr_at_formation=_atr_at(frame, i),
                    polarity=-1,
                    strength=float(strength),
                    tags=("PIVOT", "STRUCTURE"),
                    meta={"index": int(i), "strength": int(strength)},
                )
            )

    return zones


def pivot_series(frame: pd.DataFrame, params: DetectorParams | None = None) -> list[Zone]:
    """Pivots sorted by formation time — the input to structure analysis."""
    pivots = find_pivots(frame, params)
    pivots.sort(key=lambda zone: zone.formed_at)
    return pivots


# Swing labels, in the order a trend reads them.
HIGHER_HIGH = "HH"
HIGHER_LOW = "HL"
LOWER_HIGH = "LH"
LOWER_LOW = "LL"
FIRST_HIGH = "H"
FIRST_LOW = "L"


def label_swings(
    frame: pd.DataFrame, params: DetectorParams | None = None
) -> list[Zone]:
    """Annotate each pivot with HH / HL / LH / LL.

    Returns a new list of Zones (inputs are not mutated) whose ``meta``
    carries ``swing_label`` and ``swing_rank``. The first high and first
    low have nothing to compare against, so they are labelled ``H`` and
    ``L`` rather than being forced into the HH/LH dichotomy.

    Labels are assigned per side, walking each series in time order: a
    high above the previous high is HH, otherwise LH. This is the
    vocabulary the confluence layer reads when it asks whether structure
    is making higher highs and higher lows.
    """
    params = params or DetectorParams()
    pivots = pivot_series(frame, params)

    highs = [zone for zone in pivots if zone.concept == SWING_HIGH]
    lows = [zone for zone in pivots if zone.concept == SWING_LOW]

    labelled: list[Zone] = []

    previous: float | None = None
    for rank, zone in enumerate(highs):
        if previous is None:
            label = FIRST_HIGH
        elif zone.price_high > previous:
            label = HIGHER_HIGH
        else:
            label = LOWER_HIGH
        previous = zone.price_high
        labelled.append(_with_swing_label(zone, label, rank))

    previous = None
    for rank, zone in enumerate(lows):
        if previous is None:
            label = FIRST_LOW
        elif zone.price_low > previous:
            label = HIGHER_LOW
        else:
            label = LOWER_LOW
        previous = zone.price_low
        labelled.append(_with_swing_label(zone, label, rank))

    labelled.sort(key=lambda zone: zone.formed_at)
    return labelled


def _with_swing_label(zone: Zone, label: str, rank: int) -> Zone:
    """Copy a pivot with its swing label folded into ``meta`` and tags."""
    meta = dict(zone.meta)
    meta["swing_label"] = label
    meta["swing_rank"] = int(rank)
    tags = tuple(dict.fromkeys(zone.tags + (label,)))
    return replace(zone, meta=meta, tags=tags)


def swing_labels(zones: Sequence[Zone]) -> list[str]:
    """The HH/HL/LH/LL sequence from an already-labelled zone list."""
    ordered = sorted(zones, key=lambda zone: zone.formed_at)
    return [
        str(zone.meta["swing_label"])
        for zone in ordered
        if "swing_label" in zone.meta
    ]


def structure_trend(zones: Sequence[Zone]) -> str:
    """Trend implied by the last labelled high and low.

    Bullish when the most recent high is an HH and the most recent low an
    HL; bearish when they are LH and LL. Anything mixed is NEUTRAL, which
    is the honest answer — a market making higher highs but lower lows is
    ranging, not trending.
    """
    labelled = [zone for zone in zones if "swing_label" in zone.meta]
    if not labelled:
        return NEUTRAL

    last_high = None
    last_low = None
    for zone in sorted(labelled, key=lambda z: z.formed_at):
        if zone.concept == SWING_HIGH:
            last_high = str(zone.meta["swing_label"])
        elif zone.concept == SWING_LOW:
            last_low = str(zone.meta["swing_label"])

    if last_high == HIGHER_HIGH and last_low == HIGHER_LOW:
        return BULLISH
    if last_high == LOWER_HIGH and last_low == LOWER_LOW:
        return BEARISH
    return NEUTRAL


# ------------------------------------------------------------------
# STRUCTURE — BOS / CHoCH / MSS
# ------------------------------------------------------------------


def find_structure_breaks(
    frame: pd.DataFrame, params: DetectorParams | None = None
) -> list[Zone]:
    """Breaks of structure, classified as BOS, CHoCH or MSS.

    The walk is sequential and stateful, which is the whole point: a close
    above the most recent swing high is only a *continuation* (BOS) when
    the previous break was also bullish. The first break against the
    prevailing direction is a change of character (CHoCH), and a CHoCH
    that also takes out the opposite extreme in the same leg is a market
    structure shift (MSS) — the strongest reversal signal in the family.

    A pivot is consumed once broken, so the same swing cannot generate two
    breaks. Breaks are searched forward from each pivot within a bounded
    window; a pivot that survives the window stays live for the next pass.
    """
    params = params or DetectorParams()
    zones: list[Zone] = []

    pivots = pivot_series(frame, params)
    if not pivots:
        return zones

    closes = frame["close"].to_numpy(dtype=float)
    highs = frame["high"].to_numpy(dtype=float)
    lows = frame["low"].to_numpy(dtype=float)
    times = frame.index
    time_to_index = {time: i for i, time in enumerate(times)}

    last_break_direction: str | None = None
    last_high: Zone | None = None
    last_low: Zone | None = None

    for pivot in pivots:
        if pivot.concept == SWING_HIGH:
            last_high = pivot
        else:
            last_low = pivot

        index = time_to_index.get(pd.Timestamp(pivot.formed_at))
        if index is None:
            continue

        window_end = min(index + 60, len(frame))

        for k in range(index + 1, window_end):
            atr_k = _atr_at(frame, k)
            if atr_k is None:
                continue

            # ---- bullish break: close above the live swing high ------
            if last_high is not None and closes[k] > last_high.price_high:
                continuation = last_break_direction == BULLISH
                sub = BOS if continuation else CHOCH
                concept = sub

                # A CHoCH that also takes the opposite extreme in the
                # same leg is an MSS — the reversal is confirmed.
                if not continuation and last_low is not None:
                    if highs[k] > last_high.price_high and closes[k] > last_low.price_low:
                        concept = MSS
                        sub = MSS

                zones.append(
                    Zone(
                        concept=concept,
                        sub_concept=sub,
                        direction=BULLISH,
                        price_high=float(last_high.price_high),
                        price_low=float(last_high.price_high),
                        formed_at=times[k].to_pydatetime(),
                        price_close=float(closes[k]),
                        atr_at_formation=atr_k,
                        ref_price=float(last_high.price_high),
                        displacement_atr=float(
                            (closes[k] - last_high.price_high) / atr_k
                        ),
                        polarity=1,
                        strength=float((closes[k] - last_high.price_high) / atr_k),
                        tags=("STRUCTURE", sub),
                        meta={
                            "broken_pivot_at": last_high.formed_at.isoformat(),
                            "broken_level": float(last_high.price_high),
                            "break_index": int(k),
                            "prior_direction": last_break_direction,
                        },
                    )
                )
                last_break_direction = BULLISH
                last_high = None
                break

            # ---- bearish break: close below the live swing low -------
            if last_low is not None and closes[k] < last_low.price_low:
                continuation = last_break_direction == BEARISH
                sub = BOS if continuation else CHOCH
                concept = sub

                if not continuation and last_high is not None:
                    if lows[k] < last_low.price_low and closes[k] < last_high.price_high:
                        concept = MSS
                        sub = MSS

                zones.append(
                    Zone(
                        concept=concept,
                        sub_concept=sub,
                        direction=BEARISH,
                        price_high=float(last_low.price_low),
                        price_low=float(last_low.price_low),
                        formed_at=times[k].to_pydatetime(),
                        price_close=float(closes[k]),
                        atr_at_formation=atr_k,
                        ref_price=float(last_low.price_low),
                        displacement_atr=float(
                            (last_low.price_low - closes[k]) / atr_k
                        ),
                        polarity=-1,
                        strength=float((last_low.price_low - closes[k]) / atr_k),
                        tags=("STRUCTURE", sub),
                        meta={
                            "broken_pivot_at": last_low.formed_at.isoformat(),
                            "broken_level": float(last_low.price_low),
                            "break_index": int(k),
                            "prior_direction": last_break_direction,
                        },
                    )
                )
                last_break_direction = BEARISH
                last_low = None
                break

    return zones


def structure_bias(zones: Sequence[Zone]) -> str:
    """Direction of the most recent structural break, or NEUTRAL.

    This is the value the HTF filter compares against: a 15m long is only
    tradeable when the 1h bias is not bearish.
    """
    latest = last_break(zones)
    return latest.direction if latest else NEUTRAL


def last_break(zones: Sequence[Zone]) -> Zone | None:
    """Most recent structural break, or None when structure is undefined."""
    breaks = [zone for zone in zones if zone.concept in (BOS, CHOCH, MSS)]
    if not breaks:
        return None
    return max(breaks, key=lambda zone: zone.formed_at)


# ------------------------------------------------------------------
# IMBALANCE — FAIR VALUE GAPS
# ---------------------------------------------------------------------------


def find_fvgs(frame: pd.DataFrame, params: DetectorParams | None = None) -> list[Zone]:
    """Three-candle fair value gaps, filtered by ATR so micro-gaps drop out.

    A bullish gap (BISI) is candle ``i-2``'s high sitting below candle
    ``i``'s low: the middle candle moved so fast it left unfilled space
    behind it. A bearish gap (SIBI) is the mirror. The gap must exceed
    ``min_fvg_atr`` of ATR(14) or it is noise, not imbalance.
    """
    params = params or DetectorParams()
    zones: list[Zone] = []

    highs = frame["high"].to_numpy(dtype=float)
    lows = frame["low"].to_numpy(dtype=float)
    opens = frame["open"].to_numpy(dtype=float)
    closes = frame["close"].to_numpy(dtype=float)
    times = frame.index

    for i in range(2, len(frame)):
        atr_i = _atr_at(frame, i)
        if atr_i is None:
            continue
        min_gap = atr_i * params.min_fvg_atr

        # Bullish gap: candle i-2 high sits below candle i low.
        if lows[i] - highs[i - 2] > min_gap:
            gap = float(lows[i] - highs[i - 2])
            zones.append(
                Zone(
                    concept=FVG,
                    sub_concept="BISI",
                    direction=BULLISH,
                    price_high=float(lows[i]),
                    price_low=float(highs[i - 2]),
                    formed_at=times[i].to_pydatetime(),
                    price_open=float(opens[i]),
                    price_close=float(closes[i]),
                    atr_at_formation=atr_i,
                    ref_price=float(highs[i - 2]),
                    polarity=-1,
                    strength=float(gap / atr_i),
                    tags=("IMBALANCE", "BISI"),
                    meta={
                        "gap": gap,
                        "gap_atr": float(gap / atr_i),
                        "index": int(i),
                        "middle_index": int(i - 1),
                    },
                )
            )

        # Bearish gap: candle i-2 low sits above candle i high.
        if lows[i - 2] - highs[i] > min_gap:
            gap = float(lows[i - 2] - highs[i])
            zones.append(
                Zone(
                    concept=FVG,
                    sub_concept="SIBI",
                    direction=BEARISH,
                    price_high=float(lows[i - 2]),
                    price_low=float(highs[i]),
                    formed_at=times[i].to_pydatetime(),
                    price_open=float(opens[i]),
                    price_close=float(closes[i]),
                    atr_at_formation=atr_i,
                    ref_price=float(lows[i - 2]),
                    polarity=1,
                    strength=float(gap / atr_i),
                    tags=("IMBALANCE", "SIBI"),
                    meta={
                        "gap": gap,
                        "gap_atr": float(gap / atr_i),
                        "index": int(i),
                        "middle_index": int(i - 1),
                    },
                )
            )

    return zones


# ------------------------------------------------------------------
# IMBALANCE — ORDER BLOCKS
# ---------------------------------------------------------------------------


def find_order_blocks(
    frame: pd.DataFrame, params: DetectorParams | None = None
) -> list[Zone]:
    """Origin candle of a displacement leg that breaks local structure.

    A bullish order block is the last down candle before an up leg whose
    close exceeds the prior swing high — the footprint of the buy-side
    interest that started the move. Bearish is the mirror.

    Two filters keep the set honest. The displacement candle's body must
    exceed ``displacement_atr`` ATRs, so a slow grind does not qualify;
    and the origin candle is searched back at most ``ob_lookback`` bars,
    so a stale candle from a different regime is not retro-fitted as the
    origin of today's move.
    """
    params = params or DetectorParams()
    zones: list[Zone] = []

    opens = frame["open"].to_numpy(dtype=float)
    closes = frame["close"].to_numpy(dtype=float)
    highs = frame["high"].to_numpy(dtype=float)
    lows = frame["low"].to_numpy(dtype=float)
    times = frame.index

    lookback = max(1, params.ob_lookback)
    structure_window = max(2, params.pivot_strength * 2)

    for i in range(structure_window + 1, len(frame)):
        atr_i = _atr_at(frame, i)
        if atr_i is None:
            continue

        body = abs(closes[i] - opens[i])
        if body < atr_i * params.displacement_atr:
            continue  # not a displacement candle

        prior_high = float(highs[i - structure_window : i].max())
        prior_low = float(lows[i - structure_window : i].min())

        # Bullish displacement breaking the prior high -> OB is the down candle
        if closes[i] > opens[i] and closes[i] > prior_high:
            origin = _find_origin_candle(
                opens, closes, i, lookback, want_bearish=True
            )
            if origin is not None:
                j = origin
                zones.append(
                    Zone(
                        concept=ORDER_BLOCK,
                        sub_concept="OB",
                        direction=BULLISH,
                        price_high=float(highs[j]),
                        price_low=float(lows[j]),
                        formed_at=times[j].to_pydatetime(),
                        price_open=float(opens[j]),
                        price_close=float(closes[j]),
                        atr_at_formation=_atr_at(frame, j),
                        ref_price=float(highs[j]),
                        displacement_atr=float(body / atr_i),
                        polarity=-1,
                        strength=float(body / atr_i),
                        tags=("DISPLACEMENT", "BULLISH_OB"),
                        meta={
                            "displacement_index": int(i),
                            "origin_index": int(j),
                            "broken_level": prior_high,
                            "displacement_body_atr": float(body / atr_i),
                        },
                    )
                )

        # Bearish displacement breaking the prior low -> OB is the up candle
        if closes[i] < opens[i] and closes[i] < prior_low:
            origin = _find_origin_candle(
                opens, closes, i, lookback, want_bearish=False
            )
            if origin is not None:
                j = origin
                zones.append(
                    Zone(
                        concept=ORDER_BLOCK,
                        sub_concept="OB",
                        direction=BEARISH,
                        price_high=float(highs[j]),
                        price_low=float(lows[j]),
                        formed_at=times[j].to_pydatetime(),
                        price_open=float(opens[j]),
                        price_close=float(closes[j]),
                        atr_at_formation=_atr_at(frame, j),
                        ref_price=float(lows[j]),
                        displacement_atr=float(body / atr_i),
                        polarity=1,
                        strength=float(body / atr_i),
                        tags=("DISPLACEMENT", "BEARISH_OB"),
                        meta={
                            "displacement_index": int(i),
                            "origin_index": int(j),
                            "broken_level": prior_low,
                            "displacement_body_atr": float(body / atr_i),
                        },
                    )
                )

    return zones


def _find_origin_candle(
    opens: np.ndarray,
    closes: np.ndarray,
    displacement_index: int,
    lookback: int,
    want_bearish: bool,
) -> int | None:
    """Nearest opposing candle before the displacement leg.

    Returns the index of the origin candle, or None when the leg started
    from a gap or a same-direction candle and has no clean origin.
    """
    start = max(displacement_index - lookback, 0)
    for j in range(displacement_index - 1, start - 1, -1):
        is_bearish = closes[j] < opens[j]
        if want_bearish and is_bearish:
            return j
        if not want_bearish and closes[j] > opens[j]:
            return j
    return None


# ------------------------------------------------------------------
# LIQUIDITY — POOLS AND SWEEPS
# ---------------------------------------------------------------------------


def find_liquidity_pools(
    frame: pd.DataFrame, params: DetectorParams | None = None
) -> list[Zone]:
    """Equal highs / equal lows — resting liquidity within a tolerance.

    Two highs within ``equal_level_tol_pct`` of each other are treated as
    one pool: retail stops cluster there, and the level is a magnet. The
    zone is stored as a thin band around the level rather than a line, so
    the GIST envelope index in sql/002 can find it.
    """
    params = params or DetectorParams()
    zones: list[Zone] = []

    highs = frame["high"].to_numpy(dtype=float)
    lows = frame["low"].to_numpy(dtype=float)
    times = frame.index

    for i in range(1, len(frame)):
        atr_i = _atr_at(frame, i)
        if atr_i is None:
            continue

        tolerance = float(highs[i]) * params.equal_level_tol_pct

        if abs(highs[i] - highs[i - 1]) <= tolerance:
            level = float(max(highs[i], highs[i - 1]))
            zones.append(
                Zone(
                    concept=LIQUIDITY_POOL,
                    sub_concept="EQUAL_HIGHS",
                    direction=BEARISH,
                    price_high=level + tolerance,
                    price_low=level - tolerance,
                    formed_at=times[i].to_pydatetime(),
                    atr_at_formation=atr_i,
                    ref_price=level,
                    polarity=1,
                    strength=float(tolerance / atr_i),
                    tags=("LIQUIDITY", "EQUAL_HIGHS", "BUYSIDE"),
                    meta={
                        "level": level,
                        "tolerance": tolerance,
                        "index": int(i),
                        "side": "BUYSIDE",
                    },
                )
            )

        if abs(lows[i] - lows[i - 1]) <= tolerance:
            level = float(min(lows[i], lows[i - 1]))
            zones.append(
                Zone(
                    concept=LIQUIDITY_POOL,
                    sub_concept="EQUAL_LOWS",
                    direction=BULLISH,
                    price_high=level + tolerance,
                    price_low=level - tolerance,
                    formed_at=times[i].to_pydatetime(),
                    atr_at_formation=atr_i,
                    ref_price=level,
                    polarity=-1,
                    strength=float(tolerance / atr_i),
                    tags=("LIQUIDITY", "EQUAL_LOWS", "SELLSIDE"),
                    meta={
                        "level": level,
                        "tolerance": tolerance,
                        "index": int(i),
                        "side": "SELLSIDE",
                    },
                )
            )

    return zones


def find_stop_hunts(
    frame: pd.DataFrame, params: DetectorParams | None = None
) -> list[Zone]:
    """Liquidity sweeps: a wick through a prior extreme that closes back inside.

    The signature is a bar whose wick takes out a swing high or low from
    the last ``sweep_lookback`` bars, then closes back on the other side of
    it. That is a stop run — the move that grabbed the liquidity, not the
    move that was going anywhere. Direction is the direction of the
    *reaction*, so a swept high is a bearish signal.

    The swept level is recorded in ``ref_price`` and the reclaim distance
    in ``displacement_atr``, which is what the signal engine scores on.
    """
    params = params or DetectorParams()
    zones: list[Zone] = []

    highs = frame["high"].to_numpy(dtype=float)
    lows = frame["low"].to_numpy(dtype=float)
    closes = frame["close"].to_numpy(dtype=float)
    times = frame.index

    lookback = max(2, params.sweep_lookback)

    for i in range(lookback, len(frame)):
        atr_i = _atr_at(frame, i)
        if atr_i is None:
            continue

        window_high = float(highs[i - lookback : i].max())
        window_low = float(lows[i - lookback : i].min())

        # Swept a high and closed back below it -> bearish reaction.
        if highs[i] > window_high and closes[i] < window_high:
            penetration = float(highs[i] - window_high)
            reclaim = float(window_high - closes[i])
            zones.append(
                Zone(
                    concept=STOP_HUNT,
                    sub_concept="SWEEP_HIGH",
                    direction=BEARISH,
                    price_high=float(highs[i]),
                    price_low=window_high,
                    formed_at=times[i].to_pydatetime(),
                    price_close=float(closes[i]),
                    atr_at_formation=atr_i,
                    ref_price=window_high,
                    displacement_atr=float(reclaim / atr_i),
                    polarity=1,
                    strength=float(penetration / atr_i),
                    tags=("LIQUIDITY", "STOP_HUNT", "BUYSIDE_SWEEP"),
                    meta={
                        "swept_level": window_high,
                        "penetration": penetration,
                        "penetration_atr": float(penetration / atr_i),
                        "reclaim": reclaim,
                        "reclaim_atr": float(reclaim / atr_i),
                        "index": int(i),
                    },
                )
            )

        # Swept a low and closed back above it -> bullish reaction.
        if lows[i] < window_low and closes[i] > window_low:
            penetration = float(window_low - lows[i])
            reclaim = float(closes[i] - window_low)
            zones.append(
                Zone(
                    concept=STOP_HUNT,
                    sub_concept="SWEEP_LOW",
                    direction=BULLISH,
                    price_high=window_low,
                    price_low=float(lows[i]),
                    formed_at=times[i].to_pydatetime(),
                    price_close=float(closes[i]),
                    atr_at_formation=atr_i,
                    ref_price=window_low,
                    displacement_atr=float(reclaim / atr_i),
                    polarity=-1,
                    strength=float(penetration / atr_i),
                    tags=("LIQUIDITY", "STOP_HUNT", "SELLSIDE_SWEEP"),
                    meta={
                        "swept_level": window_low,
                        "penetration": penetration,
                        "penetration_atr": float(penetration / atr_i),
                        "reclaim": reclaim,
                        "reclaim_atr": float(reclaim / atr_i),
                        "index": int(i),
                    },
                )
            )

    return zones


# ------------------------------------------------------------------
# EXTREMES — PDH / PDL, ASIA RANGE, DEALING RANGE
# ------------------------------------------------------------------


def find_previous_day_levels(
    frame: pd.DataFrame, params: DetectorParams | None = None
) -> list[Zone]:
    """PDH / PDL — the previous completed trading day's high and low.

    Days are bucketed on the gold trading day (21:00 UTC roll), not the
    calendar day, so the "previous day" is the session that actually
    closed rather than an arbitrary midnight boundary.
    """
    params = params or DetectorParams()
    zones: list[Zone] = []

    if frame.empty:
        return zones

    working = frame.copy()
    working["trading_day"] = [
        trading_day(pd.Timestamp(time).to_pydatetime()) for time in working.index
    ]

    grouped = working.groupby("trading_day", sort=True)
    days = list(grouped.groups.keys())

    for index in range(1, len(days)):
        previous_day = days[index - 1]
        current_day = days[index]
        previous = grouped.get_group(previous_day)
        current = grouped.get_group(current_day)

        atr_value = _atr_at(current, 0)
        day_high = float(previous["high"].max())
        day_low = float(previous["low"].min())
        formed_at = current.index[0].to_pydatetime()

        zones.append(
            Zone(
                concept=SESSION_HIGH,
                sub_concept="PDH",
                direction=BEARISH,
                price_high=day_high,
                price_low=day_high,
                formed_at=formed_at,
                atr_at_formation=atr_value,
                ref_price=day_high,
                polarity=1,
                tags=("EXTREME", "PDH"),
                meta={"source_day": str(previous_day)},
            )
        )
        zones.append(
            Zone(
                concept=SESSION_LOW,
                sub_concept="PDL",
                direction=BULLISH,
                price_high=day_low,
                price_low=day_low,
                formed_at=formed_at,
                atr_at_formation=atr_value,
                ref_price=day_low,
                polarity=-1,
                tags=("EXTREME", "PDL"),
                meta={"source_day": str(previous_day)},
            )
        )

    return zones


def find_asia_range(
    frame: pd.DataFrame,
    params: DetectorParams | None = None,
    config: Mapping[str, Any] | None = None,
) -> list[Zone]:
    """Asia killzone high and low, stamped on the session that follows.

    The Asia range is the reference box London and New York trade against:
    a sweep of the Asia high during the London open is the classic Judas
    swing. One pair of levels is emitted per trading day.
    """
    params = params or DetectorParams()
    config = config or load_config()
    zones: list[Zone] = []

    if frame.empty:
        return zones

    working = frame.copy()
    working["trading_day"] = [
        trading_day(pd.Timestamp(time).to_pydatetime()) for time in working.index
    ]
    working["killzone"] = [
        current_killzone(pd.Timestamp(time).to_pydatetime(), config)
        for time in working.index
    ]

    asia = working[working["killzone"] == "ASIA_RANGE"]
    if asia.empty:
        return zones

    for day, group in asia.groupby("trading_day", sort=True):
        atr_value = _atr_at(group, 0)
        high = float(group["high"].max())
        low = float(group["low"].min())
        formed_at = group.index[-1].to_pydatetime()

        zones.append(
            Zone(
                concept=SESSION_HIGH,
                sub_concept="ASIA_HIGH",
                direction=BEARISH,
                price_high=high,
                price_low=high,
                formed_at=formed_at,
                atr_at_formation=atr_value,
                ref_price=high,
                polarity=1,
                tags=("EXTREME", "ASIA", "KILLZONE"),
                meta={"trading_day": str(day), "killzone": "ASIA_RANGE"},
            )
        )
        zones.append(
            Zone(
                concept=SESSION_LOW,
                sub_concept="ASIA_LOW",
                direction=BULLISH,
                price_high=low,
                price_low=low,
                formed_at=formed_at,
                atr_at_formation=atr_value,
                ref_price=low,
                polarity=-1,
                tags=("EXTREME", "ASIA", "KILLZONE"),
                meta={"trading_day": str(day), "killzone": "ASIA_RANGE"},
            )
        )

    return zones


def find_dealing_range(
    frame: pd.DataFrame, params: DetectorParams | None = None
) -> list[Zone]:
    """The current dealing range, split at its midpoint.

    Premium (above the 50% level) is where you sell, discount (below) is
    where you buy. Emitted as two zones so the engine can ask a single
    question — which half is price in — without recomputing the range.
    """
    params = params or DetectorParams()
    if frame.empty:
        return []

    high = float(frame["high"].max())
    low = float(frame["low"].min())
    if high <= low:
        return []

    mid = (high + low) / 2.0
    formed_at = frame.index[-1].to_pydatetime()
    atr_value = _atr_at(frame, len(frame) - 1)

    return [
        Zone(
            concept=DEALING_RANGE,
            sub_concept="PREMIUM",
            direction=BEARISH,
            price_high=high,
            price_low=mid,
            formed_at=formed_at,
            atr_at_formation=atr_value,
            ref_price=mid,
            polarity=1,
            tags=("EXTREME", "DEALING_RANGE", "PREMIUM"),
            meta={"range_high": high, "range_low": low, "equilibrium": mid},
        ),
        Zone(
            concept=DEALING_RANGE,
            sub_concept="DISCOUNT",
            direction=BULLISH,
            price_high=mid,
            price_low=low,
            formed_at=formed_at,
            atr_at_formation=atr_value,
            ref_price=mid,
            polarity=-1,
            tags=("EXTREME", "DEALING_RANGE", "DISCOUNT"),
            meta={"range_high": high, "range_low": low, "equilibrium": mid},
        ),
    ]


# ------------------------------------------------------------------
# AGGREGATION
# ------------------------------------------------------------------


def detect_zones(
    frame: pd.DataFrame,
    params: DetectorParams | None = None,
    config: Mapping[str, Any] | None = None,
    include_extremes: bool = True,
) -> list[Zone]:
    """Run every detector over one timeframe and return the combined set.

    ``frame`` must already be prepared (see ``prepare``); passing a raw
    frame raises rather than silently producing empty results, because a
    missing ATR column would make every detector skip every bar.
    """
    params = params or DetectorParams()
    config = config or load_config()

    if "atr" not in frame.columns:
        raise ValueError("frame must be prepared with smc_core.prepare() first")

    zones: list[Zone] = []
    zones.extend(find_pivots(frame, params))
    zones.extend(find_structure_breaks(frame, params))
    zones.extend(find_fvgs(frame, params))
    zones.extend(find_order_blocks(frame, params))
    zones.extend(find_liquidity_pools(frame, params))
    zones.extend(find_stop_hunts(frame, params))

    if include_extremes:
        zones.extend(find_previous_day_levels(frame, params))
        zones.extend(find_asia_range(frame, params, config))
        zones.extend(find_dealing_range(frame, params))

    zones.sort(key=lambda zone: zone.formed_at)
    return zones


def detect_by_concept(
    frame: pd.DataFrame,
    params: DetectorParams | None = None,
    config: Mapping[str, Any] | None = None,
) -> dict[str, list[Zone]]:
    """Same detection pass, grouped by concept. Used by the report layer."""
    grouped: dict[str, list[Zone]] = {}
    for zone in detect_zones(frame, params, config):
        grouped.setdefault(zone.concept, []).append(zone)
    return grouped


def concept_counts(zones: Iterable[Zone]) -> dict[str, int]:
    """Concept -> count, for dry-run summaries."""
    counts: dict[str, int] = {}
    for zone in zones:
        counts[zone.concept] = counts.get(zone.concept, 0) + 1
    return counts


# ------------------------------------------------------------------
# LIFECYCLE — MITIGATION AND FRESHNESS
# ---------------------------------------------------------------------------


def track_mitigation(zone: Zone, frame: pd.DataFrame) -> Zone:
    """Walk the bars after formation and update the zone's lifecycle state.

    Returns a new Zone (the input is not mutated) carrying:

        touches             how many bars traded into the zone
        first_touch_at      when price first entered
        mitigated_at        when price closed through the far edge
        status              FRESH -> TOUCHED -> MITIGATED / VIOLATED
        mitigation_state    UNMITIGATED -> PARTIAL -> FULL

    A wick into the zone is a touch; a *close* beyond the distal edge is
    mitigation. That distinction is what separates a zone that absorbed
    the move from one that failed.
    """
    formed = to_utc(zone.formed_at)
    if formed is None or frame.empty:
        return zone

    after = frame[frame.index > formed]
    if after.empty:
        return zone

    touches = 0
    first_touch_at: datetime | None = None
    mitigated_at: datetime | None = None
    status = FRESH
    mitigation_state = UNMITIGATED

    for time, bar in after.iterrows():
        high = float(bar["high"])
        low = float(bar["low"])
        close = float(bar["close"])

        entered = low <= zone.price_high and high >= zone.price_low
        if entered:
            touches += 1
            if first_touch_at is None:
                first_touch_at = time.to_pydatetime()
            if status == FRESH:
                status = TOUCHED

        # Close through the distal edge: the zone failed.
        if zone.is_bullish and close < zone.price_low:
            mitigated_at = time.to_pydatetime()
            status = VIOLATED
            mitigation_state = FULL
            break
        if zone.is_bearish and close > zone.price_high:
            mitigated_at = time.to_pydatetime()
            status = VIOLATED
            mitigation_state = FULL
            break

        # Close back out the proximal side after a touch: the zone held.
        if entered and touches > 1:
            if zone.is_bullish and close > zone.price_high:
                status = MITIGATED
                mitigation_state = PARTIAL
            elif zone.is_bearish and close < zone.price_low:
                status = MITIGATED
                mitigation_state = PARTIAL

    updated = Zone(
        concept=zone.concept,
        sub_concept=zone.sub_concept,
        direction=zone.direction,
        price_high=zone.price_high,
        price_low=zone.price_low,
        formed_at=zone.formed_at,
        price_open=zone.price_open,
        price_close=zone.price_close,
        atr_at_formation=zone.atr_at_formation,
        ref_price=zone.ref_price,
        displacement_atr=zone.displacement_atr,
        strength=zone.strength,
        polarity=zone.polarity,
        status=status,
        mitigation_state=mitigation_state,
        tags=zone.tags,
        meta=dict(zone.meta),
        confluence=zone.confluence,
        mtf_confirmed=zone.mtf_confirmed,
        mtf_aligned_tfs=zone.mtf_aligned_tfs,
        ltf_trigger_tf=zone.ltf_trigger_tf,
        entry_price=zone.entry_price,
        stop_price=zone.stop_price,
        target_price=zone.target_price,
        risk_reward=zone.risk_reward,
    )
    updated.meta.update(
        {
            "touches": touches,
            "first_touch_at": first_touch_at.isoformat() if first_touch_at else None,
            "mitigated_at": mitigated_at.isoformat() if mitigated_at else None,
        }
    )
    return updated


def is_stale(
    zone: Zone, frame: pd.DataFrame, params: DetectorParams | None = None
) -> bool:
    """True when a zone is older than ``max_zone_age_bars``."""
    params = params or DetectorParams()
    if params.max_zone_age_bars <= 0:
        return False
    return zone.age_bars(frame) > params.max_zone_age_bars


def live_zones(
    zones: Sequence[Zone],
    frame: pd.DataFrame,
    params: DetectorParams | None = None,
    concepts: Sequence[str] | None = None,
) -> list[Zone]:
    """Zones still worth trading: valid, unmitigated, not stale.

    This is the filter the signal engine runs before scoring, so the
    confluence pass never wastes time on a zone that was violated three
    days ago.
    """
    params = params or DetectorParams()
    wanted = set(concepts) if concepts else None

    live: list[Zone] = []
    for zone in zones:
        if wanted is not None and zone.concept not in wanted:
            continue
        if zone.status in (VIOLATED, EXPIRED):
            continue
        if zone.mitigation_state == FULL:
            continue
        if is_stale(zone, frame, params):
            continue
        live.append(zone)
    return live


# ------------------------------------------------------------------
# CONFLUENCE
# ------------------------------------------------------------------

# Concepts that count as independent confirmation when they overlap a
# zone. Two order blocks on top of each other is one idea, not two, so
# the label is the concept family rather than the individual zone.
CONFLUENCE_LABELS: dict[str, str] = {
    ORDER_BLOCK: "OB_OVERLAP",
    FVG: "FVG_OVERLAP",
    LIQUIDITY_POOL: "LIQUIDITY_OVERLAP",
    STOP_HUNT: "SWEEP_CONFIRM",
    SESSION_HIGH: "SESSION_LEVEL",
    SESSION_LOW: "SESSION_LEVEL",
    DEALING_RANGE: "RANGE_LEVEL",
    BOS: "STRUCTURE_BREAK",
    CHOCH: "STRUCTURE_BREAK",
    MSS: "STRUCTURE_BREAK",
}


def score_confluence(
    zones: Sequence[Zone],
    tolerance_atr: float = 0.25,
) -> list[Zone]:
    """Label each zone with the other concepts it overlaps.

    Two zones are confluent when their price envelopes intersect within
    ``tolerance_atr`` ATRs. The tolerance matters on gold: a 15m FVG and a
    1h order block rarely share an exact edge, but a quarter-ATR gap is
    the same level in practice.

    Returns new Zone objects with ``confluence`` populated and
    ``strength`` nudged upward for each distinct confirming concept, so a
    zone sitting on three ideas outranks an isolated one.
    """
    scored: list[Zone] = []

    for zone in zones:
        atr_value = zone.atr_at_formation or 0.0
        tolerance = atr_value * tolerance_atr if atr_value else 0.0

        labels: list[str] = []
        for other in zones:
            if other is zone:
                continue
            if other.direction != zone.direction:
                continue
            if not zone.overlaps(other, tolerance):
                continue
            label = CONFLUENCE_LABELS.get(other.concept)
            if label and label not in labels:
                labels.append(label)

        updated = Zone(
            concept=zone.concept,
            sub_concept=zone.sub_concept,
            direction=zone.direction,
            price_high=zone.price_high,
            price_low=zone.price_low,
            formed_at=zone.formed_at,
            price_open=zone.price_open,
            price_close=zone.price_close,
            atr_at_formation=zone.atr_at_formation,
            ref_price=zone.ref_price,
            displacement_atr=zone.displacement_atr,
            strength=zone.strength,
            polarity=zone.polarity,
            status=zone.status,
            mitigation_state=zone.mitigation_state,
            tags=zone.tags,
            meta=dict(zone.meta),
            confluence=tuple(labels),
            mtf_confirmed=zone.mtf_confirmed,
            mtf_aligned_tfs=zone.mtf_aligned_tfs,
            ltf_trigger_tf=zone.ltf_trigger_tf,
            entry_price=zone.entry_price,
            stop_price=zone.stop_price,
            target_price=zone.target_price,
            risk_reward=zone.risk_reward,
        )
        updated.meta["confluence_count"] = len(labels)
        scored.append(updated)

    return scored


def apply_mtf_confirmation(
    zones: Sequence[Zone],
    htf_zones: Sequence[Zone],
    htf_label: str,
    tolerance_atr: float = 0.5,
    min_overlap: float = 0.25,
) -> list[Zone]:
    """Mark zones that a higher timeframe independently agrees with.

    A 15m bullish order block is only ``mtf_confirmed`` when the 1h has a
    bullish zone at the same price. This is the flag the SQL partial index
    ``idx_tl_quality_rank`` filters on, so it has to mean something: the
    HTF zone must be a real zone (OB / FVG / pool / sweep), must agree on
    direction, and must cover at least ``min_overlap`` of the smaller
    envelope. A one-tick graze does not confirm anything.
    """
    confirmed: list[Zone] = []

    for zone in zones:
        atr_value = zone.atr_at_formation or 0.0
        tolerance = atr_value * tolerance_atr if atr_value else 0.0

        aligned = [
            other
            for other in htf_zones
            if other.direction == zone.direction
            and other.concept in (ORDER_BLOCK, FVG, LIQUIDITY_POOL, STOP_HUNT)
            and zone.overlaps(other, tolerance)
            and zone.overlap_ratio(other) >= min_overlap
        ]

        updated = Zone(
            concept=zone.concept,
            sub_concept=zone.sub_concept,
            direction=zone.direction,
            price_high=zone.price_high,
            price_low=zone.price_low,
            formed_at=zone.formed_at,
            price_open=zone.price_open,
            price_close=zone.price_close,
            atr_at_formation=zone.atr_at_formation,
            ref_price=zone.ref_price,
            displacement_atr=zone.displacement_atr,
            strength=zone.strength,
            polarity=zone.polarity,
            status=zone.status,
            mitigation_state=zone.mitigation_state,
            tags=zone.tags,
            meta=dict(zone.meta),
            confluence=zone.confluence,
            mtf_confirmed=bool(aligned),
            mtf_aligned_tfs=(htf_label,) if aligned else (),
            ltf_trigger_tf=zone.ltf_trigger_tf,
            entry_price=zone.entry_price,
            stop_price=zone.stop_price,
            target_price=zone.target_price,
            risk_reward=zone.risk_reward,
        )
        updated.meta["htf_overlap_count"] = len(aligned)
        confirmed.append(updated)

    return confirmed


def nearest_zone(
    zones: Sequence[Zone],
    price: float,
    direction: str | None = None,
    concepts: Sequence[str] | None = None,
) -> Zone | None:
    """Closest zone to ``price``, optionally filtered by direction/concept."""
    wanted = set(concepts) if concepts else None
    candidates = [
        zone
        for zone in zones
        if (direction is None or zone.direction == direction)
        and (wanted is None or zone.concept in wanted)
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda zone: abs(zone.distance_to(price)))
