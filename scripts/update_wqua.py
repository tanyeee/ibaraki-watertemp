#!/usr/bin/env python3
"""水文水質DB(www1.river.go.jp, KIND=5: 水質自動監視)から水温を取得し、
data/river/{station_id}.json を更新する。

データ源:
  https://www1.river.go.jp/cgi-bin/DspWquaData.exe?KIND=5&ID={station_id}
    &BGNDATE={yyyymmdd}&ENDDATE={yyyymmdd}&KAWABOU=NO
  上記ページ内に .dat (CP932) へのダウンロードリンクが含まれる。

.dat の実際の列構成(2026-07-16 に実データで確認済み):
  ヘッダ部(6行程度、観測所記号・観測所名など) の後、
    #水温,ｐＨ,ＤＯ,導電率,濁度,ＣＯＤ,シアンイオン,アンモニアイオン,塩化物イオン,BOD,塩分濃度,水位
    #℃, ,mg/l,ms/m,度,mg/l,mg/l,mg/l,mg/l,mg/l,mg/l,m
  というコメント行で項目名・単位が示され、データ行は
    年月日,時分,採水位置,水温,pH,DO,導電率,濁度,COD,... (欠測は空白)
  の順(1時間ごと、24点/日)。水温は先頭3列(年月日,時分,採水位置)の次、
  すなわち0-indexで3列目。

サーバー側の制約(実測で確認): BGNDATE〜ENDDATEの差は最大7日(=8暦日分)まで。
これを超えると「パラメータに誤りがあります」となるため、本スクリプトは
内部で自動的に8日以内のウィンドウへ分割してリクエストする。

依存: requests
"""
from __future__ import annotations

import argparse
import csv
import re
import time
from datetime import date, datetime, timedelta
from io import StringIO
from pathlib import Path
from typing import Iterator
from urllib.parse import urljoin

import requests

from http_retry import create_retry_session
from jsonutil import build_meta, load_json, write_json

REPO_ROOT = Path(__file__).resolve().parent.parent
BASE_URL = "https://www1.river.go.jp"
WQUA_URL_TEMPLATE = (
    "https://www1.river.go.jp/cgi-bin/DspWquaData.exe?KIND=5&ID={station_id}"
    "&BGNDATE={bgn}&ENDDATE={end}&KAWABOU=NO"
)
DAT_LINK_RE = re.compile(r'href=["\'](?P<href>/dat/dload/download/[^"\']+\.dat)["\']', re.IGNORECASE)
DATE_RE = re.compile(r"^\d{4}/\d{2}/\d{2}$")
USER_AGENT = "Mozilla/5.0 (compatible; IbarakiWaterTempBot/1.0; +https://github.com/)"

# BGNDATE〜ENDDATEの差の上限(実測で確認したサーバー側制約)。
MAX_WINDOW_SPAN_DAYS = 7
DEFAULT_SLEEP_SEC = 2.0

# 全8局の過去10年の正常な最低水温は3.0℃。1.5℃未満は対象水域では
# 起こり得ず、波崎2局で配信された0.1℃/-0.1℃などのセンサー異常値とみなす。
MIN_VALID_TEMP = 1.5


def decode_bytes(content: bytes) -> str:
    for enc in ("cp932", "shift_jis", "utf-8", "euc_jp", "latin1"):
        try:
            return content.decode(enc)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="ignore")


def date_windows(bgn: date, end: date, max_span_days: int = MAX_WINDOW_SPAN_DAYS) -> Iterator[tuple[date, date]]:
    """[bgn, end] を max_span_days 以下の差になるように分割して返す。"""
    cur = bgn
    while cur <= end:
        window_end = min(cur + timedelta(days=max_span_days), end)
        yield cur, window_end
        cur = window_end + timedelta(days=1)


def extract_dat_link(html: str) -> str | None:
    m = DAT_LINK_RE.search(html)
    return m.group("href") if m else None


def parse_wqua_dat(text: str) -> dict[str, list[float]]:
    """KIND=5(水質自動監視)の.datテキストから水温を抽出し、
    日付(YYYY-MM-DD)ごとの値リストを返す。"""
    daily: dict[str, list[float]] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        first_field = line.split(",", 1)[0].strip()
        if not DATE_RE.match(first_field):
            continue
        row = next(csv.reader([raw_line]))
        if len(row) < 4:
            continue
        date_raw = row[0].strip()
        temp_raw = row[3].strip()
        if not temp_raw:
            continue
        try:
            value = float(temp_raw)
        except ValueError:
            continue
        if value < MIN_VALID_TEMP:
            continue
        date_str = date_raw.replace("/", "-")
        daily.setdefault(date_str, []).append(value)
    return daily


def fetch_window(
    session: requests.Session,
    station_id: str,
    bgn: date,
    end: date,
    timeout: int,
) -> dict[str, list[float]]:
    page_url = WQUA_URL_TEMPLATE.format(
        station_id=station_id,
        bgn=bgn.strftime("%Y%m%d"),
        end=end.strftime("%Y%m%d"),
    )
    page_resp = session.get(page_url, timeout=timeout)
    page_resp.raise_for_status()
    html = decode_bytes(page_resp.content)
    href = extract_dat_link(html)
    if not href:
        # 観測期間外・データなしなどで.datリンクが無い場合
        return {}
    dat_url = urljoin(BASE_URL, href)
    dat_resp = session.get(dat_url, timeout=timeout)
    dat_resp.raise_for_status()
    text = decode_bytes(dat_resp.content)
    return parse_wqua_dat(text)


def daily_average(values: list[float]) -> float:
    return round(sum(values) / len(values), 1)


def merge_records(existing: list[dict], new_daily: dict[str, list[float]]) -> list[dict]:
    """既存レコード(日付キー)に新しい日次平均値をマージ(新しい値で上書き)し、
    日付昇順のリストで返す。"""
    by_date = {r["date"]: r for r in existing}
    for date_str, values in new_daily.items():
        if not values:
            continue
        by_date[date_str] = {"date": date_str, "value": daily_average(values)}
    return [by_date[d] for d in sorted(by_date.keys())]


def update_station(
    station_id: str,
    output: Path,
    bgn: date,
    end: date,
    timeout: int,
    sleep_sec: float,
) -> None:
    existing_payload = load_json(output) or {"meta": {}, "records": []}
    merged: list[dict] = existing_payload.get("records", [])

    session = create_retry_session(USER_AGENT)

    windows = list(date_windows(bgn, end))
    try:
        for i, (win_bgn, win_end) in enumerate(windows):
            daily = fetch_window(session, station_id, win_bgn, win_end, timeout)
            merged = merge_records(merged, daily)
            print(
                f"[{i + 1}/{len(windows)}] {win_bgn.isoformat()}〜{win_end.isoformat()}: "
                f"{len(daily)} 日分取得(累計 {len(merged)} 件)"
            )
            # 長時間のブートストラップでも中断時に進捗が残るよう、都度書き戻す。
            preserved_backfill = {
                key: existing_payload.get("meta", {})[key]
                for key in ("backfill_cursor", "backfill_done", "backfill_pending_empty")
                if key in existing_payload.get("meta", {})
            }
            meta = build_meta(
                "river_go_jp_wqua_kind5",
                f"河川・湖沼水温(観測所 {station_id})",
                merged,
                extra={"station_id": station_id, **preserved_backfill},
            )
            write_json(output, meta, merged)
            if i < len(windows) - 1:
                time.sleep(sleep_sec)
    finally:
        session.close()


def parse_yyyymmdd(s: str) -> date:
    return datetime.strptime(s, "%Y%m%d").date()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="水文水質DB(KIND=5)から水温を取得し data/river/{station}.json を更新する"
    )
    parser.add_argument("--station", required=True, help="観測所記号(例: 403031283303071)")
    parser.add_argument("--bgn", default=None, help="YYYYMMDD(--endと同時指定)")
    parser.add_argument("--end", default=None, help="YYYYMMDD(--bgnと同時指定)")
    parser.add_argument("--days", type=int, default=14, help="直近N日(--bgn/--end省略時、デフォルト14)")
    parser.add_argument("--output", default=None, help="省略時は data/river/{station}.json")
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument(
        "--sleep",
        type=float,
        default=DEFAULT_SLEEP_SEC,
        help="リクエスト間の待機秒数(サーバー負荷配慮のため2秒以上)",
    )
    args = parser.parse_args()

    if args.sleep < 2.0:
        raise SystemExit("--sleep は2秒以上を指定してください(サーバー負荷配慮)")

    if args.bgn and args.end:
        bgn = parse_yyyymmdd(args.bgn)
        end = parse_yyyymmdd(args.end)
    elif args.bgn or args.end:
        raise SystemExit("--bgn と --end は両方指定してください")
    else:
        end = datetime.now().date()
        bgn = end - timedelta(days=args.days - 1)

    if bgn > end:
        raise SystemExit("--bgn は --end より前の日付にしてください")

    output = (
        Path(args.output)
        if args.output
        else REPO_ROOT / "data" / "river" / f"{args.station}.json"
    )

    update_station(args.station, output, bgn, end, args.timeout, args.sleep)


if __name__ == "__main__":
    main()
