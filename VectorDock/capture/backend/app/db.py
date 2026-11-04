"""SQLAlchemy engine and session setup for the capture backend."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .config import ConfigError, Settings


def create_db_engine(settings: Settings) -> Engine:
    if not settings.database_url:
        raise ConfigError("DATABASE_URL is not configured")
    url = settings.database_url
    connect_args: dict[str, object] = {}
    if url.startswith("sqlite"):
        # Short busy timeout: concurrent-writer tests map SQLITE_BUSY to an
        # honest 409 instead of hanging; single-process operation is unaffected.
        connect_args = {"check_same_thread": False, "timeout": 0.5}
        path = url.split("///", 1)[-1] if "///" in url else ""
        if path:
            Path(path).expanduser().parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(url, connect_args=connect_args, future=True)
    if url.startswith("sqlite"):

        @event.listens_for(engine, "connect")
        def _enable_sqlite_fk(dbapi_connection, _record):  # pragma: no cover - driver hook
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    if settings.is_production and not url.startswith(("postgresql://", "postgresql+")):
        raise ConfigError("Production must use PostgreSQL")
    return engine


def create_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, expire_on_commit=False, future=True)


@contextmanager
def session_scope(factory: sessionmaker[Session]) -> Iterator[Session]:
    session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def healthcheck(engine: Engine) -> bool:
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))
    return True