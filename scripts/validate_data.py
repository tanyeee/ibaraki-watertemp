#!/usr/bin/env python3
"""公開前に設定と水温JSONの整合性を検査する。"""
from __future__ import annotations

import argparse
import json
import math
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MIN_REASONABLE_TEMP = -5.0
MAX_REASONABLE_TEMP = 45.0


def validate_payload(path: Path, payload: object) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return [f"{path}: ルートはオブジェクトである必要があります"]

    meta = payload.get("meta")
    records = payload.get("records")
    if not isinstance(meta, dict):
        errors.append(f"{path}: meta がオブジェクトではありません")
        meta = {}
    if not isinstance(records, list):
        errors.append(f"{path}: records が配列ではありません")
        return errors

    previous_date: str | None = None
    seen_dates: set[str] = set()
    for index, record in enumerate(records):
        label = f"{path}: records[{index}]"
        if not isinstance(record, dict):
            errors.append(f"{label} がオブジェクトではありません")
            continue
        date_str = record.get("date")
        value = record.get("value")
        if not isinstance(date_str, str):
            errors.append(f"{label}.date が文字列ではありません")
        else:
            try:
                parsed = date.fromisoformat(date_str)
                if parsed.isoformat() != date_str:
                    raise ValueError
            except ValueError:
                errors.append(f"{label}.date が YYYY-MM-DD 形式の実在日ではありません: {date_str!r}")
            if date_str in seen_dates:
                errors.append(f"{path}: 日付が重複しています: {date_str}")
            if previous_date is not None and date_str <= previous_date:
                errors.append(f"{path}: records が日付昇順ではありません: {previous_date} -> {date_str}")
            seen_dates.add(date_str)
            previous_date = date_str

        if isinstance(value, bool) or not isinstance(value, (int, float)):
            errors.append(f"{label}.value が数値ではありません")
        elif not math.isfinite(value):
            errors.append(f"{label}.value が有限値ではありません")
        elif not MIN_REASONABLE_TEMP <= value <= MAX_REASONABLE_TEMP:
            errors.append(
                f"{label}.value が許容範囲外です"
                f"({MIN_REASONABLE_TEMP}〜{MAX_REASONABLE_TEMP}°C): {value}"
            )

    expected_start = records[0].get("date") if records and isinstance(records[0], dict) else None
    expected_end = records[-1].get("date") if records and isinstance(records[-1], dict) else None
    expected_meta = {
        "record_count": len(records),
        "dataset_start": expected_start,
        "dataset_end": expected_end,
        "unit": "°C",
    }
    for key, expected in expected_meta.items():
        if meta.get(key) != expected:
            errors.append(f"{path}: meta.{key}={meta.get(key)!r}, 期待値={expected!r}")
    for key in ("source", "name", "generated_utc"):
        if not isinstance(meta.get(key), str) or not meta[key]:
            errors.append(f"{path}: meta.{key} が空です")
    return errors


def load_json(path: Path) -> tuple[object | None, list[str]]:
    try:
        return json.loads(path.read_text(encoding="utf-8")), []
    except (OSError, json.JSONDecodeError) as exc:
        return None, [f"{path}: JSONを読み込めません: {exc}"]


def configured_data_paths(repo_root: Path) -> tuple[list[Path], list[str]]:
    config_path = repo_root / "config" / "stations.json"
    payload, errors = load_json(config_path)
    if errors:
        return [], errors
    if not isinstance(payload, dict) or not isinstance(payload.get("series"), list):
        return [], [f"{config_path}: series が配列ではありません"]

    paths: list[Path] = []
    seen_ids: set[str] = set()
    for index, station in enumerate(payload["series"]):
        if not isinstance(station, dict):
            errors.append(f"{config_path}: series[{index}] がオブジェクトではありません")
            continue
        station_id = station.get("id")
        if not isinstance(station_id, str) or not station_id:
            errors.append(f"{config_path}: series[{index}].id が空です")
        elif station_id in seen_ids:
            errors.append(f"{config_path}: id が重複しています: {station_id}")
        else:
            seen_ids.add(station_id)
        if station.get("enabled") is True:
            relative_path = station.get("path")
            if not isinstance(relative_path, str) or not relative_path:
                errors.append(f"{config_path}: 有効な {station_id!r} に path がありません")
            else:
                paths.append(repo_root / relative_path)
    return paths, errors


def validate_repository(repo_root: Path) -> list[str]:
    configured, errors = configured_data_paths(repo_root)
    candidates = set(configured)
    for subdir in ("sea", "river", "tapwater", "reference"):
        candidates.update((repo_root / "data" / subdir).glob("*.json"))

    for path in configured:
        if not path.is_file():
            errors.append(f"{path}: 有効な系列のデータファイルがありません")
    for path in sorted(candidates):
        if not path.is_file():
            continue
        payload, load_errors = load_json(path)
        errors.extend(load_errors)
        if not load_errors:
            errors.extend(validate_payload(path, payload))
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="設定と水温JSONの整合性を検査する")
    parser.add_argument("--repo-root", type=Path, default=REPO_ROOT)
    args = parser.parse_args()

    errors = validate_repository(args.repo_root.resolve())
    if errors:
        print("データ検査に失敗しました:")
        for error in errors:
            print(f"- {error}")
        return 1
    print("データ検査OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
