"""collectors/source_manager.py — add / list / retire tracked source links.

The tracked_sources table (sql/006_tracked_sources.sql) is the terminal's
registry of places worth reading: news feeds, central-bank pages, data
portals, analyst blogs. This module is the one door into it — both a CLI
and an importable API, so a route handler and a shell prompt go through
the exact same validation and the exact same UPSERT.

Usage (CLI):
    python -m collectors.source_manager add "Kitco Gold" https://kitco.com --category NEWS
    python -m collectors.source_manager add-bulk sources.txt
    python -m collectors.source_manager list
    python -m collectors.source_manager list --category CENTRAL_BANK
    python -m collectors.source_manager list --inactive
    python -m collectors.source_manager show 4
    python -m collectors.source_manager update 4 --title "Kitco News" --category NEWS
    python -m collectors.source_manager deactivate 4
    python -m collectors.source_manager activate 4
    python -m collectors.source_manager remove 4 --yes
    python -m collectors.source_manager categories

Usage (code):
    from collectors.source_manager import add_source, list_sources

    source_id, created = add_source(
        title="World Gold Council",
        url="https://www.gold.org/goldhub/research",
        category="GOLD_FLOW",
    )
    for row in list_sources(active_only=True):
        print(row["title"], row["url"])

Exit codes: 0 success, 1 runtime/DB failure, 2 usage error.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from typing import Any, Iterable, Sequence
from urllib.parse import urlparse

from sqlalchemy import text

from .config import dispose, get_engine, setup_logging

log = setup_logging("sources")

# Columns returned by every read path, in display order.
COLUMNS = ("id", "title", "url", "category", "is_active", "created_at")

MAX_TITLE = 255
MAX_CATEGORY = 100

# Schemes we are willing to store. Anything else is almost certainly a
# typo or a pasted fragment, and a bad row here means a broken poller.
ALLOWED_SCHEMES = ("http", "https")


# ============================================================
# VALIDATION
# ============================================================
class SourceValidationError(ValueError):
    """Raised when a title / url / category cannot be stored as given."""


def normalise_url(url: str) -> str:
    """Trim, strip a trailing slash, and reject anything not http(s).

    The UNIQUE(url) constraint is the dedup contract, so normalising
    here means 'https://kitco.com/' and 'https://kitco.com' collapse to
    one row instead of two.
    """
    cleaned = (url or "").strip()
    if not cleaned:
        raise SourceValidationError("url is required")

    parsed = urlparse(cleaned)
    if parsed.scheme.lower() not in ALLOWED_SCHEMES:
        raise SourceValidationError(
            f"url must start with http:// or https:// (got {cleaned!r})"
        )
    if not parsed.netloc:
        raise SourceValidationError(f"url has no host: {cleaned!r}")

    # Drop a bare trailing slash so the two spellings dedup together.
    if parsed.path in ("", "/") and not parsed.query and not parsed.fragment:
        cleaned = cleaned.rstrip("/")

    return cleaned


def normalise_title(title: str) -> str:
    cleaned = (title or "").strip()
    if not cleaned:
        raise SourceValidationError("title is required")
    if len(cleaned) > MAX_TITLE:
        raise SourceValidationError(
            f"title is {len(cleaned)} chars, limit is {MAX_TITLE}"
        )
    return cleaned


def normalise_category(category: str | None) -> str | None:
    if category is None:
        return None
    cleaned = category.strip().upper().replace(" ", "_").replace("-", "_")
    if not cleaned:
        return None
    if len(cleaned) > MAX_CATEGORY:
        raise SourceValidationError(
            f"category is {len(cleaned)} chars, limit is {MAX_CATEGORY}"
        )
    return cleaned


@dataclass(frozen=True)
class SourceInput:
    """A validated, ready-to-write source row."""

    title: str
    url: str
    category: str | None

    @classmethod
    def build(
        cls, title: str, url: str, category: str | None = None
    ) -> "SourceInput":
        return cls(
            title=normalise_title(title),
            url=normalise_url(url),
            category=normalise_category(category),
        )


# ============================================================
# SQL
# ============================================================
# ON CONFLICT (url) makes add_source idempotent: re-adding a link that
# already exists refreshes its title/category and flips it back on,
# rather than raising a unique-violation. RETURNING (xmax = 0) is the
# standard trick for telling an INSERT apart from an UPDATE, so the
# caller can report "created" vs "updated" honestly.
UPSERT_SQL = text(
    """
    INSERT INTO tracked_sources (title, url, category, is_active)
    VALUES (:title, :url, :category, TRUE)
    ON CONFLICT (url) DO UPDATE SET
        title     = EXCLUDED.title,
        category  = COALESCE(EXCLUDED.category, tracked_sources.category),
        is_active = TRUE
    RETURNING id, (xmax = 0) AS created
    """
)

SELECT_SQL = """
    SELECT id, title, url, category, is_active, created_at
      FROM tracked_sources
"""


# ============================================================
# WRITE API
# ============================================================
def add_source(
    title: str,
    url: str,
    category: str | None = None,
) -> tuple[int, bool]:
    """Insert a source, or refresh it if the url is already registered.

    Returns (id, created) where created is True for a fresh insert and
    False when an existing row was updated. Raises SourceValidationError
    on bad input, or the underlying SQLAlchemy error on DB failure.
    """
    source = SourceInput.build(title=title, url=url, category=category)

    with get_engine().begin() as conn:
        row = conn.execute(
            UPSERT_SQL,
            {"title": source.title, "url": source.url, "category": source.category},
        ).mappings().one()

    return int(row["id"]), bool(row["created"])


def add_sources(
    entries: Iterable[tuple[str, str, str | None]],
) -> list[tuple[str, int, bool]]:
    """Bulk add. Each entry is (title, url, category).

    One transaction for the whole batch — a bad row rolls back the lot,
    so a half-imported file never lands. Returns (url, id, created) per
    entry, in input order.
    """
    prepared = [
        SourceInput.build(title=title, url=url, category=category)
        for title, url, category in entries
    ]
    if not prepared:
        return []

    results: list[tuple[str, int, bool]] = []
    with get_engine().begin() as conn:
        for source in prepared:
            row = conn.execute(
                UPSERT_SQL,
                {
                    "title": source.title,
                    "url": source.url,
                    "category": source.category,
                },
            ).mappings().one()
            results.append((source.url, int(row["id"]), bool(row["created"])))

    return results


def update_source(
    source_id: int,
    title: str | None = None,
    url: str | None = None,
    category: str | None = None,
) -> bool:
    """Patch one row. Only the fields passed are touched.

    Returns True when a row was changed, False when the id does not
    exist. Raises SourceValidationError if a supplied value is invalid.
    """
    assignments: list[str] = []
    params: dict[str, Any] = {"source_id": source_id}

    if title is not None:
        assignments.append("title = :title")
        params["title"] = normalise_title(title)

    if url is not None:
        assignments.append("url = :url")
        params["url"] = normalise_url(url)

    if category is not None:
        assignments.append("category = :category")
        params["category"] = normalise_category(category)

    if not assignments:
        raise SourceValidationError("nothing to update — pass a field to change")

    sql = text(
        f"UPDATE tracked_sources SET {', '.join(assignments)} "
        "WHERE id = :source_id"
    )

    with get_engine().begin() as conn:
        result = conn.execute(sql, params)

    return (result.rowcount or 0) > 0


def set_active(source_id: int, is_active: bool) -> bool:
    """Soft delete / restore. Returns False when the id does not exist."""
    with get_engine().begin() as conn:
        result = conn.execute(
            text(
                "UPDATE tracked_sources SET is_active = :is_active "
                "WHERE id = :source_id"
            ),
            {"is_active": is_active, "source_id": source_id},
        )
    return (result.rowcount or 0) > 0


def remove_source(source_id: int) -> bool:
    """Hard delete. Prefer set_active(False) unless the row is a mistake."""
    with get_engine().begin() as conn:
        result = conn.execute(
            text("DELETE FROM tracked_sources WHERE id = :source_id"),
            {"source_id": source_id},
        )
    return (result.rowcount or 0) > 0


# ============================================================
# READ API
# ============================================================
def list_sources(
    active_only: bool = False,
    category: str | None = None,
    search: str | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """Read the registry. Every filter is optional and they compose.

    active_only  — only rows with is_active = TRUE
    category     — exact match, case-insensitive
    search       — substring match against title or url
    limit        — cap the row count
    """
    clauses: list[str] = []
    params: dict[str, Any] = {}

    if active_only:
        clauses.append("is_active IS TRUE")

    if category:
        clauses.append("upper(category) = :category")
        params["category"] = normalise_category(category)

    if search:
        clauses.append("(title ILIKE :search OR url ILIKE :search)")
        params["search"] = f"%{search.strip()}%"

    sql = SELECT_SQL
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY is_active DESC, category NULLS LAST, title"

    if limit is not None:
        sql += " LIMIT :limit"
        params["limit"] = int(limit)

    with get_engine().connect() as conn:
        rows = conn.execute(text(sql), params).mappings().all()

    return [dict(row) for row in rows]


def get_source(source_id: int) -> dict[str, Any] | None:
    """One row by id, or None."""
    with get_engine().connect() as conn:
        row = conn.execute(
            text(SELECT_SQL + " WHERE id = :source_id"),
            {"source_id": source_id},
        ).mappings().first()
    return dict(row) if row else None


def list_categories() -> list[dict[str, Any]]:
    """Category names with a count of active sources in each."""
    with get_engine().connect() as conn:
        rows = conn.execute(
            text(
                """
                SELECT COALESCE(category, '(uncategorised)') AS category,
                       COUNT(*)                             AS total,
                       COUNT(*) FILTER (WHERE is_active)    AS active
                  FROM tracked_sources
                 GROUP BY 1
                 ORDER BY 1
                """
            )
        ).mappings().all()
    return [dict(row) for row in rows]


def active_urls(category: str | None = None) -> list[str]:
    """Just the urls a collector should poll. The hot path."""
    return [
        row["url"]
        for row in list_sources(active_only=True, category=category)
    ]


# ============================================================
# CLI FORMATTING
# ============================================================
def _fmt_time(value: Any) -> str:
    if value is None:
        return "-"
    try:
        return value.strftime("%Y-%m-%d %H:%M")
    except AttributeError:
        return str(value)


def _print_table(rows: Sequence[dict[str, Any]]) -> None:
    if not rows:
        print("(no sources)")
        return

    headers = ("ID", "ACTIVE", "CATEGORY", "TITLE", "URL")
    body = [
        (
            str(row["id"]),
            "yes" if row["is_active"] else "no",
            row["category"] or "-",
            row["title"],
            row["url"],
        )
        for row in rows
    ]

    widths = [
        max(len(headers[i]), max(len(line[i]) for line in body))
        for i in range(len(headers))
    ]
    # Keep the URL column from pushing the table off a normal terminal.
    widths[4] = min(widths[4], 72)

    def render(line: Sequence[str]) -> str:
        cells = []
        for i, cell in enumerate(line):
            text_cell = cell if len(cell) <= widths[i] else cell[: widths[i] - 1] + "…"
            cells.append(text_cell.ljust(widths[i]))
        return "  ".join(cells).rstrip()

    print(render(headers))
    print("  ".join("-" * w for w in widths))
    for line in body:
        print(render(line))


def _parse_bulk_file(path: str) -> list[tuple[str, str, str | None]]:
    """Read a bulk file: one source per line.

    Accepted line shapes (blank lines and # comments ignored):
        url
        title | url
        title | url | category
        title, url, category
    """
    entries: list[tuple[str, str, str | None]] = []

    with open(path, "r", encoding="utf-8") as handle:
        for lineno, raw in enumerate(handle, start=1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue

            separator = "|" if "|" in line else ","
            parts = [part.strip() for part in line.split(separator)]

            if len(parts) == 1:
                url = parts[0]
                # Derive a readable title from the host when none is given.
                host = urlparse(url).netloc or url
                entries.append((host, url, None))
            elif len(parts) == 2:
                entries.append((parts[0], parts[1], None))
            elif len(parts) >= 3:
                entries.append((parts[0], parts[1], parts[2]))
            else:
                raise SourceValidationError(
                    f"{path}:{lineno}: cannot parse {line!r}"
                )

    return entries


# ============================================================
# CLI
# ============================================================
def _cmd_add(args: argparse.Namespace) -> int:
    source_id, created = add_source(args.title, args.url, args.category)
    verb = "added" if created else "updated"
    log.info("%s source id=%d title=%r url=%s", verb, source_id, args.title, args.url)
    return 0


def _cmd_add_bulk(args: argparse.Namespace) -> int:
    entries = _parse_bulk_file(args.path)
    if not entries:
        log.error("no usable lines in %s", args.path)
        return 1

    results = add_sources(entries)
    created = sum(1 for _, _, was_new in results if was_new)
    log.info(
        "%d line(s): %d added, %d updated",
        len(results),
        created,
        len(results) - created,
    )
    for url, source_id, was_new in results:
        log.info("  %-4s id=%-5d %s", "new" if was_new else "upd", source_id, url)
    return 0


def _cmd_list(args: argparse.Namespace) -> int:
    rows = list_sources(
        active_only=args.active,
        category=args.category,
        search=args.search,
        limit=args.limit,
    )
    if args.json:
        import json

        print(json.dumps(rows, indent=2, default=str))
        return 0

    _print_table(rows)
    print(f"\n{len(rows)} source(s)")
    return 0


def _cmd_list_inactive(args: argparse.Namespace) -> int:
    """Retired rows only. Kept separate so --active stays a clean flag."""
    rows = [
        row
        for row in list_sources(
            active_only=False,
            category=args.category,
            search=args.search,
            limit=None,
        )
        if not row["is_active"]
    ]
    if args.limit is not None:
        rows = rows[: args.limit]

    if args.json:
        import json

        print(json.dumps(rows, indent=2, default=str))
        return 0

    _print_table(rows)
    print(f"\n{len(rows)} retired source(s)")
    return 0


def _cmd_show(args: argparse.Namespace) -> int:
    row = get_source(args.source_id)
    if row is None:
        log.error("no source with id=%d", args.source_id)
        return 1

    width = max(len(key) for key in COLUMNS)
    for key in COLUMNS:
        value = row[key]
        if key == "created_at":
            value = _fmt_time(value)
        print(f"{key.ljust(width)} : {value}")
    return 0


def _cmd_update(args: argparse.Namespace) -> int:
    changed = update_source(
        args.source_id,
        title=args.title,
        url=args.url,
        category=args.category,
    )
    if not changed:
        log.error("no source with id=%d", args.source_id)
        return 1
    log.info("updated source id=%d", args.source_id)
    return 0


def _cmd_set_active(args: argparse.Namespace, is_active: bool) -> int:
    changed = set_active(args.source_id, is_active)
    if not changed:
        log.error("no source with id=%d", args.source_id)
        return 1
    log.info(
        "%s source id=%d",
        "activated" if is_active else "deactivated",
        args.source_id,
    )
    return 0


def _cmd_remove(args: argparse.Namespace) -> int:
    if not args.yes:
        log.error("refusing to delete without --yes (use deactivate for a soft delete)")
        return 2
    if not remove_source(args.source_id):
        log.error("no source with id=%d", args.source_id)
        return 1
    log.info("removed source id=%d", args.source_id)
    return 0


def _cmd_categories(args: argparse.Namespace) -> int:
    rows = list_categories()
    if not rows:
        print("(no sources)")
        return 0

    width = max(len(str(row["category"])) for row in rows)
    print(f"{'CATEGORY'.ljust(width)}  ACTIVE  TOTAL")
    print(f"{'-' * width}  ------  -----")
    for row in rows:
        print(
            f"{str(row['category']).ljust(width)}  "
            f"{str(row['active']).rjust(6)}  {str(row['total']).rjust(5)}"
        )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m collectors.source_manager",
        description="Manage the tracked_sources link registry",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_add = sub.add_parser("add", help="add a source (idempotent on url)")
    p_add.add_argument("title", help="human-readable name")
    p_add.add_argument("url", help="http(s) link")
    p_add.add_argument("--category", default=None, help="e.g. NEWS, CENTRAL_BANK")
    p_add.set_defaults(func=_cmd_add)

    p_bulk = sub.add_parser("add-bulk", help="add many sources from a file")
    p_bulk.add_argument("path", help="file with one source per line")
    p_bulk.set_defaults(func=_cmd_add_bulk)

    p_list = sub.add_parser("list", help="list sources")
    p_list.add_argument("--active", action="store_true", help="only active rows")
    p_list.add_argument("--inactive", action="store_true", help="only retired rows")
    p_list.add_argument("--category", default=None, help="filter by category")
    p_list.add_argument("--search", default=None, help="substring of title or url")
    p_list.add_argument("--limit", type=int, default=None, help="cap row count")
    p_list.add_argument("--json", action="store_true", help="emit JSON")
    p_list.set_defaults(func=_cmd_list)

    p_show = sub.add_parser("show", help="print one source")
    p_show.add_argument("source_id", type=int)
    p_show.set_defaults(func=_cmd_show)

    p_upd = sub.add_parser("update", help="patch one source")
    p_upd.add_argument("source_id", type=int)
    p_upd.add_argument("--title", default=None)
    p_upd.add_argument("--url", default=None)
    p_upd.add_argument("--category", default=None)
    p_upd.set_defaults(func=_cmd_update)

    p_off = sub.add_parser("deactivate", help="soft delete (is_active = FALSE)")
    p_off.add_argument("source_id", type=int)
    p_off.set_defaults(func=lambda a: _cmd_set_active(a, False))

    p_on = sub.add_parser("activate", help="restore a retired source")
    p_on.add_argument("source_id", type=int)
    p_on.set_defaults(func=lambda a: _cmd_set_active(a, True))

    p_rm = sub.add_parser("remove", help="hard delete a source")
    p_rm.add_argument("source_id", type=int)
    p_rm.add_argument("--yes", action="store_true", help="confirm the delete")
    p_rm.set_defaults(func=_cmd_remove)

    p_cat = sub.add_parser("categories", help="category counts")
    p_cat.set_defaults(func=_cmd_categories)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    # --inactive is sugar for the inverse of --active.
    if getattr(args, "inactive", False):
        args.active = False
        args.func = _cmd_list_inactive

    try:
        return args.func(args)
    except SourceValidationError as err:
        log.error("%s", err)
        return 2
    except Exception as err:  # noqa: BLE001 — surface DB errors, exit non-zero
        log.error("database error: %s", err)
        return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        dispose()
