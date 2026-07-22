from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from backfill_wqua import empty_window_marker, is_confirmed_empty  # noqa: E402
from jsonutil import build_meta, load_json, write_json  # noqa: E402
from update_latest_wqua import update_latest_meta  # noqa: E402
from update_wqua import parse_wqua_dat_with_latest  # noqa: E402
from validate_data import validate_payload, validate_repository  # noqa: E402


class BackfillTests(unittest.TestCase):
    def test_empty_window_requires_same_marker(self) -> None:
        bgn = date(2026, 6, 12)
        end = date(2026, 6, 18)
        self.assertFalse(is_confirmed_empty({}, bgn, end))
        meta = {"backfill_pending_empty": empty_window_marker(bgn, end)}
        self.assertTrue(is_confirmed_empty(meta, bgn, end))
        self.assertFalse(is_confirmed_empty(meta, date(2026, 6, 5), date(2026, 6, 11)))


class JsonUtilityTests(unittest.TestCase):
    def test_write_json_replaces_with_complete_payload(self) -> None:
        records = [{"date": "2026-07-17", "value": 24.1}]
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "nested" / "data.json"
            write_json(path, build_meta("test", "テスト", records), records)
            self.assertEqual(load_json(path)["records"], records)
            self.assertEqual(list(path.parent.glob("*.tmp")), [])


class LatestObservationTests(unittest.TestCase):
    def test_parser_keeps_daily_values_and_selects_latest_timestamp(self) -> None:
        text = "\n".join(
            [
                "#水温,pH",
                "2026/07/21,2300,表層,24.2",
                "2026/07/22,0000,表層,24.4",
                "2026/07/22,0100,表層,0.1",
                "2026/07/22,0200,表層,24.8",
            ]
        )
        daily, latest = parse_wqua_dat_with_latest(text)
        self.assertEqual(daily, {"2026-07-21": [24.2], "2026-07-22": [24.4, 24.8]})
        self.assertEqual(
            latest,
            {"observed_at": "2026-07-22T02:00:00+09:00", "value": 24.8},
        )

    def test_parser_accepts_24_hour_boundary(self) -> None:
        _daily, latest = parse_wqua_dat_with_latest(
            "2026/07/21,2400,表層,24.3"
        )
        self.assertEqual(latest["observed_at"], "2026-07-22T00:00:00+09:00")

    def test_latest_meta_never_regresses(self) -> None:
        current = {
            "latest_observation": {
                "observed_at": "2026-07-22T12:00:00+09:00",
                "value": 25.0,
            }
        }
        older = {"observed_at": "2026-07-22T11:00:00+09:00", "value": 24.9}
        updated, changed = update_latest_meta(current, older)
        self.assertFalse(changed)
        self.assertEqual(updated, current)

        corrected = {"observed_at": "2026-07-22T12:00:00+09:00", "value": 25.1}
        updated, changed = update_latest_meta(current, corrected)
        self.assertTrue(changed)
        self.assertEqual(updated["latest_observation"], corrected)


class ValidationTests(unittest.TestCase):
    def test_rejects_duplicate_and_out_of_range_records(self) -> None:
        payload = {
            "meta": {
                "source": "test",
                "name": "テスト",
                "unit": "°C",
                "record_count": 2,
                "dataset_start": "2026-07-17",
                "dataset_end": "2026-07-17",
                "generated_utc": "2026-07-18T00:00:00Z",
            },
            "records": [
                {"date": "2026-07-17", "value": 20.0},
                {"date": "2026-07-17", "value": 99.0},
            ],
        }
        errors = validate_payload(Path("bad.json"), payload)
        self.assertTrue(any("重複" in error for error in errors))
        self.assertTrue(any("許容範囲外" in error for error in errors))

    def test_current_repository_is_valid(self) -> None:
        self.assertEqual(validate_repository(REPO_ROOT), [])


if __name__ == "__main__":
    unittest.main()
