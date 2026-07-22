# ibaraki-watertemp

茨城県内の水温(海面・河川/湖沼・水道水)を比較表示する静的Webアプリ。
ビルド工程なしの素のHTML/JS/JSONで構成し、GitHub Pagesでホスティングする。
データ更新はGitHub Actions + Python(3.11)で自動化する想定。
ブラウザ依存ライブラリは再現性を保つため、`index.html` のCDN URLで完全な
バージョン番号を固定する。

## データ源

| 種別 | 識別子(source) | 内容 |
| --- | --- | --- |
| 海面水温 | `jma_engan_area137` / `jma_engan_area138` | 気象庁 沿岸海況(茨城県北部・南部沿岸) |
| 水道水温 | `manual_tapwater` | 久慈川水系の水道水温(手動記録) |
| 河川・湖沼水温 | `river_go_jp_wqua_kind5` | 国土交通省 水文水質DBの霞ヶ浦3地点・北浦3地点・利根川2地点 |
| 参考データ | `reference_kitaura_chart` | 北浦の参考水温データ(チャート由来、日次平均) |

## 構成

```
config/
  stations.json        # フロントが読み込む系列一覧(表示名・種別・データパス・有効/無効)
data/
  sea/                  # 海面水温
  river/                # 河川・湖沼水温(霞ヶ浦・北浦・利根川)
  tapwater/             # 水道水温
  reference/            # 参考データ(比較用途、正式系列とは別扱い)
scripts/
  migrate_initial_data.py  # 既存テキスト/CSVをアプリ用JSONへ変換する初回移行スクリプト(初期移行専用・ローカル実行専用)
  update_sea.py            # 気象庁area137/138を取得し data/sea/*.json を再生成
  update_wqua.py           # 水文水質DB(KIND=5)を取得し data/river/{station_id}.json を更新
  update_latest_wqua.py    # 河川・湖沼のカード用最新時刻値だけを更新(recordsは変更しない)
  backfill_wqua.py         # 河川・湖沼データを2016年まで段階的に遡及取得
  append_tapwater.py       # GitHub Issue("temp: ...")から水道水温を1件追記
  validate_data.py         # 設定と全データJSONの整合性を検査
  http_retry.py            # 外部取得の再試行設定
  jsonutil.py              # meta+records形式のJSON入出力共通ユーティリティ
  area137_parser.py        # area137テキストの共通パーサ
```

## データJSONスキーマ

各データファイルは共通のスキーマを持つ。

```json
{
  "meta": {
    "source": "識別子",
    "name": "表示名",
    "unit": "°C",
    "record_count": 0,
    "dataset_start": "YYYY-MM-DD",
    "dataset_end": "YYYY-MM-DD",
    "generated_utc": "ISO8601",
    "latest_observation": {
      "observed_at": "YYYY-MM-DDThh:mm:ss+09:00",
      "value": 0.0
    }
  },
  "records": [
    {"date": "YYYY-MM-DD", "value": 0.0}
  ]
}
```

- 水道水温: 特記事項がある日のレコードには `note` を付与
- 海面水温: 各レコードに観測フラグ `flag`(R/P等)を付与。欠損・非数値行はスキップし、件数を `meta.skipped` に記録
- 北浦(参考データ): 元データの時刻情報は落として日付単位に丸め、同日複数レコードは平均(小数第1位)
- 河川・湖沼水温: `latest_observation` は上部カード専用の最新時刻値。グラフは従来どおり日別平均の `records` を使用

## セットアップ

Python 3.11想定。標準ライブラリのみで初回移行を実行できる。

```
python3 scripts/migrate_initial_data.py
```

日次のデータ更新(海面水温 + 河川・湖沼水温)は `requests` が必要。

```
pip install -r requirements.txt
python3 scripts/update_sea.py
python3 scripts/update_wqua.py --station <観測所記号> --days 14
python3 scripts/validate_data.py
```

## 自動更新と障害時の挙動

`.github/workflows/update_data.yml` が毎日6:10(JST)に次を実行する。

1. 海面水温2区域を全量更新
2. `config/stations.json` で有効な河川・湖沼地点の直近14日を更新
3. 各地点を1日あたり最大28日分、2016-01-01まで段階的にバックフィル
4. 全JSONを検査してから、成功した更新をまとめてcommit/push

加えて `.github/workflows/update_latest.yml` が毎時35分に、有効な河川・湖沼地点の
当日・前日データから最新の時刻値だけを取得する。更新対象は
`meta.latest_observation` のため、グラフ用の日別 `records` は変更しない。海面水温と
水道水温は時刻値の配信元がないため、カードでも従来の日次最新値を表示する。

外部取得は一時的な通信障害とHTTP 429/5xxを再試行する。特定の区域・地点が
失敗しても他地点の処理と成功分の保存は継続するが、見逃さないようworkflow全体は
最後に失敗として通知される。バックフィルで空期間が返った場合は、次回も同じ期間が
空であることを確認してから取得済みとして進める。

pushおよびPull Requestでは `.github/workflows/ci.yml` がJavaScript構文、Pythonの
単体テスト、全データJSONの整合性を検査する。

## 河川・湖沼水温をさらに過去まで取得したい場合

`scripts/update_wqua.py` は `--bgn`/`--end`(YYYYMMDD)で任意期間を指定でき、
サーバー側の制約(1リクエストあたりBGNDATE〜ENDDATEの差は最大7日)に合わせて
内部で自動的に日付範囲を分割し、リクエスト間に2秒以上のsleepを挟みながら
順次取得・マージする(既存JSONがあれば日付キーで上書きマージ)。

より過去のデータを取得したい場合は、同じコマンドで `--bgn`/`--end` に
広い期間を指定すればよい(サーバー負荷配慮のため、一度に長期間・高頻度で
実行しないこと)。

```
python3 scripts/update_wqua.py --station 403031283303071 --bgn 20240101 --end 20241231
```

長期間(数年分)を一括で遡って取得する場合は、リクエスト数が非常に多くなり
(7日チャンクで年あたり約46〜53リクエスト)実行時間もかかるため、サーバー負荷
・実行時間を踏まえて期間を区切って実行することを推奨する。
