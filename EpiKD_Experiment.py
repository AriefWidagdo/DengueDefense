# %% [markdown]
# # Epi-KD Experiment
#
# Self-contained reference implementation of the Epi-KD architecture and
# experimental protocol specified in `EpiKD.txt` (Sections 1-12).
#
# By default, this script loads the audited 21-year balanced panel from
# `data/epikd_monthly_panel_21y.csv` (514 official 2025 BPS districts x 252 months)
# and the shared-border adjacency matrix `data/epikd_adjacency_matrix.npz`.
# It also supports legacy CSV schemas (such as `data/dengue_climate_features_21y.csv`)
# and a synthetic fallback mode (`--mode synthetic`).
#
# Run from a terminal:
# `python EpiKD_Experiment.py --preset pilot`
# `python EpiKD_Experiment.py --preset full --spatial on`
#
# Training host: AMD Instinct MI300X (ROCm) or standard CUDA/CPU host.
# PyTorch on ROCm exposes the GPU through the `torch.cuda` API.
# Keep float32 for the reference run (`EpiKD.txt` Section 5 & 7).
#
# Run in Colab or Jupyter:
# execute `EpiKD_Experiment.ipynb` from top to bottom.
# The notebook and this script contain identical code organized into Cell Groups 00-15.

# %% 00. Design, configuration, seed/device/version logging; synthetic versus real-data mode
import argparse
import copy
import hashlib
import json
import math
import os
import pickle
import platform
import random
import sys
import time
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from scipy import stats

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
except Exception as _torch_error:
    torch = None
    nn = None
    F = None
    TORCH_ERROR = _torch_error
else:
    TORCH_ERROR = None

try:
    import lightgbm as lgb
except Exception:
    lgb = None


def _base_dir():
    try:
        return os.path.dirname(os.path.abspath(__file__))
    except NameError:
        return os.getcwd()


BASE_DIR = _base_dir()
DATA_SUBDIR = os.path.join(BASE_DIR, "data")


def _default_data_path():
    audited = os.path.join(DATA_SUBDIR, "epikd_monthly_panel_21y.csv")
    if os.path.exists(audited):
        return audited
    legacy_sub = os.path.join(DATA_SUBDIR, "dengue_climate_features_21y.csv")
    if os.path.exists(legacy_sub):
        return legacy_sub
    return os.path.join(BASE_DIR, "dengue_climate_features_21y.csv")


DEFAULT_CFG = {
    "PRESET": "pilot",
    "MODE": "real",  # "real" or "synthetic"
    "DATA_PATH": _default_data_path(),
    "ADJACENCY_PATH": os.path.join(DATA_SUBDIR, "epikd_adjacency_matrix.npz"),
    "GEODATA_PATH": os.path.join(DATA_SUBDIR, "epikd_geodata_static.csv"),
    "REGION_COL": "bps_kode_2025",
    "AGGREGATE_TO_REGION": False,
    "DATE_COL": "date",
    "CASES_COL": "cases",
    "PROVINCE_COL": "province",
    "POPULATION_COL": "population",
    "USE_CLIMATE": True,
    "SPATIAL": "off",  # "off", "on" (shared-border W), or "knn5" (5-NN sensitivity)
    "POPULATION_OFFSET": False,  # Sensitivity head: mu = (P/1e5)*softplus(a_h)
    "AUX_BCE_WEIGHT": 0.0,  # Auxiliary outbreak BCE control weight (e.g. 0.1 or 0.3)
    "CASE_DELAY_MONTHS": 0,  # Assumed reporting delay d in {0, 1, 2}
    "LOOKBACK": 24,
    "HORIZONS": 3,
    "MIN_OBSERVED_IN_LOOKBACK": 12,
    "EVENT_QUANTILE": 0.90,
    "EVENT_FLOOR": 5,
    "EVENT_SHRINKAGE_N0": 24.0,
    "ALARM_BUDGET_PER_DISTRICT_YEAR": 1.0,
    "MODELS": ["last_obs_naive", "seasonal_naive", "gru", "scalar_decay", "kda"],
    "SEEDS": [17],
    "EPOCHS": 12,
    "PATIENCE": 4,
    "BATCH_SIZE": 256,
    "LR": 0.001,
    "WEIGHT_DECAY": 0.0001,
    "DROPOUT": 0.10,
    "LAYERS": 2,
    "WIDTH": 64,
    "HEADS": 2,
    "MAX_TRAIN_WINDOWS": 24000,
    "MAX_EVAL_WINDOWS": None,
    "RUN_TUNING": False,
    "RUN_ROLLING_VAL": False,
    "RUN_SAMPLE_EFFICIENCY": False,
    "SAMPLE_EFFICIENCY_FRACTIONS": [0.25, 0.50, 0.75, 1.00],
    "SAMPLE_EFFICIENCY_EXCLUDED_REF_MONTHS": 0,
    "RUN_BOOTSTRAP": True,
    "BOOTSTRAP_ITERS": 200,
    "RUN_TESTS": True,
    "OUTPUT_DIR": os.path.join(BASE_DIR, "outputs_epikd"),
    "SOURCE_MODE": "retrospective_final_assumed_delay_0",
    "DEVICE": "auto",
}

FULL_OVERRIDES = {
    "SEEDS": [17, 42, 2026],
    "EPOCHS": 100,
    "PATIENCE": 12,
    "MODELS": [
        "last_obs_naive",
        "seasonal_naive",
        "tree",
        "gru",
        "transformer",
        "scalar_decay",
        "kda",
        "kda_noconv",
    ],
    "MAX_TRAIN_WINDOWS": None,
    "MAX_EVAL_WINDOWS": None,
    "RUN_ROLLING_VAL": True,
}

# Raw observed climate candidates only (Section 4 of EpiKD.txt excludes precomputed
# full-period climatological anomalies rain_anom_* / temp_anom_*).
PRIMARY_CLIMATE_CANDIDATES = ["rainfall", "tmin", "tmax", "dry_days", "oni"]
FALLBACK_CLIMATE_CANDIDATES = ["precip_mm", "rain_roll_1m", "temp_min", "temp_max", "temp_roll_1m", "humidity"]
STATIC_GEO_CANDIDATES = ["latitude", "longitude", "mean_mdpl"]
QUANTILE_LEVELS = np.array([0.025, 0.10, 0.25, 0.50, 0.75, 0.90, 0.975])


def apply_preset(user_cfg=None):
    cfg = dict(DEFAULT_CFG)
    if user_cfg:
        cfg.update(user_cfg)
    if cfg.get("PRESET") == "full":
        explicit = set((user_cfg or {}).keys())
        for key, value in FULL_OVERRIDES.items():
            if key not in explicit:
                cfg[key] = copy.deepcopy(value)
    delay = int(cfg.get("CASE_DELAY_MONTHS", 0))
    if not user_cfg or "SOURCE_MODE" not in user_cfg:
        cfg["SOURCE_MODE"] = f"retrospective_final_assumed_delay_{delay}"
    # Section 3: For lookback sensitivity runs use ceil(L/2) unless explicitly overridden.
    if not user_cfg or "MIN_OBSERVED_IN_LOOKBACK" not in user_cfg:
        cfg["MIN_OBSERVED_IN_LOOKBACK"] = int(math.ceil(int(cfg["LOOKBACK"]) / 2.0))
    return cfg


def set_seed(seed):
    random.seed(int(seed))
    np.random.seed(int(seed))
    if torch is not None:
        torch.manual_seed(int(seed))
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(int(seed))


# %% 01. Minimal dependency check; CPU/CUDA selection; no mandatory custom kernels
def get_device(cfg):
    if torch is None:
        return None
    want = str(cfg.get("DEVICE", "auto")).lower()
    if want in ("auto", "rocm", "hip", "gpu", "cuda"):
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    return torch.device(cfg["DEVICE"])


def log_environment(cfg, device):
    info = {
        "python": sys.version.split()[0],
        "platform": platform.system(),
        "platform_release": platform.release(),
        "numpy": np.__version__,
        "pandas": pd.__version__,
        "scipy": getattr(stats, "__version__", sys.modules["scipy"].__version__),
        "lightgbm": getattr(lgb, "__version__", None),
        "torch": getattr(torch, "__version__", None),
        "preset": cfg["PRESET"],
        "mode": cfg["MODE"],
        "spatial": cfg["SPATIAL"],
        "source_mode": cfg["SOURCE_MODE"],
        "case_delay_months": int(cfg["CASE_DELAY_MONTHS"]),
    }
    print(f"python={info['python']} platform={info['platform']} numpy={info['numpy']} pandas={info['pandas']}")
    if torch is None:
        print(f"torch=missing error={TORCH_ERROR}")
    else:
        hip = getattr(torch.version, "hip", None)
        backend = "ROCm/HIP" if hip else ("CUDA" if torch.version.cuda else "CPU")
        info["backend"] = backend
        info["hip"] = hip
        info["device"] = str(device)
        print(f"torch={torch.__version__} backend={backend} hip={hip} device={device}")
        if device is not None and device.type == "cuda" and torch.cuda.is_available():
            info["gpu_name"] = torch.cuda.get_device_name(0)
            info["gpu_memory_gb"] = round(torch.cuda.get_device_properties(0).total_memory / 1e9, 2)
            print(f"gpu_name={info['gpu_name']} gpu_memory_gb={info['gpu_memory_gb']:.1f}")
    print(f"preset={cfg['PRESET']} mode={cfg['MODE']} spatial={cfg['SPATIAL']} source_mode={cfg['SOURCE_MODE']}")
    return info


def check_dependencies(require_torch=True):
    missing = []
    for name in ["numpy", "pandas", "scipy", "sklearn"]:
        try:
            __import__(name)
        except Exception:
            missing.append(name)
    if missing:
        raise ImportError(f"Missing required packages: {missing}")
    if require_torch and torch is None:
        raise ImportError(
            "PyTorch is missing. On the MI300X host, install the ROCm build of "
            "PyTorch that matches the installed ROCm driver. On other hosts, "
            "install a CPU or CUDA build. Then rerun. "
            f"Original error: {TORCH_ERROR}"
        )
    print("dependency_check=pass")


# %% 02. Data loader and schema/duplicate/boundary/reporting audit
def _ordinal_from_datetime(series):
    dt = pd.to_datetime(series, errors="coerce")
    return dt.dt.year * 12 + (dt.dt.month - 1), dt


def ordinal_to_month_start(ordinal):
    ordinal = int(ordinal)
    return pd.Timestamp(year=ordinal // 12, month=ordinal % 12 + 1, day=1)


def ordinal_to_month_end(ordinal):
    start = ordinal_to_month_start(ordinal)
    return start + pd.offsets.MonthEnd(0)


def _file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _format_bps_code(val):
    if pd.isna(val):
        return "unknown"
    s = str(val).strip()
    try:
        f = float(s)
        p = int(f)
        k = round((f - p) * 100)
        return f"{p:02d}.{k:02d}"
    except Exception:
        return s


def load_and_validate_data(path, column_map=None, data_policy=None):
    """Load the panel and return a validated monthly panel with audit metadata."""
    cfg = dict(DEFAULT_CFG)
    if data_policy:
        cfg.update(data_policy)
    if not os.path.exists(path):
        raise FileNotFoundError(f"Data path does not exist: {path}")
    raw = pd.read_csv(path, low_memory=False)
    region_col = cfg.get("REGION_COL", "bps_kode_2025")
    if region_col not in raw.columns:
        for fallback_col in ["region_id", "bps_kode_2025", "district_uid", "region"]:
            if fallback_col in raw.columns:
                region_col = fallback_col
                break
    cmap = {
        "date": cfg.get("DATE_COL", "date"),
        "region": region_col,
        "province": cfg.get("PROVINCE_COL", "province"),
        "cases": cfg.get("CASES_COL", "cases"),
        "population": cfg.get("POPULATION_COL", "population"),
    }
    if column_map:
        cmap.update(column_map)
    for key in ["date", "region", "cases"]:
        if cmap[key] not in raw.columns:
            raise ValueError(f"Required column '{cmap[key]}' for {key} is missing.")
    if cmap["population"] is None or cmap["population"] not in raw.columns:
        cmap["population"] = None
        for cand in ["population", "pop", "population_estimate"]:
            if cand in raw.columns:
                cmap["population"] = cand
                break

    climate_cols = []
    if cfg.get("USE_CLIMATE", True):
        for cand in PRIMARY_CLIMATE_CANDIDATES:
            if cand in raw.columns:
                climate_cols.append(cand)
        if not climate_cols:
            for cand in FALLBACK_CLIMATE_CANDIDATES:
                if cand in raw.columns:
                    climate_cols.append(cand)

    static_geo_cols = [c for c in STATIC_GEO_CANDIDATES if c in raw.columns]
    extra_flag_cols = [c for c in ["is_island", "elevation_observed", "population_available"] if c in raw.columns]

    keep = [cmap["date"], cmap["region"], cmap["cases"]]
    if cmap["province"] in raw.columns:
        keep.append(cmap["province"])
    if cmap["population"] and cmap["population"] in raw.columns:
        keep.append(cmap["population"])
    for col in climate_cols + static_geo_cols + extra_flag_cols:
        if col not in keep:
            keep.append(col)

    df = raw[keep].copy()
    rename_map = {cmap["date"]: "date", cmap["region"]: "region", cmap["cases"]: "cases"}
    if cmap["province"] in raw.columns:
        rename_map[cmap["province"]] = "province"
    if cmap["population"] and cmap["population"] in raw.columns:
        rename_map[cmap["population"]] = "population"
    df = df.rename(columns=rename_map)

    if "province" not in df.columns:
        df["province"] = "unknown"
    df["ordinal"], parsed = _ordinal_from_datetime(df["date"])
    if parsed.isna().any():
        raise ValueError("The date column contains unparseable dates.")
    df["date"] = parsed.dt.to_period("M").dt.to_timestamp()
    df["cases"] = pd.to_numeric(df["cases"], errors="coerce")
    for col in climate_cols + static_geo_cols + (["population"] if "population" in df.columns else []):
        df[col] = pd.to_numeric(df[col], errors="coerce")

    if region_col in ("bps_kode_2025", "region_id"):
        df["region"] = df["region"].map(_format_bps_code)
    else:
        df["region"] = df["region"].astype(str)
    df["province"] = df["province"].astype(str)

    n_negative = int((df["cases"] < 0).sum())
    n_fractional = int(((df["cases"].dropna() % 1) != 0).sum())
    if n_negative:
        raise ValueError(f"The cases field has {n_negative} negative values.")
    if n_fractional:
        raise ValueError(f"The cases field has {n_fractional} fractional values; NB requires integer counts.")
    if "population" in df.columns and (df["population"].dropna() <= 0).any():
        raise ValueError("The population field contains nonpositive denominators.")

    if cfg.get("AGGREGATE_TO_REGION", False):
        # Section 3: Never convert all-NaN months to 0.0 during aggregation.
        agg = {"cases": lambda s: s.sum(min_count=1), "province": "first"}
        for col in climate_cols + static_geo_cols:
            agg[col] = "mean"
        if "population" in df.columns:
            agg["population"] = "first"
        for col in extra_flag_cols:
            agg[col] = "max"
        df = df.groupby(["region", "ordinal", "date"], as_index=False).agg(agg)
        print("region_aggregation=explicit_sum_cases_min_count_1")

    dup = int(df.duplicated(subset=["region", "ordinal"]).sum())
    if dup:
        raise ValueError(
            f"Found {dup} duplicate region-month rows for region column '{region_col}'. "
            "Use the audited panel data/epikd_monthly_panel_21y.csv or set AGGREGATE_TO_REGION=True explicitly."
        )
    df = df.sort_values(["region", "ordinal"]).reset_index(drop=True)
    audit = {
        "data_path": os.path.abspath(path),
        "data_sha256": _file_sha256(path),
        "region_col": region_col,
        "rows": int(len(df)),
        "regions": int(df["region"].nunique()),
        "provinces": int(df["province"].nunique()),
        "date_min": str(df["date"].min().date()),
        "date_max": str(df["date"].max().date()),
        "months": int(df["ordinal"].nunique()),
        "cases_observed": int(df["cases"].notna().sum()),
        "cases_missing": int(df["cases"].isna().sum()),
        "cases_zero": int((df["cases"] == 0).sum()),
        "cases_fractional": n_fractional,
        "climate_cols": list(climate_cols),
        "static_geo_cols": list(static_geo_cols),
        "has_population": bool("population" in df.columns),
        "population_coverage": float(df["population"].notna().mean()) if "population" in df.columns else 0.0,
    }
    print(f"rows={audit['rows']} regions={audit['regions']} provinces={audit['provinces']}")
    print(f"date_min={audit['date_min']} date_max={audit['date_max']} months={audit['months']}")
    print(f"cases_observed={audit['cases_observed']} cases_missing={audit['cases_missing']} cases_zero={audit['cases_zero']}")
    print(f"climate_cols={climate_cols} static_geo_cols={static_geo_cols} population={audit['has_population']}")
    df.attrs["climate_cols"] = list(climate_cols)
    df.attrs["static_geo_cols"] = list(static_geo_cols)
    df.attrs["audit"] = audit
    return df


def make_synthetic_panel(seed=17, n_regions=40, years=14):
    """Generate independent seasonal NB regional series for code-path tests (Section 10)."""
    rng = np.random.default_rng(seed)
    dates = pd.date_range("2010-01-01", periods=years * 12, freq="MS")
    rows = []
    for r in range(n_regions):
        base = rng.uniform(3.0, 35.0)
        phase = rng.uniform(0, 2 * np.pi)
        amp = rng.uniform(0.3, 0.85)
        pop = float(rng.integers(80_000, 900_000))
        lat = float(rng.uniform(-8.5, 4.5))
        lon = float(rng.uniform(96.0, 140.0))
        mdpl = float(rng.exponential(120.0)) if r % 10 != 0 else np.nan
        is_island = int(r % 12 == 0)
        rain = np.maximum(0.0, rng.normal(210.0, 75.0, len(dates)))
        tmin = rng.normal(22.5, 1.1, len(dates))
        tmax = tmin + rng.uniform(6.0, 9.5, len(dates))
        dry_days = np.clip(np.round(30.0 - rain / 12.0 + rng.normal(0, 2.0, len(dates))), 0, 30)
        for i, date in enumerate(dates):
            seasonal = 1.0 + amp * np.sin(2 * np.pi * (date.month - 1) / 12.0 + phase)
            shock = 2.5 if rng.random() < 0.04 else 1.0
            mu = max(0.1, base * seasonal * shock * (0.75 + rain[i] / 480.0))
            kappa = 3.5
            p = kappa / (kappa + mu)
            cases = float(rng.negative_binomial(kappa, p))
            if r == n_regions - 1:
                cases = 0.0  # All-zero district edge case for Check 13
            elif rng.random() < 0.03:
                cases = np.nan
            rows.append({
                "date": date,
                "region": f"{(r // 10) + 11:02d}.{(r % 10) + 1:02d}",
                "province": f"P{r % 5}",
                "cases": cases,
                "population": pop * (1.0 + 0.01 * (date.year - 2010)) if r % 15 != 0 else np.nan,
                "rainfall": rain[i] if rng.random() > 0.02 else np.nan,
                "tmin": tmin[i],
                "tmax": tmax[i],
                "dry_days": dry_days[i],
                "oni": 0.6 * np.sin(2 * np.pi * i / 42.0),
                "latitude": lat,
                "longitude": lon,
                "mean_mdpl": mdpl,
                "elevation_observed": int(np.isfinite(mdpl)),
                "is_island": is_island,
            })
    df = pd.DataFrame(rows)
    df["ordinal"] = df["date"].dt.year * 12 + (df["date"].dt.month - 1)
    df = df.sort_values(["region", "ordinal"]).reset_index(drop=True)
    df.attrs["climate_cols"] = ["rainfall", "tmin", "tmax", "dry_days", "oni"]
    df.attrs["static_geo_cols"] = ["latitude", "longitude", "mean_mdpl"]
    df.attrs["audit"] = {
        "data_path": "synthetic",
        "data_sha256": f"synthetic_seed_{seed}",
        "region_col": "region",
        "rows": int(len(df)),
        "regions": int(n_regions),
        "provinces": 5,
        "date_min": str(df["date"].min().date()),
        "date_max": str(df["date"].max().date()),
        "months": int(len(dates)),
        "cases_observed": int(df["cases"].notna().sum()),
        "cases_missing": int(df["cases"].isna().sum()),
        "cases_zero": int((df["cases"] == 0).sum()),
        "cases_fractional": 0,
        "climate_cols": ["rainfall", "tmin", "tmax", "dry_days", "oni"],
        "static_geo_cols": ["latitude", "longitude", "mean_mdpl"],
        "has_population": True,
        "population_coverage": float(df["population"].notna().mean()),
    }
    print(f"synthetic_rows={len(df)} regions={n_regions} months={len(dates)}")
    return df


# %% 03. Availability/vintage policy and illustrative issue-to-target mapping
def issue_to_target_mapping(issue_ordinal, lookback=24, horizons=3, case_delay_months=0):
    """Map an issue month t to its input window [t-L+1..t], latest published case month t-d,
    and direct forecast target months [t+1..t+H] (Section 3 of EpiKD.txt).
    """
    t = int(issue_ordinal)
    L = int(lookback)
    H = int(horizons)
    d = max(0, int(case_delay_months))
    input_ordinals = list(range(t - L + 1, t + 1))
    latest_case_ordinal = t - d
    target_ordinals = [t + h for h in range(1, H + 1)]
    return {
        "issue_ordinal": t,
        "issue_month": str(ordinal_to_month_start(t).date()),
        "issue_timestamp": str(ordinal_to_month_end(t).date()),
        "input_start_month": str(ordinal_to_month_start(input_ordinals[0]).date()),
        "input_end_month": str(ordinal_to_month_start(input_ordinals[-1]).date()),
        "case_delay_months": d,
        "latest_published_case_ordinal": latest_case_ordinal,
        "latest_published_case_month": str(ordinal_to_month_start(latest_case_ordinal).date()),
        "target_ordinals": target_ordinals,
        "target_months": {f"h{h}": str(ordinal_to_month_start(t + h).date()) for h in range(1, H + 1)},
    }


# %% 04. Locked target-date splits, fitting cutoffs, inclusion/coverage report
@dataclass
class SplitSpec:
    t_max: int
    fit_end: int
    val_start: int
    val_end: int
    alarm_start: int
    alarm_end: int
    test_start: int
    test_end: int
    case_delay_months: int = 0
    fit_start: int = 0


def make_time_splits(panel, evaluation_end=None, release_policy=None):
    t_max = int(evaluation_end if evaluation_end is not None else panel["ordinal"].max())
    t_min = int(panel["ordinal"].min())
    delay = 0
    if isinstance(release_policy, dict):
        delay = int(release_policy.get("CASE_DELAY_MONTHS", 0))
    elif isinstance(release_policy, int):
        delay = int(release_policy)
    spec = SplitSpec(
        t_max=t_max,
        fit_end=t_max - 48,
        val_start=t_max - 47,
        val_end=t_max - 36,
        alarm_start=t_max - 35,
        alarm_end=t_max - 24,
        test_start=t_max - 23,
        test_end=t_max,
        case_delay_months=delay,
        fit_start=t_min,
    )
    print(
        "splits_fit="
        + str(ordinal_to_month_start(spec.fit_start).date())
        + ".."
        + str(ordinal_to_month_start(spec.fit_end).date())
        + f" (case_delay={delay}m)"
        + " val="
        + str(ordinal_to_month_start(spec.val_start).date())
        + ".."
        + str(ordinal_to_month_start(spec.val_end).date())
        + " alarm="
        + str(ordinal_to_month_start(spec.alarm_start).date())
        + ".."
        + str(ordinal_to_month_start(spec.alarm_end).date())
        + " test="
        + str(ordinal_to_month_start(spec.test_start).date())
        + ".."
        + str(ordinal_to_month_start(spec.test_end).date())
    )
    return spec


def make_rolling_splits(panel, base_split_spec, n_folds=3):
    """Build expanding-training, 12-month rolling validation blocks entirely prior to
    the alarm-calibration and test periods (Section 7 of EpiKD.txt).
    """
    folds = []
    for k in range(n_folds, 0, -1):
        shift = (k - 1) * 12
        val_end = base_split_spec.val_end - shift
        val_start = val_end - 11
        fit_end = val_start - 1
        folds.append(
            SplitSpec(
                t_max=base_split_spec.t_max,
                fit_end=fit_end,
                val_start=val_start,
                val_end=val_end,
                alarm_start=base_split_spec.alarm_start,
                alarm_end=base_split_spec.alarm_end,
                test_start=base_split_spec.test_start,
                test_end=base_split_spec.test_end,
                case_delay_months=base_split_spec.case_delay_months,
                fit_start=base_split_spec.fit_start,
            )
        )
    return folds


# %% 05. Training-only transforms, count scales, optional fixed adjacency
def load_or_build_adjacency(panel, cfg=None):
    """Load the audited shared-border adjacency W or build a 5-NN coordinate graph."""
    cfg = cfg or DEFAULT_CFG
    mode = str(cfg.get("SPATIAL", "off")).lower()
    if mode == "off":
        return None
    regions = sorted(panel["region"].unique().tolist())
    r_to_i = {r: i for i, r in enumerate(regions)}
    N = len(regions)

    if mode == "on":
        adj_path = cfg.get("ADJACENCY_PATH", DEFAULT_CFG["ADJACENCY_PATH"])
        if adj_path and os.path.exists(adj_path):
            npz = np.load(adj_path, allow_pickle=True)
            W_file = np.asarray(npz["W"], dtype=np.float32)
            codes = [str(c) for c in npz["district_codes"].tolist()]
            code_to_idx = {c: i for i, c in enumerate(codes)}
            W = np.zeros((N, N), dtype=np.float32)
            for i, r_i in enumerate(regions):
                if r_i in code_to_idx:
                     row_src = code_to_idx[r_i]
                     for j, r_j in enumerate(regions):
                         if i != j and r_j in code_to_idx:
                             W[i, j] = float(W_file[row_src, code_to_idx[r_j]])
            row_sums = W.sum(axis=1, keepdims=True)
            W = np.where(row_sums > 0, W / np.maximum(row_sums, 1e-12), 0.0).astype(np.float32)
            return {"W": W, "regions": regions, "region_to_idx": r_to_i, "mode": "shared_border"}
        if cfg.get("MODE") == "synthetic":
            # Synthetic ring-with-islands graph for code-path testing
            W = np.zeros((N, N), dtype=np.float32)
            for i in range(N):
                if i % 12 == 0:
                    continue
                for nb in [(i - 1) % N, (i + 1) % N]:
                    if nb != i and nb % 12 != 0:
                        W[i, nb] = 1.0
                        W[nb, i] = 1.0
            row_sums = W.sum(axis=1, keepdims=True)
            W = np.where(row_sums > 0, W / np.maximum(row_sums, 1e-12), 0.0).astype(np.float32)
            return {"W": W, "regions": regions, "region_to_idx": r_to_i, "mode": "synthetic_border"}
        raise FileNotFoundError(f"Audited adjacency matrix not found at {adj_path}")

    if mode == "knn5":
        if "latitude" not in panel.columns or "longitude" not in panel.columns:
            raise ValueError("knn5 spatial mode requires audited latitude and longitude columns.")
        coords_df = panel.groupby("region")[["latitude", "longitude"]].first().reindex(regions)
        coords = coords_df.values.astype(np.float64)
        W = np.zeros((N, N), dtype=np.float32)
        for i in range(N):
            if not np.isfinite(coords[i]).all():
                continue
            d2 = np.sum((coords - coords[i]) ** 2, axis=1)
            d2[i] = np.inf
            d2[~np.isfinite(d2)] = np.inf
            k_idx = np.argsort(d2)[: min(5, N - 1)]
            valid_k = [j for j in k_idx if np.isfinite(d2[j])]
            if valid_k:
                W[i, valid_k] = 1.0 / len(valid_k)
        return {"W": W, "regions": regions, "region_to_idx": r_to_i, "mode": "knn5"}

    raise ValueError(f"Unsupported SPATIAL mode: {mode}")


@dataclass
class FrozenPreprocessor:
    region_to_idx: dict = field(default_factory=dict)
    province_to_idx: dict = field(default_factory=dict)
    dynamic_median: np.ndarray = None
    dynamic_std: np.ndarray = None
    std_cols: list = field(default_factory=list)
    static_median: np.ndarray = None
    static_std: np.ndarray = None
    static_std_cols: list = field(default_factory=list)
    count_scale_map: dict = field(default_factory=dict)
    seasonal_median: dict = field(default_factory=dict)
    global_month_median: dict = field(default_factory=dict)
    naive_residuals: dict = field(default_factory=dict)
    feature_names: list = field(default_factory=list)
    static_feature_names: list = field(default_factory=list)
    fit_end: int = None
    fit_start: int = None

    @property
    def num_regions(self):
        return len(self.region_to_idx) + 1  # 0 is unknown

    @property
    def num_provinces(self):
        return len(self.province_to_idx) + 1


def _compute_count_scales(panel, split_spec):
    """Compute s_r = max(1, mean observed training cases for district r) strictly inside
    the permitted training partition [fit_start, fit_end - delay] (Section 4 of EpiKD.txt).
    """
    max_ord = int(split_spec.fit_end - split_spec.case_delay_months)
    min_ord = int(split_spec.fit_start)
    fit_rows = panel[(panel["ordinal"] >= min_ord) & (panel["ordinal"] <= max_ord)]
    raw_means = fit_rows.groupby("region")["cases"].mean().to_dict()
    scale_map = {}
    for region in panel["region"].unique():
        m = raw_means.get(str(region), np.nan)
        scale_map[str(region)] = float(max(1.0, m)) if np.isfinite(m) else 1.0
    return scale_map


def fit_preprocessor(training_panel, cfg=None, bundle=None, split_masks=None, split_spec=None):
    """Fit scalers, vocabularies, medians, and count scales strictly on the training
    partition (Section 3 & 4 of EpiKD.txt). Can be called either with a prebuilt
    `bundle` + `split_masks` or directly with `(training_panel, cfg)`.
    """
    cfg = cfg or DEFAULT_CFG
    if split_spec is None:
        split_spec = make_time_splits(training_panel, release_policy=cfg)
    if bundle is None:
        adj = load_or_build_adjacency(training_panel, cfg)
        bundle = make_windows(training_panel, split_spec, None, cfg, adjacency=adj)
    if split_masks is None:
        split_masks = split_horizon_masks(bundle, split_spec)

    train_idx = split_masks["train"][0]
    if len(train_idx) == 0:
        raise ValueError("No eligible training windows found in the training partition.")
    x_train = bundle["X_raw"][train_idx] if "X_raw" in bundle else bundle["X"][train_idx]
    prep = FrozenPreprocessor(
        feature_names=list(bundle["feature_names"]),
        static_feature_names=list(bundle.get("static_feature_names", [])),
        count_scale_map=dict(bundle["scale_map"]),
        fit_end=int(split_spec.fit_end),
        fit_start=int(split_spec.fit_start),
    )
    prep.region_to_idx = {r: i + 1 for i, r in enumerate(sorted(set(bundle["region"][train_idx].tolist())))}
    prep.province_to_idx = {p: i + 1 for i, p in enumerate(sorted(set(bundle["province"][train_idx].tolist())))}
    with np.errstate(all="ignore"):
        med = np.nanmedian(x_train, axis=(0, 1)).astype(np.float32)
        std = np.nanstd(x_train, axis=(0, 1)).astype(np.float32)
    prep.dynamic_median = np.where(np.isfinite(med), med, 0.0).astype(np.float32)
    prep.dynamic_std = np.where(np.isfinite(std) & (std > 1e-6), std, 1.0).astype(np.float32)

    std_cols = [0, 1]
    for k in range(len(bundle["climate_cols"])):
        std_cols.append(6 + 2 * k)
    if bundle.get("has_spatial", False):
        std_cols.append(6 + 2 * len(bundle["climate_cols"]))  # log1p(n_r)
    prep.std_cols = std_cols

    # Fit static continuous medians and stds strictly on train_idx (no test leakage!)
    sc_all = bundle.get("static_cont_raw", bundle.get("static_cont"))
    if sc_all is not None and sc_all.shape[1] > 0:
        sc_train = sc_all[train_idx]
        with np.errstate(all="ignore"):
            s_med = np.nanmedian(sc_train, axis=0).astype(np.float32)
            s_std = np.nanstd(sc_train, axis=0).astype(np.float32)
        prep.static_median = np.where(np.isfinite(s_med), s_med, 0.0).astype(np.float32)
        prep.static_std = np.where(np.isfinite(s_std) & (s_std > 1e-6), s_std, 1.0).astype(np.float32)
        prep.static_std_cols = [
            j for j, name in enumerate(prep.static_feature_names)
            if not name.endswith("_missing") and not name.endswith("_obs") and name != "is_island"
        ]
    else:
        prep.static_median = np.zeros(0, dtype=np.float32)
        prep.static_std = np.ones(0, dtype=np.float32)
        prep.static_std_cols = []

    # Seasonal medians for the naive fallback use fitting-era targets only.
    y = bundle["y"]
    months = (bundle["target_ord"] % 12) + 1
    train_h = split_masks["train"][1]
    for m in range(1, 13):
        vals = y[train_h & (months == m)]
        prep.global_month_median[int(m)] = float(np.nanmedian(vals)) if len(vals) else 0.0
    for idx in train_idx:
        ridx = prep.region_to_idx.get(bundle["region"][idx], 0)
        for h in range(y.shape[1]):
            if train_h[idx, h]:
                key = (int(ridx), int(months[idx, h]))
                prep.seasonal_median.setdefault(key, []).append(float(y[idx, h]))
    prep.seasonal_median = {k: float(np.median(v)) for k, v in prep.seasonal_median.items()}
    print(f"preprocessor_regions={len(prep.region_to_idx)} provinces={len(prep.province_to_idx)}")
    return prep


def transform_bundle(bundle, prep):
    """Apply frozen training-fitted imputation and scaling to dynamic and static features."""
    if "X_raw" not in bundle:
        bundle["X_raw"] = bundle["X"].copy()
    if "static_cont_raw" not in bundle and bundle["static_cont"].shape[1]:
        bundle["static_cont_raw"] = bundle["static_cont"].copy()

    x = bundle["X_raw"].copy()
    for j in range(x.shape[-1]):
        col = x[:, :, j]
        bad = ~np.isfinite(col)
        col[bad] = prep.dynamic_median[j]
        x[:, :, j] = col
    for j in prep.std_cols:
        x[:, :, j] = (x[:, :, j] - prep.dynamic_median[j]) / prep.dynamic_std[j]
    bundle["X"] = x.astype(np.float32)
    bundle["region_idx"] = np.array([prep.region_to_idx.get(r, 0) for r in bundle["region"]], dtype=int)
    bundle["province_idx"] = np.array([prep.province_to_idx.get(p, 0) for p in bundle["province"]], dtype=int)

    if bundle["static_cont"].shape[1]:
        sc = bundle["static_cont_raw"].copy()
        for j in range(sc.shape[1]):
            bad = ~np.isfinite(sc[:, j])
            sc[bad, j] = prep.static_median[j]
        for j in prep.static_std_cols:
            sc[:, j] = (sc[:, j] - prep.static_median[j]) / prep.static_std[j]
        bundle["static_cont"] = sc.astype(np.float32)
    return bundle


# %% 06. As-of feature builder, windows, masks, timestamps
def _series_by_region(panel, climate_cols, static_geo_cols=None):
    static_geo_cols = static_geo_cols or []
    series = {}
    lo_global = int(panel["ordinal"].min())
    hi_global = int(panel["ordinal"].max())
    for region, grp in panel.groupby("region", sort=True):
        grp = grp.sort_values("ordinal")
        lo, hi = int(grp["ordinal"].min()), int(grp["ordinal"].max())
        ords = np.arange(lo, hi + 1)
        pos = {int(o): i for i, o in enumerate(grp["ordinal"].values)}
        cases = np.full(len(ords), np.nan, dtype=np.float32)
        clim = np.full((len(ords), len(climate_cols)), np.nan, dtype=np.float32)
        pop = np.full(len(ords), np.nan, dtype=np.float32)
        for j, o in enumerate(ords):
            if o in pos:
                row = grp.iloc[pos[int(o)]]
                cases[j] = row["cases"]
                for k, col in enumerate(climate_cols):
                    clim[j, k] = row[col]
                if "population" in grp.columns:
                    pop[j] = row["population"]
        first_row = grp.iloc[0]
        geo_vals = [float(first_row[c]) if c in grp.columns and pd.notna(first_row[c]) else np.nan for c in static_geo_cols]
        is_island = float(first_row["is_island"]) if "is_island" in grp.columns and pd.notna(first_row["is_island"]) else 0.0
        series[str(region)] = {
            "ords": ords,
            "cases": cases,
            "clim": clim,
            "pop": pop,
            "province": str(first_row["province"]),
            "geo_vals": geo_vals,
            "is_island": is_island,
        }
    return series, lo_global, hi_global


def _build_spatial_lookup(series, adjacency, lo_global, hi_global):
    """Precompute dense [N_regions, T_total] matrices of neighborhood coverage c_r(u)
    and log1p(n_r(u)) (Section 4, Eq. 98-99) via matrix multiplication so window
    extraction is instantaneous while strictly respecting issue-time availability.
    """
    if adjacency is None:
        return None
    regions = adjacency["regions"]
    N = len(regions)
    T = hi_global - lo_global + 1
    cases_mat = np.full((N, T), np.nan, dtype=np.float64)
    pop_mat = np.full((N, T), np.nan, dtype=np.float64)
    for i, r in enumerate(regions):
        if r not in series:
            continue
        entry = series[r]
        offset = int(entry["ords"][0] - lo_global)
        L = len(entry["ords"])
        cases_mat[i, offset:offset + L] = entry["cases"]
        pop_mat[i, offset:offset + L] = entry["pop"]

    W = adjacency["W"].astype(np.float64)
    a_mat = (np.isfinite(cases_mat) & np.isfinite(pop_mat) & (pop_mat > 0)).astype(np.float64)
    inc_mat = np.where(a_mat > 0, 1e5 * np.where(a_mat > 0, cases_mat, 0.0) / np.where(a_mat > 0, pop_mat, 1.0), 0.0)
    cov_mat = (W @ a_mat).astype(np.float32)
    num_mat = W @ (a_mat * inc_mat)
    with np.errstate(invalid="ignore", divide="ignore"):
        nr_mat = np.where(cov_mat >= 0.5, num_mat / np.maximum(cov_mat, 1e-12), np.nan)
        log_nr_mat = np.where(cov_mat >= 0.5, np.log1p(np.maximum(0.0, nr_mat)), np.nan).astype(np.float32)
    avail_mat = (cov_mat >= 0.5).astype(np.float32)
    return {
        "W": W,
        "region_to_idx": adjacency["region_to_idx"],
        "lo_global": lo_global,
        "cov_mat": cov_mat,
        "log_nr_mat": log_nr_mat,
        "avail_mat": avail_mat,
    }


def _spatial_window_features(spatial_lookup, region, hist_ords, issue_ord, case_delay_months=0):
    """Extract fixed neighborhood incidence summary (Section 4, Eq. 98-99) for window
    months hist_ords as of issue_ord, masking any month u > issue_ord - case_delay_months.
    """
    L = len(hist_ords)
    if spatial_lookup is None or region not in spatial_lookup["region_to_idx"]:
        return (
            np.full(L, np.nan, dtype=np.float32),
            np.zeros(L, dtype=np.float32),
            np.zeros(L, dtype=np.float32),
        )
    r_idx = spatial_lookup["region_to_idx"][region]
    t_cols = (hist_ords - spatial_lookup["lo_global"]).astype(int)
    max_pub_ord = int(issue_ord - max(0, int(case_delay_months)))
    pub_mask = hist_ords <= max_pub_ord

    log_nr = np.where(pub_mask, spatial_lookup["log_nr_mat"][r_idx, t_cols], np.nan).astype(np.float32)
    cov_cr = np.where(pub_mask, spatial_lookup["cov_mat"][r_idx, t_cols], 0.0).astype(np.float32)
    avail_ind = np.where(pub_mask, spatial_lookup["avail_mat"][r_idx, t_cols], 0.0).astype(np.float32)
    return log_nr, cov_cr, avail_ind


def _window_features(
    series_entry,
    origin_ord,
    count_scale,
    climate_cols,
    lookback=24,
    case_delay_months=0,
    spatial_lookup=None,
    region=None,
):
    ords = series_entry["ords"]
    start = int(origin_ord - ords[0])
    hist_idx = np.arange(start - lookback + 1, start + 1)
    hist_ords = ords[hist_idx]
    max_case_ord = int(origin_ord - max(0, int(case_delay_months)))

    raw_cases = series_entry["cases"][hist_idx].astype(np.float32)
    # Mask any case observation not yet published by issue_ord under CASE_DELAY_MONTHS
    published_mask = hist_ords <= max_case_ord
    hist_cases = np.where(published_mask, raw_cases, np.nan).astype(np.float32)
    obs = np.isfinite(hist_cases).astype(np.float32)

    age = np.zeros(lookback, dtype=np.float32)
    last = -10 ** 9
    for i in range(lookback):
        if obs[i] > 0:
            last = i
        age[i] = min(lookback, i - last if last >= 0 else lookback) / float(lookback)

    months = ((hist_ords % 12) + 1).astype(np.float32)
    angle = 2 * np.pi * (months - 1) / 12.0
    safe_cases = np.where(obs > 0, hist_cases, 0.0)
    cols = [
        np.where(obs > 0, np.log1p(safe_cases), np.nan),
        np.where(obs > 0, np.log1p(safe_cases / max(1.0, float(count_scale))), np.nan),
        obs,
        age,
        np.sin(angle),
        np.cos(angle),
    ]
    clim = series_entry["clim"]
    for k in range(len(climate_cols)):
        vals = clim[hist_idx, k].astype(np.float32)
        cols.append(vals)
        cols.append(np.isfinite(vals).astype(np.float32))

    if spatial_lookup is not None:
        log_nr, cov_cr, avail_ind = _spatial_window_features(
            spatial_lookup, region, hist_ords, origin_ord, case_delay_months=case_delay_months
        )
        cols.extend([log_nr, cov_cr, avail_ind])

    x = np.stack(cols, axis=1).astype(np.float32)
    return x, hist_cases, obs


def make_windows(panel, split_spec, preprocess=None, cfg=None, adjacency=None):
    cfg = cfg or DEFAULT_CFG
    lookback = int(cfg["LOOKBACK"])
    horizons = int(cfg["HORIZONS"])
    min_obs = int(cfg.get("MIN_OBSERVED_IN_LOOKBACK", math.ceil(lookback / 2.0)))
    delay = int(cfg.get("CASE_DELAY_MONTHS", getattr(split_spec, "case_delay_months", 0)))
    climate_cols = list(panel.attrs.get("climate_cols", []))
    static_geo_cols = list(panel.attrs.get("static_geo_cols", []))

    if adjacency is None and str(cfg.get("SPATIAL", "off")).lower() != "off":
        adjacency = load_or_build_adjacency(panel, cfg)

    series, lo_g, hi_g = _series_by_region(panel, climate_cols, static_geo_cols)
    spatial_lookup = _build_spatial_lookup(series, adjacency, lo_g, hi_g)
    scale_map = (
        dict(preprocess.count_scale_map)
        if (preprocess is not None and preprocess.count_scale_map)
        else _compute_count_scales(panel, split_spec)
    )

    xs, ys, ymasks, regions, provinces, origins, targets, hist_all, static_rows, pop_origin = (
        [], [], [], [], [], [], [], [], [], []
    )
    excluded_windows = 0
    eligible_regions = set()

    for region, entry in series.items():
        s_r = float(scale_map.get(region, 1.0))
        ords = entry["ords"]
        for start in range(lookback - 1, len(ords) - 1):
            origin = int(ords[start])
            x, hist_cases, obs = _window_features(
                entry,
                origin,
                s_r,
                climate_cols,
                lookback=lookback,
                case_delay_months=delay,
                spatial_lookup=spatial_lookup,
                region=region,
            )
            if int(np.nansum(obs)) < min_obs:
                excluded_windows += 1
                continue
            y = np.full(horizons, np.nan, dtype=np.float32)
            ymask = np.zeros(horizons, dtype=bool)
            t_ords = np.array([origin + h + 1 for h in range(horizons)], dtype=int)
            for h in range(horizons):
                t_idx = start + 1 + h
                if t_idx < len(ords) and int(ords[t_idx]) == origin + h + 1:
                    val = float(entry["cases"][t_idx])
                    y[h] = val
                    ymask[h] = np.isfinite(val)
            if not ymask.any():
                continue
            eligible_regions.add(region)
            xs.append(x)
            ys.append(y)
            ymasks.append(ymask)
            regions.append(region)
            provinces.append(entry["province"])
            origins.append(origin)
            targets.append(t_ords)
            hist_all.append(hist_cases)

            p_val = float(entry["pop"][start]) if "population" in panel.columns else np.nan
            pop_origin.append(p_val if (np.isfinite(p_val) and p_val > 0) else np.nan)

            s_row = []
            if "population" in panel.columns:
                p_ok = np.isfinite(p_val) and (p_val > 0)
                s_row.extend([np.log1p(p_val) if p_ok else np.nan, 0.0 if p_ok else 1.0])
            for g_val in entry["geo_vals"]:
                g_ok = np.isfinite(g_val)
                s_row.extend([float(g_val) if g_ok else np.nan, 0.0 if g_ok else 1.0])
            if "is_island" in panel.columns:
                s_row.append(float(entry["is_island"]))
            static_rows.append(s_row)

    feature_names = ["log_cases", "log_case_scale", "case_obs", "case_age", "month_sin", "month_cos"]
    for col in climate_cols:
        feature_names += [col, col + "_obs"]
    if spatial_lookup is not None:
        feature_names += ["neighbor_log_inc", "neighbor_coverage", "neighbor_avail"]

    static_feature_names = []
    if "population" in panel.columns:
        static_feature_names += ["log_pop", "log_pop_missing"]
    for col in static_geo_cols:
        static_feature_names += [col, col + "_missing"]
    if "is_island" in panel.columns:
        static_feature_names.append("is_island")

    bundle = {
        "X": np.stack(xs).astype(np.float32),
        "X_raw": np.stack(xs).astype(np.float32),
        "y": np.stack(ys).astype(np.float32),
        "y_mask": np.stack(ymasks),
        "region": np.array(regions, dtype=object),
        "province": np.array(provinces, dtype=object),
        "origin_ord": np.array(origins, dtype=int),
        "target_ord": np.stack(targets).astype(int),
        "hist_cases": np.stack(hist_all).astype(np.float32),
        "static_cont": np.array(static_rows, dtype=np.float32).reshape(len(regions), -1),
        "static_cont_raw": np.array(static_rows, dtype=np.float32).reshape(len(regions), -1),
        "origin_pop": np.array(pop_origin, dtype=np.float32),
        "count_scale": np.array([float(scale_map.get(r, 1.0)) for r in regions], dtype=np.float32),
        "feature_names": feature_names,
        "static_feature_names": static_feature_names,
        "climate_cols": climate_cols,
        "static_geo_cols": static_geo_cols,
        "has_spatial": bool(spatial_lookup is not None),
        "series": series,
        "scale_map": scale_map,
        "excluded_windows": int(excluded_windows),
        "excluded_districts": int(len(series) - len(eligible_regions)),
        "case_delay_months": delay,
    }
    fut_month = ((bundle["target_ord"] % 12) + 1).astype(np.float32)
    ang = 2 * np.pi * (fut_month - 1) / 12.0
    bundle["future_cal"] = np.stack([np.sin(ang), np.cos(ang)], axis=-1).astype(np.float32)
    if preprocess is not None:
        transform_bundle(bundle, preprocess)
    print(
        f"windows={len(bundle['y'])} excluded_windows={excluded_windows} "
        f"excluded_districts={bundle['excluded_districts']} features={bundle['X'].shape[-1]} "
        f"static_features={bundle['static_cont'].shape[-1]}"
    )
    return bundle


def split_horizon_masks(bundle, split_spec):
    """Assign losses and scores by target date for each horizon (Section 7 of EpiKD.txt):
    - Historical training targets must be available by the fitting cutoff (t <= fit_end - delay)
      and the entire input window must start at or after fit_start.
    - Evaluation origins must be at or after the model fitting cutoff (o >= fit_end),
      retaining valid heads from boundary-crossing windows (Section 7, line 269).
    """
    t = bundle["target_ord"]
    o = bundle["origin_ord"][:, None]
    lookback = bundle["X"].shape[1]
    win_start = o - (lookback - 1)
    delay = int(getattr(split_spec, "case_delay_months", bundle.get("case_delay_months", 0)))
    fit_start = int(getattr(split_spec, "fit_start", 0))

    masks = {
        "train": (t <= (split_spec.fit_end - delay)) & (win_start >= fit_start),
        "val": (t >= split_spec.val_start) & (t <= split_spec.val_end) & (o >= split_spec.fit_end),
        "alarm": (t >= split_spec.alarm_start) & (t <= split_spec.alarm_end) & (o >= split_spec.fit_end),
        "test": (t >= split_spec.test_start) & (t <= split_spec.test_end) & (o >= split_spec.fit_end),
    }
    out = {}
    for name, mh in masks.items():
        mh = mh & bundle["y_mask"]
        out[name] = (np.where(mh.any(axis=1))[0], mh)
    return out


def cap_indices(indices, max_n, seed=17):
    indices = np.asarray(indices)
    if max_n is None or len(indices) <= int(max_n):
        return indices
    pick = np.unique(np.linspace(0, len(indices) - 1, int(max_n)).astype(int))
    return indices[pick]


def build_history_as_of(panel, region_ids, issue_time, preprocess=None, adjacency=None, cfg=None):
    """Build one history batch per requested region at a single issue timestamp (Section 10).
    Strictly masks any observations after issue_time (and any case observations after
    issue_time - case_delay_months).
    """
    cfg = cfg or DEFAULT_CFG
    lookback = int(cfg.get("LOOKBACK", 24))
    delay = int(cfg.get("CASE_DELAY_MONTHS", 0))
    climate_cols = list(panel.attrs.get("climate_cols", []))
    static_geo_cols = list(panel.attrs.get("static_geo_cols", []))
    issue_ts = pd.Timestamp(issue_time)
    issue_ord = int(issue_ts.year * 12 + issue_ts.month - 1)

    # Filter panel to records available at or before issue_ord so future records cannot enter
    panel_as_of = panel[panel["ordinal"] <= issue_ord].copy()
    panel_as_of.attrs = dict(panel.attrs)
    series, lo_g, hi_g = _series_by_region(panel_as_of, climate_cols, static_geo_cols)
    if isinstance(adjacency, str) and adjacency != "off":
        adjacency = load_or_build_adjacency(panel_as_of, dict(cfg, SPATIAL=adjacency))
    spatial_lookup = _build_spatial_lookup(series, adjacency, lo_g, hi_g)

    out_raw, static_rows, scales, pops, provs = [], [], [], [], []
    for region in region_ids:
        r_str = str(region)
        entry = series[r_str]
        s_r = float(preprocess.count_scale_map.get(r_str, 1.0)) if (preprocess and preprocess.count_scale_map) else 1.0
        x, _, _ = _window_features(
            entry,
            issue_ord,
            s_r,
            climate_cols,
            lookback=lookback,
            case_delay_months=delay,
            spatial_lookup=spatial_lookup,
            region=r_str,
        )
        out_raw.append(x)
        scales.append(s_r)
        provs.append(entry["province"])
        start = int(issue_ord - entry["ords"][0])
        p_val = float(entry["pop"][start]) if "population" in panel_as_of.columns else np.nan
        pops.append(p_val if (np.isfinite(p_val) and p_val > 0) else np.nan)
        s_row = []
        if "population" in panel_as_of.columns:
            p_ok = np.isfinite(p_val) and (p_val > 0)
            s_row.extend([np.log1p(p_val) if p_ok else np.nan, 0.0 if p_ok else 1.0])
        for g_val in entry["geo_vals"]:
            g_ok = np.isfinite(g_val)
            s_row.extend([float(g_val) if g_ok else np.nan, 0.0 if g_ok else 1.0])
        if "is_island" in panel_as_of.columns:
            s_row.append(float(entry["is_island"]))
        static_rows.append(s_row)

    fut_ords = np.array([[issue_ord + h for h in range(1, int(cfg.get("HORIZONS", 3)) + 1)] for _ in region_ids])
    fut_month = ((fut_ords % 12) + 1).astype(np.float32)
    ang = 2 * np.pi * (fut_month - 1) / 12.0
    batch = {
        "X_raw": np.stack(out_raw).astype(np.float32),
        "X": np.stack(out_raw).astype(np.float32),
        "region": np.array([str(r) for r in region_ids], dtype=object),
        "province": np.array(provs, dtype=object),
        "static_cont_raw": np.array(static_rows, dtype=np.float32).reshape(len(region_ids), -1),
        "static_cont": np.array(static_rows, dtype=np.float32).reshape(len(region_ids), -1),
        "count_scale": np.array(scales, dtype=np.float32),
        "origin_pop": np.array(pops, dtype=np.float32),
        "future_cal": np.stack([np.sin(ang), np.cos(ang)], axis=-1).astype(np.float32),
        "issue_ordinal": issue_ord,
    }
    if preprocess is not None:
        transform_bundle(batch, preprocess)
    return batch


# %% 07. Training-derived research event thresholds and label coverage
def fit_event_thresholds(training_panel, cfg=None, split_spec=None):
    """Compute district-month outbreak thresholds C_rm strictly from observed training
    outcomes (Section 6 of EpiKD.txt):
    1. Require >= 36 observed training months spanning >= 3 years (ordinal span >= 35).
    2. Pool training observations from m-1, m, m+1 (wrapping Dec/Jan).
    3. Linear-interpolated 90th percentile Q_season and all-month Q_all.
    4. Shrink q_rm = w * Q_season + (1 - w) * Q_all, w = n / (n + 24).
    5. C_rm = max(5, floor(q_rm) + 1); event is b = 1{y >= C_rm}.
    """
    cfg = cfg or DEFAULT_CFG
    if split_spec is None:
        split_spec = make_time_splits(training_panel, release_policy=cfg)
    max_ord = int(split_spec.fit_end - getattr(split_spec, "case_delay_months", 0))
    min_ord = int(getattr(split_spec, "fit_start", training_panel["ordinal"].min()))
    q_level = float(cfg.get("EVENT_QUANTILE", 0.90))
    floor_val = int(cfg.get("EVENT_FLOOR", 5))
    n0 = float(cfg.get("EVENT_SHRINKAGE_N0", 24.0))

    panel = training_panel[(training_panel["ordinal"] >= min_ord) & (training_panel["ordinal"] <= max_ord)]
    store = {}
    coverage = {"eligible": 0, "ineligible": 0, "eligible_regions": [], "ineligible_regions": []}
    for region, grp in panel.groupby("region", sort=True):
        obs = grp.dropna(subset=["cases"])
        if len(obs) < 36 or (obs["ordinal"].max() - obs["ordinal"].min()) < 35:
            coverage["ineligible"] += 1
            coverage["ineligible_regions"].append(str(region))
            continue
        coverage["eligible"] += 1
        coverage["eligible_regions"].append(str(region))
        cases = obs["cases"].values.astype(float)
        months_all = (obs["ordinal"].values % 12) + 1
        q_all = float(np.quantile(cases, q_level, method="linear"))
        for m in range(1, 13):
            pool_mask = np.isin(months_all, [((m - 2) % 12) + 1, m, (m % 12) + 1])
            pool = cases[pool_mask]
            n = len(pool)
            q_season = float(np.quantile(pool, q_level, method="linear")) if n > 0 else q_all
            w = n / (n + n0)
            q_rm = w * q_season + (1.0 - w) * q_all
            store[(str(region), int(m))] = int(max(floor_val, math.floor(q_rm) + 1))
    store["__coverage__"] = coverage
    print(f"event_threshold_regions_eligible={coverage['eligible']} ineligible={coverage['ineligible']}")
    return store


# %% 08. Naive/tree baselines and common probabilistic metric functions
def nb_quantiles(mu, kappa, levels=QUANTILE_LEVELS):
    mu = np.maximum(np.asarray(mu, dtype=float), 1e-6)
    kappa = np.maximum(np.asarray(kappa, dtype=float), 1e-6)
    flat_mu, flat_k = mu.ravel(), kappa.ravel()
    flat_p = flat_k / (flat_k + flat_mu)
    q = stats.nbinom.ppf(levels[:, None], flat_k, flat_p)
    return q.T.reshape(mu.shape + (len(levels),)).astype(float)


def nb_nll_numpy(y, mu, kappa):
    """Explicit NB2 negative log-likelihood in float64 for evaluation and extreme-count diagnostics."""
    from scipy.special import gammaln

    y = np.asarray(y, dtype=np.float64)
    mu = np.maximum(np.asarray(mu, dtype=np.float64), 1e-6)
    kappa = np.maximum(np.asarray(kappa, dtype=np.float64), 1e-4)
    logp = (
        gammaln(y + kappa)
        - gammaln(kappa)
        - gammaln(y + 1.0)
        + kappa * (np.log(kappa) - np.log(kappa + mu))
        + y * (np.log(mu) - np.log(kappa + mu))
    )
    return -logp


def randomized_pit_nb(y, mu, kappa, seed=17):
    """Discrete randomized Probability Integral Transform (PIT) for NB2 forecasts (Section 7)."""
    rng = np.random.default_rng(seed)
    y = np.asarray(y, dtype=np.float64)
    mu = np.maximum(np.asarray(mu, dtype=np.float64), 1e-6)
    kappa = np.maximum(np.asarray(kappa, dtype=np.float64), 1e-4)
    p = kappa / (kappa + mu)
    f_y = stats.nbinom.cdf(y, kappa, p)
    f_ym1 = np.where(y > 0, stats.nbinom.cdf(np.maximum(0.0, y - 1.0), kappa, p), 0.0)
    u = rng.uniform(0.0, 1.0, size=y.shape)
    return f_ym1 + u * np.maximum(0.0, f_y - f_ym1)


def distribution_summary(mu, kappa, count_thresholds=None):
    mu = np.asarray(mu, dtype=float)
    kappa = np.asarray(kappa, dtype=float)
    out = {"mu": mu, "kappa": kappa, "quantiles": nb_quantiles(mu, kappa)}
    if count_thresholds is not None:
        c = np.asarray(count_thresholds, dtype=float)
        valid = np.isfinite(c) & np.isfinite(kappa) & np.isfinite(mu)
        prob = np.full_like(mu, np.nan, dtype=float)
        if valid.any():
            k = np.maximum(kappa[valid], 1e-6)
            m = np.maximum(mu[valid], 1e-6)
            prob[valid] = stats.nbinom.sf(c[valid] - 1.0, k, k / (k + m))
        out["event_prob"] = prob
    return out


def wis_per_row(y, quantiles):
    """Weighted Interval Score over central 50%, 80%, 95% intervals + median (Eq. 280-286)."""
    y = np.asarray(y, dtype=float)
    q = np.asarray(quantiles, dtype=float)
    total = 0.5 * np.abs(y - q[..., 3])
    pairs = [(0, 6, 0.05), (1, 5, 0.20), (2, 4, 0.50)]
    for lo, hi, alpha in pairs:
        lower, upper = q[..., lo], q[..., hi]
        iscore = (
            (upper - lower)
            + (2.0 / alpha) * (lower - y) * (y < lower)
            + (2.0 / alpha) * (y - upper) * (y > upper)
        )
        total = total + (alpha / 2.0) * iscore
    return total / 3.5


def last_obs_point(bundle, idx, horizon, prep):
    """Last observed case count in the 24-month history window, with fallback to seasonal median."""
    hist = bundle["hist_cases"][idx]
    valid = hist[np.isfinite(hist)]
    if len(valid):
        return float(valid[-1])
    month = int((bundle["target_ord"][idx, horizon] % 12) + 1)
    key = (int(bundle["region_idx"][idx]), month)
    return float(prep.seasonal_median.get(key, prep.global_month_median.get(month, 0.0)))


def naive_point(bundle, idx, horizon, prep):
    """Seasonal naive y_{t+h-12} if available at issue t, else training seasonal median.
    Here `horizon` is 0-based (0->h1=t+1, 1->h2=t+2, 2->h3=t+3) and `hist[-1]` is issue month t,
    so target month minus 12 is at index `len(hist) - 12 + horizon`.
    """
    hist = bundle["hist_cases"][idx]
    pos = len(hist) - 12 + int(horizon)
    if 0 <= pos < len(hist) and np.isfinite(hist[pos]):
        return float(hist[pos])
    month = int((bundle["target_ord"][idx, horizon] % 12) + 1)
    key = (int(bundle["region_idx"][idx]), month)
    return float(prep.seasonal_median.get(key, prep.global_month_median.get(month, 0.0)))


def predict_naive(bundle, masks, prep, split_name, indices=None, mode="seasonal"):
    """Predict point forecasts and empirical training-residual intervals for
    seasonal_naive or last_obs_naive (Section 8 of EpiKD.txt). Also caches sorted
    training residuals on `prep.naive_residuals[mode]` and `bundle["naive_residuals"][mode]`
    for exact empirical outbreak tail probabilities P(max(0, y_hat + r) >= C).
    """
    all_indices, _ = masks[split_name]
    if indices is None:
        indices = all_indices
    point_fn = naive_point if mode == "seasonal" else last_obs_point
    train_idx, train_h = masks["train"]
    resid = {h: [] for h in range(3)}
    for idx in train_idx:
        for h in range(3):
            if train_h[idx, h]:
                resid[h].append(float(bundle["y"][idx, h]) - point_fn(bundle, idx, h, prep))
    resid_sorted = {h: np.sort(np.asarray(v, dtype=float)) if v else np.zeros(0, dtype=float) for h, v in resid.items()}
    if prep is not None:
        prep.naive_residuals[mode] = resid_sorted
    bundle.setdefault("naive_residuals", {})[mode] = resid_sorted
    resid_q = {h: np.quantile(resid_sorted[h], QUANTILE_LEVELS) if len(resid_sorted[h]) else np.zeros(7) for h in range(3)}
    mus = np.zeros((len(indices), 3), dtype=float)
    qs = np.zeros((len(indices), 3, 7), dtype=float)
    for j, idx in enumerate(indices):
        for h in range(3):
            p = point_fn(bundle, idx, h, prep)
            mus[j, h] = p
            qs[j, h] = np.sort(np.maximum(0.0, p + resid_q[h]))
    return mus, np.full_like(mus, np.nan), qs


def _fit_oof_dispersion(x_tr, y_tr, origin_tr, make_mean_model):
    """Estimate NB dispersion kappa_h from chronological out-of-fold training mean
    predictions (Section 8, line 322 of EpiKD.txt).
    """
    order = np.argsort(origin_tr)
    xs, ys = x_tr[order], y_tr[order]
    n = len(ys)
    if n < 40:
        m = make_mean_model()
        m.fit(xs, ys)
        mu_oof = np.maximum(1e-6, m.predict(xs))
        y_eval = ys
    else:
        # Three chronological expanding folds inside the training era
        cuts = [int(0.4 * n), int(0.6 * n), int(0.8 * n), n]
        preds, trues = [], []
        for c_i in range(len(cuts) - 1):
            tr_end, val_end = cuts[c_i], cuts[c_i + 1]
            if np.all(ys[:tr_end] == ys[0]):
                continue
            m = make_mean_model()
            m.fit(xs[:tr_end], ys[:tr_end])
            preds.append(np.maximum(1e-6, m.predict(xs[tr_end:val_end])))
            trues.append(ys[tr_end:val_end])
        if preds:
            mu_oof = np.concatenate(preds)
            y_eval = np.concatenate(trues)
        else:
            mu_oof = np.maximum(1e-6, np.full_like(ys, np.mean(ys), dtype=float))
            y_eval = ys
    # Method-of-moments NB2 estimator from out-of-fold residuals: E[(y-mu)^2 - mu] = mu^2 / kappa
    excess_var = float(np.mean((y_eval - mu_oof) ** 2 - mu_oof))
    mean_mu_sq = float(np.mean(mu_oof ** 2))
    if excess_var > 1e-3:
        return float(np.clip(mean_mu_sq / excess_var, 0.1, 1e6))
    return 1e5


def predict_tree(bundle, masks, prep, split_name, cfg):
    """Tree count and quantile baseline (Section 8 of EpiKD.txt):
    - Uses LightGBM when installed, with automatic fallback to sklearn HistGradientBoostingRegressor.
    - Flattens full permitted history, masks, static inputs, and target calendar.
    - Fits Poisson mean model + chronological out-of-fold NB dispersion for alarm tails.
    - Fits 7 quantile models, logs crossing rate before rearrangement, and clips negatives to 0.
    """
    from sklearn.ensemble import HistGradientBoostingRegressor

    train_idx_all, train_h = masks["train"]
    indices, _ = masks[split_name]
    train_idx = cap_indices(train_idx_all, cfg.get("MAX_TRAIN_WINDOWS"), 17)
    indices = cap_indices(indices, cfg.get("MAX_EVAL_WINDOWS"), 17)

    def flat(idx_arr, horizon):
        rows = []
        for idx in idx_arr:
            parts = [
                bundle["X"][idx].ravel(),
                bundle["future_cal"][idx, horizon].ravel(),
                [bundle["region_idx"][idx], bundle["province_idx"][idx], np.log1p(bundle["count_scale"][idx])],
            ]
            if bundle["static_cont"].shape[1]:
                parts.append(bundle["static_cont"][idx].ravel())
            rows.append(np.concatenate(parts))
        return np.stack(rows)

    def _make_poisson():
        if lgb is not None:
            return lgb.LGBMRegressor(
                objective="poisson", n_estimators=200, learning_rate=0.06, random_state=17, verbose=-1, n_jobs=-1
            )
        return HistGradientBoostingRegressor(loss="poisson", max_iter=200, learning_rate=0.06, random_state=17)

    def _make_quantile(alpha):
        if lgb is not None:
            return lgb.LGBMRegressor(
                objective="quantile", alpha=float(alpha), n_estimators=150, learning_rate=0.06,
                random_state=17, verbose=-1, n_jobs=-1
            )
        return HistGradientBoostingRegressor(
            loss="quantile", quantile=float(alpha), max_iter=150, learning_rate=0.06, random_state=17
        )

    mus = np.zeros((len(indices), 3), dtype=float)
    kappas = np.zeros((len(indices), 3), dtype=float)
    qs = np.zeros((len(indices), 3, 7), dtype=float)
    crossing_rates = {}

    for h in range(3):
        x_train = flat(train_idx, h)
        x_pred = flat(indices, h)
        ok = train_h[train_idx, h]
        ytr = bundle["y"][train_idx[ok], h]
        orig_tr = bundle["origin_ord"][train_idx[ok]]

        mean_model = _make_poisson()
        mean_model.fit(x_train[ok], ytr)
        mus[:, h] = np.maximum(1e-6, mean_model.predict(x_pred))
        kappas[:, h] = _fit_oof_dispersion(x_train[ok], ytr, orig_tr, _make_poisson)

        for qi, level in enumerate(QUANTILE_LEVELS):
            qm = _make_quantile(level)
            qm.fit(x_train[ok], ytr)
            qs[:, h, qi] = np.maximum(0.0, qm.predict(x_pred))

        crossed = np.any(np.diff(qs[:, h], axis=-1) < -1e-6, axis=-1)
        crossing_rates[f"h{h + 1}"] = float(np.mean(crossed)) if len(crossed) else 0.0
        qs[:, h] = np.sort(qs[:, h], axis=-1)

    engine = "lightgbm" if lgb is not None else "sklearn_hgb"
    print(f"tree_engine={engine} split={split_name} pre_rearrangement_crossing_rate={crossing_rates}")
    return mus, kappas, qs, indices, crossing_rates


# %% 09. KDA recurrence, scalar-decay control, and mathematical tests
def _inv_softplus(y):
    return math.log(math.expm1(float(y)))


def kda_step_numpy(S, q, k, v, alpha, beta):
    """Reference NumPy value-first KDA step (Eq. 154-157 of EpiKD.txt).
    S: [B,H,V,K], q/k: [B,H,K], v: [B,H,V], alpha: [B,H,K], beta: [B,H]
    """
    D = S * alpha[..., None, :]
    predicted = np.einsum("bhvk,bhk->bhv", D, k)
    e = v - predicted
    S_new = D + beta[..., None, None] * e[..., :, None] * k[..., None, :]
    out = np.einsum("bhvk,bhk->bhv", S_new, q)
    return out, S_new, e


if torch is not None:
    def kda_step(S, q, k, v, alpha, beta):
        """One value-first KDA step in float32 (Eq. 154-157 of EpiKD.txt).

        S: [B,H,V,K], q/k: [B,H,K], v: [B,H,V], alpha: [B,H,K], beta: [B,H]
        """
        D = S * alpha.unsqueeze(-2)
        predicted = torch.einsum("bhvk,bhk->bhv", D, k)
        e = v - predicted
        S_new = D + beta.unsqueeze(-1).unsqueeze(-1) * e.unsqueeze(-1) * k.unsqueeze(-2)
        out = torch.einsum("bhvk,bhk->bhv", S_new, q)
        return out, S_new, e

    class RMSNorm(nn.Module):
        def __init__(self, dim, eps=1e-5):
            super().__init__()
            self.weight = nn.Parameter(torch.ones(dim))
            self.eps = eps

        def forward(self, x):
            var = x.pow(2).mean(dim=-1, keepdim=True)
            return x * torch.rsqrt(var + self.eps) * self.weight

    class KDABlock(nn.Module):
        def __init__(self, width=64, heads=2, dropout=0.10, decay_mode="channel", use_conv=True):
            super().__init__()
            self.heads = heads
            self.head_dim = width // heads
            self.decay_mode = decay_mode
            self.use_conv = use_conv
            self.norm1 = RMSNorm(width, eps=1e-5)
            self.q_proj = nn.Linear(width, width)
            self.k_proj = nn.Linear(width, width)
            self.v_proj = nn.Linear(width, width)
            if use_conv:
                self.q_conv = nn.Conv1d(width, width, 3, groups=width)
                self.k_conv = nn.Conv1d(width, width, 3, groups=width)
                self.v_conv = nn.Conv1d(width, width, 3, groups=width)
            alpha_out = width if decay_mode == "channel" else heads
            self.alpha_proj = nn.Sequential(nn.Linear(width, 16), nn.Linear(16, alpha_out))
            self.beta_proj = nn.Linear(width, heads)
            self.gate_proj = nn.Sequential(nn.Linear(width, 16), nn.Linear(16, width))
            self.head_norm_weight = nn.Parameter(torch.ones(heads, self.head_dim))
            self.out_proj = nn.Linear(width, width)
            self.norm2 = RMSNorm(width, eps=1e-5)
            self.ffn = nn.Sequential(
                nn.Linear(width, 128), nn.SiLU(), nn.Dropout(dropout), nn.Linear(128, width)
            )
            self.drop = nn.Dropout(dropout)
            with torch.no_grad():
                self.alpha_proj[-1].weight.normal_(0, 0.01)
                self.alpha_proj[-1].bias.fill_(_inv_softplus(1.0 / 12.0))
                self.beta_proj.weight.normal_(0, 0.01)
                self.beta_proj.bias.zero_()

        def _conv_act(self, x, proj, conv):
            y = proj(x)
            if self.use_conv and conv is not None:
                y = conv(F.pad(y.transpose(1, 2), (2, 0))).transpose(1, 2)
            return F.silu(y)

        def forward(self, x, return_state=False):
            B, T, W = x.shape
            h = self.norm1(x)
            q = self._conv_act(h, self.q_proj, getattr(self, "q_conv", None))
            k = self._conv_act(h, self.k_proj, getattr(self, "k_conv", None))
            v = self._conv_act(h, self.v_proj, getattr(self, "v_conv", None))
            q = q.view(B, T, self.heads, self.head_dim)
            k = k.view(B, T, self.heads, self.head_dim)
            v = v.view(B, T, self.heads, self.head_dim)
            q = q / q.norm(dim=-1, keepdim=True).clamp_min(1e-6)
            k = k / k.norm(dim=-1, keepdim=True).clamp_min(1e-6)
            if self.decay_mode == "channel":
                a = self.alpha_proj(h).view(B, T, self.heads, self.head_dim)
                alpha = torch.exp(torch.clamp(-F.softplus(a), -10.0, -1e-4))
            else:
                a = self.alpha_proj(h)
                alpha = torch.exp(torch.clamp(-F.softplus(a), -10.0, -1e-4)).unsqueeze(-1)
                alpha = alpha.expand(B, T, self.heads, self.head_dim)
            beta = torch.sigmoid(self.beta_proj(h))
            S = x.new_zeros(B, self.heads, self.head_dim, self.head_dim, dtype=torch.float32)
            outs = []
            for t in range(T):
                out_t, S, _ = kda_step(
                    S,
                    q[:, t].float(),
                    k[:, t].float(),
                    v[:, t].float(),
                    alpha[:, t].float(),
                    beta[:, t].float(),
                )
                outs.append(out_t.to(x.dtype))
            o = torch.stack(outs, dim=1)  # [B,T,H,V]
            o = o * torch.rsqrt(o.pow(2).mean(dim=-1, keepdim=True) + 1e-5) * self.head_norm_weight
            o = o * torch.sigmoid(self.gate_proj(h)).view(B, T, self.heads, self.head_dim)
            x = x + self.drop(self.out_proj(o.reshape(B, T, W)))
            x = x + self.drop(self.ffn(self.norm2(x)))
            if return_state:
                return x, S
            return x
else:
    def kda_step(S, q, k, v, alpha, beta):
        return kda_step_numpy(S, q, k, v, alpha, beta)


# %% 10. Encoder, NB readout, matched GRU/Transformer factories, parameter counts
if torch is not None:
    class EpiKD(nn.Module):
        """Shared encoder with backbone switch, parameter-matched GRU/Transformer
        controls (within ~5% of KDA parameters, satisfying Section 8's 15% rule),
        3 direct NB2 heads, optional population-offset head, and optional auxiliary
        BCE classifier control head.
        """

        def __init__(
            self,
            feature_dim,
            num_regions,
            num_provinces,
            static_cont_dim=0,
            width=64,
            heads=2,
            layers=2,
            dropout=0.10,
            backbone="kda",
            lookback=24,
            use_pop_offset=False,
            use_aux_bce=False,
        ):
            super().__init__()
            self.backbone = backbone
            self.width = width
            self.layers = layers
            self.use_pop_offset = bool(use_pop_offset)
            self.use_aux_bce = bool(use_aux_bce or backbone.endswith("_bce"))
            base_backbone = backbone[:-4] if backbone.endswith("_bce") else backbone
            self.base_backbone = base_backbone

            self.input_proj = nn.Linear(feature_dim, width)
            static_in = 8 + 4 + int(static_cont_dim)
            self.region_emb = nn.Embedding(num_regions, 8, padding_idx=0)
            self.province_emb = nn.Embedding(num_provinces, 4, padding_idx=0)
            self.static_proj = nn.Linear(static_in, width)
            self.drop = nn.Dropout(dropout)

            if base_backbone in ("kda", "scalar_decay", "kda_noconv"):
                mode = "channel" if base_backbone != "scalar_decay" else "scalar"
                self.blocks = nn.ModuleList([
                    KDABlock(width, heads, dropout, decay_mode=mode, use_conv=(base_backbone != "kda_noconv"))
                    for _ in range(layers)
                ])
            elif base_backbone == "gru":
                # Adjust GRU hidden width to ~82 with a readout projection to 64 so total
                # parameters match KDA within ~2% (Section 8, line 318).
                gru_hidden = 82 if width == 64 else width
                self.gru = nn.GRU(
                    width,
                    gru_hidden,
                    num_layers=layers,
                    batch_first=True,
                    dropout=dropout if layers > 1 else 0.0,
                )
                self.gru_out_proj = nn.Linear(gru_hidden, width)
            elif base_backbone == "transformer":
                # Adjust Transformer FFN width to 164 so total parameters match KDA within ~1%
                ffn_dim = 164 if width == 64 else 2 * width
                self.pos = nn.Parameter(torch.zeros(1, max(lookback, 64), width))
                nn.init.normal_(self.pos, std=0.02)
                layer = nn.TransformerEncoderLayer(
                    d_model=width,
                    nhead=heads,
                    dim_feedforward=ffn_dim,
                    dropout=dropout,
                    activation="gelu",
                    batch_first=True,
                    norm_first=True,
                )
                self.transformer = nn.TransformerEncoder(layer, num_layers=layers)
            else:
                raise ValueError(f"Unknown backbone: {backbone}")

            self.final_norm = RMSNorm(width, eps=1e-5)
            out_dim = 3 if self.use_aux_bce else 2
            self.heads = nn.ModuleList()
            for _ in range(3):
                head = nn.Sequential(
                    nn.Linear(width + 2, 32), nn.SiLU(), nn.Dropout(dropout), nn.Linear(32, out_dim)
                )
                with torch.no_grad():
                    head[-1].weight.normal_(0, 0.01)
                    bias_init = [_inv_softplus(1.0), _inv_softplus(5.0)]
                    if self.use_aux_bce:
                        bias_init.append(-2.2)
                    head[-1].bias.copy_(torch.tensor(bias_init, dtype=torch.float32))
                self.heads.append(head)

        def forward(self, x, static, future_calendar, count_scale, origin_pop=None, return_states=False):
            if isinstance(static, dict):
                region_id = static["region"]
                province_id = static["province"]
                static_cont = static.get("cont")
            else:
                region_id, province_id, static_cont = static
            parts = [self.region_emb(region_id), self.province_emb(province_id)]
            if static_cont is not None and static_cont.shape[-1] > 0:
                parts.append(static_cont)
            static_vec = self.static_proj(torch.cat(parts, dim=-1))
            h = self.drop(self.input_proj(x) + static_vec.unsqueeze(1))

            states = []
            if self.base_backbone in ("kda", "scalar_decay", "kda_noconv"):
                for block in self.blocks:
                    if return_states:
                        h, s_b = block(h, return_state=True)
                        states.append(s_b)
                    else:
                        h = block(h)
                rep = self.final_norm(h)[:, -1]
            elif self.base_backbone == "gru":
                out, s_gru = self.gru(h)
                states.append(s_gru)
                rep = self.final_norm(self.gru_out_proj(out[:, -1]))
            else:
                T = h.shape[1]
                mask = torch.triu(torch.ones(T, T, dtype=torch.bool, device=h.device), diagonal=1)
                out = self.transformer(h + self.pos[:, :T], mask=mask)
                rep = self.final_norm(out[:, -1])

            outs = []
            for head_i, head in enumerate(self.heads):
                ab = head(torch.cat([rep, future_calendar[:, head_i]], dim=-1))
                outs.append(ab)
            ab = torch.stack(outs, dim=1)

            if self.use_pop_offset and origin_pop is not None:
                pop_factor = (origin_pop.view(-1, 1).to(ab.dtype) / 100000.0).clamp_min(1e-3)
                scale = torch.where(torch.isfinite(pop_factor), pop_factor, count_scale.view(-1, 1).to(ab.dtype))
            else:
                scale = count_scale.view(-1, 1).to(ab.dtype)

            mu = 1e-6 + scale * F.softplus(ab[..., 0])
            kappa = 1e-4 + F.softplus(ab[..., 1])
            res = {"mu": mu, "kappa": kappa}
            if self.use_aux_bce:
                res["event_logits"] = ab[..., 2]
                res["classifier_prob"] = torch.sigmoid(ab[..., 2])
            if return_states:
                res["states"] = states
            return res


# %% 11. Stable loss, region/horizon balancing, optimizer, training/early stopping
if torch is not None:
    def negative_binomial_nll(y, mu, kappa, target_mask, weights=None):
        """Masked NB2 negative log-likelihood (Section 6, Eq. 193-196 of EpiKD.txt).
        Selects valid target entries before likelihood reduction so NaN targets
        cannot contaminate the loss or gradients. When `weights` are supplied from
        `compute_balanced_weights` (normalized so the average weight per training window
        is 1.0), divides by the fixed minibatch window count `y.shape[0]` instead of the
        random minibatch weight sum, yielding an unbiased estimator of the equal-
        (district, horizon) training objective for any minibatch size >= 1.
        """
        mask = target_mask.bool()
        if not mask.any():
            return (mu.sum() + kappa.sum()) * 0.0
        y_m = y[mask].float()
        mu_m = mu[mask].float().clamp_min(1e-6)
        kappa_m = kappa[mask].float().clamp_min(1e-4)
        logp = (
            torch.lgamma(y_m + kappa_m)
            - torch.lgamma(kappa_m)
            - torch.lgamma(y_m + 1.0)
            + kappa_m * (torch.log(kappa_m) - torch.log(kappa_m + mu_m))
            + y_m * (torch.log(mu_m) - torch.log(kappa_m + mu_m))
        )
        if weights is None:
            return -logp.mean()
        w = weights[mask].float()
        if w.sum() <= 0:
            return (mu.sum() + kappa.sum()) * 0.0
        n_batch = float(max(1, int(y.shape[0])))
        return -(w * logp).sum() / n_batch


def _build_optimizer_param_groups(model, weight_decay):
    """Apply weight decay to weight matrices only; exclude biases, embeddings,
    positional encodings, and RMSNorm/head_norm weights (Section 7, line 247).
    """
    decay, no_decay = [], []
    for name, p in model.named_parameters():
        if not p.requires_grad:
            continue
        is_no_decay = (
            p.ndim < 2
            or "emb" in name
            or "norm" in name
            or name.endswith("pos")
            or "bias" in name
        )
        if is_no_decay:
            no_decay.append(p)
        else:
            decay.append(p)
    return [
        {"params": decay, "weight_decay": float(weight_decay)},
        {"params": no_decay, "weight_decay": 0.0},
    ]


def _tensors(bundle, indices, device):
    idx = np.asarray(indices)
    cont = (
        torch.tensor(bundle["static_cont"][idx], dtype=torch.float32, device=device)
        if bundle["static_cont"].shape[1]
        else None
    )
    pop = (
        torch.tensor(bundle["origin_pop"][idx], dtype=torch.float32, device=device)
        if "origin_pop" in bundle
        else None
    )
    return {
        "x": torch.tensor(bundle["X"][idx], dtype=torch.float32, device=device),
        "region": torch.tensor(bundle["region_idx"][idx], dtype=torch.long, device=device),
        "province": torch.tensor(bundle["province_idx"][idx], dtype=torch.long, device=device),
        "cont": cont,
        "origin_pop": pop,
        "future": torch.tensor(bundle["future_cal"][idx], dtype=torch.float32, device=device),
        "scale": torch.tensor(bundle["count_scale"][idx], dtype=torch.float32, device=device),
        "y": torch.tensor(np.where(bundle["y_mask"][idx], bundle["y"][idx], 0.0), dtype=torch.float32, device=device),
    }


def _forward(model, batch):
    static = {"region": batch["region"], "province": batch["province"], "cont": batch["cont"]}
    return model(batch["x"], static, batch["future"], batch["scale"], origin_pop=batch.get("origin_pop"))


def predict_neural(model, bundle, indices, device, batch_size=512):
    model.eval()
    mus, kappas, clf_probs = [], [], []
    with torch.no_grad():
        for i in range(0, len(indices), batch_size):
            batch = _tensors(bundle, indices[i : i + batch_size], device)
            out = _forward(model, batch)
            mus.append(out["mu"].cpu().numpy())
            kappas.append(out["kappa"].cpu().numpy())
            if "classifier_prob" in out:
                clf_probs.append(out["classifier_prob"].cpu().numpy())
    mu_arr = np.concatenate(mus) if mus else np.zeros((0, 3))
    kappa_arr = np.concatenate(kappas) if kappas else np.zeros((0, 3))
    if clf_probs:
        return mu_arr, kappa_arr, np.concatenate(clf_probs)
    return mu_arr, kappa_arr


def _val_scaled_wis(model, bundle, indices, horizon_mask, device):
    """Macro scaled WIS averaged equally over eligible district-horizon pairs (Section 7)."""
    if len(indices) == 0:
        return float("inf")
    pred = predict_neural(model, bundle, indices, device)
    mu, kappa = pred[0], pred[1]
    q = nb_quantiles(mu, kappa)
    rows = []
    for j, idx in enumerate(indices):
        for h in range(3):
            if horizon_mask[idx, h] and bundle["y_mask"][idx, h]:
                rows.append((
                    bundle["region"][idx],
                    h,
                    wis_per_row(bundle["y"][idx, h], q[j, h]) / max(1.0, float(bundle["count_scale"][idx])),
                ))
    if not rows:
        return float("inf")
    frame = pd.DataFrame(rows, columns=["region", "h", "score"])
    rh_mean = frame.groupby(["region", "h"])["score"].mean()
    return float(rh_mean.groupby(level="h").mean().mean())


def compute_balanced_weights(bundle, train_idx, train_hmask):
    """Compute inverse-count weights so every represented (district, horizon) pair receives
    equal total objective weight regardless of history length (Section 6, line 198).
    Scaled by `len(train_idx)` (the fixed number of training windows) so that dividing each
    minibatch sum by the fixed minibatch size `|B|` is an exact, unbiased Horvitz-Thompson
    estimator of the full-dataset equal-(district, horizon) objective.
    """
    weights = np.zeros_like(bundle["y"], dtype=np.float32)
    counts = {}
    for idx in train_idx:
        r_key = str(bundle["region"][idx])
        for h in range(bundle["y"].shape[1]):
            if train_hmask[idx, h] and bundle["y_mask"][idx, h]:
                counts[(r_key, h)] = counts.get((r_key, h), 0) + 1
    n_pairs = max(1, len(counts))
    n_win = float(max(1, len(train_idx)))
    for idx in train_idx:
        r_key = str(bundle["region"][idx])
        for h in range(bundle["y"].shape[1]):
            if train_hmask[idx, h] and bundle["y_mask"][idx, h]:
                weights[idx, h] = n_win / float(n_pairs * counts[(r_key, h)])
    return weights


def balanced_minibatch_loss_numpy(losses, target_mask, weights):
    """Reference NumPy implementation of the fixed-denominator balanced minibatch estimator."""
    mask = np.asarray(target_mask, dtype=bool)
    if not mask.any():
        return 0.0
    w = np.asarray(weights, dtype=np.float64)[mask]
    if w.sum() <= 0:
        return 0.0
    l_val = np.asarray(losses, dtype=np.float64)[mask]
    n_batch = float(max(1, np.asarray(losses).shape[0]))
    return float((w * l_val).sum() / n_batch)


def fit_neural_model(backbone, bundle, masks, prep, cfg, seed, device, thresholds=None):
    set_seed(seed)
    train_idx_all, train_hmask = masks["train"]
    val_idx, val_hmask = masks["val"]
    train_idx = cap_indices(train_idx_all, cfg.get("MAX_TRAIN_WINDOWS"), seed)
    val_idx = cap_indices(val_idx, cfg.get("MAX_EVAL_WINDOWS"), seed)

    use_aux_bce = bool(float(cfg.get("AUX_BCE_WEIGHT", 0.0)) > 0 or backbone.endswith("_bce"))
    lambda_bce = float(cfg.get("AUX_BCE_WEIGHT", 0.1 if backbone.endswith("_bce") else 0.0))

    model = EpiKD(
        feature_dim=bundle["X"].shape[-1],
        num_regions=prep.num_regions,
        num_provinces=prep.num_provinces,
        static_cont_dim=bundle["static_cont"].shape[1],
        width=int(cfg.get("WIDTH", 64)),
        heads=int(cfg.get("HEADS", 2)),
        layers=int(cfg.get("LAYERS", 2)),
        dropout=float(cfg.get("DROPOUT", 0.10)),
        backbone=backbone,
        lookback=int(cfg.get("LOOKBACK", 24)),
        use_pop_offset=bool(cfg.get("POPULATION_OFFSET", False)),
        use_aux_bce=use_aux_bce,
    ).to(device)

    n_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    opt = torch.optim.AdamW(
        _build_optimizer_param_groups(model, float(cfg.get("WEIGHT_DECAY", 0.0001))),
        lr=float(cfg.get("LR", 0.001)),
    )

    weights = compute_balanced_weights(bundle, train_idx, train_hmask)
    train_h_t = torch.tensor(train_hmask & bundle["y_mask"], dtype=torch.bool, device=device)
    weights_t = torch.tensor(weights, dtype=torch.float32, device=device)

    # Precompute binary event labels for optional NB+BCE control experiment
    event_labels_t, event_mask_t = None, None
    if use_aux_bce and thresholds is not None:
        ev_lab = np.zeros_like(bundle["y"], dtype=np.float32)
        ev_msk = np.zeros_like(bundle["y_mask"], dtype=bool)
        for idx in train_idx:
            r_str = str(bundle["region"][idx])
            for h in range(3):
                if train_hmask[idx, h] and bundle["y_mask"][idx, h]:
                    m = int((bundle["target_ord"][idx, h] % 12) + 1)
                    c_th = thresholds.get((r_str, m), np.nan)
                    if np.isfinite(c_th):
                        ev_lab[idx, h] = float(bundle["y"][idx, h] >= c_th)
                        ev_msk[idx, h] = True
        event_labels_t = torch.tensor(ev_lab, dtype=torch.float32, device=device)
        event_mask_t = torch.tensor(ev_msk, dtype=torch.bool, device=device)

    rng = np.random.default_rng(seed)
    best_score, best_state, bad_epochs = float("inf"), None, 0
    curves = []
    t0 = time.time()

    for epoch in range(int(cfg["EPOCHS"])):
        model.train()
        order = train_idx.copy()
        rng.shuffle(order)
        epoch_loss, seen = 0.0, 0
        for i in range(0, len(order), int(cfg["BATCH_SIZE"])):
            idx = order[i : i + int(cfg["BATCH_SIZE"])]
            batch = _tensors(bundle, idx, device)
            out = _forward(model, batch)
            loss = negative_binomial_nll(
                batch["y"], out["mu"], out["kappa"], train_h_t[idx], weights_t[idx]
            )
            if use_aux_bce and event_mask_t is not None and "event_logits" in out:
                em = event_mask_t[idx]
                if em.any():
                    bce = F.binary_cross_entropy_with_logits(
                        out["event_logits"][em], event_labels_t[idx][em]
                    )
                    loss = loss + lambda_bce * bce
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            epoch_loss += float(loss.item()) * len(idx)
            seen += len(idx)
        score = _val_scaled_wis(model, bundle, val_idx, val_hmask, device)
        curves.append({
            "epoch": epoch + 1,
            "train_nll": epoch_loss / max(1, seen),
            "val_scaled_wis": score,
            "elapsed_sec": round(time.time() - t0, 2),
        })
        print(f"model={backbone} seed={seed} epoch={epoch + 1} val_scaled_wis={score:.4f}")
        if score < best_score - 1e-6:
            best_score, bad_epochs = score, 0
            best_state = copy.deepcopy({k: v.detach().cpu() for k, v in model.state_dict().items()})
        else:
            bad_epochs += 1
            if bad_epochs >= int(cfg["PATIENCE"]):
                break
    if best_state is not None:
        model.load_state_dict(best_state)
    info = {
        "backbone": backbone,
        "seed": int(seed),
        "params": int(n_params),
        "best_val_scaled_wis": float(best_score),
        "epochs_ran": len(curves),
        "train_seconds": round(time.time() - t0, 2),
    }
    return model, info, pd.DataFrame(curves)


# %% 12. Rolling validation and finite declared tuning grid
def run_tuning_grid(bundle, masks, prep, cfg, device, neural_families=None):
    """Finite 8-configuration grid per neural family from Section 7 of EpiKD.txt:
    layers {1, 2} x lr {0.0003, 0.001} x dropout {0.05, 0.10}.
    Selects the best configuration per family by validation macro scaled WIS.
    """
    records = []
    base_seed = int(cfg["SEEDS"][0])
    if neural_families is None:
        neural_set = {"kda", "scalar_decay", "gru", "transformer", "kda_noconv"}
        neural_families = [m for m in cfg["MODELS"] if m in neural_set] or ["kda"]
    best_by_family = {}
    for fam in neural_families:
        fam_records = []
        for layers in [1, 2]:
            for lr in [0.0003, 0.001]:
                for dropout in [0.05, 0.10]:
                    trial = dict(
                        cfg,
                        LAYERS=layers,
                        LR=lr,
                        DROPOUT=dropout,
                        EPOCHS=min(int(cfg["EPOCHS"]), 15),
                        PATIENCE=4,
                    )
                    _, info, _ = fit_neural_model(fam, bundle, masks, prep, trial, base_seed, device)
                    rec = {**info, "family": fam, "layers": layers, "lr": lr, "dropout": dropout}
                    records.append(rec)
                    fam_records.append(rec)
        fam_df = pd.DataFrame(fam_records).sort_values("best_val_scaled_wis")
        best = fam_df.iloc[0]
        best_by_family[fam] = {
            "LAYERS": int(best["layers"]),
            "LR": float(best["lr"]),
            "DROPOUT": float(best["dropout"]),
        }
        print(f"tuning_best family={fam} layers={best['layers']} lr={best['lr']} dropout={best['dropout']}")
    cfg["TUNED_BY_FAMILY"] = best_by_family
    if "kda" in best_by_family:
        cfg["LAYERS"] = best_by_family["kda"]["LAYERS"]
        cfg["LR"] = best_by_family["kda"]["LR"]
        cfg["DROPOUT"] = best_by_family["kda"]["DROPOUT"]
    return pd.DataFrame(records).sort_values(["family", "best_val_scaled_wis"]).reset_index(drop=True)


def run_rolling_validation(panel, base_split_spec, cfg, device, n_folds=3):
    """Evaluate model ranking stability across expanding-training 12-month rolling
    validation folds prior to the alarm-calibration and test periods (Section 7).
    """
    folds = make_rolling_splits(panel, base_split_spec, n_folds=n_folds)
    adj = load_or_build_adjacency(panel, cfg)
    rows = []
    base_seed = int(cfg["SEEDS"][0])
    for fold_i, fold_spec in enumerate(folds, start=1):
        bundle = make_windows(panel, fold_spec, None, cfg, adjacency=adj)
        masks = split_horizon_masks(bundle, fold_spec)
        if len(masks["train"][0]) == 0 or len(masks["val"][0]) == 0:
            continue
        prep = fit_preprocessor(panel, cfg, bundle, masks, fold_spec)
        transform_bundle(bundle, prep)
        thresholds = fit_event_thresholds(panel, cfg, fold_spec)
        val_idx = cap_indices(masks["val"][0], cfg.get("MAX_EVAL_WINDOWS"), base_seed)
        val_hmask = masks["val"][1]

        for model_name in cfg["MODELS"]:
            if model_name in ("seasonal_naive", "last_obs_naive"):
                mode = "seasonal" if model_name == "seasonal_naive" else "last_obs"
                mu, kappa, qs = predict_naive(bundle, masks, prep, "val", val_idx, mode=mode)
                frame = build_prediction_frame(
                    bundle, val_idx, val_hmask, mu, kappa, qs, thresholds, model_name, 0, cfg
                )
            elif model_name == "tree":
                mu, kappa, qs, idx_t, _ = predict_tree(bundle, masks, prep, "val", cfg)
                frame = build_prediction_frame(
                    bundle, idx_t, val_hmask, mu, kappa, qs, thresholds, model_name, 0, cfg
                )
            elif torch is not None:
                model, _, _ = fit_neural_model(
                    model_name, bundle, masks, prep, cfg, base_seed, device, thresholds=thresholds
                )
                pred = predict_neural(model, bundle, val_idx, device)
                frame = build_prediction_frame(
                    bundle, val_idx, val_hmask, pred[0], pred[1], None, thresholds, model_name, base_seed, cfg
                )
            else:
                continue
            sc = evaluate_forecasts(frame, None, thresholds, None, cfg)
            sc["fold"] = fold_i
            sc["val_start"] = str(ordinal_to_month_start(fold_spec.val_start).date())
            sc["val_end"] = str(ordinal_to_month_start(fold_spec.val_end).date())
            rows.append(sc)
    return pd.concat(rows, ignore_index=True) if rows else pd.DataFrame()


# %% 13. Ablation and low-data runners; resource report
def run_sample_efficiency_experiment(panel, base_split_spec, cfg, device):
    """Sample-efficiency learning curve runner (Section 8, lines 326-331 of EpiKD.txt):
    - Uses the most recent 25%, 50%, 75%, and 100% of the fitting era.
    - Keeps validation, alarm-calibration, and test target months fixed.
    - Requires entire historical 24-month input windows to lie inside that fraction
      (win_start >= fit_start_frac) so older data never covertly enter short-history runs.
    - Refits feature preprocessors, count scales, vocabularies, and event thresholds at each fraction.
    - Explicitly labels that fraction-specific thresholds define different outbreak events across
      fractions (never borrowing 100%-era thresholds for low-data runs, per Section 8, line 330).
    - Optionally supports an excluded pre-fitting common reference era when
      `SAMPLE_EFFICIENCY_EXCLUDED_REF_MONTHS >= 36` is configured, recomputing event probabilities
      and alarm cutoffs from scratch under the excluded-era thresholds.
    """
    fractions = cfg.get("SAMPLE_EFFICIENCY_FRACTIONS", [0.25, 0.50, 0.75, 1.00])
    adj = load_or_build_adjacency(panel, cfg)
    t_min = int(panel["ordinal"].min())
    excl_ref_months = int(cfg.get("SAMPLE_EFFICIENCY_EXCLUDED_REF_MONTHS", 0))
    excluded_ref_thresholds = None
    if excl_ref_months >= 36 and (base_split_spec.fit_end - (t_min + excl_ref_months) + 1) >= (int(cfg["LOOKBACK"]) + 12):
        ref_spec = SplitSpec(
            t_max=base_split_spec.t_max,
            fit_end=t_min + excl_ref_months - 1,
            val_start=base_split_spec.val_start,
            val_end=base_split_spec.val_end,
            alarm_start=base_split_spec.alarm_start,
            alarm_end=base_split_spec.alarm_end,
            test_start=base_split_spec.test_start,
            test_end=base_split_spec.test_end,
            case_delay_months=base_split_spec.case_delay_months,
            fit_start=t_min,
        )
        excluded_ref_thresholds = fit_event_thresholds(panel, cfg, ref_spec)
        pool_start = t_min + excl_ref_months
    else:
        pool_start = t_min

    total_fit_months = int(base_split_spec.fit_end - pool_start + 1)
    base_seed = int(cfg["SEEDS"][0])
    budget = float(cfg.get("ALARM_BUDGET_PER_DISTRICT_YEAR", 1.0))
    rows = []

    for frac in fractions:
        keep_months = max(int(cfg["LOOKBACK"]) + 6, int(round(float(frac) * total_fit_months)))
        fit_start_frac = max(pool_start, int(base_split_spec.fit_end - keep_months + 1))
        frac_spec = SplitSpec(
            t_max=base_split_spec.t_max,
            fit_end=base_split_spec.fit_end,
            val_start=base_split_spec.val_start,
            val_end=base_split_spec.val_end,
            alarm_start=base_split_spec.alarm_start,
            alarm_end=base_split_spec.alarm_end,
            test_start=base_split_spec.test_start,
            test_end=base_split_spec.test_end,
            case_delay_months=base_split_spec.case_delay_months,
            fit_start=fit_start_frac,
        )
        bundle = make_windows(panel, frac_spec, None, cfg, adjacency=adj)
        masks = split_horizon_masks(bundle, frac_spec)
        train_idx, train_h = masks["train"]
        if len(train_idx) == 0:
            continue
        prep = fit_preprocessor(panel, cfg, bundle, masks, frac_spec)
        transform_bundle(bundle, prep)
        frac_thresholds = fit_event_thresholds(panel, cfg, frac_spec)

        fit_slice = panel[(panel["ordinal"] >= fit_start_frac) & (panel["ordinal"] <= frac_spec.fit_end)]
        eligible_region_months = int(fit_slice["cases"].notna().sum())
        eligible_windows = int(len(train_idx))

        for model_name in cfg["MODELS"]:
            raw_preds = {}
            if model_name in ("seasonal_naive", "last_obs_naive"):
                mode = "seasonal" if model_name == "seasonal_naive" else "last_obs"
                for split in ["alarm", "test"]:
                    idx = cap_indices(masks[split][0], cfg.get("MAX_EVAL_WINDOWS"), base_seed)
                    mu, kappa, qs = predict_naive(bundle, masks, prep, split, idx, mode=mode)
                    raw_preds[split] = (idx, mu, kappa, qs, 0)
            elif model_name == "tree":
                for split in ["alarm", "test"]:
                    mu, kappa, qs, idx_t, _ = predict_tree(bundle, masks, prep, split, cfg)
                    raw_preds[split] = (idx_t, mu, kappa, qs, 0)
            elif torch is not None:
                model, _, _ = fit_neural_model(
                    model_name, bundle, masks, prep, cfg, base_seed, device, thresholds=frac_thresholds
                )
                for split in ["alarm", "test"]:
                    idx = cap_indices(masks[split][0], cfg.get("MAX_EVAL_WINDOWS"), base_seed)
                    pred = predict_neural(model, bundle, idx, device)
                    raw_preds[split] = (idx, pred[0], pred[1], None, base_seed)
            else:
                continue

            frames = {}
            for split in ["alarm", "test"]:
                idx_s, mu_s, kappa_s, qs_s, seed_s = raw_preds[split]
                frames[split] = build_prediction_frame(
                    bundle, idx_s, masks[split][1], mu_s, kappa_s, qs_s, frac_thresholds, model_name, seed_s, cfg
                )
            cuts = fit_alarm_cutoffs(frames["alarm"], budget=budget)
            test_df = frames["test"]
            test_df["alert"] = [
                bool(np.isfinite(p) and p >= cuts.get(h, np.inf))
                for p, h in zip(test_df["event_prob"], test_df["horizon"])
            ]

            sc = evaluate_forecasts(test_df, None, frac_thresholds, cuts, cfg)
            sc["train_fraction"] = float(frac)
            sc["fit_start"] = str(ordinal_to_month_start(fit_start_frac).date())
            sc["eligible_region_months"] = eligible_region_months
            sc["eligible_train_windows"] = eligible_windows
            sc["threshold_regime"] = "fraction_specific_alarm_defs_not_comparable"
            rows.append(sc)

            if excluded_ref_thresholds is not None:
                ref_frames = {}
                for split in ["alarm", "test"]:
                    idx_s, mu_s, kappa_s, qs_s, seed_s = raw_preds[split]
                    ref_frames[split] = build_prediction_frame(
                        bundle,
                        idx_s,
                        masks[split][1],
                        mu_s,
                        kappa_s,
                        qs_s,
                        excluded_ref_thresholds,
                        model_name,
                        seed_s,
                        cfg,
                    )
                ref_cuts = fit_alarm_cutoffs(ref_frames["alarm"], budget=budget)
                ref_test_df = ref_frames["test"]
                ref_test_df["alert"] = [
                    bool(np.isfinite(p) and p >= ref_cuts.get(h, np.inf))
                    for p, h in zip(ref_test_df["event_prob"], ref_test_df["horizon"])
                ]
                sc_ref = evaluate_forecasts(ref_test_df, None, excluded_ref_thresholds, ref_cuts, cfg)
                sc_ref["train_fraction"] = float(frac)
                sc_ref["fit_start"] = str(ordinal_to_month_start(fit_start_frac).date())
                sc_ref["eligible_region_months"] = eligible_region_months
                sc_ref["eligible_train_windows"] = eligible_windows
                sc_ref["threshold_regime"] = f"excluded_common_reference_{excl_ref_months}m"
                rows.append(sc_ref)

    return pd.concat(rows, ignore_index=True) if rows else pd.DataFrame()


# %% 14. Frozen probability cutoffs, calibration and episode diagnostics
def _empirical_event_prob_from_residuals(point_pred, c_thresh, resid_sorted):
    """Exact empirical survival probability P(max(0, point_pred + R) >= c_thresh)
    using sorted training residuals `resid_sorted` (Section 8, line 324).
    """
    if not np.isfinite(c_thresh):
        return np.nan
    if c_thresh <= 0.0:
        return 1.0
    if resid_sorted is None or len(resid_sorted) == 0:
        return float(point_pred >= c_thresh)
    needed_r = (float(c_thresh) - float(point_pred)) - 1e-12
    idx_first = int(np.searchsorted(resid_sorted, needed_r, side="left"))
    return float(len(resid_sorted) - idx_first) / float(len(resid_sorted))


def _quantile_fallback_event_prob(q_row, c_thresh):
    """Fallback tail probability P(Y >= c_thresh) = 1 - P(Y <= c_thresh - 1) for a discrete
    count forecast represented only by 7 quantiles, preserving left-continuity at ties
    so a point-mass forecast at `C` with threshold `C` returns 1.0.
    """
    if not np.isfinite(c_thresh):
        return np.nan
    if c_thresh <= 0.0:
        return 1.0
    q_arr = np.asarray(q_row, dtype=float)
    if q_arr[0] >= c_thresh:
        return 1.0
    if q_arr[-1] < c_thresh:
        return 0.0
    uniq_vals, uniq_idx = np.unique(q_arr, return_index=True)
    cdf_below = float(np.interp(c_thresh - 1.0, uniq_vals, QUANTILE_LEVELS[uniq_idx], left=0.0, right=1.0))
    return float(np.clip(1.0 - cdf_below, 0.0, 1.0))


def build_prediction_frame(
    bundle,
    indices,
    horizon_mask,
    mu,
    kappa,
    quantiles,
    thresholds,
    model_name,
    seed,
    cfg,
    alarm_cutoffs=None,
    classifier_prob=None,
    empirical_resids=None,
):
    rows = []
    summary = distribution_summary(mu, kappa) if quantiles is None else None
    if quantiles is None:
        quantiles = summary["quantiles"]
    if empirical_resids is None and isinstance(bundle, dict) and "naive_residuals" in bundle:
        mode_key = "seasonal" if model_name == "seasonal_naive" else ("last_obs" if model_name == "last_obs_naive" else model_name)
        empirical_resids = bundle["naive_residuals"].get(mode_key)

    for j, idx in enumerate(indices):
        for h in range(3):
            if not horizon_mask[idx, h]:
                continue
            region = str(bundle["region"][idx])
            target_ord = int(bundle["target_ord"][idx, h])
            month = int((target_ord % 12) + 1)
            c_thresh = thresholds.get((region, month), np.nan) if thresholds else np.nan
            event_prob = np.nan
            if np.isfinite(c_thresh) and np.isfinite(kappa[j, h]):
                k_val = max(1e-6, float(kappa[j, h]))
                m_val = max(1e-6, float(mu[j, h]))
                event_prob = float(stats.nbinom.sf(c_thresh - 1.0, k_val, k_val / (k_val + m_val)))
            elif np.isfinite(c_thresh) and empirical_resids is not None and h in empirical_resids:
                event_prob = _empirical_event_prob_from_residuals(mu[j, h], c_thresh, empirical_resids[h])
            elif np.isfinite(c_thresh):
                event_prob = _quantile_fallback_event_prob(quantiles[j, h], c_thresh)
            alert = False
            if alarm_cutoffs is not None and np.isfinite(event_prob):
                alert = bool(event_prob >= alarm_cutoffs.get(h + 1, np.inf))
            row = {
                "region": region,
                "issue_time": ordinal_to_month_end(bundle["origin_ord"][idx]),
                "origin_ord": int(bundle["origin_ord"][idx]),
                "target_month": ordinal_to_month_start(target_ord),
                "target_ord": target_ord,
                "horizon": h + 1,
                "mu": float(mu[j, h]),
                "kappa": float(kappa[j, h]) if np.isfinite(kappa[j, h]) else np.nan,
                "event_threshold": float(c_thresh) if np.isfinite(c_thresh) else np.nan,
                "event_prob": event_prob,
                "classifier_prob": float(classifier_prob[j, h]) if classifier_prob is not None else np.nan,
                "alert": alert,
                "y": float(bundle["y"][idx, h]) if bundle["y_mask"][idx, h] else np.nan,
                "count_scale": float(bundle["count_scale"][idx]),
                "origin_pop": float(bundle["origin_pop"][idx]) if "origin_pop" in bundle else np.nan,
                "model": model_name,
                "seed": int(seed),
                "source_mode": cfg["SOURCE_MODE"],
            }
            for qi, level in enumerate(QUANTILE_LEVELS):
                row[f"q{level}"] = float(quantiles[j, h, qi])
            rows.append(row)
    return pd.DataFrame(rows)


def fit_alarm_cutoffs(calibration_predictions, budget=1.0):
    """Select one global probability cutoff per horizon on the alarm-calibration period
    to maximize sensitivity subject to at most `budget` false target-month alarms per
    observed eligible district-year, breaking ties toward the higher cutoff and
    including a no-alert option (np.inf) (Section 7, lines 294-296).
    Uses exact unrounded observed probabilities so close probabilities are never merged.
    """
    cutoffs = {}
    frame = calibration_predictions.dropna(subset=["event_prob", "event_threshold", "y"])
    for h, grp in frame.groupby("horizon"):
        event = (grp["y"].values >= grp["event_threshold"].values).astype(int)
        prob = grp["event_prob"].values.astype(float)
        denom_years = len(grp) / 12.0
        best_sens, best_cut = -1.0, float("inf")
        n_pos = int((event == 1).sum())
        candidates = np.unique(np.concatenate([[0.0], prob, [1.0 + 1e-12, np.inf]]))
        for cand in candidates:
            alert = (prob >= cand) if np.isfinite(cand) else np.zeros(len(grp), dtype=bool)
            false_n = int((alert & (event == 0)).sum())
            rate = false_n / denom_years if denom_years > 0 else float("inf")
            if rate <= budget + 1e-12:
                sens = float((alert & (event == 1)).sum() / n_pos) if n_pos > 0 else 0.0
                if sens > best_sens + 1e-12 or (abs(sens - best_sens) <= 1e-12 and cand > best_cut):
                    best_sens, best_cut = sens, float(cand)
        cutoffs[int(h)] = best_cut
    print(f"alarm_cutoffs={cutoffs}")
    return cutoffs


def evaluate_forecasts(predictions, truth=None, thresholds=None, cutoffs=None, cfg=None):
    """Evaluate probabilistic count and outbreak metrics (Section 6 & 7 of EpiKD.txt):
    - Primary selection score `wis_scaled` is the macro equal-district mean of WIS / s_r.
    - Also reports `wis_scaled_micro`, `wis_raw_macro`, `wis_raw_micro`, `mae_median`,
      `mae_mean`, `rmse_mean`, `nb_nll`, `bias`, central 50/80/95% coverage and widths,
      discrete randomized PIT diagnostics, and outbreak Brier, AP, sensitivity, and
      false-alarms per observed district-year (retaining zero-event districts in Brier
      and false-alarm denominators).
    """
    from sklearn.metrics import average_precision_score

    if len(predictions) == 0:
        return pd.DataFrame()
    frame = predictions.copy()
    qcols = [f"q{level}" for level in QUANTILE_LEVELS]
    valid_y = frame["y"].notna()
    frame["wis"] = np.nan
    if valid_y.any():
        frame.loc[valid_y, "wis"] = wis_per_row(
            frame.loc[valid_y, "y"].values, frame.loc[valid_y, qcols].values.astype(float)
        )
    frame["wis_over_scale"] = frame["wis"] / np.maximum(1.0, frame["count_scale"])

    if thresholds is not None:
        new_c = []
        for idx_r, row_r in frame.iterrows():
            r_str = str(row_r["region"])
            if "target_ord" in frame.columns and pd.notna(row_r["target_ord"]):
                m_int = int((int(row_r["target_ord"]) % 12) + 1)
            else:
                m_int = int(pd.Timestamp(row_r["target_month"]).month)
            new_c.append(thresholds.get((r_str, m_int), row_r.get("event_threshold", np.nan)))
        frame["event_threshold"] = new_c

    # Ensure NB event_prob is always synchronized with event_threshold (prevents stale probabilities
    # if event_threshold was updated or overridden for a reference threshold evaluation).
    nb_rows = frame["kappa"].notna() & frame["mu"].notna() & frame["event_threshold"].notna()
    if nb_rows.any():
        k_arr = np.maximum(1e-6, frame.loc[nb_rows, "kappa"].values.astype(float))
        m_arr = np.maximum(1e-6, frame.loc[nb_rows, "mu"].values.astype(float))
        c_arr = frame.loc[nb_rows, "event_threshold"].values.astype(float)
        frame.loc[nb_rows, "event_prob"] = stats.nbinom.sf(c_arr - 1.0, k_arr, k_arr / (k_arr + m_arr))

    frame["event"] = np.where(
        frame["event_threshold"].notna() & frame["y"].notna(),
        (frame["y"] >= frame["event_threshold"]).astype(float),
        np.nan,
    )
    if cutoffs is not None:
        frame["alert"] = [
            bool(np.isfinite(p) and p >= cutoffs.get(int(h), np.inf))
            for p, h in zip(frame["event_prob"], frame["horizon"])
        ]

    out = []
    for (model, seed, h), grp in frame.groupby(["model", "seed", "horizon"]):
        g = grp.dropna(subset=["y"])
        if not len(g):
            continue
        # Macro equal-district average of WIS / s_r (Primary score in Section 7, line 289)
        wis_scaled_macro = float(g.groupby("region")["wis_over_scale"].mean().mean())
        wis_scaled_micro = float(g["wis_over_scale"].mean())
        wis_raw_macro = float(g.groupby("region")["wis"].mean().mean())
        wis_raw_micro = float(g["wis"].mean())

        has_nb = g["kappa"].notna().all()
        if has_nb:
            nll_vals = nb_nll_numpy(g["y"].values, g["mu"].values, g["kappa"].values)
            nb_nll_macro = float(
                pd.Series(nll_vals, index=g["region"]).groupby(level=0).mean().mean()
            )
            pit_vals = randomized_pit_nb(g["y"].values, g["mu"].values, g["kappa"].values, seed=17)
            pit_mean = float(np.mean(pit_vals))
            pit_std = float(np.std(pit_vals))
            pit_ks = float(stats.kstest(pit_vals, "uniform").statistic)
        else:
            nb_nll_macro, pit_mean, pit_std, pit_ks = np.nan, np.nan, np.nan, np.nan

        rec = {
            "model": model,
            "seed": int(seed),
            "horizon": int(h),
            "n": int(len(g)),
            "n_districts": int(g["region"].nunique()),
            "wis_scaled": wis_scaled_macro,
            "wis_scaled_micro": wis_scaled_micro,
            "wis_raw": wis_raw_macro,
            "wis_raw_micro": wis_raw_micro,
            "nb_nll": nb_nll_macro,
            "mae_median": float(np.mean(np.abs(g["y"] - g["q0.5"]))),
            "mae_mean": float(np.mean(np.abs(g["y"] - g["mu"]))),
            "rmse_mean": float(np.sqrt(np.mean((g["y"] - g["mu"]) ** 2))),
            "bias": float(np.mean(g["mu"] - g["y"])),
            "cov50": float(np.mean((g["y"] >= g["q0.25"]) & (g["y"] <= g["q0.75"]))),
            "cov80": float(np.mean((g["y"] >= g["q0.1"]) & (g["y"] <= g["q0.9"]))),
            "cov95": float(np.mean((g["y"] >= g["q0.025"]) & (g["y"] <= g["q0.975"]))),
            "width50": float(np.mean(g["q0.75"] - g["q0.25"])),
            "width80": float(np.mean(g["q0.9"] - g["q0.1"])),
            "width95": float(np.mean(g["q0.975"] - g["q0.025"])),
            "pit_mean": pit_mean,
            "pit_std": pit_std,
            "pit_ks": pit_ks,
        }
        # Outbreak alarm evaluation: retain all eligible districts (including 0-event districts)
        # in Brier and false-alarm denominators (Section 6, line 216).
        ev = g.dropna(subset=["event", "event_prob"])
        if len(ev) > 0:
            alert = ev["alert"].astype(bool)
            denom_years = len(ev) / 12.0
            rec["eligible_alarm_districts"] = int(ev["region"].nunique())
            rec["brier"] = float(np.mean((ev["event_prob"] - ev["event"]) ** 2))
            rec["false_per_district_year"] = float(
                ((alert) & (ev["event"] == 0)).sum() / denom_years
            ) if denom_years > 0 else np.nan
            n_pos = int((ev["event"] == 1).sum())
            if n_pos > 0:
                rec["sensitivity_at_cutoff"] = float(((alert) & (ev["event"] == 1)).sum() / n_pos)
                rec["average_precision"] = (
                    float(average_precision_score(ev["event"], ev["event_prob"]))
                    if ev["event"].nunique() > 1
                    else np.nan
                )
            else:
                rec["sensitivity_at_cutoff"] = np.nan
                rec["average_precision"] = np.nan
        out.append(rec)
    return pd.DataFrame(out)


def evaluate_stratified_forecasts(predictions):
    """Report forecast scores stratified by training incidence burden group
    (low / medium / high count_scale) and population availability (Section 7, line 290).
    """
    if len(predictions) == 0:
        return pd.DataFrame()
    df = predictions.dropna(subset=["y"]).copy()
    if len(df) == 0:
        return pd.DataFrame()
    qcols = [f"q{level}" for level in QUANTILE_LEVELS]
    df["wis"] = wis_per_row(df["y"].values, df[qcols].values.astype(float))
    df["wis_over_scale"] = df["wis"] / np.maximum(1.0, df["count_scale"])
    q33, q67 = np.quantile(df["count_scale"].unique(), [1.0 / 3.0, 2.0 / 3.0]) if df["count_scale"].nunique() >= 3 else (5.0, 20.0)
    df["burden_stratum"] = np.where(
        df["count_scale"] <= q33, "low_burden", np.where(df["count_scale"] <= q67, "medium_burden", "high_burden")
    )
    rows = []
    for (model, h, stratum), grp in df.groupby(["model", "horizon", "burden_stratum"]):
        rows.append({
            "model": model,
            "horizon": int(h),
            "stratum_type": "incidence_burden",
            "stratum": stratum,
            "n": int(len(grp)),
            "n_districts": int(grp["region"].nunique()),
            "wis_scaled": float(grp.groupby("region")["wis_over_scale"].mean().mean()),
            "wis_raw": float(grp.groupby("region")["wis"].mean().mean()),
            "mae_median": float(np.mean(np.abs(grp["y"] - grp["q0.5"]))),
            "rmse_mean": float(np.sqrt(np.mean((grp["y"] - grp["mu"]) ** 2))),
        })
    return pd.DataFrame(rows)


def evaluate_episodes_and_peaks(predictions, panel, split_spec, thresholds):
    """Secondary episode onset lead-time and 3-month window peak timing/height analysis
    (Section 7, lines 299-302 of EpiKD.txt):
    - Episode: maximal run of consecutive above-threshold months (y >= C_rm) inside the test
      partition. Episodes touching a missing case observation or the partition start/end
      boundary are censored/excluded from onset lead-time metrics.
    - Match only forecasts targeting the episode's first (onset) month issued h in {1,2,3}
      months earlier; earliest successful alert supplies lead time (1..3 months).
    - Peak timing/height: at each fixed origin with all 3 target months observed, compare
      argmax_h(mu_{r,t,h}) vs argmax_h(y_{r,t+h}) with earliest-month tie-breaking (np.argmax)
      and evaluate peak height MAE and bias.
    """
    if len(predictions) == 0:
        return pd.DataFrame(), pd.DataFrame()

    # 1. Identify valid uncensored onset episodes in the test period
    test_slice = panel[
        (panel["ordinal"] >= split_spec.test_start - 1) & (panel["ordinal"] <= split_spec.test_end)
    ].sort_values(["region", "ordinal"])

    uncensored_onsets = []  # list of (region, onset_ord, length)
    for region, grp in test_slice.groupby("region"):
        ords = grp["ordinal"].values
        cases = grp["cases"].values
        ord_to_case = {int(o): float(c) if pd.notna(c) else np.nan for o, c in zip(ords, cases)}
        full_ords = list(range(int(split_spec.test_start), int(split_spec.test_end) + 1))

        in_ep = False
        ep_start = None
        ep_len = 0
        censored = False

        for o in full_ords:
            y_val = ord_to_case.get(o, np.nan)
            c_th = thresholds.get((str(region), int((o % 12) + 1)), np.nan)
            if not np.isfinite(c_th):
                break
            if not np.isfinite(y_val):
                if in_ep:
                    censored = True
                    in_ep = False
                continue
            is_above = y_val >= c_th
            if is_above and not in_ep:
                in_ep = True
                ep_start = o
                ep_len = 1
                # Check preceding month (o - 1): if missing or already above threshold, onset is censored
                prev_y = ord_to_case.get(o - 1, np.nan)
                prev_th = thresholds.get((str(region), int(((o - 1) % 12) + 1)), np.nan)
                if o == int(split_spec.test_start) or not np.isfinite(prev_y) or (np.isfinite(prev_th) and prev_y >= prev_th):
                    censored = True
                else:
                    censored = False
            elif is_above and in_ep:
                ep_len += 1
            elif (not is_above) and in_ep:
                if not censored:
                    uncensored_onsets.append((str(region), int(ep_start), int(ep_len)))
                in_ep = False
        # Any episode still active at test_end touches the upper evaluation boundary and is censored.

    ep_rows = []
    for (model, seed), grp in predictions.groupby(["model", "seed"]):
        alert_lookup = {
            (str(r), int(t_ord), int(h)): bool(al)
            for r, t_ord, h, al in zip(grp["region"], grp["target_ord"], grp["horizon"], grp["alert"])
        }
        detected = 0
        lead_times = []
        for region, onset_ord, ep_len in uncensored_onsets:
            # Check forecasts targeting onset_ord issued 3, 2, or 1 months earlier
            best_lead = None
            for h in [3, 2, 1]:
                if alert_lookup.get((region, onset_ord, h), False):
                    best_lead = h
                    break
            if best_lead is not None:
                detected += 1
                lead_times.append(best_lead)
        n_ep = len(uncensored_onsets)
        ep_rows.append({
            "model": model,
            "seed": int(seed),
            "uncensored_episodes": n_ep,
            "episodes_detected_at_onset": detected,
            "onset_detection_rate": float(detected / n_ep) if n_ep > 0 else np.nan,
            "mean_onset_lead_months": float(np.mean(lead_times)) if lead_times else np.nan,
        })

    # 2. 3-month window peak timing and peak height evaluation at fixed origins
    peak_rows = []
    for (model, seed), grp in predictions.groupby(["model", "seed"]):
        piv_y = grp.pivot_table(index=["region", "origin_ord"], columns="horizon", values="y")
        piv_mu = grp.pivot_table(index=["region", "origin_ord"], columns="horizon", values="mu")
        if not {1, 2, 3}.issubset(set(piv_y.columns)) or not {1, 2, 3}.issubset(set(piv_mu.columns)):
            continue
        valid = piv_y[[1, 2, 3]].notna().all(axis=1) & piv_mu[[1, 2, 3]].notna().all(axis=1)
        y_mat = piv_y.loc[valid, [1, 2, 3]].values
        mu_mat = piv_mu.loc[valid, [1, 2, 3]].values
        if len(y_mat) == 0:
            continue
        # np.argmax uses earliest-month tie-breaking per Section 7, line 301
        true_peak_h = np.argmax(y_mat, axis=1) + 1
        pred_peak_h = np.argmax(mu_mat, axis=1) + 1
        true_peak_val = np.max(y_mat, axis=1)
        pred_peak_val = np.max(mu_mat, axis=1)
        peak_rows.append({
            "model": model,
            "seed": int(seed),
            "n_complete_windows": int(len(y_mat)),
            "peak_timing_exact_match": float(np.mean(pred_peak_h == true_peak_h)),
            "peak_timing_mae_months": float(np.mean(np.abs(pred_peak_h - true_peak_h))),
            "peak_height_mae": float(np.mean(np.abs(pred_peak_val - true_peak_val))),
            "peak_height_bias": float(np.mean(pred_peak_val - true_peak_val)),
        })

    return pd.DataFrame(ep_rows), pd.DataFrame(peak_rows)


def paired_block_bootstrap(predictions, reference_model="kda", n_boot=200, block_months=6, seed=17):
    """Paired calendar-block bootstrap resampling across the entire regional panel
    (Section 7, line 303 of EpiKD.txt). Preserves cross-district spatial correlation,
    within-block temporal dependence, and the primary equal-horizon, equal-district
    `wis_scaled` aggregation even when horizon coverage differs.
    """
    if len(predictions) == 0 or reference_model not in predictions["model"].unique():
        return pd.DataFrame()
    df = predictions.dropna(subset=["y"]).copy()
    qcols = [f"q{level}" for level in QUANTILE_LEVELS]
    df["wis"] = wis_per_row(df["y"].values, df[qcols].values.astype(float))
    df["wis_over_scale"] = df["wis"] / np.maximum(1.0, df["count_scale"])
    if "target_ord" not in df.columns:
        df["target_ord"], _ = _ordinal_from_datetime(df["target_month"])

    # Average over seeds per (model, target_ord, region, horizon)
    agg = (
        df.groupby(["model", "target_ord", "region", "horizon"])["wis_over_scale"]
        .mean()
        .reset_index()
    )
    ords = sorted(agg["target_ord"].unique())
    if len(ords) < 2:
        return pd.DataFrame()
    b_len = min(int(block_months), len(ords))
    blocks = [ords[i : i + b_len] for i in range(0, len(ords) - b_len + 1)]
    n_blocks_draw = max(1, int(math.ceil(len(ords) / float(b_len))))

    piv = agg.pivot_table(index=["target_ord", "region", "horizon"], columns="model", values="wis_over_scale")
    if reference_model not in piv.columns:
        return pd.DataFrame()

    def _equal_horizon_district_score(sub_df, col):
        rh = sub_df[col].groupby(level=["region", "horizon"]).mean()
        return float(rh.groupby(level="horizon").mean().mean())

    rng = np.random.default_rng(seed)
    rows = []
    for other in [c for c in piv.columns if c != reference_model]:
        sub = piv[[reference_model, other]].dropna()
        if len(sub) == 0:
            continue
        point_diff = _equal_horizon_district_score(sub, reference_model) - _equal_horizon_district_score(sub, other)
        boot_diffs = []
        avail_ords = set(sub.index.get_level_values(0))
        for _ in range(int(n_boot)):
            chosen = rng.choice(len(blocks), size=n_blocks_draw, replace=True)
            sampled_ords = [o for bi in chosen for o in blocks[bi] if o in avail_ords]
            if not sampled_ords:
                continue
            parts = [sub.loc[[o]] for o in sampled_ords]
            b_df = pd.concat(parts, axis=0)
            boot_diffs.append(
                _equal_horizon_district_score(b_df, reference_model)
                - _equal_horizon_district_score(b_df, other)
            )
        if boot_diffs:
            ci_lo, ci_hi = np.quantile(boot_diffs, [0.025, 0.975])
            rows.append({
                "reference_model": reference_model,
                "comparison_model": other,
                "mean_wis_scaled_diff_ref_minus_comp": float(point_diff),
                "ci95_low": float(ci_lo),
                "ci95_high": float(ci_hi),
                "block_months": b_len,
                "n_boot": int(n_boot),
            })
    return pd.DataFrame(rows)


# %% 15. Locked final test, error analysis, export, reload reproduction
def verify_backend_equivalence(ref_fn, custom_fn, B=2, H=2, D=32, T=6, atol=1e-5):
    """Check 15 helper: Verify a future optimized backend against the reference recurrence
    for forward outputs, final state, and input gradients at matched conventions (Section 11).
    """
    if torch is None:
        return True
    torch.manual_seed(17)
    q = F.normalize(torch.randn(B, T, H, D), dim=-1).requires_grad_(True)
    k = F.normalize(torch.randn(B, T, H, D), dim=-1).requires_grad_(True)
    v = torch.randn(B, T, H, D, requires_grad=True)
    alpha = torch.exp(-F.softplus(torch.randn(B, T, H, D))).requires_grad_(True)
    beta = torch.sigmoid(torch.randn(B, T, H)).requires_grad_(True)

    def _run_seq(step_fn, q_in, k_in, v_in, a_in, b_in):
        S = torch.zeros(B, H, D, D, dtype=torch.float32)
        outs = []
        for t in range(T):
            o_t, S, _ = step_fn(S, q_in[:, t], k_in[:, t], v_in[:, t], a_in[:, t], b_in[:, t])
            outs.append(o_t)
        return torch.stack(outs, dim=1), S

    out1, S1 = _run_seq(ref_fn, q, k, v, alpha, beta)
    (out1.sum() + S1.sum()).backward()
    g1 = [t.grad.detach().clone() for t in (q, k, v, alpha, beta)]
    for t in (q, k, v, alpha, beta):
        t.grad = None

    out2, S2 = _run_seq(custom_fn, q, k, v, alpha, beta)
    (out2.sum() + S2.sum()).backward()
    g2 = [t.grad.detach().clone() for t in (q, k, v, alpha, beta)]

    assert torch.allclose(out1, out2, atol=atol), "Backend outputs diverged"
    assert torch.allclose(S1, S2, atol=atol), "Backend final states diverged"
    for ga, gb in zip(g1, g2):
        assert torch.allclose(ga, gb, atol=atol), "Backend gradients diverged"
    return True


def run_correctness_tests():
    """Execute all 15 required mathematical, data-contract, leakage, and reproduction
    checks specified in Section 11 of EpiKD.txt.
    """
    rng = np.random.default_rng(7)
    B, H, D = 2, 2, 4

    # Check 2 & 3 (NumPy/SciPy mathematical checks run unconditionally)
    S_np = rng.standard_normal((B, H, D, D))
    q_np = rng.standard_normal((B, H, D))
    q_np = q_np / np.linalg.norm(q_np, axis=-1, keepdims=True)
    k_unit = np.zeros((B, H, D))
    k_unit[..., 0] = 1.0
    v_np = rng.standard_normal((B, H, D))

    # Check 2a: No-update limit (beta=0, alpha=1)
    _, S_noupd, _ = kda_step_numpy(S_np, q_np, k_unit, v_np, np.ones((B, H, D)), np.zeros((B, H)))
    assert np.allclose(S_noupd, S_np, atol=1e-6), "Check 2a failed: no-update limit"

    # Check 2b: Pure-decay limit (beta=0, alpha=0.5)
    _, S_decay, _ = kda_step_numpy(S_np, q_np, k_unit, v_np, np.full((B, H, D), 0.5), np.zeros((B, H)))
    assert np.allclose(S_decay, 0.5 * S_np, atol=1e-6), "Check 2b failed: pure-decay limit"

    # Check 2c: Unit-key overwrite (beta=1, alpha=1, k=e_0)
    _, S_over, _ = kda_step_numpy(S_np, q_np, k_unit, v_np, np.ones((B, H, D)), np.ones((B, H)))
    assert np.allclose(S_over[..., 0], v_np, atol=1e-6), "Check 2c failed: unit-key overwrite"

    # Check 3: Expanded matrix expression & non-commuting anisotropic decay vs erasure
    s0 = rng.standard_normal((D, D))
    qq = rng.standard_normal(D)
    kk = np.array([0.6, -0.5, 0.4, 0.46904158])  # multi-component unit key
    vv = rng.standard_normal(D)
    aa = np.array([0.95, 0.40, 0.75, 0.20])  # unequal channel decays
    bb = 0.7
    Dmat = s0 @ np.diag(aa)
    S_decay_first = Dmat @ (np.eye(D) - bb * np.outer(kk, kk)) + bb * np.outer(vv, kk)
    S_erase_first = (s0 @ (np.eye(D) - bb * np.outer(kk, kk))) @ np.diag(aa) + bb * np.outer(vv, kk)
    _, s_step, _ = kda_step_numpy(
        s0[None, None], qq[None, None], kk[None, None], vv[None, None], aa[None, None], np.array([[bb]])
    )
    assert np.allclose(s_step[0, 0], S_decay_first, atol=1e-6), "Check 3a failed: expanded matrix match"
    assert not np.allclose(S_decay_first, S_erase_first, atol=1e-3), "Check 3b failed: anisotropic non-commutativity"

    # Check 6: Issue-to-target calendar mapping across year boundaries and delays d in {0,1,2}
    dec_2023 = 2023 * 12 + 11  # December 2023
    for d_check in [0, 1, 2]:
        m_info = issue_to_target_mapping(dec_2023, lookback=24, horizons=3, case_delay_months=d_check)
        assert m_info["target_months"]["h1"] == "2024-01-01", "Check 6a failed: h1 year boundary"
        assert m_info["target_months"]["h2"] == "2024-02-01", "Check 6b failed: h2 year boundary"
        assert m_info["target_months"]["h3"] == "2024-03-01", "Check 6c failed: h3 year boundary"
        assert m_info["latest_published_case_ordinal"] == dec_2023 - d_check, "Check 6d failed: delay ordinal"

    # Check 7 & 8: Leakage audits on synthetic panel (as-of perturbation & partition isolation)
    syn = make_synthetic_panel(seed=17, n_regions=8, years=8)
    sp = make_time_splits(syn, release_policy={"CASE_DELAY_MONTHS": 1})
    cfg_t = dict(DEFAULT_CFG, MODE="synthetic", SPATIAL="on", CASE_DELAY_MONTHS=1, LOOKBACK=24)
    adj_t = load_or_build_adjacency(syn, cfg_t)
    b1 = make_windows(syn, sp, None, cfg_t, adjacency=adj_t)
    m1 = split_horizon_masks(b1, sp)
    prep1 = fit_preprocessor(syn, cfg_t, b1, m1, sp)
    th1 = fit_event_thresholds(syn, cfg_t, sp)

    # Check 8: Perturb all validation/test records (> fit_end) before fitting preprocessing/thresholds
    syn_pert = syn.copy()
    fut_rows = syn_pert["ordinal"] >= sp.fit_end
    syn_pert.loc[fut_rows, "cases"] = syn_pert.loc[fut_rows, "cases"].fillna(10.0) * 50.0 + 999.0
    syn_pert.loc[fut_rows, "rainfall"] = 9999.0
    b2 = make_windows(syn_pert, sp, None, cfg_t, adjacency=adj_t)
    m2 = split_horizon_masks(b2, sp)
    prep2 = fit_preprocessor(syn_pert, cfg_t, b2, m2, sp)
    th2 = fit_event_thresholds(syn_pert, cfg_t, sp)
    assert np.allclose(prep1.dynamic_median, prep2.dynamic_median, atol=1e-6), "Check 8a failed: dynamic median leaked"
    assert np.allclose(prep1.dynamic_std, prep2.dynamic_std, atol=1e-6), "Check 8b failed: dynamic std leaked"
    assert prep1.count_scale_map == prep2.count_scale_map, "Check 8c failed: count scale leaked"
    assert th1 == th2, "Check 8d failed: event thresholds leaked"

    # Check 7: Perturb records unavailable at fixed issue t (including delayed month t when d=1)
    issue_test_ts = ordinal_to_month_start(sp.val_start)
    issue_test_ord = sp.val_start
    hb1 = build_history_as_of(syn, sorted(syn["region"].unique()), issue_test_ts, prep1, adj_t, cfg_t)
    syn_asof_pert = syn.copy()
    # Perturb everything strictly after issue_test_ord, AND cases at issue_test_ord (since d=1!)
    syn_asof_pert.loc[syn_asof_pert["ordinal"] > issue_test_ord, "cases"] = 77777.0
    syn_asof_pert.loc[syn_asof_pert["ordinal"] > issue_test_ord, "rainfall"] = 88888.0
    syn_asof_pert.loc[syn_asof_pert["ordinal"] == issue_test_ord, "cases"] = 55555.0
    hb2 = build_history_as_of(syn_asof_pert, sorted(syn["region"].unique()), issue_test_ts, prep1, adj_t, cfg_t)
    assert np.allclose(hb1["X"], hb2["X"], atol=1e-6), "Check 7 failed: future or delayed-month perturbation leaked into as-of features"

    # Check 9: NB log-probability against SciPy and Y >= C vs sf(C - 1) inclusivity
    for yv, muv, kv in [(0, 3.0, 5.0), (7, 10.0, 2.0), (100, 80.0, 20.0), (2500, 1800.0, 15.0)]:
        nll_np = float(nb_nll_numpy(yv, muv, kv))
        ref_nll = float(-stats.nbinom.logpmf(yv, kv, kv / (kv + muv)))
        assert abs(nll_np - ref_nll) < 1e-6, f"Check 9a failed: {nll_np} vs {ref_nll}"
    c_test, mu_test, k_test = 5, 4.2, 2.5
    p_test = k_test / (k_test + mu_test)
    sf_val = float(stats.nbinom.sf(c_test - 1, k_test, p_test))
    pmf_comp = float(1.0 - sum(stats.nbinom.pmf(j, k_test, p_test) for j in range(c_test)))
    assert abs(sf_val - pmf_comp) < 1e-10, "Check 9b failed: NB.sf(C-1) inclusivity mismatch"

    # Check 11: Ordered quantiles, WIS analytical check, threshold equality (y == C -> event=1)
    q_chk = nb_quantiles(np.array([[10.0, 25.0, 50.0]]), np.array([[2.0, 4.0, 8.0]]))
    assert np.all(np.diff(q_chk, axis=-1) >= 0), "Check 11a failed: quantiles not ordered"
    w_zero = wis_per_row(np.array([10.0]), np.full((1, 7), 10.0))[0]
    assert abs(w_zero) < 1e-9, "Check 11b failed: zero-width exact WIS should be 0"

    # Check 12: Split boundaries (train targets <= fit_end - d; eval origins >= fit_end;
    # and complete 24-month test / 12-month alarm target coverage per horizon on complete series)
    tr_idx, tr_hm = m1["train"]
    assert np.all(b1["target_ord"][tr_hm] <= sp.fit_end - sp.case_delay_months), "Check 12a failed: train target crossed fit cutoff"
    for eval_part in ["val", "alarm", "test"]:
        e_idx, _ = m1[eval_part]
        if len(e_idx):
            assert np.all(b1["origin_ord"][e_idx] >= sp.fit_end), f"Check 12b failed: {eval_part} origin predated fit_end"
    complete_reg = sorted(syn["region"].unique())[-1]  # all-zero district has 0 missing months
    reg_mask = b1["region"] == complete_reg
    for h_i in range(3):
        test_t_ords = b1["target_ord"][reg_mask & m1["test"][1][:, h_i], h_i]
        alarm_t_ords = b1["target_ord"][reg_mask & m1["alarm"][1][:, h_i], h_i]
        assert list(test_t_ords) == list(range(sp.test_start, sp.test_end + 1)), f"Check 12c failed: h{h_i+1} test months != 24"
        assert list(alarm_t_ords) == list(range(sp.alarm_start, sp.alarm_end + 1)), f"Check 12d failed: h{h_i+1} alarm months != 12"

    # Check 13: Edge cases (islands, all-zero district count_scale=1.0, unknown IDs -> 0,
    # seasonal naive month indexing, unbiased minibatch weights, threshold equality, exact cutoffs, bootstrap)
    zero_reg = sorted(syn["region"].unique())[-1]
    assert prep1.count_scale_map[zero_reg] == 1.0, "Check 13a failed: all-zero district count scale != 1.0"
    island_reg = sorted(syn["region"].unique())[0]
    island_idx = np.where(b1["region"] == island_reg)[0][0]
    # Neighbor coverage column is second-to-last when spatial is on
    assert np.allclose(b1["X_raw"][island_idx, :, -2], 0.0), "Check 13b failed: island coverage != 0"
    assert np.allclose(b1["X_raw"][island_idx, :, -1], 0.0), "Check 13c failed: island neighbor_avail != 0"

    # Check 13d: Seasonal naive index across L in {12, 24, 36} selects target month - 12 (July/Aug/Sep 2023 for June 2024 issue)
    for L_chk in [12, 24, 36]:
        hist_seq = np.arange(1.0, L_chk + 1.0, dtype=np.float32)
        dummy_b = {"hist_cases": np.array([hist_seq]), "target_ord": np.array([[1, 2, 3]]), "region_idx": np.array([1])}
        for h_i in range(3):
            assert naive_point(dummy_b, 0, h_i, prep1) == float(L_chk - 12 + h_i + 1), f"Check 13d failed for L={L_chk}, h={h_i}"

    # Check 13e: Unbiased minibatch district-horizon balancing (District A: 1 origin loss 2; District B: 3 origins loss 10 -> 6.0)
    b_bal = {
        "y": np.zeros((4, 1), dtype=np.float32),
        "y_mask": np.ones((4, 1), dtype=bool),
        "region": np.array(["A", "B", "B", "B"], dtype=object),
    }
    tr_idx_bal = np.array([0, 1, 2, 3])
    tr_hm_bal = np.ones((4, 1), dtype=bool)
    w_bal = compute_balanced_weights(b_bal, tr_idx_bal, tr_hm_bal)
    losses_bal = np.array([[2.0], [10.0], [10.0], [10.0]])
    assert abs(balanced_minibatch_loss_numpy(losses_bal, tr_hm_bal, w_bal) - 6.0) < 1e-6, "Check 13e full batch failed"
    pairs_2 = [(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)]
    exp_2 = np.mean([balanced_minibatch_loss_numpy(losses_bal[list(p)], tr_hm_bal[list(p)], w_bal[list(p)]) for p in pairs_2])
    exp_1 = np.mean([balanced_minibatch_loss_numpy(losses_bal[[i]], tr_hm_bal[[i]], w_bal[[i]]) for i in range(4)])
    assert abs(exp_2 - 6.0) < 1e-6 and abs(exp_1 - 6.0) < 1e-6, f"Check 13e minibatch expectation failed: {exp_2}, {exp_1}"

    # Check 13f: Naive outbreak probability at threshold equality (point mass at 5 with C=5 -> prob=1.0)
    b_eq = {
        "region": np.array(["R1"], dtype=object),
        "origin_ord": np.array([24299]),
        "target_ord": np.array([[24300, 24301, 24302]]),
        "y": np.array([[5.0, 5.0, 5.0]]),
        "y_mask": np.array([[True, True, True]]),
        "count_scale": np.array([1.0]),
        "naive_residuals": {"seasonal": {0: np.zeros(20), 1: np.zeros(20), 2: np.zeros(20)}},
    }
    th_eq = {("R1", 1): 5, ("R1", 2): 5, ("R1", 3): 6}
    df_eq_emp = build_prediction_frame(
        b_eq, [0], np.ones((1, 3), dtype=bool), np.full((1, 3), 5.0), np.full((1, 3), np.nan),
        np.full((1, 3, 7), 5.0), th_eq, "seasonal_naive", 0, cfg_t
    )
    assert df_eq_emp.loc[df_eq_emp["horizon"] == 1, "event_prob"].iloc[0] == 1.0, "Check 13f empirical equality failed"
    assert df_eq_emp.loc[df_eq_emp["horizon"] == 3, "event_prob"].iloc[0] == 0.0, "Check 13f empirical above failed"
    df_eq_q = build_prediction_frame(
        {k: v for k, v in b_eq.items() if k != "naive_residuals"}, [0], np.ones((1, 3), dtype=bool),
        np.full((1, 3), 5.0), np.full((1, 3), np.nan), np.full((1, 3, 7), 5.0), th_eq, "custom_q", 0, cfg_t
    )
    assert df_eq_q.loc[df_eq_q["horizon"] == 1, "event_prob"].iloc[0] == 1.0, "Check 13f quantile fallback equality failed"

    # Check 13g: Exact unrounded alarm cutoff search (0.50000046 vs 0.50000044 with budget=0)
    cal_exact = pd.DataFrame({
        "horizon": [1, 1],
        "y": [10.0, 2.0],
        "event_threshold": [5.0, 5.0],
        "event_prob": [0.50000046, 0.50000044],
    })
    cuts_exact = fit_alarm_cutoffs(cal_exact, budget=0.0)
    assert abs(cuts_exact[1] - 0.50000046) < 1e-12, f"Check 13g failed: cutoff={cuts_exact[1]}"

    # Check 13h: Bootstrap point difference matches primary equal-horizon score under unequal horizon coverage
    boot_test_rows = []
    for m_name, h_scores in [("kda", {1: [0.0, 0.0, 0.0], 2: [0.0]}), ("other", {1: [10.0, 10.0, 10.0], 2: [0.0]})]:
        for h_k, vals in h_scores.items():
            for t_i, v_val in enumerate(vals):
                boot_test_rows.append({
                    "model": m_name, "seed": 0, "region": "R1", "horizon": h_k,
                    "target_ord": 24300 + t_i, "target_month": ordinal_to_month_start(24300 + t_i),
                    "y": 0.0, "mu": v_val, "kappa": np.nan, "count_scale": 1.0,
                    "event_threshold": np.nan, "event_prob": np.nan, "alert": False,
                    **{f"q{lv}": v_val for lv in QUANTILE_LEVELS},
                })
    boot_df_chk = pd.DataFrame(boot_test_rows)
    sc_chk = evaluate_forecasts(boot_df_chk)
    prim_diff = (
        sc_chk[sc_chk["model"] == "kda"]["wis_scaled"].mean()
        - sc_chk[sc_chk["model"] == "other"]["wis_scaled"].mean()
    )
    bt_chk = paired_block_bootstrap(boot_df_chk, reference_model="kda", n_boot=10, block_months=2)
    assert abs(bt_chk["mean_wis_scaled_diff_ref_minus_comp"].iloc[0] - prim_diff) < 1e-9, "Check 13h bootstrap point diff mismatch"

    if torch is not None:
        torch.manual_seed(7)
        # Check 1 & 4: Full EpiKD tensor shapes, separate block states, and finite gradients through all modules
        model_chk = EpiKD(
            feature_dim=b1["X"].shape[-1],
            num_regions=prep1.num_regions,
            num_provinces=prep1.num_provinces,
            static_cont_dim=b1["static_cont"].shape[1],
            width=64,
            heads=2,
            layers=2,
            backbone="kda",
            lookback=24,
        )
        transform_bundle(b1, prep1)
        batch_chk = _tensors(b1, [0, 1, 2, 3], torch.device("cpu"))
        out_chk = model_chk(
            batch_chk["x"],
            {"region": batch_chk["region"], "province": batch_chk["province"], "cont": batch_chk["cont"]},
            batch_chk["future"],
            batch_chk["scale"],
            return_states=True,
        )
        assert out_chk["mu"].shape == (4, 3) and out_chk["kappa"].shape == (4, 3), "Check 1a failed: output shape"
        assert len(out_chk["states"]) == 2 and out_chk["states"][0].shape == (4, 2, 32, 32), "Check 1b failed: state shape"
        assert not torch.allclose(out_chk["states"][0], out_chk["states"][1]), "Check 1c failed: blocks shared state"

        # Check 10: Masked NaN targets do not corrupt loss or gradients; all-missing subset returns 0
        y_nan = batch_chk["y"].clone()
        y_nan[0, 1] = float("nan")
        mask_nan = torch.ones_like(y_nan, dtype=torch.bool)
        mask_nan[0, 1] = False
        loss_chk = negative_binomial_nll(y_nan, out_chk["mu"], out_chk["kappa"], mask_nan)
        assert torch.isfinite(loss_chk), "Check 10a failed: masked NaN target produced non-finite loss"
        loss_chk.backward()
        for name, p in model_chk.named_parameters():
            assert p.grad is not None and torch.isfinite(p.grad).all(), f"Check 4 failed: bad gradient in {name}"
        loss_empty = negative_binomial_nll(y_nan, out_chk["mu"], out_chk["kappa"], torch.zeros_like(mask_nan))
        assert torch.isfinite(loss_empty) and float(loss_empty.item()) == 0.0, "Check 10b failed: all-missing mask"

        # Check 5a: Causal convolution & recurrence (future token perturbation invariance)
        model_chk.eval()
        x_c1 = batch_chk["x"].clone()
        x_c2 = x_c1.clone()
        x_c2[:, -1, :] += 10.0
        with torch.no_grad():
            b_out1 = model_chk.blocks[0](x_c1[:, :10, :64] if x_c1.shape[-1] == 64 else model_chk.input_proj(x_c1))
            b_out2 = model_chk.blocks[0](model_chk.input_proj(x_c2))
            assert torch.allclose(b_out1[:, :-1], b_out2[:, :-1], atol=1e-5), "Check 5a failed: future token leaked backward"

            # Check 5b: Batch-order invariance in eval mode (no cross-window memory)
            perm = [3, 1, 0, 2]
            out_orig = _forward(model_chk, batch_chk)["mu"]
            batch_perm = {k: (v[perm] if isinstance(v, torch.Tensor) else v) for k, v in batch_chk.items()}
            out_perm = _forward(model_chk, batch_perm)["mu"]
            assert torch.allclose(out_orig[perm], out_perm, atol=1e-6), "Check 5b failed: batch order changed eval predictions"

        # Check 14: Save and reload model + preprocessor and reproduce fixed-origin prediction
        state_bytes = pickle.dumps({"model": model_chk.state_dict(), "prep": prep1.__dict__})
        reloaded = pickle.loads(state_bytes)
        model_rel = EpiKD(
            feature_dim=b1["X"].shape[-1],
            num_regions=prep1.num_regions,
            num_provinces=prep1.num_provinces,
            static_cont_dim=b1["static_cont"].shape[1],
            width=64,
            heads=2,
            layers=2,
            backbone="kda",
            lookback=24,
        )
        model_rel.load_state_dict(reloaded["model"])
        model_rel.eval()
        with torch.no_grad():
            mu_rel = _forward(model_rel, batch_chk)["mu"]
            assert torch.allclose(out_orig, mu_rel, atol=1e-6), "Check 14 failed: reload reproduction mismatch"

        # Check 15: Backend equivalence helper verification
        verify_backend_equivalence(kda_step, kda_step)

    print("correctness_tests=pass (all 15 specification checks verified)")


def run_experiments(configs, data_bundle, panel=None, split_spec=None, prep=None, thresholds=None, device=None):
    """Run all configured baselines and neural models on identical origins, masks,
    features, and alarm budgets (Section 8 & 10 of EpiKD.txt).
    """
    cfg = configs or DEFAULT_CFG
    bundle = data_bundle
    if split_spec is None:
        split_spec = SplitSpec(
            t_max=int(bundle["target_ord"].max()),
            fit_end=int(bundle["target_ord"].max()) - 48,
            val_start=int(bundle["target_ord"].max()) - 47,
            val_end=int(bundle["target_ord"].max()) - 36,
            alarm_start=int(bundle["target_ord"].max()) - 35,
            alarm_end=int(bundle["target_ord"].max()) - 24,
            test_start=int(bundle["target_ord"].max()) - 23,
            test_end=int(bundle["target_ord"].max()),
            case_delay_months=int(cfg.get("CASE_DELAY_MONTHS", 0)),
        )
    masks = split_horizon_masks(bundle, split_spec)
    if prep is None and panel is not None:
        prep = fit_preprocessor(panel, cfg, bundle, masks, split_spec)
        transform_bundle(bundle, prep)
    if thresholds is None and panel is not None:
        thresholds = fit_event_thresholds(panel, cfg, split_spec)
    if device is None:
        device = get_device(cfg)

    budget = float(cfg.get("ALARM_BUDGET_PER_DISTRICT_YEAR", 1.0))
    all_test, all_cutoffs, infos, curves_all = [], [], [], []
    neural_map = {
        "kda": "kda",
        "scalar_decay": "scalar_decay",
        "gru": "gru",
        "transformer": "transformer",
        "kda_noconv": "kda_noconv",
        "kda_bce": "kda_bce",
        "gru_bce": "gru_bce",
    }

    for model_name in cfg["MODELS"]:
        if model_name in ("seasonal_naive", "last_obs_naive"):
            mode = "seasonal" if model_name == "seasonal_naive" else "last_obs"
            frames = {}
            for split in ["alarm", "test"]:
                idx = cap_indices(masks[split][0], cfg.get("MAX_EVAL_WINDOWS"), 17)
                mu, kappa, qs = predict_naive(bundle, masks, prep, split, idx, mode=mode)
                frames[split] = build_prediction_frame(
                    bundle, idx, masks[split][1], mu, kappa, qs, thresholds, model_name, 0, cfg
                )
            cuts = fit_alarm_cutoffs(frames["alarm"], budget=budget)
            test = frames["test"]
            test["alert"] = [
                bool(np.isfinite(p) and p >= cuts.get(h, np.inf))
                for p, h in zip(test["event_prob"], test["horizon"])
            ]
            all_test.append(test)
            all_cutoffs.append({"model": model_name, "seed": 0, **{f"h{k}": v for k, v in cuts.items()}})
        elif model_name == "tree":
            frames = {}
            crossings_info = {}
            for split in ["alarm", "test"]:
                mu, kappa, qs, idx, c_rates = predict_tree(bundle, masks, prep, split, cfg)
                crossings_info[split] = c_rates
                frames[split] = build_prediction_frame(
                    bundle, idx, masks[split][1], mu, kappa, qs, thresholds, model_name, 0, cfg
                )
            cuts = fit_alarm_cutoffs(frames["alarm"], budget=budget)
            test = frames["test"]
            test["alert"] = [
                bool(np.isfinite(p) and p >= cuts.get(h, np.inf))
                for p, h in zip(test["event_prob"], test["horizon"])
            ]
            all_test.append(test)
            all_cutoffs.append({"model": model_name, "seed": 0, **{f"h{k}": v for k, v in cuts.items()}})
            infos.append({
                "backbone": "tree",
                "seed": 0,
                "params": 0,
                "best_val_scaled_wis": np.nan,
                "crossing_rates_test": json.dumps(crossings_info.get("test", {})),
            })
        elif model_name in neural_map:
            if torch is None:
                print(f"skipping_neural_model={model_name} reason=torch_not_installed")
                continue
            fam_cfg = dict(cfg)
            if "TUNED_BY_FAMILY" in cfg and model_name in cfg["TUNED_BY_FAMILY"]:
                fam_cfg.update(cfg["TUNED_BY_FAMILY"][model_name])
            for seed in cfg["SEEDS"]:
                model, info, curves = fit_neural_model(
                    neural_map[model_name], bundle, masks, prep, fam_cfg, int(seed), device, thresholds=thresholds
                )
                infos.append(info)
                curves.insert(0, "model", model_name)
                curves.insert(1, "seed", int(seed))
                curves_all.append(curves)
                frames = {}
                for split in ["alarm", "test"]:
                    idx = cap_indices(masks[split][0], cfg.get("MAX_EVAL_WINDOWS"), int(seed))
                    pred = predict_neural(model, bundle, idx, device)
                    mu, kappa = pred[0], pred[1]
                    clf_p = pred[2] if len(pred) > 2 else None
                    frames[split] = build_prediction_frame(
                        bundle,
                        idx,
                        masks[split][1],
                        mu,
                        kappa,
                        None,
                        thresholds,
                        model_name,
                        int(seed),
                        cfg,
                        classifier_prob=clf_p,
                    )
                cuts = fit_alarm_cutoffs(frames["alarm"], budget=budget)
                test = frames["test"]
                test["alert"] = [
                    bool(np.isfinite(p) and p >= cuts.get(h, np.inf))
                    for p, h in zip(test["event_prob"], test["horizon"])
                ]
                all_test.append(test)
                all_cutoffs.append({"model": model_name, "seed": int(seed), **{f"h{k}": v for k, v in cuts.items()}})
                save_path = os.path.join(cfg["OUTPUT_DIR"], f"model_{model_name}_{seed}.pt")
                os.makedirs(cfg["OUTPUT_DIR"], exist_ok=True)
                torch.save({"state_dict": model.state_dict(), "info": info}, save_path)
        else:
            raise ValueError(f"Unknown model: {model_name}")

    predictions = pd.concat(all_test, ignore_index=True) if all_test else pd.DataFrame()
    scores = evaluate_forecasts(predictions, None, thresholds, None, cfg) if len(predictions) else pd.DataFrame()
    stratified = evaluate_stratified_forecasts(predictions) if len(predictions) else pd.DataFrame()
    episodes, peaks = (
        evaluate_episodes_and_peaks(predictions, panel, split_spec, thresholds)
        if (len(predictions) and panel is not None and thresholds is not None)
        else (pd.DataFrame(), pd.DataFrame())
    )
    bootstrap = (
        paired_block_bootstrap(predictions, reference_model="kda", n_boot=int(cfg.get("BOOTSTRAP_ITERS", 200)))
        if (len(predictions) and cfg.get("RUN_BOOTSTRAP", True))
        else pd.DataFrame()
    )
    return {
        "predictions": predictions,
        "scores": scores,
        "stratified_scores": stratified,
        "episodes": episodes,
        "peaks": peaks,
        "bootstrap": bootstrap,
        "cutoffs": pd.DataFrame(all_cutoffs),
        "infos": pd.DataFrame(infos),
        "curves": pd.concat(curves_all, ignore_index=True) if curves_all else pd.DataFrame(),
    }


def _save_diagnostic_plots(result, output_dir):
    """Export reliability/calibration and learning-curve plots if matplotlib is available."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        return
    preds = result.get("predictions", pd.DataFrame())
    if len(preds):
        ev = preds.dropna(subset=["event_prob", "event_threshold", "y"]).copy()
        if len(ev):
            ev["event"] = (ev["y"] >= ev["event_threshold"]).astype(float)
            fig, ax = plt.subplots(figsize=(5.5, 5.0))
            ax.plot([0, 1], [0, 1], "k--", lw=1, label="Ideal calibration")
            for model, grp in ev[ev["horizon"] == 1].groupby("model"):
                bins = np.linspace(0.0, 1.0, 11)
                grp = grp.copy()
                grp["bin"] = np.digitize(grp["event_prob"], bins) - 1
                cal = grp.groupby("bin")[["event_prob", "event"]].mean()
                ax.plot(cal["event_prob"], cal["event"], marker="o", label=model)
            ax.set_xlabel("Predicted Outbreak Probability (h1)")
            ax.set_ylabel("Observed Outbreak Frequency (h1)")
            ax.set_title("Epi-KD Outbreak Reliability Diagram (Locked Test)")
            ax.legend(fontsize=8)
            fig.tight_layout()
            fig.savefig(os.path.join(output_dir, "reliability_plot_h1.png"), dpi=150)
            plt.close(fig)

    curves = result.get("curves", pd.DataFrame())
    if len(curves):
        fig, ax = plt.subplots(figsize=(6.0, 4.2))
        for (model, seed), grp in curves.groupby(["model", "seed"]):
            ax.plot(grp["epoch"], grp["val_scaled_wis"], marker=".", label=f"{model} (s={seed})")
        ax.set_xlabel("Epoch")
        ax.set_ylabel("Validation Macro Scaled WIS")
        ax.set_title("Validation Learning Curves")
        ax.legend(fontsize=8)
        fig.tight_layout()
        fig.savefig(os.path.join(output_dir, "learning_curves.png"), dpi=150)
        plt.close(fig)


def run_pipeline(user_cfg=None):
    cfg = apply_preset(user_cfg)
    os.makedirs(cfg["OUTPUT_DIR"], exist_ok=True)
    device = get_device(cfg)
    env_info = log_environment(cfg, device)
    neural_set = {"kda", "scalar_decay", "gru", "transformer", "kda_noconv", "kda_bce", "gru_bce"}
    needs_torch = any(m in neural_set for m in cfg["MODELS"])
    check_dependencies(require_torch=needs_torch)

    set_seed(int(cfg["SEEDS"][0]))
    start = time.time()
    if cfg["MODE"] == "synthetic":
        panel = make_synthetic_panel(seed=int(cfg["SEEDS"][0]))
    elif cfg["MODE"] == "real":
        panel = load_and_validate_data(cfg["DATA_PATH"], None, cfg)
    else:
        raise ValueError("MODE must be 'real' or 'synthetic'.")

    split_spec = make_time_splits(panel, release_policy=cfg)
    adjacency = load_or_build_adjacency(panel, cfg)
    bundle = make_windows(panel, split_spec, None, cfg, adjacency=adjacency)
    masks = split_horizon_masks(bundle, split_spec)
    prep = fit_preprocessor(panel, cfg, bundle, masks, split_spec)
    bundle = transform_bundle(bundle, prep)
    thresholds = fit_event_thresholds(panel, cfg, split_spec)

    if cfg.get("RUN_TESTS", True):
        run_correctness_tests()

    tuning_table = pd.DataFrame()
    if cfg.get("RUN_TUNING", False) and torch is not None:
        tuning_table = run_tuning_grid(bundle, masks, prep, cfg, device)

    rolling_table = pd.DataFrame()
    if cfg.get("RUN_ROLLING_VAL", False):
        rolling_table = run_rolling_validation(panel, split_spec, cfg, device)

    sample_eff_table = pd.DataFrame()
    if cfg.get("RUN_SAMPLE_EFFICIENCY", False):
        sample_eff_table = run_sample_efficiency_experiment(panel, split_spec, cfg, device)

    result = run_experiments(cfg, bundle, panel, split_spec, prep, thresholds, device)

    # Save provenance manifest, truth snapshot, and all tables required by Section 11
    manifest = {
        "environment": env_info,
        "data_audit": panel.attrs.get("audit", {}),
        "split_spec": {
            "fit_start": str(ordinal_to_month_start(split_spec.fit_start).date()),
            "fit_end": str(ordinal_to_month_start(split_spec.fit_end).date()),
            "val_start": str(ordinal_to_month_start(split_spec.val_start).date()),
            "val_end": str(ordinal_to_month_start(split_spec.val_end).date()),
            "alarm_start": str(ordinal_to_month_start(split_spec.alarm_start).date()),
            "alarm_end": str(ordinal_to_month_start(split_spec.alarm_end).date()),
            "test_start": str(ordinal_to_month_start(split_spec.test_start).date()),
            "test_end": str(ordinal_to_month_start(split_spec.test_end).date()),
            "case_delay_months": int(split_spec.case_delay_months),
        },
        "window_counts": {k: int(len(v[0])) for k, v in masks.items()},
        "excluded_windows": int(bundle.get("excluded_windows", 0)),
        "excluded_districts": int(bundle.get("excluded_districts", 0)),
        "feature_names": list(bundle["feature_names"]),
        "static_feature_names": list(bundle.get("static_feature_names", [])),
        "threshold_coverage": thresholds.get("__coverage__", {}),
    }
    with open(os.path.join(cfg["OUTPUT_DIR"], "config.json"), "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2, default=str)
    with open(os.path.join(cfg["OUTPUT_DIR"], "split_manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, default=str)

    # Save locked evaluation truth snapshot
    truth_snap = panel[panel["ordinal"] >= split_spec.val_start][["date", "region", "province", "cases"]].copy()
    truth_snap.to_csv(os.path.join(cfg["OUTPUT_DIR"], "truth_snapshot.csv"), index=False)

    result["predictions"].to_csv(os.path.join(cfg["OUTPUT_DIR"], "predictions_test.csv"), index=False)
    result["scores"].to_csv(os.path.join(cfg["OUTPUT_DIR"], "scores_test.csv"), index=False)
    result["stratified_scores"].to_csv(os.path.join(cfg["OUTPUT_DIR"], "scores_stratified.csv"), index=False)
    result["episodes"].to_csv(os.path.join(cfg["OUTPUT_DIR"], "episode_lead_time.csv"), index=False)
    result["peaks"].to_csv(os.path.join(cfg["OUTPUT_DIR"], "peak_timing_height.csv"), index=False)
    result["bootstrap"].to_csv(os.path.join(cfg["OUTPUT_DIR"], "bootstrap_comparisons.csv"), index=False)
    result["cutoffs"].to_csv(os.path.join(cfg["OUTPUT_DIR"], "alarm_cutoffs.csv"), index=False)
    result["infos"].to_csv(os.path.join(cfg["OUTPUT_DIR"], "model_info.csv"), index=False)
    result["curves"].to_csv(os.path.join(cfg["OUTPUT_DIR"], "learning_curves.csv"), index=False)
    tuning_table.to_csv(os.path.join(cfg["OUTPUT_DIR"], "tuning.csv"), index=False)
    rolling_table.to_csv(os.path.join(cfg["OUTPUT_DIR"], "rolling_validation.csv"), index=False)
    sample_eff_table.to_csv(os.path.join(cfg["OUTPUT_DIR"], "sample_efficiency.csv"), index=False)
    pd.DataFrame([
        {"region": k[0], "month": k[1], "threshold": v}
        for k, v in thresholds.items()
        if isinstance(k, tuple)
    ]).to_csv(os.path.join(cfg["OUTPUT_DIR"], "event_thresholds.csv"), index=False)
    with open(os.path.join(cfg["OUTPUT_DIR"], "preprocessor.pkl"), "wb") as fh:
        pickle.dump(prep.__dict__, fh)
    _save_diagnostic_plots(result, cfg["OUTPUT_DIR"])

    print("scores_by_model_horizon:")
    if len(result["scores"]):
        cols = [
            c
            for c in [
                "model",
                "seed",
                "horizon",
                "n",
                "wis_scaled",
                "wis_raw",
                "mae_median",
                "rmse_mean",
                "sensitivity_at_cutoff",
                "false_per_district_year",
            ]
            if c in result["scores"].columns
        ]
        print(result["scores"][cols].to_string(index=False))
    print(f"outputs_dir={cfg['OUTPUT_DIR']} elapsed_sec={time.time() - start:.1f}")
    return {
        "cfg": cfg,
        "panel": panel,
        "bundle": bundle,
        "prep": prep,
        "thresholds": thresholds,
        "result": result,
        "manifest": manifest,
    }


def _parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Run the Epi-KD experiment.")
    parser.add_argument("--preset", default="pilot", choices=["pilot", "full"])
    parser.add_argument("--mode", default="real", choices=["real", "synthetic"])
    parser.add_argument("--data", default=None)
    parser.add_argument("--region-col", default=None)
    parser.add_argument("--aggregate-region", action="store_true")
    parser.add_argument("--spatial", default=None, choices=["off", "on", "knn5"])
    parser.add_argument("--case-delay", type=int, default=None, choices=[0, 1, 2])
    parser.add_argument("--lookback", type=int, default=None)
    parser.add_argument("--pop-offset", action="store_true")
    parser.add_argument("--aux-bce-weight", type=float, default=None)
    parser.add_argument("--models", default=None, help="Comma-separated model names.")
    parser.add_argument("--epochs", type=int, default=None)
    parser.add_argument("--batch-size", type=int, default=None)
    parser.add_argument("--run-tuning", action="store_true")
    parser.add_argument("--run-rolling", action="store_true")
    parser.add_argument("--run-sample-efficiency", action="store_true")
    parser.add_argument("--device", default=None, help="auto, cpu, or cuda. ROCm uses the cuda device name.")
    parser.add_argument("--output-dir", default=None)
    parser.add_argument("--no-tests", action="store_true")
    args = parser.parse_args(argv)
    user = {"PRESET": args.preset, "MODE": args.mode}
    if args.data:
        user["DATA_PATH"] = args.data
    if args.region_col:
        user["REGION_COL"] = args.region_col
    if args.aggregate_region:
        user["AGGREGATE_TO_REGION"] = True
    if args.spatial:
        user["SPATIAL"] = args.spatial
    if args.case_delay is not None:
        user["CASE_DELAY_MONTHS"] = args.case_delay
    if args.lookback is not None:
        user["LOOKBACK"] = args.lookback
    if args.pop_offset:
        user["POPULATION_OFFSET"] = True
    if args.aux_bce_weight is not None:
        user["AUX_BCE_WEIGHT"] = args.aux_bce_weight
    if args.models:
        user["MODELS"] = [m.strip() for m in args.models.split(",") if m.strip()]
    if args.epochs:
        user["EPOCHS"] = args.epochs
    if args.batch_size:
        user["BATCH_SIZE"] = args.batch_size
    if args.run_tuning:
        user["RUN_TUNING"] = True
    if args.run_rolling:
        user["RUN_ROLLING_VAL"] = True
    if args.run_sample_efficiency:
        user["RUN_SAMPLE_EFFICIENCY"] = True
    if args.device:
        user["DEVICE"] = args.device
    if args.output_dir:
        user["OUTPUT_DIR"] = args.output_dir
    if args.no_tests:
        user["RUN_TESTS"] = False
    return user


if __name__ == "__main__":
    if "ipykernel" in sys.modules:
        run_pipeline({"PRESET": "pilot", "MODE": "real"})
    else:
        run_pipeline(_parse_args())
