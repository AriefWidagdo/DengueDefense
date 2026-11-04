"""Authenticated, bounded access to the separate district forecasting service.

Forecasts are transient research outputs. This route neither saves a forecast
nor reads trap measurements, and it never accepts executable model artifacts.
"""
from __future__ import annotations

import os
from pathlib import Path
from threading import BoundedSemaphore
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from . import service
from .deps import AppState, get_db, get_state, require_user
from .security import AuthContext

router = APIRouter(prefix="/api")
MAX_FORECAST_FILE_BYTES = 12 * 1024 * 1024
FORECAST_RATE_PER_MINUTE = 5
# Bound concurrent forecasts within each capture container. The separate Modal
# forecast function is also subject to the platform's configured concurrency.
_forecast_slot = BoundedSemaphore(1)


class ForecastUnavailable(RuntimeError):
    """The forecast service is not configured or could not be reached."""


def _forecast_mode(state: AppState) -> str:
    mode = os.environ.get("CAPTURE_FORECAST_RUNTIME", "disabled").strip().lower()
    if mode not in {"disabled", "local", "modal"}:
        return "disabled"
    # Never allow a production request to choose or run local repository files.
    if state.settings.is_production and mode == "local":
        return "disabled"
    return mode


def run_forecast(*, mode: str, panel_csv: bytes, region: str, issue_date: str,
                 model: str, modal_env: str) -> dict:
    """Run an explicitly configured backend, without exposing runtime errors."""
    if mode == "local":
        # All numerical/model imports happen only for an actual forecast. The
        # capture API can still start when the optional dependencies are absent.
        from .forecast_engine import ForecastUnavailableError, ForecastValidationError, predict_forecast

        configured_root = os.environ.get("CAPTURE_FORECAST_ASSETS_ROOT", "").strip()
        root = Path(configured_root) if configured_root else Path(__file__).resolve().parents[4]
        try:
            result = predict_forecast(panel_csv=panel_csv, region=region, issue_date=issue_date,
                                      model=model, assets_root=root)
            return {"ok": True, "result": result}
        except ForecastUnavailableError as error:
            raise ForecastUnavailable("The forecast runtime is unavailable.") from error
        except ForecastValidationError as error:
            return {"ok": False, "kind": "validation", "message": str(error)}
        except Exception as error:
            raise ForecastUnavailable("The forecast runtime is unavailable.") from error
    if mode == "modal":
        try:
            import modal
            function = modal.Function.from_name(
                "vectordock-forecast", "forecast", environment_name=modal_env,
            )
            result = function.remote(panel_csv=panel_csv, region=region,
                                     issue_date=issue_date, model=model)
        except Exception as error:
            raise ForecastUnavailable("The forecast service could not be reached.") from error
        if not isinstance(result, dict):
            raise ForecastUnavailable("The forecast service returned an invalid response.")
        return result
    raise ForecastUnavailable("The forecast service is not configured.")


@router.post("/forecasts")
def create_forecast(
    model: Literal["tree", "epikd"] = Form(...),
    region: str = Form(..., min_length=1, max_length=16),
    issue_date: str = Form(..., min_length=10, max_length=10),
    panel: UploadFile = File(...),
    auth: AuthContext = Depends(require_user),
    db: Session = Depends(get_db),
    state: AppState = Depends(get_state),
) -> dict:
    mode = _forecast_mode(state)
    if mode == "disabled":
        raise HTTPException(status_code=503, detail="The forecast service is not configured.")
    if not _forecast_slot.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="A forecast is already running. Try again shortly.")
    try:
        service.check_rate(db, f"forecast:{auth.operator.id}", FORECAST_RATE_PER_MINUTE)
        data = panel.file.read(MAX_FORECAST_FILE_BYTES + 1)
        if not data:
            raise HTTPException(status_code=422, detail="Choose a nonempty monthly-data CSV.")
        if len(data) > MAX_FORECAST_FILE_BYTES:
            raise HTTPException(status_code=413, detail="The monthly-data CSV exceeds 12 MiB.")
        try:
            response = run_forecast(mode=mode, panel_csv=data, region=region.strip(),
                                    issue_date=issue_date, model=model,
                                    modal_env=state.settings.modal_env)
        except ForecastUnavailable:
            raise HTTPException(status_code=503, detail="The forecast service is unavailable.") from None
        if response.get("ok") is not True:
            # Only the engine's explicitly safe validation messages are returned.
            if response.get("kind") == "validation" and isinstance(response.get("message"), str):
                raise HTTPException(status_code=422, detail=response["message"][:300])
            raise HTTPException(status_code=503, detail="The forecast service is unavailable.")
        result = response.get("result")
        if not isinstance(result, dict):
            raise HTTPException(status_code=503, detail="The forecast service returned an invalid response.")
        return result
    finally:
        _forecast_slot.release()
