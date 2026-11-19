# AGENTS.md

AI のコーディングエージェント（Codex、Claude Code など）向けの決まり。Claude Code は `CLAUDE.md` からこのファイルを読む。決まりはここにだけ書き、`CLAUDE.md` には書かない。

## このリポジトリ

札幌市議会の会議録（2007〜2026年、本会議と委員会）を、話題ごと・区ごとに20年分の経緯と現状を追える形に整理したもの。公開リポジトリで、読む人（議員・候補者など）向けの入口は [README.md](README.md)。エンジニア向けの資料は `docs/` にある: 全体の流れは [docs/README.md](docs/README.md)、工程ごとの判断と理由は [docs/作り方.md](docs/作り方.md)、コマンドとファイル構成は [docs/動かし方.md](docs/動かし方.md)。作業の前に、頼まれたことに関係する節を読む。

工程と出力:

| 工程 | スクリプト | 出力 | AI |
|---|---|---|---|
| 1 原本 | `pipeline/01_download.mjs` | `data/raw/`（Git の外） | なし |
| 2 Markdown | `pipeline/02_to_markdown.mjs` | `data/md/`（Git の外） | なし |
| 3 構造化 | `pipeline/03a`〜`03f` | `data/struct/`（Git の外） | なし |
| 4 話題の一覧 | 人が `pipeline/topics.csv` を直す | `pipeline/topics.csv` | 試行だけ |
| 5 分類・要約 | `pipeline/05_run_all.mjs`、`05_classify.mjs` | `records/<年>.jsonl`（記録の本体） | API（Haiku） |
| 6 話題×任期 | `pipeline/06_bundle.mjs` | `bundles/<話題>/<任期>.json`、`.md` | API（細かく分けた5分野は Opus、ほかは Sonnet） |
| 7 20年のまとめ | `pipeline/07_history.mjs`、手直し `07b_fix.mjs` | `topics/<話題>/history.json`、`README.md`、`topics/README.md` | API（Opus） |
| 年表（全市） | `pipeline/07a_timeline.mjs` | `topics/<話題>/年表.md`（Git の外） | なし |
| 8 照合 | `pipeline/08_verify.mjs`（`data/struct/` の原文が要る） | `topics/要確認.md`、`verify/` | なし |
| 区の入口 | `pipeline/09_area.mjs` | `areas/README.md`、`areas/<区>/` | なし |

## 守ること

- **API の料金がかかるものは、流す前に見積もりを出して人に確かめる。** `--env-file=.env` を付けて `05`・`06`・`07` を流す前に、`--dry-run` で件数と量を出し、スクリプトの単価の表（`BATCH_PRICE` など）で見積もる。人が「流して」と言うまで流さない
- **`data/` の中身をそのまま読み込まない。** 会議録の原文は数千万字ある。件数や中身は、スクリプトや `node -e` で数えて確かめる。原文を見るときは、記録の `huids`（発言の番号）で `data/struct/speeches/<年>.jsonl` から必要な発言だけを引く
- **会議録システムへのリクエストは1.5秒に1回。** `01_download.mjs` の間隔を縮めない。並列で動かさない
- **AI が作った中身（`records/`、`bundles/`、`topics/<話題>/history.json`）を手で書き換えない。** 20年のまとめの文を直すときは、原文で確かめてから `pipeline/fixes/07_history.jsonl` に1行書き、`node pipeline/07b_fix.mjs` で当てる。理由（どの記録の原文と照らしたか）を書く
- **指示書（`pipeline/prompts/`）を直すときは版を上げる。** 別のファイル（`_v3.md` など）にし、スクリプトの `PROMPT_VERSION` を変える。記録やまとめには、どの版で作ったかが残る
- **話題の一覧は `pipeline/topics.csv`、会派の名簿は `pipeline/members/*.csv` を直す。** 会派の名簿を直したら `node pipeline/03c_members.mjs` で検証の件数が0件のままかを見る
- **作り直したら、照合と印を付け直す。** `08_verify.mjs` → `07_history.mjs --render` → `06_bundle.mjs --render` の順。区の入口も `09_area.mjs --all` で作り直す
- **出典を壊さない。** まとめの文の出典は記録の id（`[246405-1]`）で、会議録の URL はコードで付ける。AI に URL を書かせない
- **公開リポジトリなので、使った金額と、作った人の個人的な事情を書かない。** 資料、コメント、コミットメッセージに、API に払った実績の金額や、誰のために作ったか・誰が決めたかなどの内輪のことを書かない。見積もりのための単価の表と、`--dry-run` の見積もりの表示はよい
- **読む人の入口（README.md）は、Git、Node、JSONL などの言葉を使わずに書く**（「エンジニア向け」と「ライセンス」の節を除く）。読む人の目に入る出力（`topics/`、`areas/`、`bundles/` の `.md`、README.md）では、話題の分け方を「分野」と書き、「5本柱」「柱」は使わない（`topics.csv` の列名「柱」、`--pillars`、API に送る入力の文はそのまま）
- **読む人が開く `.md` は、GitHub の画面で Markdown として表示できる大きさにする。** バイト数だけでなく、リンクと見出しの数で決まる（2026年11月19日に確かめた。`09_area.mjs` の頭のコメント）。`09_area.mjs` は、見積もり（バイト数＋リンク1本につき100＋見出し1つにつき800）が40万を超えるものを自動で分ける。ほかのファイルも 1MB 未満にする（`records/*.jsonl` を除く）
- `.env`（API キー）を読まない・表示しない・Git に入れない

## よく頼まれること

- **区の入口を作り直す**: `node pipeline/09_area.mjs --all`（料金なし、数秒）。1つの区だけなら `--area <区>`。区の名前は「北区」のように「区」まで。作ったら `node pipeline/07_history.mjs --render` で話題の一覧のリンクも作り直す
- **新しい会議の分を足す**: [docs/動かし方.md](docs/動かし方.md) の「4」の順。最初に料金の見積もりを出す
- **［要確認］を確かめる**: `topics/要確認.md` の文について、引いた記録（`records/`）と、その記録の `huids` の原文を照らす。直すべきものは `pipeline/fixes/07_history.jsonl` に書く。確かめ方は [docs/照合と手直し.md](docs/照合と手直し.md)
- **誤りの指摘を直す**: 指摘された文を、引いた記録と会議録の原文で確かめてから、上と同じく `pipeline/fixes/07_history.jsonl` に書いて当てる
- **話題の一覧を変える**: `pipeline/topics.csv` を直す。工程5から全部流し直しになり料金が大きいので、必ず先に `--dry-run` で見積もりを出して人と相談する

## 書き方

- 文書は日本語。です・ます調でなく、だ・である調か体言止めで簡潔に書く
- 表やファイルの説明は docs/ の書き方に合わせる
- 結果を書くときは、数（件数、何件中何件）と日付を入れる
