# Claude Code の設定の同期の作り直し

作り替えの全体計画（`2026-10-07-refactor-roadmap-design.md`）の D6 と、段 4 の骨子を詳しくした設計である。
実装は、段 2 の骨格（書き込みの通知と配る層、畳んだマイグレーション）が入ってから行う。
画面（送る一覧、適用の一覧、ぶつかりの見せ方）は、設定の画面の試作で選んだ（7 章の 5 行目）。
調査は 2026-10-09、main `2782113` で行った。

## 1. いまの実装

`sync/claudeConfig.ts`（884 行、試験 49 件）。運ぶのは `CLAUDE.md`、`settings.json` 全体、`skills/**`、`memory/**`、`projects/*/memory/**`、`statusLine` のスクリプトの 6 種。commands、agents、`keybindings.json` は運ばない。1 ファイル＝R2 の 1 オブジェクト `config/<PC ID>/<相対パス>`、索引は D1 `files`（PUT 1 回で D1 文 3 本）。送信は fs.watch＋60 秒ごと、受信は 30 秒ごと、確認までは書かない。ぶつかりは mtime で新しい方、負けは隣に `.conflict-*`、バックアップは 20 世代。削除は運ばない。ホームだけ `__HANGAR_HOME__` に置換。

危ない所：(a) 認証は運んでいない。(b) `settings.json` 丸ごとなので `env`、`apiKeyHelper`、`hooks`、`statusLine` が渡り、降りたスクリプトに実行許可を付ける＝他 PC からの実行経路。(c) ホーム以外の絶対パス（`permissions` の `//…`、`additionalDirectories`）は直さない。(d) メモリを Claude の slug のまま運ぶので、パスの違う PC では読まれない。(e) mtime 頼みで時計のずれに弱い。

## 2. `settings.json` の鍵の仕分け

公式 index は約 260 鍵。好みは運ぶ、実行、パス、機械の事情は運ばない、権限は選ぶ。

| 区分 | 鍵（例） | 理由 |
|---|---|---|
| 運ぶ | `model`、`effortLevel`、`language`、`outputStyle`、`theme`、`editorMode`、`cleanupPeriodDays`、`attribution`、`autoCompact*`、`autoMemoryEnabled` | 好みで、パスも実行も含まない |
| 運ばない | `env`、`apiKeyHelper`、`hooks`、`statusLine`、`fileSuggestion`、`aws*`、`forceLogin*`、`sandbox`、`autoMemoryDirectory`、`plansDirectory`、`permissions.additionalDirectories`、`enabledPlugins`、`extraKnownMarketplaces`、`*McpjsonServers` | 実行、絶対パス、認証、機械固有。plugins は `cache/` と対で、設定だけ渡すと not cached |
| 選ぶ | `permissions.allow/ask/deny`、`defaultMode` | 価値は最大だが `//` の絶対パス規則は機械固有。既定は「運ぶ、`//` 規則は落として知らせる」 |

知らない鍵は運ばない。許可リストは段 0 の `compat/` に置き、未知の鍵は「変更点」に記録。MCP の個人設定は `~/.claude.json` で対象外。

## 3. データの持ち方

共通：単位は「項目」（ファイル 1 つ、または `settings.json` の鍵 1 つ）。各 PC が `config_base`（項目、最後に同期した sha）を持ち 3 方向で判定：手元だけ→送る、相手だけ→適用、両方→ぶつかり（新しい方を採り、古い方は `conflicts/<時刻>/` へ）。削除は目録に無いことで分かり、相手では `backups/claude-config/removed/` へ移す。メモリは hangar の `project_id` で運び、受け手が `project_roots` のパスから slug（英数字以外→`-`）を作る。プロジェクトの無い PC では保留。公式はメモリの slug を git リポジトリから導くとあり、worktree の扱いは未確認。

| | A ファイル単位 | B PC ごとの束 |
|---|---|---|
| 置き方 | 項目ごとに R2 1 オブジェクト、目録は共有表 `config_items` | PC ごとに R2 1 オブジェクト（tar.gz）、共有表 `config_snapshots` に PC 1 行（目録 JSON） |
| 削除 | 行に墓標 | 目録に無い＝削除 |
| 無料枠（D1 書き 10 万/日、R2 Class A 100 万/月） | 変更 1 件＝PUT 1＋D1 行 2 | まとまり 1 回＝PUT 1＋D1 行 2、件数に依らない。束は数百 KB |
| 段 2 | 共有表なので notify→publisher が配る。起点のマイグレーションに足す | 同じ、表 1 つ |

推すのは B。目録と中身が 1 回の送信で一致し（A は途中で止まるとずれる）、ぶつかりと削除が目録の比較で閉じる。束は既存の `files` PUT に `kind: 'config'` で載せる。

## 4. 始め方と画面

- 1 台目：スイッチを入れると送る一覧（種類ごとの件数、`settings.json` は鍵、落とした鍵と理由）を見せ、承諾で送る。読むだけなので HTTP でよい。
- 2 台目：受けた束は `~/.agent-hangar/claude-config/inbox/` に置くだけ。「適用内容を確認」で新規／上書き／削除／ぶつかりの一覧。
- 適用は D9 どおり HTTP に載せず、殻の命令がネイティブの確認を出して `hangar config apply` と同じ処理（バックアップ→inbox から書く→base 更新）。ブラウザの人にはそのコマンドを案内。
- 承諾した項目は、サーバが hangar の置き場に「適用の指示書」として書くだけにして殻へ渡す（段 4 の設計書の 9 章の 9 と 4.2 の 13）。
  サーバは `~/.claude` に書かない。
  指示書を読んでネイティブの確認を出し、バックアップを取って書くのは、殻の命令と `hangar config apply` だけで、指示書は適用が済むか取り消したら消す。
- 設定にバックアップの世代一覧と「この世代に戻す」。ぶつかりの写しは `~/.claude` の隣に置かず（skills として読まれる）`conflicts/` に置き、「相手を採用」「自分を採用」「差分」。

## 5. 安全

skills、commands、agents は実行される指示で、user-level の agents の `hooks` は信頼の確認なしに走り、skills も `hooks` と `` !`cmd` `` を持てる。暗号はクラウドの改ざんは防ぐが、乗っ取られた PC の正規の送信は防げない。

案：(1) 毎回一覧で承諾、(2) 署名、(3) 初回だけ。推すのは (1) に種類の区別：`CLAUDE.md`、`settings.json`、`keybindings.json`、メモリは初回後は自動でよいが、skills、commands、agents は新規と変更のたびに項目ごとに承諾し、既定では自動にしない（設定で自動に切り替えられる。7 章）。(2) は鍵が共通で無意味、(3) は後の乗っ取りに効かない。

秘密：送る前に本文を走査し、トークンの形（`sk-ant-`、`ghp_`、`AKIA`、`-----BEGIN`）があればその項目を送らず一覧に出す。送るには項目ごとに明示。`env` は鍵ごと落とす。

## 6. PR の切り方

1. サーバ：仕分けと 3 方向判定の純粋関数、2 表（起点に追加）、束の作成と inbox 展開。旧実装は残す。
2. Worker：`kind: 'config'` の束の PUT/GET、旧 `config/` の sweep。
3. CLI と殻：`hangar config apply`、殻の命令と確認、戻し。
4. 画面：設定の節、送る一覧、適用の一覧、ぶつかりの節。
5. 旧実装の削除：`claudeConfig.ts`、`file_sync` の config 行、`/sync/config/*`。

1〜3 は既定が切なので単独で動き、4 で使え、5 で入れ替える。

## 7. 決めたこと（2026-10-09）

| # | 問い | 決めた答え | 決めた人と理由 |
|---|---|---|---|
| 1 | データの形 | PC ごとの束（B） | 設計の判断。目録と中身が 1 回の送信で一致し、無料枠の消費が件数に依らない |
| 2 | 実行される種類（skills、commands、agents）が他の PC から届いたとき | 既定は毎回、項目ごとに承諾する。設定で自動に切り替えられる | 利用者の決定。自動に切り替えるときは、乗っ取られた PC から指示が広がりうることを、その場で 1 文で示す |
| 3 | 適用の経路 | 殻の命令とネイティブの確認、および CLI。HTTP API には載せない | 全体計画の D9 のとおり |
| 4 | 権限の規則（`permissions` の allow、ask、deny） | 運ぶ。絶対パスの規則だけ落とし、落とした規則を一覧で知らせる | 利用者の決定。機械に固有の分だけ外せる |
| 5 | 一覧とぶつかりの見せ方 | (a) 送るものの一覧は、種類ごとの折りたたみ。(b) 適用内容の確認は、操作ごとの折りたたみで、競合と削除を上に置く。(c) 届いた skills、commands、agents の承諾は、表にチェックを付ける。フックやコマンド実行の印の無い行はまとめて選べ、印のある行は中身を開いて 1 件ずつ選ぶ。(d) 競合は、差分を最初から出し、「相手を採用」「自分を採用」を並べる。(e) 送らなかったもの（落とした権限の規則、秘密らしい文字列が見つかった項目）は、同期の節に常設の行を置き、送った直後は通知カードで知らせる。 | 利用者の決定。試作は `docs/superpowers/specs/2026-10-09-settings-screen/options.html`。画面の細部は段 4 の設計書の 2.5。通知カードの置き場は、右下の札を入力待ちだけにする決定（同 2.11.2）と合わせて、段 4 の PR 19 で決める |
