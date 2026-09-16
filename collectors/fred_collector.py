"""collectors/fred_collector.py — FRED -> macro_fundamentals

Pulls the fundamental series that actually move XAUUSD and lands them in
the macro_fundamentals hypertable. Every print is stored as a vintage row
(observed_at, series_code, geography, vintage_at) so a revision never
overwrites history — the unique index uq_mf_observation enforces that.

Series map (FRED id -> our taxonomy):
    CPIAUCSL   CPI              INFLATION   monthly
    CPILFESL   CORE_CPI         INFLATION   monthly
    PCEPILFE   CORE_PCE         INFLATION   monthly
    T10YIE     BREAKEVEN_10Y    INFLATION   daily
    DFII10     REAL_YIELD_10Y   RATES       daily
    DGS10      NOMINAL_YIELD_10Y RATES      daily
    DGS2       NOMINAL_YIELD_2Y RATES       daily
    FEDFUNDS   FED_FUNDS        POLICY      monthly
    SOFR       SOFR             POLICY      daily
    M2SL       M2               LIQUIDITY   monthly
    WALCL      FED_BALANCE_SHEET LIQUIDITY  weekly
    RRPONTSYD  RRP              LIQUIDITY   daily
    UNRATE     UNEMPLOYMENT     GROWTH      monthly
    PAYEMS     NONFARM_PAYROLLS GROWTH      monthly
    GDPC1      REAL_GDP         GROWTH      quarterly

Usage:
    python -m collectors.fred_collector                 # incremental, all series
    python -m collectors.fred_collector --full          # ignore watermark
    python -m collectors.fred_collector --series DFII10 # one series
    python -m collectors.fred_collector --list          # show the series map
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterable

import pandas as pd
import requests
from sqlalchemy import text

from .config import dispose, fred_api_key, get_engine, setup_logging

log = setup_logging("fred")

FRED_OBSERVATIONS_URL = "https://api.stlouisfed.org/fred/series/observations"
FRED_SERIES_URL = "https://api.stlouisfed.org/fred/series"
REQUEST_TIMEOUT = 20
GEOGRAPHY = "US"
CURRENCY = "USD"


@dataclass(frozen=True)
class SeriesSpec:
    """One FRED series mapped onto our indicator taxonomy."""

    series_code: str
    indicator: str
    family: str
    frequency: str
    unit: str
    tenor: str | None = None
    tenor_months: int | None = None
    is_forward_looking: bool = False
    is_seasonally_adj: bool | None = None


SERIES_MAP: tuple[SeriesSpec, ...] = (
    SeriesSpec("CPIAUCSL", "CPI", "INFLATION", "MONTHLY", "index",
               is_seasonally_adj=True),
    SeriesSpec("CPILFESL", "CORE_CPI", "INFLATION", "MONTHLY", "index",
               is_seasonally_adj=True),
    SeriesSpec("PCEPILFE", "CORE_PCE", "INFLATION", "MONTHLY", "index",
               is_seasonally_adj=True),
    SeriesSpec("T10YIE", "BREAKEVEN_10Y", "INFLATION", "DAILY", "%",
               tenor="10Y", tenor_months=120, is_forward_looking=True),
    SeriesSpec("DFII10", "REAL_YIELD_10Y", "RATES", "DAILY", "%",
               tenor="10Y", tenor_months=120),
    SeriesSpec("DGS10", "NOMINAL_YIELD_10Y", "RATES", "DAILY", "%",
               tenor="10Y", tenor_months=120),
    SeriesSpec("DGS2", "NOMINAL_YIELD_2Y", "RATES", "DAILY", "%",
               tenor="2Y", tenor_months=24),
    SeriesSpec("FEDFUNDS", "FED_FUNDS", "POLICY", "MONTHLY", "%"),
    SeriesSpec("SOFR", "SOFR", "POLICY", "DAILY", "%"),
    SeriesSpec("M2SL", "M2", "LIQUIDITY", "MONTHLY", "B", is_seasonally_adj=True),
    SeriesSpec("WALCL", "FED_BALANCE_SHEET", "LIQUIDITY", "WEEKLY", "M"),
    SeriesSpec("RRPONTSYD", "RRP", "LIQUIDITY", "DAILY", "B"),
    SeriesSpec("UNRATE", "UNEMPLOYMENT", "GROWTH", "MONTHLY", "%",
               is_seasonally_adj=True),
    SeriesSpec("PAYEMS", "NONFARM_PAYROLLS", "GROWTH", "MONTHLY", "K",
               is_seasonally_adj=True),
    SeriesSpec("GDPC1", "REAL_GDP", "GROWTH", "QUARTERLY", "B",
               is_seasonally_adj=True),
)

SERIES_BY_CODE = {spec.series_code: spec for spec in SERIES_MAP}


def _hash(*parts: object) -> bytes:
    payload = "|".join("" if p is None else str(p) for p in parts)
    return hashlib.sha256(payload.encode("utf-8")).digest()


def _json_dumps(value: object) -> str:
    return json.dumps(value, default=str)


def fetch_series_meta(session: requests.Session, spec: SeriesSpec) -> dict:
    """Series title / units / last-updated — stored in raw_payload for audit."""
    response = session.get(
        FRED_SERIES_URL,
        params={
            "series_id": spec.series_code,
            "api_key": fred_api_key(),
            "file_type": "json",
        },
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    series = (response.json().get("seriess") or [{}])[0]
    return {
        "title": series.get("title"),
        "units": series.get("units"),
        "frequency": series.get("frequency"),
        "last_updated": series.get("last_updated"),
        "observation_start": series.get("observation_start"),
        "observation_end": series.get("observation_end"),
    }


def fetch_observations(
    session: requests.Session,
    spec: SeriesSpec,
    start: datetime | None,
) -> pd.DataFrame:
    """Return a tidy frame of (observed_at, value) for one series."""
    params = {
        "series_id": spec.series_code,
        "api_key": fred_api_key(),
        "file_type": "json",
        "sort_order": "asc",
    }
    if start is not None:
        params["observation_start"] = start.strftime("%Y-%m-%d")

    response = session.get(
        FRED_OBSERVATIONS_URL, params=params, timeout=REQUEST_TIMEOUT
    )
    response.raise_for_status()
    observations = response.json().get("observations", [])
    if not observations:
        return pd.DataFrame(columns=["observed_at", "value"])

    frame = pd.DataFrame(observations)[["date", "value"]]
    # FRED encodes missing prints as "." — coerce to NaN, then drop.
    frame["value"] = pd.to_numeric(frame["value"], errors="coerce")
    frame = frame.dropna(subset=["value"])
    frame["observed_at"] = pd.to_datetime(frame["date"], utc=True)
    return frame[["observed_at", "value"]].reset_index(drop=True)


def latest_observed_at(series_code: str) -> datetime | None:
    """Watermark: newest period already stored for this series."""
    with get_engine().connect() as conn:
        row = conn.execute(
            text(
                """
                SELECT max(observed_at) AS latest
                  FROM macro_fundamentals
                 WHERE series_code = :code
                """
            ),
            {"code": series_code},
        ).mappings().one()
    return row["latest"]


def build_rows(spec: SeriesSpec, frame: pd.DataFrame, meta: dict) -> list[dict]:
    """Map a FRED frame onto macro_fundamentals columns."""
    ingested_at = datetime.now(timezone.utc)
    rows: list[dict] = []

    for record in frame.itertuples(index=False):
        observed_at = record.observed_at.to_pydatetime()
        value = float(record.value)

        rows.append(
            {
                "observed_at": observed_at,
                "released_at": None,
                "vintage_at": ingested_at,
                "series_code": spec.series_code,
                "indicator": spec.indicator,
                "indicator_family": spec.family,
                "geography": GEOGRAPHY,
                "currency": CURRENCY,
                "tenor": spec.tenor,
                "tenor_months": spec.tenor_months,
                "frequency": spec.frequency,
                "is_forward_looking": spec.is_forward_looking,
                "is_seasonally_adj": spec.is_seasonally_adj,
                "source_name": "FRED",
                "source_url": (
                    f"https://fred.stlouisfed.org/series/{spec.series_code}"
                ),
                "source_series_id": spec.series_code,
                "external_id": (
                    f"{spec.series_code}:{observed_at.date().isoformat()}"
                ),
                "unit": spec.unit,
                "value": value,
                "hash_sha256": _hash(
                    spec.series_code, observed_at.isoformat(), value
                ),
                "raw_payload": {
                    "series_code": spec.series_code,
                    "date": observed_at.date().isoformat(),
                    "value": value,
                    "series_meta": meta,
                },
            }
        )

    return rows


INSERT_SQL = text(
    """
    INSERT INTO macro_fundamentals (
        observed_at, released_at, vintage_at,
        series_code, indicator, indicator_family,
        geography, currency, tenor, tenor_months, frequency,
        is_forward_looking, is_seasonally_adj,
        source_name, source_url, source_series_id, external_id,
        unit, value, hash_sha256, raw_payload
    ) VALUES (
        :observed_at, :released_at, :vintage_at,
        :series_code, :indicator, :indicator_family,
        :geography, :currency, :tenor, :tenor_months, :frequency,
        :is_forward_looking, :is_seasonally_adj,
        :source_name, :source_url, :source_series_id, :external_id,
        :unit, :value, :hash_sha256, CAST(:raw_payload AS jsonb)
    )
    ON CONFLICT (observed_at, series_code, geography, vintage_at)
    DO NOTHING
    """
)


def upsert_rows(rows: Iterable[dict]) -> int:
    """Write rows in one transaction. Returns rows actually inserted."""
    rows = list(rows)
    if not rows:
        return 0

    inserted = 0
    with get_engine().begin() as conn:
        for row in rows:
            payload = dict(row)
            payload["raw_payload"] = _json_dumps(payload["raw_payload"])
            result = conn.execute(INSERT_SQL, payload)
            inserted += result.rowcount or 0
    return inserted


def collect_series(
    http: requests.Session,
    spec: SeriesSpec,
    full: bool,
    lookback_days: int,
) -> tuple[int, int]:
    """Fetch + store one series. Returns (fetched, inserted)."""
    start = None
    if not full:
        watermark = latest_observed_at(spec.series_code)
        if watermark is not None:
            # Re-pull a small overlap so late revisions are captured.
            start = watermark - timedelta(days=7)

    meta = fetch_series_meta(http, spec)
    frame = fetch_observations(http, spec, start)
    if frame.empty:
        log.info("%-16s no new observations", spec.series_code)
        return 0, 0

    rows = build_rows(spec, frame, meta)
    inserted = upsert_rows(rows)
    log.info(
        "%-16s fetched=%-5d inserted=%-5d window=%s..%s",
        spec.series_code,
        len(rows),
        inserted,
        frame["observed_at"].min().date(),
        frame["observed_at"].max().date(),
    )
    return len(rows), inserted


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Ingest FRED macro series into macro_fundamentals"
    )
    parser.add_argument("--full", action="store_true",
                        help="ignore the watermark and re-pull full history")
    parser.add_argument("--series", action="append", default=None,
                        help="limit to one series code (repeatable)")
    parser.add_argument("--lookback-days", type=int, default=1825,
                        help="history depth for a cold start (default 5 years)")
    parser.add_argument("--list", action="store_true",
                        help="print the series map and exit")
    args = parser.parse_args(argv)

    if args.list:
        print(f"{'FRED ID':<12} {'INDICATOR':<20} {'FAMILY':<12} FREQ")
        for spec in SERIES_MAP:
            print(
                f"{spec.series_code:<12} {spec.indicator:<20} "
                f"{spec.family:<12} {spec.frequency}"
            )
        return 0

    key = fred_api_key()
    if key is None:
        log.error(
            "FRED_API_KEY is missing or still the placeholder. "
            "Get a free key at https://fred.stlouisfed.org/docs/api/api_key.html"
        )
        return 2

    targets = SERIES_MAP
    if args.series:
        unknown = [c for c in args.series if c not in SERIES_BY_CODE]
        if unknown:
            log.error("unknown series code(s): %s", ", ".join(unknown))
            return 2
        targets = tuple(SERIES_BY_CODE[c] for c in args.series)

    total_fetched = 0
    total_inserted = 0
    failures = 0

    with requests.Session() as http:
        http.headers.update({"User-Agent": "gold-terminal/1.0"})
        for spec in targets:
            try:
                fetched, inserted = collect_series(
                    http, spec, args.full, args.lookback_days
                )
                total_fetched += fetched
                total_inserted += inserted
            except requests.HTTPError as err:
                failures += 1
                log.error("%-16s HTTP %s", spec.series_code, err.response.status_code)
            except requests.RequestException as err:
                failures += 1
                log.error("%-16s network error: %s", spec.series_code, err)
            except Exception as err:  # noqa: BLE001 — one bad series must not kill the run
                failures += 1
                log.exception("%-16s failed: %s", spec.series_code, err)

    log.info(
        "done: series=%d fetched=%d inserted=%d failures=%d",
        len(targets),
        total_fetched,
        total_inserted,
        failures,
    )
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        dispose()
