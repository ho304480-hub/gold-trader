"""collectors/yahoo_collector.py — Yahoo Finance GC=F -> technical_levels

Pulls gold futures candles and runs a Smart Money Concepts detector over
them, writing one row per detected zone into technical_levels. The table
is versioned on state_version, so a re-detection of the same zone appends
a lifecycle row instead of colliding with the genesis row
(uq_tl_zone_identity is scoped to state_version = 1).

Detectors implemented:
    SWING_HIGH / SWING_LOW   fractal pivots (left/right strength configurable)
    BOS / CHoCH / MSS        break of structure, change of character
    FVG / BISI / SIBI        three-candle fair value gaps
    ORDER_BLOCK              last opposing candle before a displacement leg
    LIQUIDITY_POOL           equal highs / equal lows within a tolerance
    PDH / PDL                previous day high / low

Usage:
    python -m collectors.yahoo_collector                    # 1h, 1 year
    python -m collectors.yahoo_collector --timeframe 15m --range 1mo
    python -m collectors.yahoo_collector --timeframe 1D --range 5y --dry-run
    python -m collectors.yahoo_collector --list
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

import pandas as pd
import requests
from sqlalchemy import text

from .config import dispose, get_engine, setup_logging

log = setup_logging("yahoo")

YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/GC=F"
REQUEST_TIMEOUT = 25
SYMBOL = "XAUUSD"
YAHOO_TICKER = "GC=F"

# Yahoo interval -> (our timeframe label, seconds, tf_rank)
TIMEFRAMES: dict[str, tuple[str, int, int]] = {
    "1m": ("1m", 60, 1),
    "5m": ("5m", 300, 2),
    "15m": ("15m", 900, 3),
    "60m": ("1h", 3600, 4),
    "1d": ("1D", 86400, 6),
}

# Yahoo range -> how far back one request reaches
RANGES = ("1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "max")

# Detector tuning
PIVOT_STRENGTH = 2          # candles either side of a fractal pivot
EQUAL_LEVEL_TOL_PCT = 0.0006  # 0.06% — "equal" highs/lows for liquidity pools
MIN_FVG_ATR = 0.15          # gap must exceed this fraction of ATR(14)
ATR_PERIOD = 14


@dataclass(frozen=True)
class Zone:
    """One detected structural zone, ready to map onto technical_levels."""

    concept: str
    sub_concept: str | None
    direction: str
    price_high: float
    price_low: float
    formed_at: datetime
    price_open: float | None = None
    price_close: float | None = None
    atr_at_formation: float | None = None
    strength: float | None = None
    status: str = "FRESH"
    mitigation_state: str = "UNMITIGATED"
    polarity: int = 0
    tags: tuple[str, ...] = ()
    meta: dict | None = None


def _hash(*parts: object) -> bytes:
    payload = "|".join("" if p is None else str(p) for p in parts)
    return hashlib.sha256(payload.encode("utf-8")).digest()


def _json_dumps(value: object) -> str:
    return json.dumps(value, default=str)


def fetch_candles(interval: str, range_: str) -> pd.DataFrame:
    """Fetch OHLCV from Yahoo and return a tidy, time-sorted frame."""
    response = requests.get(
        YAHOO_CHART_URL,
        params={"interval": interval, "range": range_},
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            "Accept": "application/json",
        },
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()

    result = (response.json().get("chart", {}).get("result") or [None])[0]
    if not result or "timestamp" not in result:
        raise RuntimeError("Yahoo returned no candle data for GC=F")

    quote = result["indicators"]["quote"][0]
    frame = pd.DataFrame(
        {
            "ts": result["timestamp"],
            "open": quote.get("open"),
            "high": quote.get("high"),
            "low": quote.get("low"),
            "close": quote.get("close"),
            "volume": quote.get("volume"),
        }
    )
    frame = frame.dropna(subset=["open", "high", "low", "close"])
    frame["formed_at"] = pd.to_datetime(frame["ts"], unit="s", utc=True)
    frame["volume"] = frame["volume"].fillna(0).astype("int64")
    return frame.reset_index(drop=True)


def add_atr(frame: pd.DataFrame, period: int = ATR_PERIOD) -> pd.DataFrame:
    """Wilder ATR — used to normalise zone height and filter noise gaps."""
    previous_close = frame["close"].shift(1)
    true_range = pd.concat(
        [
            frame["high"] - frame["low"],
            (frame["high"] - previous_close).abs(),
            (frame["low"] - previous_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    frame = frame.copy()
    frame["atr"] = true_range.ewm(alpha=1 / period, adjust=False).mean()
    return frame


def find_pivots(frame: pd.DataFrame, strength: int = PIVOT_STRENGTH) -> list[Zone]:
    """Fractal swing highs and lows."""
    zones: list[Zone] = []
    highs = frame["high"].to_numpy()
    lows = frame["low"].to_numpy()
    times = frame["formed_at"].tolist()
    atrs = frame["atr"].tolist()

    for i in range(strength, len(frame) - strength):
        window_high = highs[i - strength : i + strength + 1]
        window_low = lows[i - strength : i + strength + 1]

        if highs[i] == window_high.max() and (window_high == highs[i]).sum() == 1:
            zones.append(
                Zone(
                    concept="SWING_HIGH",
                    sub_concept=None,
                    direction="BEARISH",
                    price_high=float(highs[i]),
                    price_low=float(highs[i]),
                    formed_at=times[i].to_pydatetime(),
                    atr_at_formation=float(atrs[i]),
                    polarity=1,
                    strength=float(strength),
                    tags=("PIVOT",),
                )
            )

        if lows[i] == window_low.min() and (window_low == lows[i]).sum() == 1:
            zones.append(
                Zone(
                    concept="SWING_LOW",
                    sub_concept=None,
                    direction="BULLISH",
                    price_high=float(lows[i]),
                    price_low=float(lows[i]),
                    formed_at=times[i].to_pydatetime(),
                    atr_at_formation=float(atrs[i]),
                    polarity=-1,
                    strength=float(strength),
                    tags=("PIVOT",),
                )
            )

    return zones


def find_fvgs(frame: pd.DataFrame) -> list[Zone]:
    """Three-candle fair value gaps, filtered by ATR so micro-gaps drop out."""
    zones: list[Zone] = []
    highs = frame["high"].to_numpy()
    lows = frame["low"].to_numpy()
    opens = frame["open"].to_numpy()
    closes = frame["close"].to_numpy()
    times = frame["formed_at"].tolist()
    atrs = frame["atr"].tolist()

    for i in range(2, len(frame)):
        atr = atrs[i]
        if not atr or atr != atr:  # NaN guard
            continue
        min_gap = atr * MIN_FVG_ATR

        # Bullish gap: candle i-2 high sits below candle i low.
        if lows[i] - highs[i - 2] > min_gap:
            zones.append(
                Zone(
                    concept="FVG",
                    sub_concept="BISI",
                    direction="BULLISH",
                    price_high=float(lows[i]),
                    price_low=float(highs[i - 2]),
                    formed_at=times[i].to_pydatetime(),
                    price_open=float(opens[i]),
                    price_close=float(closes[i]),
                    atr_at_formation=float(atr),
                    polarity=-1,
                    strength=float((lows[i] - highs[i - 2]) / atr),
                    tags=("IMBALANCE", "BISI"),
                )
            )

        # Bearish gap: candle i-2 low sits above candle i high.
        if lows[i - 2] - highs[i] > min_gap:
            zones.append(
                Zone(
                    concept="FVG",
                    sub_concept="SIBI",
                    direction="BEARISH",
                    price_high=float(lows[i - 2]),
                    price_low=float(highs[i]),
                    formed_at=times[i].to_pydatetime(),
                    price_open=float(opens[i]),
                    price_close=float(closes[i]),
                    atr_at_formation=float(atr),
                    polarity=1,
                    strength=float((lows[i - 2] - highs[i]) / atr),
                    tags=("IMBALANCE", "SIBI"),
                )
            )

    return zones


def find_order_blocks(frame: pd.DataFrame) -> list[Zone]:
    """Last opposing candle before a displacement leg that breaks structure.

    Bullish OB: the final down candle before an up leg whose close exceeds
    the prior swing high. Bearish OB: mirror image.
    """
    zones: list[Zone] = []
    opens = frame["open"].to_numpy()
    closes = frame["close"].to_numpy()
    highs = frame["high"].to_numpy()
    lows = frame["low"].to_numpy()
    times = frame["formed_at"].tolist()
    atrs = frame["atr"].tolist()

    for i in range(3, len(frame)):
        atr = atrs[i]
        if not atr or atr != atr:
            continue

        body = abs(closes[i] - opens[i])
        if body < atr * 0.5:
            continue  # not a displacement candle

        prior_high = highs[i - 3 : i].max()
        prior_low = lows[i - 3 : i].min()

        # Bullish displacement breaking the prior high -> OB is the down candle
        if closes[i] > opens[i] and closes[i] > prior_high:
            for j in range(i - 1, max(i - 4, -1), -1):
                if closes[j] < opens[j]:
                    zones.append(
                        Zone(
                            concept="ORDER_BLOCK",
                            sub_concept="OB",
                            direction="BULLISH",
                            price_high=float(highs[j]),
                            price_low=float(lows[j]),
                            formed_at=times[j].to_pydatetime(),
                            price_open=float(opens[j]),
                            price_close=float(closes[j]),
                            atr_at_formation=float(atrs[j]),
                            polarity=-1,
                            strength=float(body / atr),
                            tags=("DISPLACEMENT", "BULLISH_OB"),
                            meta={"displacement_index": int(i)},
                        )
                    )
                    break

        # Bearish displacement breaking the prior low
        if closes[i] < opens[i] and closes[i] < prior_low:
            for j in range(i - 1, max(i - 4, -1), -1):
                if closes[j] > opens[j]:
                    zones.append(
                        Zone(
                            concept="ORDER_BLOCK",
                            sub_concept="OB",
                            direction="BEARISH",
                            price_high=float(highs[j]),
                            price_low=float(lows[j]),
                            formed_at=times[j].to_pydatetime(),
                            price_open=float(opens[j]),
                            price_close=float(closes[j]),
                            atr_at_formation=float(atrs[j]),
                            polarity=1,
                            strength=float(body / atr),
                            tags=("DISPLACEMENT", "BEARISH_OB"),
                            meta={"displacement_index": int(i)},
                        )
                    )
                    break

    return zones


def find_liquidity_pools(frame: pd.DataFrame) -> list[Zone]:
    """Equal highs / equal lows — resting liquidity within a tight tolerance."""
    zones: list[Zone] = []
    highs = frame["high"].to_numpy()
    lows = frame["low"].to_numpy()
    times = frame["formed_at"].tolist()
    atrs = frame["atr"].tolist()

    for i in range(1, len(frame)):
        atr = atrs[i]
        if not atr or atr != atr:
            continue
        tolerance = highs[i] * EQUAL_LEVEL_TOL_PCT

        if abs(highs[i] - highs[i - 1]) <= tolerance:
            level = max(highs[i], highs[i - 1])
            zones.append(
                Zone(
                    concept="LIQUIDITY_POOL",
                    sub_concept="EQUAL_HIGHS",
                    direction="BEARISH",
                    price_high=float(level + tolerance),
                    price_low=float(level - tolerance),
                    formed_at=times[i].to_pydatetime(),
                    atr_at_formation=float(atr),
                    polarity=1,
                    strength=float(tolerance / atr),
                    tags=("LIQUIDITY", "EQUAL_HIGHS", "BUYSIDE"),
                )
            )

        if abs(lows[i] - lows[i - 1]) <= tolerance:
            level = min(lows[i], lows[i - 1])
            zones.append(
                Zone(
                    concept="LIQUIDITY_POOL",
                    sub_concept="EQUAL_LOWS",
                    direction="BULLISH",
                    price_high=float(level + tolerance),
                    price_low=float(level - tolerance),
                    formed_at=times[i].to_pydatetime(),
                    atr_at_formation=float(atr),
                    polarity=-1,
                    strength=float(tolerance / atr),
                    tags=("LIQUIDITY", "EQUAL_LOWS", "SELLSIDE"),
                )
            )

    return zones


def find_previous_day_levels(frame: pd.DataFrame) -> list[Zone]:
    """PDH / PDL — previous completed day's high and low, stamped on today."""
    zones: list[Zone] = []
    if frame.empty:
        return zones

    working = frame.copy()
    working["day"] = working["formed_at"].dt.floor("D")
    grouped = working.groupby("day", sort=True)

    days = list(grouped.groups.keys())
    for index in range(1, len(days)):
        previous_day = days[index - 1]
        current_day = days[index]
        previous = grouped.get_group(previous_day)
        current = grouped.get_group(current_day)

        atr = float(current["atr"].iloc[0])
        if not atr or atr != atr:
            atr = None

        day_high = float(previous["high"].max())
        day_low = float(previous["low"].min())
        formed_at = current["formed_at"].iloc[0].to_pydatetime()

        zones.append(
            Zone(
                concept="SESSION_HIGH",
                sub_concept="PDH",
                direction="BEARISH",
                price_high=day_high,
                price_low=day_high,
                formed_at=formed_at,
                atr_at_formation=atr,
                polarity=1,
                tags=("EXTREME", "PDH"),
                meta={"source_day": str(previous_day.date())},
            )
        )
        zones.append(
            Zone(
                concept="SESSION_LOW",
                sub_concept="PDL",
                direction="BULLISH",
                price_high=day_low,
                price_low=day_low,
                formed_at=formed_at,
                atr_at_formation=atr,
                polarity=-1,
                tags=("EXTREME", "PDL"),
                meta={"source_day": str(previous_day.date())},
            )
        )

    return zones


def find_structure_breaks(frame: pd.DataFrame) -> list[Zone]:
    """BOS / CHoCH from consecutive swing pivots.

    A close beyond the most recent swing high is a bullish break; whether it
    is a continuation (BOS) or a reversal (CHoCH) depends on the direction of
    the previous break.
    """
    zones: list[Zone] = []
    pivots = find_pivots(frame)
    if not pivots:
        return zones

    pivots.sort(key=lambda zone: zone.formed_at)
    closes = frame["close"].to_numpy()
    times = frame["formed_at"].tolist()
    atrs = frame["atr"].tolist()
    time_to_index = {t: i for i, t in enumerate(times)}

    last_break_direction: str | None = None
    last_high: Zone | None = None
    last_low: Zone | None = None

    for pivot in pivots:
        if pivot.concept == "SWING_HIGH":
            last_high = pivot
        else:
            last_low = pivot

        index = time_to_index.get(pivot.formed_at)
        if index is None:
            continue

        # Look forward from the pivot for a decisive close through it.
        for k in range(index + 1, min(index + 60, len(frame))):
            atr = atrs[k]
            if not atr or atr != atr:
                continue

            if last_high is not None and closes[k] > last_high.price_high:
                sub = "BOS" if last_break_direction == "BULLISH" else "CHoCH"
                zones.append(
                    Zone(
                        concept="BOS" if sub == "BOS" else "CHoCH",
                        sub_concept=sub,
                        direction="BULLISH",
                        price_high=float(last_high.price_high),
                        price_low=float(last_high.price_high),
                        formed_at=times[k].to_pydatetime(),
                        price_close=float(closes[k]),
                        atr_at_formation=float(atr),
                        polarity=1,
                        strength=float((closes[k] - last_high.price_high) / atr),
                        tags=("STRUCTURE", sub),
                        meta={"broken_pivot_at": str(last_high.formed_at)},
                    )
                )
                last_break_direction = "BULLISH"
                last_high = None
                break

            if last_low is not None and closes[k] < last_low.price_low:
                sub = "BOS" if last_break_direction == "BEARISH" else "CHoCH"
                zones.append(
                    Zone(
                        concept="BOS" if sub == "BOS" else "CHoCH",
                        sub_concept=sub,
                        direction="BEARISH",
                        price_high=float(last_low.price_low),
                        price_low=float(last_low.price_low),
                        formed_at=times[k].to_pydatetime(),
                        price_close=float(closes[k]),
                        atr_at_formation=float(atr),
                        polarity=-1,
                        strength=float((last_low.price_low - closes[k]) / atr),
                        tags=("STRUCTURE", sub),
                        meta={"broken_pivot_at": str(last_low.formed_at)},
                    )
                )
                last_break_direction = "BEARISH"
                last_low = None
                break

    return zones


def detect_zones(frame: pd.DataFrame) -> list[Zone]:
    """Run every detector over one timeframe and return the combined set."""
    zones: list[Zone] = []
    zones.extend(find_pivots(frame))
    zones.extend(find_structure_breaks(frame))
    zones.extend(find_fvgs(frame))
    zones.extend(find_order_blocks(frame))
    zones.extend(find_liquidity_pools(frame))
    zones.extend(find_previous_day_levels(frame))
    return zones


INSERT_SQL = text(
    """
    INSERT INTO technical_levels (
        symbol, timeframe, timeframe_seconds, tf_rank,
        concept, sub_concept, direction, is_htf, polarity,
        price_high, price_low, price_open, price_close,
        atr_at_formation, premium_discount,
        formed_at, valid_from, state_version,
        status, mitigation_state,
        strength, tags, meta, raw_payload, hash_sha256
    ) VALUES (
        :symbol, :timeframe, :timeframe_seconds, :tf_rank,
        :concept, :sub_concept, :direction, :is_htf, :polarity,
        :price_high, :price_low, :price_open, :price_close,
        :atr_at_formation, :premium_discount,
        :formed_at, :valid_from, 1,
        :status, :mitigation_state,
        :strength, CAST(:tags AS text[]), CAST(:meta AS jsonb),
        CAST(:raw_payload AS jsonb), :hash_sha256
    )
    ON CONFLICT (symbol, timeframe, concept, formed_at, price_high, price_low)
        WHERE state_version = 1
    DO NOTHING
    """
)


def build_rows(
    zones: Iterable[Zone],
    timeframe: str,
    timeframe_seconds: int,
    tf_rank: int,
    range_high: float,
    range_low: float,
) -> list[dict]:
    """Map detected zones onto technical_levels columns."""
    span = range_high - range_low
    rows: list[dict] = []

    for zone in zones:
        premium_discount = None
        if span > 0:
            mid = (zone.price_high + zone.price_low) / 2.0
            premium_discount = round((mid - range_low) / span, 4)

        rows.append(
            {
                "symbol": SYMBOL,
                "timeframe": timeframe,
                "timeframe_seconds": timeframe_seconds,
                "tf_rank": tf_rank,
                "concept": zone.concept,
                "sub_concept": zone.sub_concept,
                "direction": zone.direction,
                "is_htf": tf_rank >= 5,
                "polarity": zone.polarity,
                "price_high": zone.price_high,
                "price_low": zone.price_low,
                "price_open": zone.price_open,
                "price_close": zone.price_close,
                "atr_at_formation": zone.atr_at_formation,
                "premium_discount": premium_discount,
                "formed_at": zone.formed_at,
                "valid_from": zone.formed_at,
                "status": zone.status,
                "mitigation_state": zone.mitigation_state,
                "strength": zone.strength,
                "tags": list(zone.tags),
                "meta": _json_dumps(zone.meta or {}),
                "raw_payload": _json_dumps(
                    {
                        "detector": "yahoo_collector",
                        "ticker": YAHOO_TICKER,
                        "concept": zone.concept,
                        "sub_concept": zone.sub_concept,
                    }
                ),
                "hash_sha256": _hash(
                    SYMBOL,
                    timeframe,
                    zone.concept,
                    zone.formed_at.isoformat(),
                    zone.price_high,
                    zone.price_low,
                ),
            }
        )

    return rows


def upsert_rows(rows: Iterable[dict]) -> int:
    """Write rows in one transaction. Returns rows actually inserted."""
    rows = list(rows)
    if not rows:
        return 0

    inserted = 0
    with get_engine().begin() as conn:
        for row in rows:
            result = conn.execute(INSERT_SQL, row)
            inserted += result.rowcount or 0
    return inserted


def collect_timeframe(interval: str, range_: str, dry_run: bool) -> tuple[int, int]:
    """Fetch, detect, and store one timeframe. Returns (detected, inserted)."""
    label, seconds, rank = TIMEFRAMES[interval]

    frame = add_atr(fetch_candles(interval, range_))
    if frame.empty:
        log.warning("%-4s no candles returned", label)
        return 0, 0

    zones = detect_zones(frame)
    range_high = float(frame["high"].max())
    range_low = float(frame["low"].min())

    if dry_run:
        counts: dict[str, int] = {}
        for zone in zones:
            counts[zone.concept] = counts.get(zone.concept, 0) + 1
        summary = " ".join(f"{k}={v}" for k, v in sorted(counts.items()))
        log.info(
            "%-4s candles=%-6d zones=%-6d %s",
            label,
            len(frame),
            len(zones),
            summary,
        )
        return len(zones), 0

    rows = build_rows(zones, label, seconds, rank, range_high, range_low)
    inserted = upsert_rows(rows)
    log.info(
        "%-4s candles=%-6d detected=%-6d inserted=%-6d range=%.2f..%.2f",
        label,
        len(frame),
        len(rows),
        inserted,
        range_low,
        range_high,
    )
    return len(rows), inserted


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Detect SMC zones from Yahoo GC=F candles into technical_levels"
    )
    parser.add_argument("--timeframe", default="60m", choices=sorted(TIMEFRAMES),
                        help="Yahoo interval to pull (default 60m)")
    parser.add_argument("--range", dest="range_", default="1y", choices=RANGES,
                        help="Yahoo range window (default 1y)")
    parser.add_argument("--all-timeframes", action="store_true",
                        help="run every mapped timeframe with its default range")
    parser.add_argument("--dry-run", action="store_true",
                        help="detect and report, write nothing")
    parser.add_argument("--list", action="store_true",
                        help="print the timeframe map and exit")
    args = parser.parse_args(argv)

    if args.list:
        print(f"{'YAHOO':<8} {'LABEL':<6} {'SECONDS':<9} RANK")
        for interval, (label, seconds, rank) in TIMEFRAMES.items():
            print(f"{interval:<8} {label:<6} {seconds:<9} {rank}")
        return 0

    default_ranges = {
        "1m": "5d",
        "5m": "1mo",
        "15m": "1mo",
        "60m": "1y",
        "1d": "5y",
    }

    targets = (
        [(i, default_ranges[i]) for i in TIMEFRAMES]
        if args.all_timeframes
        else [(args.timeframe, args.range_)]
    )

    total_detected = 0
    total_inserted = 0
    failures = 0

    for interval, range_ in targets:
        try:
            detected, inserted = collect_timeframe(interval, range_, args.dry_run)
            total_detected += detected
            total_inserted += inserted
        except requests.HTTPError as err:
            failures += 1
            log.error("%-4s HTTP %s", interval, err.response.status_code)
        except requests.RequestException as err:
            failures += 1
            log.error("%-4s network error: %s", interval, err)
        except Exception as err:  # noqa: BLE001 — one TF must not kill the run
            failures += 1
            log.exception("%-4s failed: %s", interval, err)

    log.info(
        "done: timeframes=%d detected=%d inserted=%d failures=%d",
        len(targets),
        total_detected,
        total_inserted,
        failures,
    )
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        dispose()
