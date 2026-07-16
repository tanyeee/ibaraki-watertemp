"""アプリ共通のJSON入出力ユーティリティ。

meta + records[{date, value, ...}] 形式のスキーマを扱う各スクリプト
(migrate_initial_data.py / update_sea.py / update_wqua.py)で共用する。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_meta(source: str, name: str, records: list[dict], extra: dict | None = None) -> dict:
    meta = {
        "source": source,
        "name": name,
        "unit": "°C",
        "record_count": len(records),
        "dataset_start": records[0]["date"] if records else None,
        "dataset_end": records[-1]["date"] if records else None,
        "generated_utc": utc_now_iso(),
    }
    if extra:
        meta.update(extra)
    return meta


def write_json(path: Path, meta: dict, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"meta": meta, "records": records}
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {path} ({len(records)} records)")


def load_json(path: Path) -> dict | None:
    """既存JSONを読み込む。存在しなければ None を返す。"""
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))
