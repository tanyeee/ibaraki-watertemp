#!/usr/bin/env python3
"""GitHub Issue(「temp: YYYY-MM-DD 数値」形式のタイトル)から水道水温を1件取り出し、
data/tapwater/suidousui.json に追記(同日既存なら上書き)するスクリプト。

想定呼び出し(Actionsから):
  python scripts/append_tapwater.py --title "temp: 2026-07-16 25.2" --body "note: 曇り"

Issueタイトル形式: "temp: YYYY-MM-DD 25.4"
Issue本文1行目(任意): "note: <備考>"

不正な形式・範囲外の値の場合は標準エラー出力に日本語メッセージを出し、
exit code 1 で終了する。成功時は標準出力に完了メッセージを1行出す
(Issueへのコメントに利用する想定)。
"""
from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime
from pathlib import Path

from jsonutil import load_json, utc_now_iso, write_json

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = REPO_ROOT / "data" / "tapwater" / "suidousui.json"

DEFAULT_SOURCE = "manual_tapwater"
DEFAULT_NAME = "水道水温(久慈川水系)"
UNIT = "°C"

MIN_VALUE = -5.0
MAX_VALUE = 45.0

TITLE_RE = re.compile(
    r"^\s*temp:\s*(?P<date>\d{4}-\d{2}-\d{2})\s+(?P<value>-?\d+(?:\.\d+)?)\s*$",
)
NOTE_LINE_RE = re.compile(r"^note:\s*(?P<note>.*)$", re.IGNORECASE)


class InvalidInputError(Exception):
    """タイトル・本文の解析や値の検証に失敗した場合に送出する。"""


def parse_title(title: str) -> tuple[str, float]:
    m = TITLE_RE.match(title or "")
    if not m:
        raise InvalidInputError(
            "Issueタイトルの形式が不正です。"
            "「temp: YYYY-MM-DD 数値」の形式で入力してください"
            f"(受け取ったタイトル: {title!r})"
        )
    date_str = m.group("date")
    value_str = m.group("value")

    try:
        datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        raise InvalidInputError(f"日付の形式が不正です: {date_str}") from None

    try:
        value = float(value_str)
    except ValueError:
        raise InvalidInputError(f"水温の値を数値として解釈できません: {value_str}") from None

    if not (MIN_VALUE <= value <= MAX_VALUE):
        raise InvalidInputError(
            f"水温の値が範囲外です({MIN_VALUE:.1f}〜{MAX_VALUE:.1f}°Cの範囲で入力してください): {value}"
        )

    return date_str, value


def parse_note(body: str) -> str | None:
    if not body:
        return None
    lines = body.splitlines()
    if not lines:
        return None
    m = NOTE_LINE_RE.match(lines[0].strip())
    if not m:
        return None
    note = m.group("note").strip()
    return note if note else None


def merge_record(
    existing_records: list[dict], date_str: str, value: float, note: str | None
) -> list[dict]:
    by_date = {r["date"]: r for r in existing_records}
    record: dict = {"date": date_str, "value": round(value, 1)}
    if note:
        record["note"] = note
    by_date[date_str] = record
    return [by_date[d] for d in sorted(by_date.keys())]


def build_meta(existing_meta: dict, records: list[dict]) -> dict:
    meta = dict(existing_meta) if existing_meta else {}
    meta.setdefault("source", DEFAULT_SOURCE)
    meta.setdefault("name", DEFAULT_NAME)
    meta["unit"] = UNIT
    meta["record_count"] = len(records)
    meta["dataset_start"] = records[0]["date"] if records else None
    meta["dataset_end"] = records[-1]["date"] if records else None
    meta["generated_utc"] = utc_now_iso()
    return meta


def run(title: str, body: str, output: Path) -> str:
    date_str, value = parse_title(title)
    note = parse_note(body)

    payload = load_json(output) or {"meta": {}, "records": []}
    existing_records = payload.get("records", [])
    existing_meta = payload.get("meta", {})

    records = merge_record(existing_records, date_str, value, note)
    meta = build_meta(existing_meta, records)

    write_json(output, meta, records)

    return f"{date_str} の水温 {value:.1f}°C を記録しました(全{len(records)}件)"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Issueタイトル/本文から水道水温を1件抽出し suidousui.json に追記する"
    )
    parser.add_argument("--title", required=True, help='Issueタイトル(例: "temp: 2026-07-16 25.2")')
    parser.add_argument("--body", default="", help="Issue本文(1行目に note: <備考> があれば取り込む)")
    parser.add_argument("--output", default=None, help="省略時は data/tapwater/suidousui.json")
    args = parser.parse_args()

    output = Path(args.output) if args.output else DEFAULT_OUTPUT

    try:
        message = run(args.title, args.body, output)
    except InvalidInputError as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1

    print(message)
    return 0


if __name__ == "__main__":
    sys.exit(main())
