"""collectors/goldapi_collector.py — gold-api.com + Yahoo drivers -> intermarket_sentiment

Builds the cross-asset context layer. For each observation window it
captures the XAU spot state alongside every driver that explains it
(DXY, silver, yields, VIX, BTC, gold/silver ratio) and writes one row per
driver into intermarket_sentiment.

The unique index uq_is_observation is
(as_of, base_symbol, driver_symbol, timeframe, session) NULLS NOT DISTINCT,
so re-collection UPSERTs rather than duplicating.

Usage:
    python -m collectors.goldapi_collector                 # one snapshot, 5m window
    python -m collectors.goldapi_collector --timeframe 1h
    python -m collectors.goldapi_collector --watch --interval 60
    python -m collectors.goldapi_collector --list
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

import pandas as pd
import requests
from sqlalchemy import text

from .config import dispose, get_engine, setup_logging

log = setup_logging("goldapi")

GOLD_SPOT_URL = "https://api.gold-api.com/price/XAU"
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
REQUEST_TIMEOUT = 20
BASE_SYMBOL = "XAUUSD"

TIMEFRAME_SECONDS = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1h": 3600,
    "4h": 14400,
    "1D": 86400,
}


@dataclass(frozen=True)
class DriverSpec:
    """One correlated instrument mapped onto the driver taxonomy."""

    driver_symbol: str
    driver_class: str
    ticker: str
    driver_source: str
    invert: bool = False  # True when the driver moves opposite to gold


DRIVERS: tuple[DriverSpec, ...] = (
    DriverSpec("DXY", "RATES", "DX-Y.NYB", "YahooFinance", invert=True),
    DriverSpec("XAGUSD", "METALS", "SI=F", "YahooFinance"),
    DriverSpec("PLATINUM", "METALS", "PL=F", "YahooFinance"),
    DriverSpec("COPPER", "METALS", "HG=F", "YahooFinance"),
    DriverSpec("US10Y", "RATES", "^TNX", "YahooFinance", invert=True),
    DriverSpec("VIX", "RISK", "^VIX", "YahooFinance"),
    DriverSpec("SPX", "RISK", "^GSPC", "YahooFinance"),
    DriverSpec("US100", "RISK", "^NDX", "YahooFinance"),
    DriverSpec("USDJPY", "RISK", "JPY=X", "YahooFinance"),
    DriverSpec("BTCUSD", "CRYPTO", "BTC-USD", "YahooFinance"),
)

DRIVERS_BY_SYMBOL = {spec.driver_symbol: spec for spec in DRIVERS}


def _hash(*parts: object) -> bytes:
    payload = "|".join("" if p is None else str(p) for p in parts)
    return hashlib.sha256(payload.encode("utf-8")).digest()


def _json_dumps(value: object) -> str:
    return json.dumps(value, default=str)


def current_session(moment: datetime) -> str:
    """Rough FX session label from UTC hour. Overlap beats single sessions."""
    hour = moment.astimezone(timezone.utc).hour
    if 13 <= hour < 16:
        return "OVERLAP"   # London + NY
    if 7 <= hour < 13:
        return "LONDON"
    if 16 <= hour < 21:
        return "NY"
    if 0 <= hour < 7:
        return "ASIA"
    return "CLOSED"


def fetch_gold_spot(http: requests.Session) -> tuple[float, datetime]:
    """Live XAU spot from gold-api.com."""
    response = http.get(GOLD_SPOT_URL, timeout=REQUEST_TIMEOUT)
    response.raise_for_status()
    payload = response.json()
    price = float(payload["price"])
    if price <= 0:
        raise RuntimeError(f"implausible gold spot: {price}")
    return price, datetime.now(timezone.utc)


def fetch_driver_quote(
    http: requests.Session, spec: DriverSpec
) -> dict | None:
    """Latest quote + window stats for one driver ticker."""
    response = http.get(
        YAHOO_CHART_URL.format(ticker=spec.ticker),
        params={"interval": "5m", "range": "5d"},
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()

    result = (response.json().get("chart", {}).get("result") or [None])[0]
    if not result or "timestamp" not in result:
        return None

    quote = result["indicators"]["quote"][0]
    frame = pd.DataFrame(
        {
            "open": quote.get("open"),
            "high": quote.get("high"),
            "low": quote.get("low"),
            "close": quote.get("close"),
        }
    ).dropna(subset=["close"])

    if frame.empty:
        return None

    closes = frame["close"]
    last = float(closes.iloc[-1])
    first = float(closes.iloc[0])
    change_abs = last - first
    change_pct = (change_abs / first * 100.0) if first else 0.0

    mean = float(closes.mean())
    std = float(closes.std(ddof=0))
    zscore = ((last - mean) / std) if std else 0.0
    percentile = float((closes <= last).mean())

    return {
        "driver_price": last,
        "driver_open": float(frame["open"].iloc[0]),
        "driver_high": float(frame["high"].max()),
        "driver_low": float(frame["low"].min()),
        "driver_change_abs": change_abs,
        "driver_change_pct": change_pct,
        "driver_zscore": zscore,
        "driver_percentile": percentile,
        "meta": {
            "ticker": spec.ticker,
            "samples": int(len(closes)),
            "window": "5d/5m",
        },
    }


def compute_gold_silver_ratio(
    gold_price: float, silver_price: float | None
) -> float | None:
    if not silver_price:
        return None
    return round(gold_price / silver_price, 4)


def classify_vol_regime(gold_range_pct: float | None) -> str | None:
    """Coarse volatility bucket from the window range as a % of price."""
    if gold_range_pct is None:
        return None
    if gold_range_pct < 0.35:
        return "LOW"
    if gold_range_pct < 0.9:
        return "NORMAL"
    if gold_range_pct < 1.8:
        return "HIGH"
    return "EXTREME"


INSERT_SQL = text(
    """
    INSERT INTO intermarket_sentiment (
        as_of, base_symbol, timeframe, timeframe_seconds, session,
        driver_symbol, driver_class, driver_source,
        driver_price, driver_open, driver_high, driver_low,
        driver_change_pct, driver_change_abs, driver_zscore, driver_percentile,
        gold_price, gold_change_pct, gold_range_pct, gold_trend,
        vol_regime, is_stale, tags, meta, raw_payload
    ) VALUES (
        :as_of, :base_symbol, :timeframe, :timeframe_seconds, :session,
        :driver_symbol, :driver_class, :driver_source,
        :driver_price, :driver_open, :driver_high, :driver_low,
        :driver_change_pct, :driver_change_abs, :driver_zscore, :driver_percentile,
        :gold_price, :gold_change_pct, :gold_range_pct, :gold_trend,
        :vol_regime, FALSE, CAST(:tags AS text[]), CAST(:meta AS jsonb),
        CAST(:raw_payload AS jsonb)
    )
    ON CONFLICT (as_of, base_symbol, driver_symbol, timeframe, session)
    DO UPDATE SET
        driver_price      = EXCLUDED.driver_price,
        driver_open       = EXCLUDED.driver_open,
        driver_high       = EXCLUDED.driver_high,
        driver_low        = EXCLUDED.driver_low,
        driver_change_pct = EXCLUDED.driver_change_pct,
        driver_change_abs = EXCLUDED.driver_change_abs,
        driver_zscore     = EXCLUDED.driver_zscore,
        driver_percentile = EXCLUDED.driver_percentile,
        gold_price        = EXCLUDED.gold_price,
        gold_change_pct   = EXCLUDED.gold_change_pct,
        gold_range_pct    = EXCLUDED.gold_range_pct,
        gold_trend        = EXCLUDED.gold_trend,
        vol_regime        = EXCLUDED.vol_regime,
        meta              = EXCLUDED.meta,
        raw_payload       = EXCLUDED.raw_payload
    """
)


def build_rows(
    as_of: datetime,
    timeframe: str,
    session: str,
    gold_price: float,
    gold_change_pct: float | None,
    gold_range_pct: float | None,
    gold_trend: str | None,
    quotes: dict[str, dict],
) -> list[dict]:
    """One row per driver, all sharing the same as_of snapshot."""
    seconds = TIMEFRAME_SECONDS[timeframe]
    vol_regime = classify_vol_regime(gold_range_pct)
    silver = quotes.get("XAGUSD", {}).get("driver_price")
    ratio = compute_gold_silver_ratio(gold_price, silver)

    rows: list[dict] = []

    for spec in DRIVERS:
        quote = quotes.get(spec.driver_symbol)
        if quote is None:
            continue

        rows.append(
            {
                "as_of": as_of,
                "base_symbol": BASE_SYMBOL,
                "timeframe": timeframe,
                "timeframe_seconds": seconds,
                "session": session,
                "driver_symbol": spec.driver_symbol,
                "driver_class": spec.driver_class,
                "driver_source": spec.driver_source,
                "driver_price": quote["driver_price"],
                "driver_open": quote["driver_open"],
                "driver_high": quote["driver_high"],
                "driver_low": quote["driver_low"],
                "driver_change_pct": quote["driver_change_pct"],
                "driver_change_abs": quote["driver_change_abs"],
                "driver_zscore": quote["driver_zscore"],
                "driver_percentile": quote["driver_percentile"],
                "gold_price": gold_price,
                "gold_change_pct": gold_change_pct,
                "gold_range_pct": gold_range_pct,
                "gold_trend": gold_trend,
                "vol_regime": vol_regime,
                "tags": [spec.driver_class, spec.driver_symbol],
                "meta": _json_dumps(
                    {
                        **quote["meta"],
                        "invert": spec.invert,
                        "gold_silver_ratio": ratio,
                    }
                ),
                "raw_payload": _json_dumps(
                    {
                        "driver": spec.driver_symbol,
                        "ticker": spec.ticker,
                        "quote": quote,
                        "gold_spot_source": "gold-api.com",
                    }
                ),
            }
        )

    # Synthetic driver: the ratio itself is a tradable signal in its own right.
    if ratio is not None:
        rows.append(
            {
                "as_of": as_of,
                "base_symbol": BASE_SYMBOL,
                "timeframe": timeframe,
                "timeframe_seconds": seconds,
                "session": session,
                "driver_symbol": "GOLD_SILVER_RATIO",
                "driver_class": "METALS",
                "driver_source": "derived",
                "driver_price": ratio,
                "driver_open": None,
                "driver_high": None,
                "driver_low": None,
                "driver_change_pct": None,
                "driver_change_abs": None,
                "driver_zscore": None,
                "driver_percentile": None,
                "gold_price": gold_price,
                "gold_change_pct": gold_change_pct,
                "gold_range_pct": gold_range_pct,
                "gold_trend": gold_trend,
                "vol_regime": vol_regime,
                "tags": ["METALS", "DERIVED", "RATIO"],
                "meta": _json_dumps({"formula": "XAU / XAG"}),
                "raw_payload": _json_dumps(
                    {"gold": gold_price, "silver": silver, "ratio": ratio}
                ),
            }
        )

    return rows


def upsert_rows(rows: Iterable[dict]) -> int:
    """Write rows in one transaction. Returns rows touched."""
    rows = list(rows)
    if not rows:
        return 0

    touched = 0
    with get_engine().begin() as conn:
        for row in rows:
            result = conn.execute(INSERT_SQL, row)
            touched += result.rowcount or 0
    return touched


def collect_snapshot(
    http: requests.Session, timeframe: str, dry_run: bool
) -> tuple[int, int]:
    """One full cross-asset snapshot. Returns (built, written)."""
    gold_price, as_of = fetch_gold_spot(http)
    session = current_session(as_of)

    quotes: dict[str, dict] = {}
    failures = 0
    for spec in DRIVERS:
        try:
            quote = fetch_driver_quote(http, spec)
            if quote is not None:
                quotes[spec.driver_symbol] = quote
        except requests.RequestException as err:
            failures += 1
            log.warning("%-16s quote failed: %s", spec.driver_symbol, err)

    # Gold window stats come from the same 5d/5m frame as the drivers.
    gold_change_pct = None
    gold_range_pct = None
    gold_trend = None
    try:
        gold_frame = fetch_driver_quote(
            http, DriverSpec("XAUUSD", "METALS", "GC=F", "YahooFinance")
        )
        if gold_frame:
            gold_change_pct = gold_frame["driver_change_pct"]
            high = gold_frame["driver_high"]
            low = gold_frame["driver_low"]
            if gold_price:
                gold_range_pct = round((high - low) / gold_price * 100.0, 6)
            if gold_change_pct is not None:
                gold_trend = (
                    "UP" if gold_change_pct > 0.1
                    else "DOWN" if gold_change_pct < -0.1
                    else "RANGE"
                )
    except requests.RequestException as err:
        failures += 1
        log.warning("XAUUSD window stats failed: %s", err)

    rows = build_rows(
        as_of=as_of,
        timeframe=timeframe,
        session=session,
        gold_price=gold_price,
        gold_change_pct=gold_change_pct,
        gold_range_pct=gold_range_pct,
        gold_trend=gold_trend,
        quotes=quotes,
    )

    if dry_run:
        log.info(
            "dry-run as_of=%s session=%-8s gold=%.2f drivers=%d rows=%d",
            as_of.isoformat(timespec="seconds"),
            session,
            gold_price,
            len(quotes),
            len(rows),
        )
        for row in rows:
            log.info(
                "  %-18s %-9s price=%-12s chg%%=%s",
                row["driver_symbol"],
                row["driver_class"],
                row["driver_price"],
                (
                    f"{row['driver_change_pct']:.4f}"
                    if row["driver_change_pct"] is not None
                    else "n/a"
                ),
            )
        return len(rows), 0

    touched = upsert_rows(rows)
    log.info(
        "as_of=%s session=%-8s gold=%.2f drivers=%d rows=%d written=%d failures=%d",
        as_of.isoformat(timespec="seconds"),
        session,
        gold_price,
        len(quotes),
        len(rows),
        touched,
        failures,
    )
    return len(rows), touched


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Snapshot XAU spot + cross-asset drivers into intermarket_sentiment"
    )
    parser.add_argument("--timeframe", default="5m", choices=sorted(TIMEFRAME_SECONDS),
                        help="observation window label (default 5m)")
    parser.add_argument("--watch", action="store_true",
                        help="keep sampling on an interval instead of exiting")
    parser.add_argument("--interval", type=int, default=60,
                        help="seconds between samples in --watch mode (default 60)")
    parser.add_argument("--dry-run", action="store_true",
                        help="fetch and report, write nothing")
    parser.add_argument("--list", action="store_true",
                        help="print the driver map and exit")
    args = parser.parse_args(argv)

    if args.list:
        print(f"{'DRIVER':<18} {'CLASS':<10} {'TICKER':<12} SOURCE")
        for spec in DRIVERS:
            print(
                f"{spec.driver_symbol:<18} {spec.driver_class:<10} "
                f"{spec.ticker:<12} {spec.driver_source}"
            )
        return 0

    if args.watch and args.interval < 5:
        log.error("--interval must be at least 5 seconds")
        return 2

    with requests.Session() as http:
        http.headers.update({"User-Agent": "gold-terminal/1.0"})

        if not args.watch:
            try:
                collect_snapshot(http, args.timeframe, args.dry_run)
            except requests.RequestException as err:
                log.error("snapshot failed: %s", err)
                return 1
            except Exception as err:  # noqa: BLE001
                log.exception("snapshot failed: %s", err)
                return 1
            return 0

        log.info("watch mode: sampling every %ds (ctrl-c to stop)", args.interval)
        try:
            while True:
                try:
                    collect_snapshot(http, args.timeframe, args.dry_run)
                except Exception as err:  # noqa: BLE001 — keep the loop alive
                    log.error("sample failed: %s", err)
                time.sleep(args.interval)
        except KeyboardInterrupt:
            log.info("watch mode stopped")
            return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        dispose()
