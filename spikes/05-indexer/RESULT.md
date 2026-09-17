# spike 05: jsonl の逐次解析と FTS5 trigram

判定: 合格
実施日: 2026-09-17

## 確かめたこと
- better-sqlite3 同梱の SQLite は 3.53.4 で、FTS5 と trigram トークナイザが使える。
- `~/.claude/projects` 直下の 170 セッションと、`<sessionId>/subagents/` 配下の 563 サブエージェント本文を、バイト位置を持ちながら 1 行ずつ解析して索引化できた。壊れた行は 0。
- 追記中の jsonl を 300 ミリ秒間隔でバイト位置から追い、改行で終わっていない断片を次回に回す方式で、実行中のセッションに 3 回プロンプトを送っても `BAD` は出なかった。
- 日本語の部分一致（「動画 チャンネル」）と英字の検索が 1 ミリ秒以内に返る。

## 計測値
- ファイル 733、行 217,706、合計 1,341MB、所要 7.1 秒、DB 183MB（FTS 込み）。最大行 7.2MB。
- 検索：3 語とも 0〜1 ミリ秒（FTS5 trigram、セッション別の集計付き）。

## 設計への影響
- **サブエージェントの本文は別ファイル**（`<sessionId>/subagents/agent-<hex>.jsonl`）にあり、件数ではセッション本体の 3 倍以上ある。インデクサは両方を読み、`parent_agent` で親に紐づける。
- **FTS5 の検索語はトークンごとに二重引用符で包む**。`agent-hangar` のようなハイフン入りを素のまま渡すと列指定と解釈されて `no such column` になる。
- 行の `type` は設計文書に挙げた以外にも多数ある（`bridge-session`、`agent-name`、`file-history-delta`、`frame-link`、`cost-state`、`relocated`、`worktree-state`、`history-suppression`、`artifact-autoreact-ledger`、`artifact-comment-monitor`、`custom-title`、`fork-context-ref`）。未知の種別は `meta` として保持する方針で正しい。`custom-title` は利用者が付けた題名の候補になる。
- `user` 行の `message.content` は配列ではなく文字列のことがある。抽出は両方を受ける。
- 1.4GB でも 10 秒未満なので、`indexer_version` 変更時の全件再構築は背景で気軽に回せる。「N / 総数 件」の進行表示で足りる。
- DB は本文抜きでも 183MB になる。FTS に入れる本文の上限（現状 1 イベント 20,000 字）は妥当。

## 残った疑問
- 1 行 7.2MB の巨大イベント（貼り付けや大きなツール結果）を UI で開くときの描画方針。フェーズ 1 で折りたたみと部分表示を決める。
