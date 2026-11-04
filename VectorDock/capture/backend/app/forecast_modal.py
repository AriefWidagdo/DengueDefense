"""Separate CPU-only Modal function for Tree and EpiKD forecasts.

This is deployment configuration, not a deployment. It copies an allowlist of
trusted local model files into the forecast image. It never mounts the capture
or SAM3 volumes and does not download or train model weights.
"""
from __future__ import annotations

from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parents[4]
TREE = ROOT / "outputs_epikd_tree_export"
KDA = ROOT / "outputs_epikd_fullkda_12epoch_20261027_231817"
REMOTE = "/forecast"

# Pin the versions used by the saved KDA reference run. PyTorch is installed
# from its CPU wheel index; no GPU is attached to this function.
forecast_image = (
    modal.Image.debian_slim(python_version="3.13")
    .apt_install("libgomp1")
    .pip_install("numpy==2.1.3", "pandas==2.3.1", "scipy==1.15.3", "lightgbm==4.7.0")
    .pip_install("torch==2.11.0+cpu", extra_index_url="https://download.pytorch.org/whl/cpu")
    .add_local_file(ROOT / "EpiKD_Experiment.py", f"{REMOTE}/EpiKD_Experiment.py", copy=True)
    .add_local_file(ROOT / "data" / "epikd_geodata_static.csv", f"{REMOTE}/data/epikd_geodata_static.csv", copy=True)
    .add_local_file(Path(__file__).with_name("forecast_engine.py"), f"{REMOTE}/forecast_engine.py", copy=True)
    .add_local_file(TREE / "COMPLETE.json", f"{REMOTE}/outputs_epikd_tree_export/COMPLETE.json", copy=True)
    .add_local_file(TREE / "SHA256SUMS.txt", f"{REMOTE}/outputs_epikd_tree_export/SHA256SUMS.txt", copy=True)
    .add_local_file(TREE / "model_bundle.pkl", f"{REMOTE}/outputs_epikd_tree_export/model_bundle.pkl", copy=True)
    .add_local_file(TREE / "feature_pipeline.py", f"{REMOTE}/outputs_epikd_tree_export/feature_pipeline.py", copy=True)
    .add_local_file(TREE / "adjacency.npz", f"{REMOTE}/outputs_epikd_tree_export/adjacency.npz", copy=True)
    .add_local_file(TREE / "lightgbm_artifact.py", f"{REMOTE}/outputs_epikd_tree_export/lightgbm_artifact.py", copy=True)
    .add_local_dir(TREE / "native", f"{REMOTE}/outputs_epikd_tree_export/native", copy=True)
    .add_local_file(KDA / "model_kda_17.pt", f"{REMOTE}/outputs_epikd_fullkda_12epoch_20261027_231817/model_kda_17.pt", copy=True)
    .add_local_file(KDA / "preprocessor.pkl", f"{REMOTE}/outputs_epikd_fullkda_12epoch_20261027_231817/preprocessor.pkl", copy=True)
    .add_local_file(KDA / "config.json", f"{REMOTE}/outputs_epikd_fullkda_12epoch_20261027_231817/config.json", copy=True)
)

app = modal.App("vectordock-forecast")


@app.function(image=forecast_image, cpu=2, memory=4096, max_containers=1, timeout=300)
def forecast(*, panel_csv: bytes, region: str, issue_date: str, model: str) -> dict:
    """Return a forecast or a safe error; do not persist the submitted panel."""
    import sys

    sys.path.insert(0, REMOTE)
    from forecast_engine import ForecastUnavailableError, ForecastValidationError, predict_forecast

    try:
        result = predict_forecast(panel_csv=panel_csv, region=region, issue_date=issue_date,
                                  model=model, assets_root=Path(REMOTE))
        return {"ok": True, "result": result}
    except ForecastUnavailableError:
        return {"ok": False, "kind": "unavailable"}
    except ForecastValidationError as error:
        return {"ok": False, "kind": "validation", "message": str(error)}
    except Exception:
        return {"ok": False, "kind": "unavailable"}
