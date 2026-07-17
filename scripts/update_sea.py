#!/usr/bin/env python3
"""気象庁 沿岸海況の海面水温をエリア番号ごとに取得する。

データ源(公開データ、全量が同じテキストで配信される):
  https://www.data.jma.go.jp/kaiyou/data/db/kaikyo/series/engan/txt/area{番号}.txt

依存: requests
"""
from __future__ import annotations

import argparse
from pathlib import Path

from area137_parser import parse_area137_text
from http_retry import create_retry_session
from jsonutil import build_meta, write_json

REPO_ROOT = Path(__file__).resolve().parent.parent
AREA_URL_TEMPLATE = (
    "https://www.data.jma.go.jp/kaiyou/data/db/kaikyo/series/engan/txt/area{area}.txt"
)
USER_AGENT = "Mozilla/5.0 (compatible; IbarakiWaterTempBot/1.0; +https://github.com/)"
AREA_NAMES = {
    137: "海面水温(茨城県北部沿岸)",
    138: "海面水温(茨城県南部沿岸)",
}


def fetch_area_text(area: int, timeout: int = 60) -> str:
    with create_retry_session(USER_AGENT) as session:
        resp = session.get(AREA_URL_TEMPLATE.format(area=area), timeout=timeout)
        resp.raise_for_status()
        # レスポンスはASCII互換の数値CSVのため、文字コード判定に失敗しても
        # utf-8として扱えば問題ない。
        resp.encoding = resp.apparent_encoding or "utf-8"
        return resp.text


def main() -> None:
    parser = argparse.ArgumentParser(
        description="気象庁 沿岸海況を取得し data/sea/area{番号}.json を再生成する"
    )
    parser.add_argument("--area", type=int, default=137, help="エリア番号 (default: 137)")
    parser.add_argument(
        "--output",
        help="出力先 (default: data/sea/area{番号}.json)",
    )
    parser.add_argument("--timeout", type=int, default=60)
    args = parser.parse_args()

    if args.area <= 0:
        parser.error("--area には正の整数を指定してください")

    output = Path(args.output) if args.output else REPO_ROOT / "data" / "sea" / f"area{args.area}.json"
    text = fetch_area_text(args.area, timeout=args.timeout)
    records, skipped = parse_area137_text(text)
    if not records:
        raise SystemExit(f"area{args.area}.txt から有効なレコードを取得できませんでした")

    meta = build_meta(
        f"jma_engan_area{args.area}",
        AREA_NAMES.get(args.area, f"海面水温(area{args.area})"),
        records,
        extra={"skipped": skipped},
    )
    write_json(output, meta, records)


if __name__ == "__main__":
    main()
