from __future__ import annotations

import csv
import io
import sys
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app import forecast_engine as engine

PROJECT_ROOT = Path(__file__).resolve().parents[4]
TREE_ARTIFACTS = PROJECT_ROOT / "outputs_epikd_tree_export"
KDA_ARTIFACTS = PROJECT_ROOT / "outputs_epikd_fullkda_12epoch_20261027_231817"
PANEL_PATH = PROJECT_ROOT / "data" / "epikd_monthly_panel_21y.csv"


def _small_csv(*, trap_count: int = 0, tmin: str = "22.0", dry_days: str = "4", duplicate: bool = False,
               start: str = "2020-01-01") -> bytes:
    import pandas as pd

    header = [
        "date", "bps_kode_2025", "cases", "province", "population", "rainfall",
        "tmin", "tmax", "dry_days", "oni", "latitude", "longitude", "mean_mdpl",
        "is_island", "trap_count",
    ]
    rows = []
    for index, date in enumerate(pd.date_range(start, periods=24, freq="MS")):
        rows.append([
            str(date.date()), "31.73", str(index % 9), "DKI Jakarta", "900000", "180",
            tmin, "30.0", dry_days, "0.2", "-6.2", "106.8", "8", "0", str(trap_count),
        ])
    if duplicate:
        rows.append(rows[-1])
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer)
    writer.writerow(header)
    writer.writerows(rows)
    return buffer.getvalue().encode("utf-8")


def _append_one_future_district_month(panel_bytes: bytes, district: str) -> bytes:
    """Extend only user-supplied input for a runtime-eligibility test, not as truth."""
    text = panel_bytes.decode("utf-8-sig")
    reader = csv.reader(io.StringIO(text, newline=""))
    header = next(reader)
    region_col = "bps_kode_2025"
    ix = {name: header.index(name) for name in ("date", region_col, "cases")}
    row_for_district = None
    for row in reader:
        if row[ix[region_col]].strip() in (district, str(float(district))):
            row_for_district = row
    if row_for_district is None:
        raise AssertionError("Expected local test-panel district is missing")
    future = list(row_for_district)
    future[ix["date"]] = "2025-01-01"
    future[ix["cases"]] = "27"
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(future)
    return panel_bytes + output.getvalue().encode("utf-8")


class ForecastValidationTests(unittest.TestCase):
    def setUp(self):
        try:
            import numpy  # noqa: F401
            import pandas  # noqa: F401
        except Exception:
            self.skipTest("NumPy and pandas are required for the isolated feature tests")

    def test_unrecognized_trap_column_is_removed_from_model_panel(self):
        first = engine._parse_panel(_small_csv(trap_count=0), {"31.73"}, {"DKI Jakarta"})
        second = engine._parse_panel(_small_csv(trap_count=987654), {"31.73"}, {"DKI Jakarta"})
        self.assertNotIn("trap_count", first.columns)
        self.assertEqual(list(first.columns), list(second.columns))
        self.assertTrue(first.equals(second))

    def test_unreasonable_celsius_and_duplicate_months_are_rejected_safely(self):
        with self.assertRaises(engine.ForecastValidationError) as raised:
            engine._parse_panel(_small_csv(tmin="82"), {"31.73"}, {"DKI Jakarta"})
        self.assertNotIn("82", str(raised.exception))
        with self.assertRaises(engine.ForecastValidationError):
            engine._parse_panel(_small_csv(duplicate=True), {"31.73"}, {"DKI Jakarta"})
        for invalid_dry_days in ("2.5", "30"):
            with self.assertRaises(engine.ForecastValidationError):
                engine._parse_panel(_small_csv(dry_days=invalid_dry_days), {"31.73"}, {"DKI Jakarta"})
        with self.assertRaises(engine.ForecastValidationError):
            engine._normalize_region("31.734")
        self.assertEqual(engine._normalize_region("31.1"), "31.10")
        wrong_province = _small_csv().replace(b"DKI Jakarta", b"Jawa Barat")
        with self.assertRaises(engine.ForecastValidationError):
            engine._parse_panel(wrong_province, {"31.73"}, {"DKI Jakarta", "Jawa Barat"}, {"31.73": "DKI Jakarta"})

    def test_fixed_full_graph_keeps_partial_neighbor_coverage(self):
        import numpy as np

        weights = np.array([[0.0, 0.6, 0.4], [1.0, 0.0, 0.0], [1.0, 0.0, 0.0]])
        graph = engine._fixed_adjacency(weights, ["A", "B", "C"], np)
        np.testing.assert_array_equal(graph["W"], weights.astype(np.float32))
        self.assertEqual(graph["regions"], ["A", "B", "C"])
        self.assertEqual(graph["region_to_idx"], {"A": 0, "B": 1, "C": 2})

        # C is absent from the supplied panel. The trained A->B weight remains
        # 0.6, not 1.0; the reference spatial builder reports partial coverage.
        base = engine._module_from_path(
            "_forecast_engine_test_reference", PROJECT_ROOT / "EpiKD_Experiment.py"
        )
        series = {
            "A": {"ords": np.array([24000]), "cases": np.array([1.0]), "pop": np.array([1000.0])},
            "B": {"ords": np.array([24000]), "cases": np.array([2.0]), "pop": np.array([1000.0])},
        }
        lookup = base._build_spatial_lookup(series, graph, 24000, 24000)
        self.assertAlmostEqual(float(lookup["cov_mat"][0, 0]), 0.6, places=6)
        self.assertNotAlmostEqual(float(lookup["cov_mat"][0, 0]), 1.0, places=6)

    def test_month_end_clock_and_required_history_are_enforced(self):
        import pandas as pd

        self.assertEqual(str(engine._validate_issue("2024-12-31", pd).date()), "2024-12-31")
        with self.assertRaises(engine.ForecastValidationError):
            engine._validate_issue("2024-12-01", pd)
        panel = engine._parse_panel(_small_csv(), {"31.73"}, {"DKI Jakarta"})
        engine._validate_requested_history(panel, "31.73", pd.Timestamp("2021-12-31"), pd)
        with self.assertRaises(engine.ForecastValidationError):
            engine._validate_requested_history(panel.iloc[:-1], "31.73", pd.Timestamp("2021-12-31"), pd)
        underobserved = panel.copy()
        underobserved.loc[underobserved.index[:13], "cases"] = float("nan")
        with self.assertRaises(engine.ForecastValidationError):
            engine._validate_requested_history(underobserved, "31.73", pd.Timestamp("2021-12-31"), pd)


try:
    import numpy  # noqa: F401
    import pandas  # noqa: F401
    import scipy  # noqa: F401
    import lightgbm  # noqa: F401
    import torch  # noqa: F401
    _HAS_OFFLINE_RUNTIME = True
except Exception:
    _HAS_OFFLINE_RUNTIME = False

_HAS_REAL_ASSETS = all(
    path.exists() for path in (
        TREE_ARTIFACTS / "COMPLETE.json",
        KDA_ARTIFACTS / "model_kda_17.pt",
        KDA_ARTIFACTS / "preprocessor.pkl",
        KDA_ARTIFACTS / "predictions_test.csv",
        PANEL_PATH,
    )
)


@unittest.skipUnless(_HAS_OFFLINE_RUNTIME, "optional CPU forecast runtime unavailable")
class IncludedArtifactSmokeTests(unittest.TestCase):
    def test_tree_and_kda_run_with_synthetic_monthly_input(self):
        for model in ("tree", "epikd"):
            with self.subTest(model=model):
                result = engine.predict_forecast(
                    panel_csv=_small_csv(), region="31.73", issue_date="2021-12-31",
                    model=model, assets_root=PROJECT_ROOT,
                )
                self.assertEqual(len(result["predictions"]), 3)
                self.assertTrue(all(item["expected_cases"] >= 0 for item in result["predictions"]))


@unittest.skipUnless(_HAS_OFFLINE_RUNTIME and _HAS_REAL_ASSETS, "offline model artifacts/runtime unavailable")
class OfflineArtifactIntegrationTests(unittest.TestCase):
    def test_tree_matches_trusted_native_export_smoke_prediction(self):
        import pandas as pd

        output = engine.predict_forecast(
            panel_csv=PANEL_PATH.read_bytes(), region="31.73", issue_date="2024-06-30",
            model="tree", assets_root=PROJECT_ROOT,
        )
        reference = pd.read_csv(TREE_ARTIFACTS / "smoke_native.csv").sort_values("horizon")
        self.assertEqual(output["model_id"], "epikd_tree_export_v1")
        self.assertEqual(len(output["predictions"]), 3)
        self.assertEqual(output["issue_date"], "2024-06-30")
        for forecast, (_, row) in zip(output["predictions"], reference.iterrows()):
            self.assertAlmostEqual(forecast["expected_cases"], row["mu"], delta=1e-8)
            for level in engine.QUANTILE_LEVELS:
                key = f"q{level:g}"
                self.assertAlmostEqual(forecast["uncertainty"]["quantiles"][key], row[key], delta=1e-8)

    def test_kda_matches_saved_prediction_for_eligible_test_origin(self):
        import pandas as pd

        issue = "2024-11-30"
        district = "31.73"
        output = engine.predict_forecast(
            panel_csv=PANEL_PATH.read_bytes(), region=district, issue_date=issue,
            model="epikd", assets_root=PROJECT_ROOT,
        )
        reference = pd.read_csv(KDA_ARTIFACTS / "predictions_test.csv")
        reference = reference.loc[
            (reference["region"].round(2) == float(district))
            & (reference["issue_time"] == issue)
            & (reference["horizon"] == 1)
        ].iloc[0]
        forecast = output["predictions"][0]
        self.assertEqual(output["model_id"], "epikd_kda_full_12epoch_seed17")
        self.assertAlmostEqual(forecast["expected_cases"], reference["mu"], delta=2e-5)
        self.assertAlmostEqual(forecast["uncertainty"]["nb_size"], reference["kappa"], delta=2e-5)
        for level in engine.QUANTILE_LEVELS:
            key = f"q{level:g}"
            self.assertAlmostEqual(forecast["uncertainty"]["quantiles"][key], reference[key], delta=2e-5)

    def test_tree_accepts_single_district_manual_data_without_neighbor_history(self):
        output = engine.predict_forecast(
            panel_csv=_small_csv(), region="31.73", issue_date="2021-12-31",
            model="tree", assets_root=PROJECT_ROOT,
        )
        self.assertEqual(output["district"], "31.73")
        self.assertEqual(len(output["predictions"]), 3)
        self.assertTrue(any("neighbor" in item.lower() for item in output["limitations"]))

    def test_epikd_accepts_user_supplied_history_after_2024(self):
        output = engine.predict_forecast(
            panel_csv=_small_csv(start="2026-01-01"), region="31.73", issue_date="2027-12-31",
            model="epikd", assets_root=PROJECT_ROOT,
        )
        self.assertEqual(output["issue_date"], "2027-12-31")
        self.assertEqual([item["target_month"] for item in output["predictions"]], [
            "2028-01-01", "2028-02-01", "2028-03-01",
        ])

    def test_tree_accepts_user_supplied_month_after_bundled_2024_data(self):
        extended = _append_one_future_district_month(PANEL_PATH.read_bytes(), "31.73")
        output = engine.predict_forecast(
            panel_csv=extended, region="31.73", issue_date="2025-01-31",
            model="tree", assets_root=PROJECT_ROOT,
        )
        self.assertEqual(output["issue_date"], "2025-01-31")
        self.assertEqual([item["target_month"] for item in output["predictions"]], [
            "2025-02-01", "2025-03-01", "2025-04-01",
        ])
        self.assertTrue(all(item["expected_cases"] >= 0 for item in output["predictions"]))
