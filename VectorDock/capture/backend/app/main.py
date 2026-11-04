"""FastAPI application factory for the VectorDock capture backend.

No permissive CORS middleware: the phone page and the Cloudflare Pages /api
proxy are same-origin flows. The relay credential authenticates the proxy
transport only.
"""

from __future__ import annotations

import re

from fastapi import FastAPI
from sqlalchemy import inspect as sql_inspect

from .adapter import build_adapter
from .config import ConfigError, Settings, load_settings
from .db import create_db_engine, create_session_factory, healthcheck
from .deps import AppState
from .forecast_api import router as forecast_router
from .request_limit import RequestSizeLimitMiddleware
from .routes import router
from .storage import FileStorage, build_storage


def _production_storage(settings: Settings, volume=None, *, resolved_volume_id: str | None = None) -> FileStorage:
    """Storage bound to the dedicated capture Volume mount inside Modal.

    `volume` is the hydrated modal.Volume handle from the entry point; the
    storage commits through that exact handle. Called without a handle it
    fails closed: a configuration-only construction could commit a
    mismatched volume.
    """
    if volume is None:
        raise ConfigError(
            "Production storage requires the mounted capture Volume handle: "
            "pass the hydrated modal.Volume from the Modal entry point"
        )
    from .storage import ModalVolumeStorage

    return ModalVolumeStorage(volume, settings.volume_mount, settings.volume_name,
                              resolved_volume_id=resolved_volume_id)


def _verify_production_schema(engine) -> None:
    """Full schema gate: every metadata table AND its required columns must
    exist. A partial or old schema refuses to start with actionable migration
    guidance; nothing is created, altered, or erased here."""
    inspector = sql_inspect(engine)
    from .models import Base

    missing_tables: list[str] = []
    missing_columns: list[str] = []
    present = set(inspector.get_table_names())
    for table_name, table in Base.metadata.tables.items():
        if table_name not in present:
            missing_tables.append(table_name)
            continue
        actual = {column["name"] for column in inspector.get_columns(table_name)}
        for column in table.columns:
            if column.name not in actual:
                missing_columns.append(f"{table_name}.{column.name}")
    missing_indexes = []
    if "measurements" in present:
        indexes = inspector.get_indexes("measurements")
        valid_active_index = False
        for index in indexes:
            options = index.get("dialect_options", {})
            predicate = options.get("sqlite_where")
            if predicate is None:
                predicate = options.get("postgresql_where")
            if (index["name"] == "uq_active_measurement" and index.get("unique")
                    and index.get("column_names") == ["sample_id"]
                    and predicate is not None
                    and re.fullmatch(r'\(*"?superseded_at"?\s+IS\s+NULL\)*', str(predicate).strip(), re.I)):
                valid_active_index = True
        if not valid_active_index:
            missing_indexes.append("measurements.uq_active_measurement (unique active review)")
    if missing_tables or missing_columns or missing_indexes:
        raise ConfigError(
            "Production database schema is incomplete."
            + (" Missing tables: " + ", ".join(sorted(missing_tables)) + "." if missing_tables else "")
            + (" Missing columns: " + ", ".join(sorted(missing_columns)) + "." if missing_columns else "")
            + (" Missing indexes: " + ", ".join(missing_indexes) + "." if missing_indexes else "")
            + " Apply the additive schema migrations documented in the backend README "
            "before starting; never recreate or erase existing data."
        )


def create_app(settings: Settings | None = None, *, storage: FileStorage | None = None) -> FastAPI:
    settings = settings or load_settings()
    if settings.problems:
        raise ConfigError("Refusing to start with incomplete/insecure production configuration: " + "; ".join(settings.problems))
    engine = create_db_engine(settings)
    if settings.is_production:
        healthcheck(engine)
        _verify_production_schema(engine)
    session_factory = create_session_factory(engine)
    if not settings.is_production:
        from .models import Base

        Base.metadata.create_all(engine)
    storage = storage if storage is not None else build_storage(settings)
    adapter = build_adapter(settings)
    app = FastAPI(
        title="VectorDock Capture Backend",
        version="0.1.0",
        description=(
            "Manual trap, QR identification, phone photo confirmation, asynchronous Modal "
            "counting, and human acceptance of candidate counts. QR identification is not "
            "authentication; SAM3 outputs are candidate detections for human review."
        ),
    )
    app.state.capture = AppState(
        settings=settings, session_factory=session_factory, storage=storage, adapter=adapter
    )
    app.include_router(router)
    app.include_router(forecast_router)
    # Bound the request body at the ASGI receive layer, before any multipart
    # buffering or route code. Reads the live settings so test overrides work.
    app.add_middleware(
        RequestSizeLimitMiddleware,
        limit_bytes=lambda: app.state.capture.settings.max_request_bytes,
    )
    return app