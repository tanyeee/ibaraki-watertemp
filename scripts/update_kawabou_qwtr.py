#!/usr/bin/env python3
"""川の防災情報(www.river.go.jp/kawabou)の静的JSONから河川・湖沼水温を取得する。

- 最新時刻: /kawabou/file/system/tmCrntTime.json (crntObsTime)
- 水温:     /kawabou/file/files/tmlist/qwtr/<YYYYMMDD>/<HHMM>/<13桁コード>.json
  obsValue(最新1件) と hrValues(直近約50件の毎正時) を使う。
  wtrtmpCcd が0以外は欠測(190=欠測, 140=閉局, 160=データなし)として取り込まない。

hrValues から日別平均(JST)を作って data/river/{station_id}.json の records へ
日付キーでマージし、obsValue を meta.latest_observation に反映する。
1地点1リクエスト、リクエスト間1秒以上。403/429 を受けたら残りを中止して非ゼロ終了する。
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests

from http_retry import create_retry_session
from jsonutil import build_meta, load_json, write_json
from update_latest_wqua import update_latest_meta
from update_wqua import JST, MIN_VALID_TEMP, REPO_ROOT, merge_records

USER_AGENT = "ibaraki-watertemp/1.0 (+https://github.com/tanyeee/ibaraki-watertemp)"
BASE = "https://www.river.go.jp/kawabou/file"
CRNT_TIME_URL = f"{BASE}/system/tmCrntTime.json"
QWTR_URL = BASE + "/files/tmlist/qwtr/{ymd}/{hm}/{code}.json"
MIN_INTERVAL_SEC = 1.0


class Blocked(Exception):
    """403/429 を受けた。"""


def get_json(session: requests.Session, url: str, timeout: int):
    resp = session.get(url, timeout=timeout)
    if resp.status_code in (403, 429):
        raise Blocked(f"HTTP {resp.status_code}: {url}")
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def parse_obs_time(s: str) -> datetime:
    return datetime.strptime(s.strip(), "%Y/%m/%d %H:%M").replace(tzinfo=JST)


def valid_temp(entry) -> tuple[datetime, float] | None:
    """有効な水温(Ccd==0かつ1.5℃以上)だけを (時刻, 値) で返す。"""
    if not isinstance(entry, dict):
        return None
    try:
        if int(entry.get("wtrtmpCcd")) != 0:
            return None
        value = float(entry.get("wtrtmp"))
        observed = parse_obs_time(entry["obsTime"])
    except (TypeError, ValueError, KeyError):
        return None
    if value < MIN_VALID_TEMP:
        return None
    return observed, value


def daily_values(hr_values) -> tuple[dict[str, list[float]], str | None]:
    """hrValues から JST日付ごとの値リストと、最古の有効観測日を返す。"""
    daily: dict[str, list[float]] = {}
    oldest: datetime | None = None
    for entry in hr_values or []:
        parsed = valid_temp(entry)
        if parsed is None:
            continue
        observed, value = parsed
        daily.setdefault(observed.strftime("%Y-%m-%d"), []).append(value)
        if oldest is None or observed < oldest:
            oldest = observed
    first_partial = None
    if oldest is not None and oldest.hour != 0:
        first_partial = oldest.strftime("%Y-%m-%d")
    return daily, first_partial


def latest_from_obs(obs) -> dict | None:
    parsed = valid_temp(obs)
    if parsed is None:
        return None
    observed, value = parsed
    return {"observed_at": observed.isoformat(timespec="seconds"), "value": value}


def apply_payload(payload: dict, data: dict, station_id: str) -> tuple[dict, list[dict], bool]:
    """取得JSONを既存payloadへ反映し (meta, records, 変更有無) を返す。"""
    old_meta = payload.get("meta", {})
    old_records = payload.get("records", [])
    daily, first_partial = daily_values(data.get("hrValues"))
    existing_dates = {r["date"] for r in old_records}
    # 観測窓の先頭日が途中(0時以外から)なら、既存の日平均を部分平均で上書きしない。
    if first_partial and first_partial in existing_dates:
        daily.pop(first_partial, None)
    records = merge_records(old_records, daily)

    meta_base = {k: v for k, v in old_meta.items()}
    latest = latest_from_obs(data.get("obsValue"))
    meta_base, latest_changed = update_latest_meta(meta_base, latest)
    changed = latest_changed or records != old_records
    if not changed:
        return old_meta, old_records, False
    extra = {k: v for k, v in meta_base.items()
             if k not in ("source", "name", "unit", "record_count", "dataset_start", "dataset_end", "generated_utc")}
    extra["station_id"] = station_id
    meta = build_meta(old_meta.get("source", "river_go_jp_wqua_kind5"),
                      old_meta.get("name", f"河川・湖沼水温(観測所 {station_id})"), records, extra=extra)
    return meta, records, True


def main() -> int:
    parser = argparse.ArgumentParser(description="川の防災情報から河川・湖沼水温を更新する")
    parser.add_argument("--config", default=str(REPO_ROOT / "config" / "stations.json"))
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--sleep", type=float, default=MIN_INTERVAL_SEC)
    args = parser.parse_args()
    if args.sleep < MIN_INTERVAL_SEC:
        raise SystemExit("--sleep は1秒以上を指定してください")

    config = load_json(Path(args.config)) or {}
    targets = [s for s in config.get("series", [])
               if s.get("kind") == "river" and s.get("enabled") and s.get("kawabou_code") and s.get("station_id")]
    if not targets:
        print("no enabled river stations with kawabou_code")
        return 0

    session = create_retry_session(USER_AGENT, retries=0)
    failures = 0
    try:
        try:
            crnt = get_json(session, CRNT_TIME_URL, args.timeout)
            obs_time = parse_obs_time(crnt["crntObsTime"])
        except Blocked as e:
            print(f"::error::blocked: {e}", file=sys.stderr)
            return 1
        except (requests.RequestException, TypeError, KeyError, ValueError) as e:
            print(f"::error::failed to get current time: {e}", file=sys.stderr)
            return 1
        print(f"crntObsTime={obs_time:%Y/%m/%d %H:%M}")

        for series in targets:
            station_id, code = series["station_id"], series["kawabou_code"]
            time.sleep(args.sleep)
            try:
                data = None
                for t in (obs_time, obs_time - timedelta(minutes=10)):
                    url = QWTR_URL.format(ymd=t.strftime("%Y%m%d"), hm=t.strftime("%H%M"), code=code)
                    data = get_json(session, url, args.timeout)
                    if data is not None:
                        obs_time = t
                        break
                    time.sleep(args.sleep)
                if data is None:
                    raise ValueError("404 (not found)")
                output = REPO_ROOT / series["path"]
                payload = load_json(output) or {"meta": {}, "records": []}
                meta, records, changed = apply_payload(payload, data, station_id)
                if changed:
                    write_json(output, meta, records)
                else:
                    print(f"unchanged: station={station_id}")
            except Blocked as e:
                print(f"::error::blocked, aborting remaining stations: {e}", file=sys.stderr)
                return 1
            except (requests.RequestException, ValueError, KeyError, TypeError) as e:
                print(f"::error::failed station={station_id}: {e}", file=sys.stderr)
                failures += 1
    finally:
        session.close()
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
