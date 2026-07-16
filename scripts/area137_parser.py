"""気象庁 沿岸海況(area137: 茨城県北部沿岸)テキストのパーサ。

フォーマット: yyyy,mm,dd,areaNo.,flag,Temp.
migrate_initial_data.py(ローカルファイル入力)と update_sea.py(HTTP取得)で共用する。
"""
from __future__ import annotations

import csv
from io import StringIO


def parse_area137_text(text: str) -> tuple[list[dict], int]:
    """area137テキストをパースして (records, skipped件数) を返す。"""
    records: list[dict] = []
    skipped = 0
    reader = csv.reader(StringIO(text))
    next(reader, None)  # header: yyyy,mm,dd,areaNo.,flag,Temp.
    for row in reader:
        if not row or len(row) < 6:
            skipped += 1
            continue
        row = [c.strip() for c in row]
        yyyy, mm, dd, _area_no, flag, temp_raw = row[0], row[1], row[2], row[3], row[4], row[5]
        try:
            year = int(yyyy)
            month = int(mm)
            day = int(dd)
            value = float(temp_raw)
        except (ValueError, TypeError):
            skipped += 1
            continue
        date = f"{year:04d}-{month:02d}-{day:02d}"
        records.append({"date": date, "value": value, "flag": flag})

    records.sort(key=lambda r: r["date"])
    return records, skipped
