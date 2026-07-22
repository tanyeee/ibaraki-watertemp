#!/usr/bin/env python3
"""水質自動監視局の最新時刻値だけを更新する。

日別平均の records は変更せず、上部カードが参照する
meta.latest_observation を更新する。
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta
from pathlib import Path

from http_retry import create_retry_session
from jsonutil import load_json, utc_now_iso, write_json
from update_wqua import (
    JST,
    REPO_ROOT,
    USER_AGENT,
    fetch_window_with_latest,
)


def update_latest_meta(
    meta: dict,
    latest: dict[str, str | float] | None,
) -> tuple[dict, bool]:
    """より新しい観測、または同時刻の訂正値だけをmetaへ反映する。"""
    if latest is None:
        return dict(meta), False

    current = meta.get("latest_observation")
    if isinstance(current, dict):
        current_at = current.get("observed_at")
        latest_at = latest.get("observed_at")
        if isinstance(current_at, str) and isinstance(latest_at, str) and latest_at < current_at:
            return dict(meta), False
        if current == latest:
            return dict(meta), False

    updated = dict(meta)
    updated["latest_observation"] = latest
    updated["generated_utc"] = utc_now_iso()
    return updated, True


def update_station(station_id: str, output: Path, timeout: int, days: int) -> bool:
    payload = load_json(output)
    if not payload:
        raise SystemExit(f"既存データがありません: {output}")

    # 日付境界直後や配信遅延でも直前の観測を拾えるよう、JST基準で前日も取得する。
    end = datetime.now(JST).date()
    bgn = end - timedelta(days=days - 1)
    session = create_retry_session(USER_AGENT)
    try:
        _daily, latest = fetch_window_with_latest(
            session, station_id, bgn, end, timeout
        )
    finally:
        session.close()

    updated_meta, changed = update_latest_meta(payload.get("meta", {}), latest)
    if not changed:
        print(f"latest unchanged: station={station_id}")
        return False

    records = payload.get("records", [])
    write_json(output, updated_meta, records)
    print(
        "latest updated: "
        f"station={station_id} observed_at={latest['observed_at']} value={latest['value']}"
    )
    return True


def main() -> None:
    parser = argparse.ArgumentParser(
        description="水文水質DBからカード用の最新観測値だけを更新する"
    )
    parser.add_argument("--station", required=True, help="観測所記号")
    parser.add_argument("--output", default=None, help="省略時は data/river/{station}.json")
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument("--days", type=int, default=2, help="確認する直近日数(デフォルト2)")
    args = parser.parse_args()

    if args.days < 1 or args.days > 8:
        raise SystemExit("--days は1〜8で指定してください")
    output = (
        Path(args.output)
        if args.output
        else REPO_ROOT / "data" / "river" / f"{args.station}.json"
    )
    update_station(args.station, output, args.timeout, args.days)


if __name__ == "__main__":
    main()
