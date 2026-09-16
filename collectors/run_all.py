"""collectors/run_all.py — run every collector in one pass.

Order matters: fundamentals and structure land first, then the
cross-asset snapshot that contextualises them.

Usage:
    python -m collectors.run_all                 # full pass
    python -m collectors.run_all --dry-run       # fetch + report only
    python -m collectors.run_all --skip fred     # subset
    python -m collectors.run_all --check         # DB connectivity only
"""

from __future__ import annotations

import argparse
import sys
import time

from . import fred_collector, goldapi_collector, yahoo_collector
from .config import dispose, health_check, setup_logging

log = setup_logging("run_all")

COLLECTORS = ("fred", "yahoo", "goldapi")


def run_fred(dry_run: bool) -> int:
    argv = ["--full"] if dry_run else []
    return fred_collector.main(argv)


def run_yahoo(dry_run: bool) -> int:
    argv = ["--all-timeframes"]
    if dry_run:
        argv.append("--dry-run")
    return yahoo_collector.main(argv)


def run_goldapi(dry_run: bool) -> int:
    argv = []
    if dry_run:
        argv.append("--dry-run")
    return goldapi_collector.main(argv)


RUNNERS = {
    "fred": run_fred,
    "yahoo": run_yahoo,
    "goldapi": run_goldapi,
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run every Gold Terminal collector")
    parser.add_argument("--dry-run", action="store_true",
                        help="fetch and report, write nothing")
    parser.add_argument("--skip", action="append", default=[],
                        choices=list(COLLECTORS),
                        help="skip a collector (repeatable)")
    parser.add_argument("--only", action="append", default=[],
                        choices=list(COLLECTORS),
                        help="run only these collectors (repeatable)")
    parser.add_argument("--check", action="store_true",
                        help="verify database connectivity and exit")
    args = parser.parse_args(argv)

    try:
        info = health_check()
    except Exception as err:  # noqa: BLE001
        log.error("database unreachable: %s", err)
        return 1

    log.info(
        "database=%s user=%s timescaledb=%s",
        info["database"],
        info["db_user"],
        info["timescaledb_version"] or "NOT INSTALLED",
    )

    if args.check:
        return 0

    if info["timescaledb_version"] is None:
        log.error(
            "timescaledb extension is missing — run the sql/ migrations first "
            "(node migrate.js)"
        )
        return 1

    targets = list(args.only) if args.only else list(COLLECTORS)
    targets = [name for name in targets if name not in args.skip]

    if not targets:
        log.error("nothing to run after applying --skip/--only")
        return 1

    log.info("running: %s (dry_run=%s)", ", ".join(targets), args.dry_run)

    results: dict[str, int] = {}
    started = time.time()

    for name in targets:
        log.info("--- %s ---", name)
        try:
            results[name] = RUNNERS[name](args.dry_run)
        except Exception as err:  # noqa: BLE001 — one collector must not kill the pass
            log.exception("%s crashed: %s", name, err)
            results[name] = 1

    elapsed = time.time() - started
    log.info("--- summary (%.1fs) ---", elapsed)
    for name in targets:
        log.info("  %-8s exit=%d", name, results[name])

    return 1 if any(code != 0 for code in results.values()) else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        dispose()

