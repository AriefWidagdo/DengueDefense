"""Isolated CPU inference for the trusted EpiKD Tree and KDA research artifacts.

The public entry point accepts only a user-supplied monthly CSV byte string. It
never reads a bundled panel to fill missing history, never loads a user pickle,
and never uses trap-count fields. ``assets_root`` is the local EpiKD project root
containing the explicitly named, integrity-checked research artifacts.
"""
from __future__ import annotations

import csv
import hashlib
import importlib.util
import io
import json
import math
import re
import sys
from pathlib import Path
from typing import Any


MAX_PANEL_BYTES = 32 * 1024 * 1024
MAX_PANEL_ROWS = 300_000
LOOKBACK = 24
HORIZONS = 3
MIN_OBSERVED_CASES = 12
CLIMATE_COLUMNS = ("rainfall", "tmin", "tmax", "dry_days", "oni")
STATIC_COLUMNS = ("latitude", "longitude", "mean_mdpl")
DYNAMIC_FEATURES = (
    "log_cases", "log_case_scale", "case_obs", "case_age", "month_sin", "month_cos",
    "rainfall", "rainfall_obs", "tmin", "tmin_obs", "tmax", "tmax_obs",
    "dry_days", "dry_days_obs", "oni", "oni_obs", "neighbor_log_inc",
    "neighbor_coverage", "neighbor_avail",
)
STATIC_FEATURES = (
    "log_pop", "log_pop_missing", "latitude", "latitude_missing", "longitude",
    "longitude_missing", "mean_mdpl", "mean_mdpl_missing", "is_island",
)
QUANTILE_LEVELS = (0.025, 0.10, 0.25, 0.50, 0.75, 0.90, 0.975)

# The KDA output did not ship its own SHA256SUMS file. Pin the local trusted
# checkpoint/preprocessor/config bytes so a different or partial checkpoint is
# rejected rather than loaded as if it were the model described here.
KDA_TRUSTED_SHA256 = {
    "model_kda_17.pt": "a6ecc0302cdf2367f711b94868176d3d0401d1b162aa574afcef39e204b7049e",
    "preprocessor.pkl": "624bc56a46848fd75ae4b9be41ab0cdbe5d2de9f5a3021c5142e1191d259a1ea",
    "config.json": "52df133d5e80b077dcbc5c7d048b05b552b25a30a0e4a2e14504fd9c80d7f80a",
}
ADJACENCY_SHA256 = "effc4a0e368df032f6ec0114bf46aefd7081e46ded129550cbac7b225b80b3c2"
GEODATA_CANONICAL_SHA256 = "6c5e88bcc8fe17b105f328cc537a0c5ff0c92a7cb37d8e011fe4976a6b7aec12"


class ForecastValidationError(ValueError):
    """Safe, non-echoing validation error for a forecast request."""


class ForecastUnavailableError(RuntimeError):
    """The trusted model files or numerical runtime are unavailable."""


def _fail(message: str) -> None:
    raise ForecastValidationError(message)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _canonical_sha256(data: bytes) -> str:
    return hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest()


def _safe_asset_path(path: Path) -> Path:
    if not path.is_file():
        _fail("Trusted forecast assets are missing or incomplete.")
    return path


def _verify_tree_checksums(tree_dir: Path) -> None:
    marker = _safe_asset_path(tree_dir / "COMPLETE.json")
    sums = _safe_asset_path(tree_dir / "SHA256SUMS.txt")
    try:
        marker.read_bytes()
        lines = sums.read_text(encoding="utf-8").splitlines()
        if not lines:
            _fail("Trusted forecast assets are missing or incomplete.")
        seen: set[str] = set()
        for line in lines:
            fields = line.strip().split(None, 1)
            if len(fields) != 2 or not re.fullmatch(r"[0-9a-fA-F]{64}", fields[0]):
                _fail("Trusted forecast assets failed integrity validation.")
            relative = fields[1].lstrip("* ").strip()
            rel_path = Path(relative)
            if rel_path.is_absolute() or ".." in rel_path.parts or relative in seen:
                _fail("Trusted forecast assets failed integrity validation.")
            seen.add(relative)
            target = tree_dir / rel_path
            if not target.is_file() or _sha256(target) != fields[0].lower():
                _fail("Trusted forecast assets failed integrity validation.")
        required = {
            "model_bundle.pkl", "native/manifest.json", "adjacency.npz", "feature_pipeline.py",
            "lightgbm_artifact.py", "native/h1_mean.txt", "native/h2_mean.txt",
            "native/h3_mean.txt",
        }
        if not required.issubset(seen):
            _fail("Trusted forecast assets failed integrity validation.")
        return seen
    except ForecastValidationError:
        raise
    except Exception:
        _fail("Trusted forecast assets failed integrity validation.")


def _module_from_path(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        _fail("A required trusted inference component is unavailable.")
    module = importlib.util.module_from_spec(spec)
    # Some reference modules consult sys.modules while defining dataclasses.
    previous = sys.modules.get(name)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        if previous is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = previous
        _fail("A required trusted inference component is unavailable.")
    return module


def _load_reference(project_root: Path, expected_code_hash: str):
    source_path = _safe_asset_path(project_root / "EpiKD_Experiment.py")
    try:
        source = source_path.read_bytes()
    except Exception:
        _fail("The trusted feature pipeline is unavailable.")
    if _canonical_sha256(source) != expected_code_hash:
        _fail("The saved feature-pipeline code does not match the trusted export.")
    return _module_from_path("_vectordock_epikd_reference", source_path)


def _load_tree_assets(project_root: Path):
    import numpy as np

    tree_dir = project_root / "outputs_epikd_tree_export"
    checked_files = _verify_tree_checksums(tree_dir)
    try:
        manifest = json.loads((tree_dir / "native" / "manifest.json").read_text(encoding="utf-8"))
        if manifest.get("format_version") != 1:
            _fail("The trusted Tree export has an unsupported format.")
        expected_code_hash = manifest.get("feature_code_canonical_sha256")
        if not isinstance(expected_code_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_code_hash):
            _fail("The trusted Tree export is missing its feature-code integrity check.")
        if manifest.get("schema", {}).get("lookback") != LOOKBACK:
            _fail("The trusted Tree export has an incompatible history window.")
        schema = manifest.get("schema", {})
        if schema.get("dynamic_features") != list(DYNAMIC_FEATURES):
            _fail("The trusted Tree export has an incompatible feature order.")
        if schema.get("static_features") != list(STATIC_FEATURES):
            _fail("The trusted Tree export has an incompatible static-feature order.")
        config = manifest.get("config", {})
        if (config.get("SPATIAL") != "on" or int(config.get("CASE_DELAY_MONTHS", -1)) != 0
                or int(config.get("LOOKBACK", -1)) != LOOKBACK
                or int(config.get("MIN_OBSERVED_IN_LOOKBACK", -1)) != MIN_OBSERVED_CASES):
            _fail("The trusted Tree export has incompatible availability assumptions.")
        if len(manifest.get("horizons", [])) != HORIZONS or len(manifest.get("quantile_levels", [])) != 7:
            _fail("The trusted Tree export has incomplete forecast heads.")
        for fitted in manifest["horizons"]:
            model_names = [fitted.get("mean_model"), *fitted.get("quantile_models", [])]
            if len(fitted.get("quantile_models", [])) != 7:
                _fail("The trusted Tree export has incomplete quantile heads.")
            for name in model_names:
                relative = Path(str(name))
                if (relative.is_absolute() or len(relative.parts) != 1 or ".." in relative.parts
                        or f"native/{name}" not in checked_files):
                    _fail("The trusted Tree model files failed integrity validation.")
        source_snapshot = tree_dir / "feature_pipeline.py"
        if _sha256(source_snapshot) != manifest.get("feature_code_sha256"):
            _fail("The trusted Tree feature snapshot failed integrity validation.")
        reference = _load_reference(project_root, expected_code_hash)
        helper_path = _safe_asset_path(tree_dir / "lightgbm_artifact.py")
        helper = _module_from_path("_vectordock_lightgbm_artifact", helper_path)
        artifact = helper.load_native(tree_dir / "native")
        prep = reference.FrozenPreprocessor(**artifact["preprocessor"])
        adjacency = _load_full_adjacency(tree_dir / "adjacency.npz", prep.region_to_idx, np)
        _validate_vocabulary(prep, adjacency)
        return {
            "tree_dir": tree_dir,
            "manifest": manifest,
            "artifact": artifact,
            "helper": helper,
            "prep": prep,
            "reference": reference,
            "adjacency": adjacency,
            "model_id": "epikd_tree_export_v1",
        }
    except ForecastValidationError:
        raise
    except Exception:
        _fail("The trusted Tree export is missing, corrupt, or incompatible.")


def _verify_kda_assets(kda_dir: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    for name, expected in KDA_TRUSTED_SHA256.items():
        path = _safe_asset_path(kda_dir / name)
        try:
            if _sha256(path) != expected:
                _fail("The trusted KDA checkpoint failed integrity validation.")
        except ForecastValidationError:
            raise
        except Exception:
            _fail("The trusted KDA checkpoint failed integrity validation.")
    try:
        config = json.loads((kda_dir / "config.json").read_text(encoding="utf-8"))
        if (config.get("SPATIAL") != "on" or config.get("LOOKBACK") != LOOKBACK
                or config.get("HORIZONS") != HORIZONS
                or config.get("MIN_OBSERVED_IN_LOOKBACK") != MIN_OBSERVED_CASES
                or config.get("CASE_DELAY_MONTHS") != 0
                or config.get("WIDTH") != 64 or config.get("HEADS") != 2
                or config.get("LAYERS") != 2 or config.get("DROPOUT") != 0.1
                or config.get("POPULATION_OFFSET") is not False):
            _fail("The trusted KDA checkpoint has incompatible inference assumptions.")
        return config, {}
    except ForecastValidationError:
        raise
    except Exception:
        _fail("The trusted KDA configuration is unavailable or incompatible.")


def _load_kda_assets(project_root: Path, tree_assets: dict[str, Any]):
    import pickle
    import torch

    kda_dir = project_root / "outputs_epikd_fullkda_12epoch_20261027_231817"
    config, _ = _verify_kda_assets(kda_dir)
    try:
        # This pickle is a pinned, trusted local training artifact. User input is
        # never passed to pickle.load; checkpoint loading below is weights_only.
        with (kda_dir / "preprocessor.pkl").open("rb") as stream:
            prep_values = pickle.load(stream)
        if not isinstance(prep_values, dict):
            _fail("The trusted KDA preprocessing artifact is incompatible.")
        prep = tree_assets["reference"].FrozenPreprocessor(**prep_values)
        checkpoint = torch.load(kda_dir / "model_kda_17.pt", map_location="cpu", weights_only=True)
        if not isinstance(checkpoint, dict) or not isinstance(checkpoint.get("state_dict"), dict):
            _fail("The trusted KDA checkpoint is incompatible.")
        info = checkpoint.get("info", {})
        if info.get("backbone") != "kda" or info.get("seed") != 17 or info.get("params") != 90782:
            _fail("The trusted KDA checkpoint is not the expected trained KDA model.")
        _validate_vocabulary(prep, tree_assets["adjacency"])
        if (list(prep.feature_names) != list(DYNAMIC_FEATURES)
                or list(prep.static_feature_names) != list(STATIC_FEATURES)):
            _fail("The trusted KDA preprocessing feature order is incompatible.")
        if len(prep.region_to_idx) != 514 or len(prep.province_to_idx) != 38:
            _fail("The trusted KDA trained vocabulary is incompatible.")
        model = tree_assets["reference"].EpiKD(
            feature_dim=len(prep.feature_names),
            num_regions=len(prep.region_to_idx) + 1,
            num_provinces=len(prep.province_to_idx) + 1,
            static_cont_dim=len(prep.static_feature_names),
            width=int(config["WIDTH"]), heads=int(config["HEADS"]),
            layers=int(config["LAYERS"]), dropout=float(config["DROPOUT"]),
            backbone="kda", lookback=LOOKBACK, use_pop_offset=False, use_aux_bce=False,
        )
        model.load_state_dict(checkpoint["state_dict"], strict=True)
        if sum(parameter.numel() for parameter in model.parameters()) != info["params"]:
            _fail("The trusted KDA checkpoint architecture does not match its metadata.")
        model.to("cpu")
        model.eval()
        return {
            "prep": prep,
            "model": model,
            "reference": tree_assets["reference"],
            "adjacency": tree_assets["adjacency"],
            "model_id": "epikd_kda_full_12epoch_seed17",
        }
    except ForecastValidationError:
        raise
    except Exception:
        _fail("The trusted KDA checkpoint or CPU inference runtime is unavailable.")


def _fixed_adjacency(weights, codes, np):
    """Validate, but never subset, reorder, or renormalize, a saved full graph."""
    matrix = np.asarray(weights, dtype=np.float64)
    ordered_codes = [str(code) for code in codes]
    if (matrix.shape != (len(ordered_codes), len(ordered_codes)) or not ordered_codes
            or len(ordered_codes) != len(set(ordered_codes)) or not np.isfinite(matrix).all()
            or (matrix < 0).any() or not np.allclose(np.diag(matrix), 0.0)):
        _fail("The trained geographic graph is invalid.")
    row_sums = matrix.sum(axis=1)
    if not np.all((np.isclose(row_sums, 0.0) | np.isclose(row_sums, 1.0, atol=1e-6))):
        _fail("The trained geographic graph is not in its saved normalized form.")
    return {
        "W": matrix.astype(np.float32, copy=False),
        "regions": ordered_codes,
        "region_to_idx": {code: index for index, code in enumerate(ordered_codes)},
        "mode": "shared_border",
    }


def _load_full_adjacency(path: Path, region_to_idx: dict[str, int], np):
    """Keep the original full graph/order; never subset or renormalize for input rows."""
    if _sha256(path) != ADJACENCY_SHA256:
        _fail("The trained geographic graph failed integrity validation.")
    try:
        with np.load(path, allow_pickle=False) as data:
            weights = np.asarray(data["W"], dtype=np.float64)
            codes = [str(code) for code in data["district_codes"].tolist()]
        adjacency = _fixed_adjacency(weights, codes, np)
        if set(codes) != set(region_to_idx):
            _fail("The trained geographic graph and district vocabulary do not match.")
        return adjacency
    except ForecastValidationError:
        raise
    except Exception:
        _fail("The trained geographic graph is unavailable or invalid.")


def _validate_vocabulary(prep, adjacency: dict[str, Any]) -> None:
    mapping = prep.region_to_idx
    if (not isinstance(mapping, dict) or len(mapping) != 514
            or sorted(mapping.values()) != list(range(1, 515))
            or set(mapping) != set(adjacency["regions"])):
        _fail("The saved district vocabulary and geographic graph do not match.")


def _normalize_region(value: Any) -> str:
    if value is None:
        _fail("The panel contains an invalid district code.")
    text = str(value).strip()
    if not text:
        _fail("The panel contains an invalid district code.")
    # CSV readers commonly parse a code like 31.10 as numeric 31.1. Restore
    # its trailing zero, but never round an invalid code to another district.
    match = re.fullmatch(r"(\d{1,2})\.(\d{1,2})", text)
    if match:
        return f"{int(match.group(1)):02d}.{match.group(2).ljust(2, '0')}"
    _fail("The panel contains an invalid district code.")


def _load_region_provinces(path: Path, region_vocabulary) -> dict[str, str]:
    """Load the pinned, one-row-per-district training geography."""
    content = _safe_asset_path(path).read_bytes()
    if _canonical_sha256(content) != GEODATA_CANONICAL_SHA256:
        _fail("The trusted district geography failed integrity validation.")
    mapping: dict[str, str] = {}
    for row in csv.DictReader(io.StringIO(content.decode("utf-8-sig"), newline="")):
        region = _normalize_region(row.get("bps_kode_2025"))
        province = (row.get("province") or "").strip()
        if not province or region in mapping:
            _fail("The trusted district geography is inconsistent.")
        mapping[region] = province
    if set(mapping) != set(region_vocabulary):
        _fail("The trusted district geography does not match the trained vocabulary.")
    return mapping


def _parse_panel(panel_csv: bytes, region_vocabulary, province_vocabulary, region_provinces=None):
    """Parse a bounded canonical monthly panel; discard every unrecognized field."""
    import numpy as np
    import pandas as pd

    if not isinstance(panel_csv, bytes) or not panel_csv or len(panel_csv) > MAX_PANEL_BYTES:
        _fail("The monthly panel is empty or exceeds the supported input size.")
    try:
        text = panel_csv.decode("utf-8-sig")
        header = next(csv.reader(io.StringIO(text, newline="")), None)
        if not header or len(header) != len(set(header)):
            _fail("The monthly panel has an invalid or duplicated header.")
        raw = pd.read_csv(io.StringIO(text), low_memory=False, on_bad_lines="error")
    except ForecastValidationError:
        raise
    except Exception:
        _fail("The monthly panel is not a valid UTF-8 CSV.")
    if len(raw) > MAX_PANEL_ROWS:
        _fail("The monthly panel exceeds the supported row limit.")
    id_columns = [name for name in ("bps_kode_2025", "region", "region_id") if name in raw.columns]
    if not id_columns:
        _fail("The monthly panel is missing its district-code column.")
    region_col = id_columns[0]
    if len(id_columns) > 1:
        try:
            reference_ids = raw[region_col].map(_normalize_region)
            for alias in id_columns[1:]:
                if not raw[alias].map(_normalize_region).equals(reference_ids):
                    _fail("The monthly panel contains conflicting district-code columns.")
        except ForecastValidationError:
            raise
        except Exception:
            _fail("The monthly panel contains conflicting district-code columns.")
    required = {"date", region_col, "cases", "province", "population", *CLIMATE_COLUMNS,
                *STATIC_COLUMNS, "is_island"}
    if not required.issubset(raw.columns):
        _fail("The monthly panel is missing required climate, case, or geographic columns.")
    # Intentionally project only trusted model inputs. In particular, trap counts,
    # labels, death counts, and arbitrary extra fields cannot reach either model.
    columns = ["date", region_col, "cases", "province", "population", *CLIMATE_COLUMNS,
               *STATIC_COLUMNS, "is_island"]
    panel = raw.loc[:, columns].copy()
    panel = panel.rename(columns={region_col: "region"})
    try:
        parsed_dates = pd.to_datetime(panel["date"], errors="coerce", utc=False)
        if parsed_dates.isna().any() or not hasattr(parsed_dates, "dt") or parsed_dates.dt.tz is not None:
            _fail("The monthly panel contains an invalid or timezone-aware date.")
        panel["date"] = parsed_dates.dt.to_period("M").dt.to_timestamp()
        panel["ordinal"] = panel["date"].dt.year * 12 + panel["date"].dt.month - 1
        panel["region"] = panel["region"].map(_normalize_region)
        panel["province"] = panel["province"].astype("string").str.strip()
        if panel["province"].isna().any() or (panel["province"] == "").any():
            _fail("The monthly panel contains a missing province label.")
        for name in ("cases", "population", *CLIMATE_COLUMNS, *STATIC_COLUMNS, "is_island"):
            original = panel[name]
            numeric = pd.to_numeric(original, errors="coerce")
            nonempty = original.notna() & original.astype(str).str.strip().ne("")
            if (nonempty & numeric.isna()).any() or np.isinf(numeric.dropna().to_numpy(dtype=float)).any():
                _fail("The monthly panel contains a nonnumeric or non-finite model input.")
            panel[name] = numeric.astype(float)
    except ForecastValidationError:
        raise
    except Exception:
        _fail("The monthly panel contains invalid dates or numeric values.")

    if panel.empty or panel.duplicated(["region", "ordinal"]).any():
        _fail("The monthly panel is empty or contains duplicate district-month rows.")
    # The reference graph uses a dense calendar range across districts. Bound
    # that range independently of byte and row limits to prevent a sparse CSV
    # with distant dates from allocating an enormous matrix.
    if int(panel["ordinal"].max() - panel["ordinal"].min()) >= 600:
        _fail("The monthly panel must cover less than 50 years per request.")
    if not set(panel["region"].unique()).issubset(set(region_vocabulary)):
        _fail("The monthly panel contains a district outside the trained vocabulary.")
    if not set(panel["province"].unique()).issubset(set(province_vocabulary)):
        _fail("The monthly panel contains a province outside the trained vocabulary.")
    if region_provinces is not None and (panel["region"].map(region_provinces) != panel["province"]).any():
        _fail("A province does not match its trained district BPS code.")
    cases = panel["cases"].dropna().to_numpy(dtype=float)
    if ((cases < 0).any() or (cases > 10_000_000).any()
            or not np.allclose(cases, np.rint(cases), atol=1e-8, rtol=0)):
        _fail("Case counts must be nonnegative, integer-valued monthly counts within supported bounds.")
    population = panel["population"].dropna().to_numpy(dtype=float)
    if ((population <= 0).any() or (population > 1_000_000_000).any()):
        _fail("Population values are outside supported physical bounds.")
    physical_bounds = {
        "rainfall": (0.0, 10_000.0, "Rainfall must be 0–10,000 mm/month."),
        "tmin": (-10.0, 45.0, "Minimum temperature must be -10–45 °C."),
        "tmax": (-5.0, 60.0, "Maximum temperature must be -5–60 °C."),
        "dry_days": (0.0, 31.0, "Dry days must be between 0 and 31."),
        "oni": (-5.0, 5.0, "ONI must be between -5 and 5 °C."),
        "latitude": (-90.0, 90.0, "Latitude must be between -90 and 90 degrees."),
        "longitude": (-180.0, 180.0, "Longitude must be between -180 and 180 degrees."),
        "mean_mdpl": (-500.0, 9_000.0, "Elevation must be -500–9,000 metres."),
        "is_island": (0.0, 1.0, "The island indicator must be 0 or 1."),
    }
    for name, (lower, upper, message) in physical_bounds.items():
        vals = panel[name].dropna().to_numpy(dtype=float)
        if ((vals < lower).any() or (vals > upper).any()):
            _fail(message)
    if ((panel["is_island"].dropna() % 1) != 0).any():
        _fail("The island indicator must be binary.")
    known_dry = panel.loc[panel["dry_days"].notna()].copy()
    dry_days = known_dry["dry_days"].to_numpy(dtype=float)
    dry_date = known_dry["date"].dt.days_in_month.to_numpy(dtype=float)
    dry_ok = np.isfinite(dry_days) & np.isfinite(dry_date) & (dry_days % 1 == 0) & (dry_days <= dry_date)
    if not bool(np.all(dry_ok)):
        _fail("Dry days must be a whole number within the number of days in the month.")
    both_temps = (panel["tmin"].notna() & panel["tmax"].notna()).to_numpy()
    temps = panel[["tmin", "tmax"]].to_numpy()
    if bool(np.any(np.isfinite(temps[both_temps, 0]) & np.isfinite(temps[both_temps, 1]) & (temps[both_temps, 0] > temps[both_temps, 1]))):
        _fail("Minimum temperature cannot exceed maximum temperature.")

    panel = panel.sort_values(["region", "ordinal"], kind="stable").reset_index(drop=True)
    # These are static in the fitted pipeline (which reads the first monthly row).
    # Reject conflicting or silently-lost first-row values instead of guessing.
    for _, group in panel.groupby("region", sort=False):
        for name in ("province", *STATIC_COLUMNS, "is_island"):
            values = group[name].dropna().unique()
            if len(values) > 1:
                _fail("A district has conflicting static geography or province values.")
            if len(values) == 1 and pd.isna(group.iloc[0][name]):
                _fail("Static geography must be present consistently from the first supplied month.")
    panel.attrs["climate_cols"] = list(CLIMATE_COLUMNS)
    panel.attrs["static_geo_cols"] = list(STATIC_COLUMNS)
    return panel


def _validate_issue(issue_date: str, pd):
    if not isinstance(issue_date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", issue_date):
        _fail("Issue date must be a month-end date in YYYY-MM-DD format.")
    try:
        issue = pd.Timestamp(issue_date)
        if (issue.tzinfo is not None or issue.strftime("%Y-%m-%d") != issue_date
                or issue.normalize() != issue.to_period("M").end_time.normalize()):
            _fail("Issue date must be a month-end date in YYYY-MM-DD format.")
        return issue
    except ForecastValidationError:
        raise
    except Exception:
        _fail("Issue date is outside the supported calendar range.")


def _validate_requested_history(panel, selected_region: str, issue, pd):
    issue_ord = int(issue.year * 12 + issue.month - 1)
    region_rows = panel.loc[panel["region"] == selected_region]
    if region_rows.empty:
        _fail("The selected district has no user-supplied monthly history.")
    supplied = set(region_rows["ordinal"].astype(int).tolist())
    if issue_ord not in supplied:
        _fail("The selected district must include the issue month, even when its case count is missing.")
    history_ord = list(range(issue_ord - LOOKBACK + 1, issue_ord + 1))
    if any(ordinal not in supplied for ordinal in history_ord):
        _fail("The selected district must have a continuous 24-month calendar history ending at issue date.")
    window = region_rows.loc[region_rows["ordinal"].between(history_ord[0], history_ord[-1])]
    if int(window["cases"].notna().sum()) < MIN_OBSERVED_CASES:
        _fail("The selected district does not meet the trained observed-case-history eligibility rule.")
    return region_rows


def _prepare_history(panel, selected_region: str, issue, loaded: dict[str, Any], pd):
    import numpy as np

    region_rows = _validate_requested_history(panel, selected_region, issue, pd)
    prep = loaded["prep"]
    if selected_region not in prep.region_to_idx:
        _fail("Cold-start districts are unsupported by this trained model.")
    target_provinces = region_rows["province"].unique()
    if len(target_provinces) != 1 or str(target_provinces[0]) not in prep.province_to_idx:
        _fail("The selected district's province is outside the trained vocabulary.")
    if pd.isna(region_rows.iloc[0]["is_island"]):
        _fail("The selected district is missing a required trained geography value.")
    cfg = dict(
        loaded["reference"].DEFAULT_CFG,
        LOOKBACK=LOOKBACK,
        HORIZONS=HORIZONS,
        MIN_OBSERVED_IN_LOOKBACK=MIN_OBSERVED_CASES,
        CASE_DELAY_MONTHS=0,
        SPATIAL="on",
        ADJACENCY_PATH=str(loaded.get("tree_dir", Path(".")) / "adjacency.npz"),
    )
    try:
        batch = loaded["reference"].build_history_as_of(
            panel, [selected_region], issue, preprocess=prep,
            adjacency=loaded["adjacency"], cfg=cfg,
        )
        if list(panel.attrs.get("climate_cols", [])) != list(CLIMATE_COLUMNS):
            _fail("The supplied climate columns do not match the trained feature schema.")
        if not np.isfinite(batch["X"]).all() or not np.isfinite(batch["static_cont"]).all():
            _fail("The saved preprocessing did not produce finite model inputs.")
        batch["feature_names"] = list(loaded.get("manifest", {}).get("schema", {}).get("dynamic_features", DYNAMIC_FEATURES))
        batch["static_feature_names"] = list(loaded.get("manifest", {}).get("schema", {}).get("static_features", STATIC_FEATURES))
        return batch
    except ForecastValidationError:
        raise
    except Exception:
        _fail("The supplied history cannot be transformed with the saved as-of feature pipeline.")


def _finite_number(value: Any) -> float:
    number = float(value)
    if not math.isfinite(number):
        _fail("The model produced a non-finite forecast; no result is available.")
    return number


def _format_result(model: str, model_id: str, selected_region: str, issue, mu, kappa, quantiles, levels, kind):
    predictions = []
    for horizon in range(HORIZONS):
        target = issue.to_period("M") + horizon + 1
        predictions.append({
            "horizon_months": horizon + 1,
            "target_month": str(target.start_time.date()),
            "expected_cases": _finite_number(mu[horizon]),
            "uncertainty": {
                "kind": kind,
                "nb_size": _finite_number(kappa[horizon]),
                "quantiles": {
                    f"q{level:g}": _finite_number(quantiles[horizon][index])
                    for index, level in enumerate(levels)
                },
                "nominal_levels": list(levels),
                "calibration_note": "Research-model uncertainty; prospective calibration and coverage are not established.",
            },
        })
    limitations = [
        "These are retrospective research-model forecasts, not verified live surveillance truth or proven future accuracy.",
        "The fitted protocol assumes zero case-reporting delay and retains its retrospective climate/ONI availability assumptions.",
        "No bundled historical panel is used to fill user-supplied history; all required inputs come from this request.",
        "The saved preprocessing fills some missing values with training-derived statistics; those are not measured inputs.",
        "The trained district vocabulary is closed; unseen districts and cold-start forecasts are rejected.",
        "The fixed trained neighbor graph is preserved: absent neighboring districts remain missing/partially covered, never renormalized away.",
        "Trap counts and other unrecognized extra CSV fields are excluded from model inputs.",
    ]
    if model == "tree":
        limitations.append("Tree quantile predictions and the saved NB dispersion are separate baseline outputs, not one calibrated predictive distribution.")
    else:
        limitations.append("The KDA NB2 quantiles are model-distribution outputs, not evidence of calibrated prospective intervals.")
    return {
        "model": model,
        "model_id": model_id,
        "origin": str(issue.date()),
        "issue_date": str(issue.date()),
        "district": selected_region,
        "predictions": predictions,
        "limitations": limitations,
    }


def predict_forecast(*, panel_csv: bytes, region: str, issue_date: str, model: str, assets_root: Path) -> dict:
    """Return 1--3 month district dengue case forecasts using saved CPU artifacts.

    CSV contract (monthly rows): ``date`` (month represented by any unambiguous
    calendar date), one district ID column (``bps_kode_2025``, ``region`` or
    ``region_id``), ``cases``, ``province``, ``population``, ``rainfall`` (mm per
    month), ``tmin`` and ``tmax`` (degrees Celsius), ``dry_days`` (days), ``oni``,
    ``latitude``, ``longitude``, ``mean_mdpl`` (metres), and ``is_island`` (0/1).
    A column must exist even when some monthly values are unavailable; numeric
    missing values are represented by empty CSV cells. Extra columns, including
    any trap counts, are ignored. The CSV must carry the full supplied monthly
    panel needed for the selected district and neighbor features.

    ``assets_root`` is the EpiKD project root. Errors use
    :class:`ForecastValidationError` with safe messages that never include CSV
    contents, row values, or local paths.
    """
    if model not in ("tree", "epikd"):
        _fail("Model must be exactly 'tree' or 'epikd'.")
    if not isinstance(region, str):
        _fail("District must be a trained district code.")
    try:
        import numpy as np
        import pandas as pd
        import scipy  # noqa: F401 -- reference preprocessing/quantiles dependency
    except Exception as error:
        raise ForecastUnavailableError("CPU forecast dependencies are unavailable.") from error
    issue = _validate_issue(issue_date, pd)
    selected_region = _normalize_region(region)
    try:
        project_root = Path(assets_root).resolve()
    except Exception as error:
        raise ForecastUnavailableError("The trusted forecast asset root is unavailable.") from error
    if not project_root.is_dir():
        raise ForecastUnavailableError("The trusted forecast asset root is unavailable.")

    # Load and verify the Tree export first: its immutable native metadata pins
    # the exact shared feature implementation and full fixed graph also used by KDA.
    try:
        tree_assets = _load_tree_assets(project_root)
        if model == "tree":
            loaded = tree_assets
        else:
            import torch  # noqa: F401
            loaded = _load_kda_assets(project_root, tree_assets)
    except Exception as error:
        raise ForecastUnavailableError("Trusted model assets or the CPU runtime are unavailable.") from error
    if selected_region not in loaded["prep"].region_to_idx:
        _fail("Cold-start districts are unsupported by this trained model.")
    try:
        region_provinces = _load_region_provinces(
            project_root / "data" / "epikd_geodata_static.csv", loaded["prep"].region_to_idx,
        )
    except Exception as error:
        raise ForecastUnavailableError("The trusted district geography is unavailable.") from error
    panel = _parse_panel(
        panel_csv,
        loaded["prep"].region_to_idx,
        loaded["prep"].province_to_idx,
        region_provinces,
    )
    # Fixed graph uses its complete saved ordering/weights. The reference spatial
    # lookup treats absent districts/population/cases as unavailable coverage.
    batch = _prepare_history(panel, selected_region, issue, loaded, pd)

    if model == "tree":
        try:
            mu, kappa, quantiles = loaded["helper"].predict_prepared(loaded["artifact"], batch)
            mu, kappa, quantiles = mu[0], kappa[0], quantiles[0]
            levels = tuple(float(value) for value in loaded["artifact"]["quantile_levels"])
        except Exception as error:
            raise ForecastUnavailableError("CPU Tree inference failed.") from error
        kind = "separate_saved_tree_quantiles_and_nb2_size"
    else:
        try:
            torch = sys.modules.get("torch")
            # The reference tensor adapter also packages training labels, though
            # _forward never reads them. Supply an all-masked empty target solely
            # to satisfy that adapter; no user labels or fabricated cases enter inference.
            tensor_batch = dict(batch)
            tensor_batch["y"] = np.zeros((1, HORIZONS), dtype=np.float32)
            tensor_batch["y_mask"] = np.zeros((1, HORIZONS), dtype=bool)
            batch_tensors = loaded["reference"]._tensors(tensor_batch, np.array([0]), torch.device("cpu"))
            with torch.inference_mode():
                output = loaded["reference"]._forward(loaded["model"], batch_tensors)
            mu = output["mu"].cpu().numpy()[0]
            kappa = output["kappa"].cpu().numpy()[0]
            quantiles = loaded["reference"].nb_quantiles(mu, kappa)
            levels = tuple(float(value) for value in loaded["reference"].QUANTILE_LEVELS)
        except Exception as error:
            raise ForecastUnavailableError("CPU KDA inference failed.") from error
        kind = "saved_kda_nb2_predictive_quantiles"
    try:
        return _format_result(model, loaded["model_id"], selected_region, issue, mu, kappa, quantiles, levels, kind)
    except (ForecastValidationError, TypeError, ValueError, IndexError) as error:
        raise ForecastUnavailableError("The model returned an invalid forecast.") from error
