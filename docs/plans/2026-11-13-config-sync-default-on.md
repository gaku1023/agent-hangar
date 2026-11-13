# 計画：設定の同期を「基本は同期される」ものにする

決定は `docs/superpowers/specs/2026-11-13-config-sync-default-on/decisions.md`（13 項目と、試作で選んだ C・P1）。
試作は同じ所の `options.html`。
この計画には、インタフェース、受け入れの試験、タスクの分け方だけを書く。

## インタフェース

### 設定 `configKinds`

- `Settings.configKinds?: Partial<Record<ConfigItemKind | 'transcript', ConfigKindMode>>`、`ConfigKindMode = 'off' | 'confirm' | 'auto'`。
- `SettingsDto.configKinds` は、21 個の鍵を全部埋めて返す（足りない鍵は既定で埋める）。
- 既定：`claude-hooks`、`claude-statusline`、`plugins`、`claude-mcp`、`codex-mcp`、`opencode-mcp` は `confirm`。ほかは `auto`。`transcript` は `off` か `auto` だけを取る。
- 共通の読み口：`configKindModeOf(settings, kind): ConfigKindMode`（shared に置き、server と ui が使う）。
- hangar-pref（`targets/hangar.ts` の FITS）に `configKinds` を足し、全部の PC で共通にする。`configApproval` は FITS から外す。
- `configTargets` は使わなくなる。対象（target）は、その対象の種類のどれかが `off` でなければ有効とみなす。
- `settings` の種類は複数の対象にまたがる（claude、claude-keys2、claude-hooks、claude-plugins）。状態は id の `parseItemId(id).kind` で引き、対象では引かない。

### 移行（決定 11）

- `configKinds` が無く、`configBundleSync === true` の設定を読んだとき、1 回だけ `configKinds` を作って書く。
  - その種類の対象が `configTargets` で切なら `off`。
  - 今まで `configApproval === 'each'` で承認が要った種類は `confirm`、`auto` なら `auto`。
  - ほかは既定。
- `configBundleSync` が `false` か無い設定は変えない。
- 新しく作る設定ファイル（`defaultSettings`）だけ、`configBundleSync: true` で始める。

### 状態ごとの振る舞い

- `off`：その種類の項目を送らず（束に入れない）、受けても判定に載せない。
- `confirm`：今の `needsApproval: true` と同じ。画面の確認から適用する。
- `auto`：届いた束の判定のあと、サーバが自分で適用する。

### サーバの自動の適用

- `ConfigSyncService` に `autoApply()` を足す。`receiveNow()` の `reconcile()` のあとに、`chain` に載せて呼ぶ。
- 載せる項目：`configKindModeOf` が `auto`、op が `conflict` でない、`held` でない項目。
- 適用は `writeApplyOrder` と `runApplyAll` を使い、控え（`takeGeneration`）、`config_base` の更新、指示書の削除まで済ませる。
- 人の承認を待つ指示書がすでにあるときは、その回の自動の適用を飛ばす（次の受け取りでやり直す）。
- HTTP の口は増やさない（決定 3）。

### 適用の履歴

- 新しい表 `config_history`：`id`、`at`、`from_device`、`mode`（`auto` か `manual`）、`items`（JSON：`id`、`kind`、`label`、`op`）、`generations`（JSON：対象ごとの世代名）、`undone`（JSON：戻した項目の id）。
- `runApplyAll` に `source?: { mode, fromDevice }` を足し、成功したら 1 行を書く。CLI の手での適用も同じ所で記録される。
- `ConfigSyncDto` に足す：`askCount`（`confirm` で待つ件数）、`autoUnseen`（自動で入って未読の件数）、`history`（新しい順に 20 件）。
- 既読にする口：`POST /config-sync/history/seen`（書き込みは DB の既読の印だけなので HTTP に置く）。

### 1 項目の戻し

- `restoreItem({ generation, target, itemId })`：その世代の控えから 1 項目だけ戻し、`config_base` のその項目も戻す。戻す前の状態は `restore` の世代として控える。
- 呼び口は、世代の戻しと同じく CLI（`hangar config restore --item <id>`）と殻の命令。UI は `runtime/desktop.ts` から。
- 戻したら `config_history.undone` に足す。

### リンクで外した件数

- `collect` の戻り値に、種類ごとに外したパスを足す。`ConfigSyncDto.linkSkipped: Partial<Record<ConfigItemKind, string[]>>`。

### 会話の本文の入切

- `configKinds.transcript === 'off'` のとき、`TranscriptUploader` の送り（`noteChanged`、`sweep`、`flushSession`、`flushAll`、`uploadFile`）と、`RemotePuller.pullNowInner` を止める。
- `isPaused` には混ぜない（メタの行の同期は続ける）。

### 知らせ

- セッションに紐づかない知らせの口を足す：`notifyApp({ text, kind })`。`notifyRulesOf(settings)` の os と phone の振り分けに従う（unread は使わず、ヘッダの札が代わる）。
- 出すとき：`confirm` の項目が新しく届いた、競合が新しく出た、自動の適用が失敗した（どれも `ask`）。自動で入ったものは出さない。

### 画面

- 設定の同期の節を、試作の C（性質ごとの束、束の見出しの切り替え、自動で走るコードの束は色付き）に置き換える。`ConfigTargetRows` と `configApproval` の切り替えは消す。
- 自動で走るコードを `auto` にするときだけ、行の下に 1 文の帯を開く（決定 6）。
- ヘッダの `SyncStatus` の横に、確認の件数（`askCount + conflicts`）と自動で入った件数（`autoUnseen`）の札（P1）。
- 右の「届いたもの」：確認と競合、履歴（1 回ごとに開き、まとめても 1 項目ずつでも戻す）。
- 初回の突き合わせ：競合の確認に「全部手元」「全部相手」を足す。
- 動きは `motionKit`（growIn、collapseOut、resizeFrom、fadeIn、usePresence）にそろえる。
- 文言は全部 Gemini に当ててから入れる。

## 受け入れの試験

1. 既定の設定で他の PC から skills の項目が届くと、画面を触らずに `~/.claude/skills` に書かれ、控えの世代と履歴の 1 行ができる。
2. `claude-hooks` の項目は、既定では書かれず `askCount` に数えられる。
3. 競合の項目は書かれず、ほかの項目だけ自動で入る。
4. 削除の項目は、控えを取って消される。
5. `skills` を `off` にすると、その PC から送らず、届いても判定に載らない。
6. `configKinds` を 1 台で変えると、hangar-pref に乗って別の PC にも効く。
7. 旧設定（`configBundleSync: true`、`configApproval: 'each'`、`configTargets.codex: false`）からの移行で、Codex の種類が `off`、承認の要った種類が `confirm` になる。`configBundleSync` が無い設定は変わらない。
8. 履歴から 1 項目だけ戻すと、その項目だけ前の中身に戻り、ほかはそのまま。
9. リンクの skill は束に入らず、`linkSkipped.skills` に名前が出る。
10. `transcript` を `off` にすると、本文の送受信が止まり、メタの行は同期する。
11. `confirm` の項目と競合が届くと、`ask` の知らせが os と phone に振り分けられる。自動の分では出ない。

## タスク

| # | 内容 | 依存 | 担当 |
|---|---|---|---|
| T1 | `configKinds`、既定、移行、hangar-pref、送受信の off、`needsApproval` を種類の状態から | なし | opus |
| T2 | 自動の適用、`config_history`、`askCount`・`autoUnseen`・`history`、既読の口 | T1 | opus |
| T3 | 会話の本文の入切 | T1 | sonnet |
| T4 | リンクで外した件数 | なし | sonnet |
| T5 | 1 項目の戻し（apply、CLI、殻、runtime） | T2 | sonnet |
| T6 | セッションに紐づかない知らせ | T2 | sonnet |
| T7 | 画面（C、P1、届いたもの、初回、文言の校閲） | T1〜T6 | sonnet |

各タスクで `docs/design.md` と `docs/cloud-sync.md` の該当の節も直す。
1 タスク 1 PR とし、CI が緑ならマージしてから、次の依存のタスクを渡す。
