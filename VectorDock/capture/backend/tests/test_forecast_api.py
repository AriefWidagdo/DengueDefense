"""Forecast route security and transport checks; no cloud/model inference."""
from __future__ import annotations

import importlib.util
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import forecast_api
from conftest import login


def payload():
    return {"model": "tree", "region": "31.73", "issue_date": "2024-06-30"}


def panel(data=b"date,cases\n"):
    return {"panel": ("monthly.csv", data, "text/csv")}


def test_forecast_requires_a_session_and_csrf(seeded, monkeypatch):
    monkeypatch.setenv("CAPTURE_FORECAST_RUNTIME", "local")
    unauthenticated = seeded.post("/api/forecasts", data=payload(), files=panel())
    assert unauthenticated.status_code == 401
    headers = login(seeded, "worker1", "worker-password-1")
    missing_csrf = seeded.post("/api/forecasts", data=payload(), files=panel())
    assert missing_csrf.status_code == 403
    forbidden_origin = seeded.post(
        "/api/forecasts", data=payload(), files=panel(),
        headers={**headers, "Origin": "https://untrusted.example"},
    )
    assert forbidden_origin.status_code == 403


def test_forecast_forwards_only_the_requested_inputs(seeded, monkeypatch):
    monkeypatch.setenv("CAPTURE_FORECAST_RUNTIME", "local")
    calls = []

    def fake_run(**kwargs):
        calls.append(kwargs)
        return {"ok": True, "result": {"model": "tree", "predictions": []}}

    monkeypatch.setattr(forecast_api, "run_forecast", fake_run)
    headers = login(seeded, "worker1", "worker-password-1")
    response = seeded.post("/api/forecasts", data=payload(), files=panel(), headers=headers)
    assert response.status_code == 200
    assert response.json() == {"model": "tree", "predictions": []}
    assert len(calls) == 1
    assert calls[0]["panel_csv"] == b"date,cases\n"
    assert calls[0]["region"] == "31.73"
    assert calls[0]["model"] == "tree"
    assert calls[0]["issue_date"] == "2024-06-30"


def test_forecast_is_disabled_by_default(seeded, monkeypatch):
    monkeypatch.delenv("CAPTURE_FORECAST_RUNTIME", raising=False)
    headers = login(seeded, "worker1", "worker-password-1")
    response = seeded.post("/api/forecasts", data=payload(), files=panel(), headers=headers)
    assert response.status_code == 503
    assert "not configured" in response.json()["detail"]


def test_forecast_rejects_bad_model_and_empty_or_oversized_input(seeded, monkeypatch):
    monkeypatch.setenv("CAPTURE_FORECAST_RUNTIME", "local")
    monkeypatch.setattr(forecast_api, "MAX_FORECAST_FILE_BYTES", 8)
    headers = login(seeded, "worker1", "worker-password-1")
    wrong = seeded.post("/api/forecasts", data={**payload(), "model": "other"}, files=panel(b"x"), headers=headers)
    empty = seeded.post("/api/forecasts", data=payload(), files=panel(b""), headers=headers)
    large = seeded.post("/api/forecasts", data=payload(), files=panel(b"x" * 9), headers=headers)
    assert wrong.status_code == 422
    assert empty.status_code == 422
    assert large.status_code == 413


def test_forecast_reports_validation_and_unavailable_distinctly(seeded, monkeypatch):
    monkeypatch.setenv("CAPTURE_FORECAST_RUNTIME", "local")
    headers = login(seeded, "worker1", "worker-password-1")
    monkeypatch.setattr(forecast_api, "run_forecast", lambda **_: {
        "ok": False, "kind": "validation", "message": "Invalid temperature."
    })
    invalid = seeded.post("/api/forecasts", data=payload(), files=panel(), headers=headers)
    assert invalid.status_code == 422
    assert invalid.json()["detail"] == "Invalid temperature."
    monkeypatch.setattr(forecast_api, "run_forecast", lambda **_: {"ok": False, "kind": "unavailable"})
    unavailable = seeded.post("/api/forecasts", data=payload(), files=panel(), headers=headers)
    assert unavailable.status_code == 503


def test_forecasts_are_rate_limited_per_operator(seeded, monkeypatch):
    monkeypatch.setenv("CAPTURE_FORECAST_RUNTIME", "local")
    monkeypatch.setattr(forecast_api.service, "utcnow", lambda: datetime(2026, 1, 1, tzinfo=timezone.utc))
    monkeypatch.setattr(forecast_api, "run_forecast", lambda **_: {"ok": True, "result": {"predictions": []}})
    headers = login(seeded, "worker1", "worker-password-1")
    for _ in range(forecast_api.FORECAST_RATE_PER_MINUTE):
        assert seeded.post("/api/forecasts", data=payload(), files=panel(), headers=headers).status_code == 200
    assert seeded.post("/api/forecasts", data=payload(), files=panel(), headers=headers).status_code == 429


def test_production_never_uses_local_model_files(monkeypatch):
    monkeypatch.setenv("CAPTURE_FORECAST_RUNTIME", "local")
    state = SimpleNamespace(settings=SimpleNamespace(is_production=True))
    assert forecast_api._forecast_mode(state) == "disabled"


def test_modal_forecast_uses_only_the_fixed_function_and_environment(monkeypatch):
    seen = {}

    class Function:
        @staticmethod
        def from_name(app_name, name, *, environment_name):
            seen.update(app=app_name, name=name, environment=environment_name)
            return SimpleNamespace(remote=lambda **kwargs: {"ok": True, "result": kwargs})

    monkeypatch.setitem(sys.modules, "modal", SimpleNamespace(Function=Function))
    response = forecast_api.run_forecast(mode="modal", panel_csv=b"csv", region="31.73",
                                          issue_date="2024-06-30", model="tree", modal_env="main")
    assert seen == {"app": "vectordock-forecast", "name": "forecast", "environment": "main"}
    assert response["result"]["panel_csv"] == b"csv"
    assert response["result"]["region"] == "31.73"


def test_forecast_reports_busy_without_starting_another_call(seeded, monkeypatch):
    monkeypatch.setenv("CAPTURE_FORECAST_RUNTIME", "local")
    headers = login(seeded, "worker1", "worker-password-1")
    assert forecast_api._forecast_slot.acquire(blocking=False)
    try:
        response = seeded.post("/api/forecasts", data=payload(), files=panel(), headers=headers)
        assert response.status_code == 429
    finally:
        forecast_api._forecast_slot.release()


@pytest.mark.skipif(
    any(importlib.util.find_spec(name) is None for name in ("numpy", "pandas", "scipy", "lightgbm", "torch"))
    or not (Path(__file__).resolve().parents[4] / "data" / "epikd_monthly_panel_21y.csv").is_file()
    or not (Path(__file__).resolve().parents[4] / "outputs_epikd_fullkda_12epoch_20261027_231817" / "predictions_test.csv").is_file(),
    reason="optional CPU runtime or local research test data is unavailable",
)
@pytest.mark.parametrize("model", ["tree", "epikd"])
@pytest.mark.parametrize("issue", ["2024-06-30", "2025-01-31", "2027-12-31"])
def test_real_forecast_through_authenticated_api(seeded, monkeypatch, model, issue):
    """Local-only end-to-end check using saved model data, never a live service."""
    import pandas as pd

    monkeypatch.setenv("CAPTURE_FORECAST_RUNTIME", "local")
    root = Path(__file__).resolve().parents[4]
    frame = pd.read_csv(root / "data" / "epikd_monthly_panel_21y.csv")
    frame["month"] = pd.to_datetime(frame["date"]).dt.to_period("M")
    end = pd.Period(issue, freq="M")
    if end <= pd.Period("2024-12", freq="M"):
        frame = frame.loc[frame["month"].between(end - 23, end)].copy()
    else:
        # Roll the last complete 24-month window forward so the future issue
        # month has continuous user-supplied history for every district row.
        frame = frame.loc[frame["month"] > frame["month"].max() - 24].copy()
        delta = (end.year - frame["month"].max().year) * 12 + (end.month - frame["month"].max().month)
        frame["date"] = (pd.to_datetime(frame["date"]) + pd.DateOffset(months=delta)).dt.strftime("%Y-%m-%d")
        frame["month"] = pd.to_datetime(frame["date"]).dt.to_period("M")
        # Shifting a calendar window by one month can make a valid leap-day
        # or 30/31-day dry-day count invalid. Trim test-only dry days to the
        # target month before checking the model; the input is still real rows.
        days = frame["month"].dt.days_in_month.clip(upper=31)
        frame["dry_days"] = frame["dry_days"].clip(upper=days)
    monthly_csv = frame.drop(columns=["month"]).to_csv(index=False).encode("utf-8")
    headers = login(seeded, "worker1", "worker-password-1")
    response = seeded.post("/api/forecasts", data={**payload(), "model": model, "issue_date": issue},
                             files=panel(monthly_csv), headers=headers)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["model"] == model
    assert result["issue_date"] == issue
    assert [item["target_month"] for item in result["predictions"]] == [
        str((end + offset).start_time.date()) for offset in (1, 2, 3)]
    if model == "tree" and issue == "2024-06-30":
        assert result["predictions"][0]["expected_cases"] == pytest.approx(81.0251140647124, abs=1e-8)
    if model == "epikd" and issue == "2024-06-30":
        reference = pd.read_csv(root / "outputs_epikd_fullkda_12epoch_20261027_231817" / "predictions_test.csv")
        row = reference.loc[(reference["region"].round(2) == 31.73)
                            & (reference["issue_time"] == "2024-06-30")
                            & (reference["horizon"] == 1)].iloc[0]
        assert result["predictions"][0]["expected_cases"] == pytest.approx(row["mu"], abs=2e-5)
    assert all(item["expected_cases"] >= 0 for item in result["predictions"])

