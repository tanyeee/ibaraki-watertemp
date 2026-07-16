#!/usr/bin/env python3
"""気象庁 沿岸海況(area137: 茨城県北部沿岸)の海面水温を取得し、
data/sea/area137.json を再生成する。

データ源(公開データ、全量が同じテキストで配信される):
  https://www.data.jma.go.jp/kaiyou/data/db/kaikyo/series/engan/txt/area137.txt

依存: requests
"""
from __future__ import annotations

import argparse
from pathlib import Path

import requests

from area137_parser import parse_area137_text
from jsonutil import build_meta, write_json

REPO_ROOT = Path(__file__).resolve().parent.parent
AREA137_URL = "https://www.data.jma.go.jp/kaiyou/data/db/kaikyo/series/engan/txt/area137.txt"
SEA_JSON = REPO_ROOT / "data" / "sea" / "area137.json"
USER_AGENT = "Mozilla/5.0 (compatible; IbarakiWaterTempBot/1.0; +https://github.com/)"


def fetch_area137_text(timeout: int = 60) -> str:
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    resp = session.get(AREA137_URL, timeout=timeout)
    resp.raise_for_status()
    # レスポンスはASCII互換の数値CSVのため、文字コード判定に失敗しても
    # utf-8として扱えば問題ない。
    resp.encoding = resp.apparent_encoding or "utf-8"
    return resp.text


def main() -> None:
    parser = argparse.ArgumentParser(
        description="気象庁 沿岸海況(area137)を取得し data/sea/area137.json を再生成する"
    )
    parser.add_argument("--output", default=str(SEA_JSON))
    parser.add_argument("--timeout", type=int, default=60)
    args = parser.parse_args()

    text = fetch_area137_text(timeout=args.timeout)
    records, skipped = parse_area137_text(text)
    if not records:
        raise SystemExit("area137.txt から有効なレコードを取得できませんでした")

    meta = build_meta(
        "jma_engan_area137",
        "海面水温(茨城県北部沿岸)",
        records,
        extra={"skipped": skipped},
    )
    write_json(Path(args.output), meta, records)


if __name__ == "__main__":
    main()
