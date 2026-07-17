#!/usr/bin/env python3
"""水文水質DBの水温を7日窓で過去方向へ段階的にバックフィルする。"""
from __future__ import annotations

import argparse
import time
from datetime import date, datetime, timedelta
from pathlib import Path

from http_retry import create_retry_session
from jsonutil import build_meta, load_json, write_json
from update_wqua import (
    DEFAULT_SLEEP_SEC,
    REPO_ROOT,
    USER_AGENT,
    fetch_window,
    merge_records,
    parse_yyyymmdd,
)

WINDOW_DAYS = 7


def backward_windows(cursor: date, count: int) -> list[tuple[date, date]]:
    """cursorを終端として、重複しない7暦日窓を過去方向へ返す。"""
    return [
        (
            cursor - timedelta(days=(index + 1) * WINDOW_DAYS - 1),
            cursor - timedelta(days=index * WINDOW_DAYS),
        )
        for index in range(count)
    ]


def refreshed_meta(
    existing_meta: dict,
    station_id: str,
    records: list[dict],
    cursor: date,
    done: bool,
) -> dict:
    """データセット要約を更新しつつ、既存の追加metaを保持する。"""
    source = existing_meta.get("source", "river_go_jp_wqua_kind5")
    name = existing_meta.get("name", f"河川・湖沼水温(観測所 {station_id})")
    computed_keys = {
        "source",
        "name",
        "unit",
        "record_count",
        "dataset_start",
        "dataset_end",
        "generated_utc",
    }
    extra = {key: value for key, value in existing_meta.items() if key not in computed_keys}
    extra.update({"station_id": station_id, "backfill_cursor": cursor.isoformat()})
    if done:
        extra["backfill_done"] = True
    else:
        extra.pop("backfill_done", None)
    return build_meta(source, name, records, extra=extra)


def empty_window_marker(bgn: date, end: date) -> dict[str, str]:
    return {"bgn": bgn.isoformat(), "end": end.isoformat()}


def is_confirmed_empty(existing_meta: dict, bgn: date, end: date) -> bool:
    """同じ空期間を前回の実行でも確認済みなら True。"""
    return existing_meta.get("backfill_pending_empty") == empty_window_marker(bgn, end)


def write_progress(
    output: Path,
    existing_meta: dict,
    station_id: str,
    records: list[dict],
    cursor: date,
    floor: date,
    pending_empty: dict[str, str] | None = None,
) -> dict:
    """1窓ごとの進捗を保存し、次の保存に使うmetaを返す。"""
    updated_meta = refreshed_meta(existing_meta, station_id, records, cursor, cursor <= floor)
    if pending_empty is None:
        updated_meta.pop("backfill_pending_empty", None)
    else:
        updated_meta["backfill_pending_empty"] = pending_empty
    write_json(output, updated_meta, records)
    return updated_meta


def main() -> None:
    parser = argparse.ArgumentParser(description="水文水質DBを7日窓で過去方向へバックフィルする")
    parser.add_argument("--station", required=True, help="観測所記号")
    parser.add_argument("--windows", type=int, default=4, help="取得する7日窓の数(デフォルト4)")
    parser.add_argument("--floor", default="20160101", help="遡及下限 YYYYMMDD")
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument("--sleep", type=float, default=DEFAULT_SLEEP_SEC)
    parser.add_argument("--dry-run", action="store_true", help="取得・保存せずcursor遷移だけ表示")
    args = parser.parse_args()

    if args.windows < 1:
        raise SystemExit("--windows は1以上を指定してください")
    if args.sleep < 2.0:
        raise SystemExit("--sleep は2秒以上を指定してください(サーバー負荷配慮)")
    floor = parse_yyyymmdd(args.floor)
    output = REPO_ROOT / "data" / "river" / f"{args.station}.json"
    payload = load_json(output) or {"meta": {}, "records": []}
    meta = payload.get("meta", {})
    try:
        cursor = date.fromisoformat(meta.get("backfill_cursor", datetime.now().date().isoformat()))
    except ValueError as exc:
        raise SystemExit("meta.backfill_cursor は YYYY-MM-DD 形式で指定してください") from exc

    if cursor <= floor:
        print(f"backfill完了: cursor={cursor.isoformat()} floor={floor.isoformat()} (取得なし)")
        if args.dry_run:
            print("dry-run: JSON更新なし, backfill_done=true")
        elif not meta.get("backfill_done"):
            records = payload.get("records", [])
            updated_meta = refreshed_meta(meta, args.station, records, cursor, True)
            write_json(output, updated_meta, records)
        return

    windows = [
        (max(win_bgn, floor), win_end)
        for win_bgn, win_end in backward_windows(cursor, args.windows)
        if win_end >= floor
    ]
    next_cursor = cursor - timedelta(days=args.windows * WINDOW_DAYS)
    done = next_cursor <= floor
    print(f"cursor: {cursor.isoformat()} -> {next_cursor.isoformat()} (floor={floor.isoformat()})")
    for index, (win_bgn, win_end) in enumerate(windows, 1):
        print(f"[{index}/{len(windows)}] {win_bgn.isoformat()}〜{win_end.isoformat()}")
    if args.dry_run:
        print(f"dry-run: JSON更新なし, backfill_done={str(done).lower()}")
        return

    records = payload.get("records", [])
    session = create_retry_session(USER_AGENT)
    try:
        current_meta = meta
        current_cursor = cursor
        for index, (win_bgn, win_end) in enumerate(windows, 1):
            daily = fetch_window(session, args.station, win_bgn, win_end, args.timeout)
            if not daily and not is_confirmed_empty(current_meta, win_bgn, win_end):
                marker = empty_window_marker(win_bgn, win_end)
                write_progress(
                    output,
                    current_meta,
                    args.station,
                    records,
                    current_cursor,
                    floor,
                    pending_empty=marker,
                )
                print(
                    f"[{index}/{len(windows)}] データが空でした。次回も同じ期間が空なら確定します: "
                    f"{win_bgn.isoformat()}〜{win_end.isoformat()}"
                )
                return

            if not daily:
                print(f"[{index}/{len(windows)}] 空期間を再確認しました")
            records = merge_records(records, daily)
            current_cursor = win_bgn - timedelta(days=1)
            current_meta = write_progress(
                output,
                current_meta,
                args.station,
                records,
                current_cursor,
                floor,
            )
            print(f"[{index}/{len(windows)}] {len(daily)} 日分取得(累計 {len(records)} 件)")
            if current_cursor <= floor:
                break
            if index < len(windows):
                time.sleep(args.sleep)
    finally:
        session.close()


if __name__ == "__main__":
    main()
