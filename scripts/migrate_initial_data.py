#!/usr/bin/env python3
"""既存の水温データ(テキスト/CSV)をアプリ用の共通JSONスキーマへ変換する
初回移行スクリプト。

【初期移行専用・ローカル実行専用】
このスクリプトは開発者のローカル環境にある元データ(移行元テキスト/CSV)を
1度だけ読み込んでJSONへ変換するためのものであり、GitHub Actions等の自動更新
パイプラインからは呼び出さない。日次更新には scripts/update_sea.py /
scripts/update_wqua.py / scripts/append_tapwater.py を使用すること。

依存: 標準ライブラリのみ。

入力(いずれも変更・移動しないこと。既定では --input-dir 未指定時に
ローカル環境固有のパスを参照するため、他環境で実行する場合は --input-dir で
明示的に指定すること):
  - suidousui.txt : 水道水温(久慈川水系)
  - area137.txt   : 気象庁 海面水温(茨城県北部沿岸 area137)
  - chart.csv     : 北浦(参考データ)

出力:
  - data/tapwater/suidousui.json
  - data/sea/area137.json
  - data/reference/kitaura_chart.json
"""
from __future__ import annotations

import argparse
import csv
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from area137_parser import parse_area137_text
from jsonutil import build_meta, write_json

REPO_ROOT = Path(__file__).resolve().parent.parent

# ローカル実行専用のデフォルト入力ディレクトリ。他環境では --input-dir で上書きする。
DEFAULT_INPUT_DIR = Path(
    "/Users/tanyeee/Desktop/athena/dev/Scripts/waterTemp/read"
)

TAPWATER_JSON = REPO_ROOT / "data" / "tapwater" / "suidousui.json"
SEA_JSON = REPO_ROOT / "data" / "sea" / "area137.json"
KITAURA_JSON = REPO_ROOT / "data" / "reference" / "kitaura_chart.json"


_TAPWATER_MISSING_COMMA_RE = re.compile(r"^(\d{4}/\d{2}/\d{2})(-?\d+\.?\d*)$")


def migrate_tapwater(input_dir: Path) -> None:
    """水道水温(久慈川水系): 日付,水道水温度,備考"""
    suidousui_txt = input_dir / "suidousui.txt"
    records = []
    with suidousui_txt.open("r", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)
        for row in reader:
            if not row:
                continue
            row = [c.strip() for c in row]
            if len(row) < 2:
                # 入力ファイルに稀に日付と値の間のカンマが欠落した行があるため
                # (例: "2026/04/0914.2")、その場合のみ正規表現で復元する。
                m = _TAPWATER_MISSING_COMMA_RE.match(row[0]) if row else None
                if not m:
                    continue
                row = [m.group(1), m.group(2)]
            date_raw, value_raw = row[0], row[1]
            note = row[2] if len(row) > 2 else ""
            if not date_raw or not value_raw:
                continue
            date = datetime.strptime(date_raw, "%Y/%m/%d").strftime("%Y-%m-%d")
            record = {"date": date, "value": float(value_raw)}
            if note:
                record["note"] = note
            records.append(record)

    records.sort(key=lambda r: r["date"])
    meta = build_meta("manual_tapwater", "水道水温(久慈川水系)", records)
    write_json(TAPWATER_JSON, meta, records)


def migrate_sea(input_dir: Path) -> None:
    """海面水温(茨城県北部沿岸 area137): yyyy,mm,dd,areaNo.,flag,Temp."""
    area137_txt = input_dir / "area137.txt"
    text = area137_txt.read_text(encoding="utf-8")
    records, skipped = parse_area137_text(text)
    meta = build_meta(
        "jma_engan_area137",
        "海面水温(茨城県北部沿岸)",
        records,
        extra={"skipped": skipped},
    )
    write_json(SEA_JSON, meta, records)


def migrate_kitaura_reference(input_dir: Path) -> None:
    """北浦(参考データ): "DateTime","水温" -> 日付のみに丸め、同日複数行は平均"""
    chart_csv = input_dir / "chart.csv"
    daily_values: dict[str, list[float]] = defaultdict(list)
    with chart_csv.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        for row in reader:
            if not row or len(row) < 2:
                continue
            datetime_raw, value_raw = row[0].strip(), row[1].strip()
            if not datetime_raw or not value_raw:
                continue
            dt = datetime.strptime(datetime_raw, "%Y-%m-%d %H:%M:%S")
            date = dt.strftime("%Y-%m-%d")
            daily_values[date].append(float(value_raw))

    records = []
    for date in sorted(daily_values.keys()):
        values = daily_values[date]
        avg = round(sum(values) / len(values), 1)
        records.append({"date": date, "value": avg})

    meta = build_meta(
        "reference_kitaura_chart",
        "北浦(参考データ)",
        records,
    )
    write_json(KITAURA_JSON, meta, records)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "既存の水温データ(テキスト/CSV)をアプリ用の共通JSONスキーマへ変換する"
            "初回移行スクリプト(初期移行専用・ローカル実行専用)。"
        )
    )
    parser.add_argument(
        "--input-dir",
        default=str(DEFAULT_INPUT_DIR),
        help="suidousui.txt / area137.txt / chart.csv を含む入力ディレクトリ",
    )
    args = parser.parse_args()

    input_dir = Path(args.input_dir)

    migrate_tapwater(input_dir)
    migrate_sea(input_dir)
    migrate_kitaura_reference(input_dir)


if __name__ == "__main__":
    main()
