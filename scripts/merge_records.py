#!/usr/bin/env python3
"""2つの水温JSONを日付キーで統合する。"""
from __future__ import annotations

import argparse
from pathlib import Path

from jsonutil import load_json, utc_now_iso, write_json


def merge_payloads(src_payload: dict, dst_payload: dict) -> tuple[dict, list[dict]]:
    """srcへdstを重ね、同日の値はdst優先で日付昇順にする。"""
    by_date = {record["date"]: record for record in src_payload.get("records", [])}
    by_date.update({record["date"]: record for record in dst_payload.get("records", [])})
    records = [by_date[date_key] for date_key in sorted(by_date)]

    meta = dict(dst_payload.get("meta", {}))
    meta.update(
        {
            "record_count": len(records),
            "dataset_start": records[0]["date"] if records else None,
            "dataset_end": records[-1]["date"] if records else None,
            "generated_utc": utc_now_iso(),
        }
    )
    return meta, records


def main() -> None:
    parser = argparse.ArgumentParser(description="srcのrecordsをdstへ日付キーで統合する")
    parser.add_argument("--src", type=Path, required=True)
    parser.add_argument("--dst", type=Path, required=True)
    args = parser.parse_args()

    src_payload = load_json(args.src)
    dst_payload = load_json(args.dst)
    if src_payload is None:
        raise SystemExit(f"srcが見つかりません: {args.src}")
    if dst_payload is None:
        raise SystemExit(f"dstが見つかりません: {args.dst}")

    meta, records = merge_payloads(src_payload, dst_payload)
    write_json(args.dst, meta, records)


if __name__ == "__main__":
    main()
