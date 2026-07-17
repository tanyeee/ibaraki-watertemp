"""アプリ共通のJSON入出力ユーティリティ。

meta + records[{date, value, ...}] 形式のスキーマを扱う各スクリプト
(migrate_initial_data.py / update_sea.py / update_wqua.py)で共用する。
"""
from __future__ import annotations

import json
import os
import stat
import tempfile
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
    # 同じディレクトリに完全な一時ファイルを書いてから置換し、中断時に
    # 既存JSONが途中までの内容へ切り替わることを防ぐ。
    temp_path: Path | None = None
    try:
        existing_mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o644
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as f:
            temp_path = Path(f.name)
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
            f.flush()
            os.fsync(f.fileno())
        os.chmod(temp_path, existing_mode)
        os.replace(temp_path, path)
    finally:
        if temp_path is not None and temp_path.exists():
            temp_path.unlink()
    print(f"wrote {path} ({len(records)} records)")


def load_json(path: Path) -> dict | None:
    """既存JSONを読み込む。存在しなければ None を返す。"""
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))
