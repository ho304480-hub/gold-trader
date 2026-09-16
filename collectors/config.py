"""collectors/config.py — shared configuration for the Python collector layer.

Loads .env from the project root (one level above this package) so the
collectors and the Node API read the exact same credentials. Exposes a
single SQLAlchemy engine plus a session factory; every collector imports
from here rather than building its own connection.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")


def _int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def database_url() -> str:
    """Full connection URL. DATABASE_URL wins over the discrete DB_* vars."""
    explicit = os.getenv("DATABASE_URL")
    if explicit:
        return explicit

    host = os.getenv("DB_HOST", "localhost")
    port = _int("DB_PORT", 5432)
    name = os.getenv("DB_NAME", "gold_terminal")
    user = os.getenv("DB_USER", "postgres")
    password = os.getenv("DB_PASSWORD", "")
    return f"postgresql+psycopg2://{user}:{password}@{host}:{port}/{name}"


def fred_api_key() -> str | None:
    key = os.getenv("FRED_API_KEY")
    if not key or key.startswith("your_"):
        return None
    return key


def setup_logging(name: str) -> logging.Logger:
    """One consistent log format across every collector."""
    level_name = os.getenv("COLLECTOR_LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)

    root = logging.getLogger()
    if not root.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(
            logging.Formatter(
                fmt="%(asctime)s %(levelname)-7s [%(name)s] %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            )
        )
        root.addHandler(handler)
    root.setLevel(level)

    return logging.getLogger(name)


_engine: Engine | None = None
_SessionFactory: sessionmaker[Session] | None = None


def get_engine() -> Engine:
    """Process-wide engine. pool_pre_ping survives Postgres restarts."""
    global _engine
    if _engine is None:
        _engine = create_engine(
            database_url(),
            pool_size=_int("DB_POOL_MAX", 10),
            max_overflow=5,
            pool_pre_ping=True,
            pool_recycle=1800,
            future=True,
        )
    return _engine


def get_session() -> Session:
    """New ORM session. Caller owns the lifecycle (use as a context manager)."""
    global _SessionFactory
    if _SessionFactory is None:
        _SessionFactory = sessionmaker(bind=get_engine(), future=True)
    return _SessionFactory()


def health_check() -> dict:
    """Return server + TimescaleDB versions, or raise if unreachable."""
    with get_engine().connect() as conn:
        row = conn.execute(
            text(
                """
                SELECT current_database() AS database,
                       current_user      AS db_user,
                       version()         AS server_version,
                       (SELECT extversion FROM pg_extension
                         WHERE extname = 'timescaledb') AS timescaledb_version
                """
            )
        ).mappings().one()
        return dict(row)


def dispose() -> None:
    """Release pooled connections at process exit."""
    global _engine, _SessionFactory
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _SessionFactory = None
