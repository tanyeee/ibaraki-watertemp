#!/usr/bin/env python3
"""meta + records 形式のJSONから閾値未満の水温レコードを除去する。"""
from __future__ import annotations

import argparse
from pathlib import Path

from jsonutil import load_json, utc_now_iso, write_json


def clean_records(path: Path, min_temp: float) -> tuple[int, int]:
    payload = load_json(path)
    if payload is None:
        raise ValueError(f"ファイルが存在しません: {path}")
    if not isinstance(payload, dict):
        raise ValueError("JSONのルートはオブジェクトである必要があります")

    meta = payload.get("meta")
    records = payload.get("records")
    if not isinstance(meta, dict) or not isinstance(records, list):
        raise ValueError("JSONにはmetaオブジェクトとrecords配列が必要です")

    kept: list[dict] = []
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            raise ValueError(f"records[{index}]はオブジェクトである必要があります")
        value = record.get("value")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"records[{index}].valueは数値である必要があります")
        if value >= min_temp:
            kept.append(record)

    dates = [record.get("date") for record in kept]
    if any(not isinstance(date, str) for date in dates):
        raise ValueError("各レコードのdateは文字列である必要があります")

    updated_meta = dict(meta)
    updated_meta.update(
        {
            "record_count": len(kept),
            "dataset_start": min(dates) if dates else None,
            "dataset_end": max(dates) if dates else None,
            "generated_utc": utc_now_iso(),
        }
    )
    write_json(path, updated_meta, kept)
    return len(records), len(kept)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="meta + records形式のJSONから指定水温未満のレコードを除去する"
    )
    parser.add_argument("--file", type=Path, required=True, help="クリーニング対象のJSONファイル")
    parser.add_argument("--min-temp", type=float, required=True, help="保持する最低水温(℃)")
    args = parser.parse_args()

    try:
        before, after = clean_records(args.file, args.min_temp)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    print(f"removed {before - after} records below {args.min_temp:g}°C ({before} -> {after})")


if __name__ == "__main__":
    main()
