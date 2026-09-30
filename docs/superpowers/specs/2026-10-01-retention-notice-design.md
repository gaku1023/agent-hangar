# 会話の保持期間の周知 設計

## この文書の位置づけ

Claude Code は、保持期間（`cleanupPeriodDays`、既定は 30 日）を過ぎた会話の本文を黙って消す。消えた会話は hangar でも本文を読めなくなる。
この機能は、そのことを hangar の中で利用者に知らせ、確認を挟んでその場で保持期間を延ばせるようにする。本文が消えた会話も、消えたと分かる形で見せる。
見た目の試作は `2026-10-01-retention-notice/notice.html`（全 12 案）と `2026-10-01-retention-notice/combined.html`（決めた組み合わせ）にある。
実装が済んだら、本体の設計書 `docs/design.md` の該当箇所（原則、Home、セッション詳細、Sessions、Settings）へ内容を移す。原則の例外は、この機能と同じ変更で書き足す。

## 目的

2026-09-30 に測ったところ、hangar の DB には 1,177 件の会話があり、本文が残っていたのは 214 件だった。利用者自身も、過去の会話が開けない理由をすぐには分からなかった。
Claude Code のドキュメントには「削除は通知なしに行う」と書いてある（settings-reference の `cleanupPeriodDays`）。

うまくいった状態とは、次の三つが揃うことである。

- 保持期間が既定の 30 日のままなら、それが Home で分かり、1 回の確認で延ばせる。
- 延ばすとディスクをどれだけ使うかが、延ばす前に分かる。
- 本文が消えた会話が、一覧でも詳細でも「消えた」と分かる。今のように、開いてから 404 のエラーになることが無い。

## 利用者の決定（2026-10-01）

- 知らせる経路は三つにする。保持期間が短いときだけ出る帯、本文が消えた会話を開いたときの理由の表示、設定画面の常設の項目。初回起動の案内やトーストは使わない。
- 確認を挟めば、UI から `~/.claude/settings.json` に書いてよい。これは原則「読み取り専用」の 4 つめの例外として `docs/design.md` に書き足す（CLI に回す案は採らない）。
- 帯と確認では、使用量も見せる。
- 延ばすときの既定は 1 年（365 日）にする。
- 帯は A2 にする。まもなく消える会話の件数を出し、0 件なら A1 の文言にする。
- 確認は B1 にする。書き込む 1 行を差分で見せ、使用量の見込みをバーで見せる。
- 開いたときは C2 にする。要約を見せ、消えたことを上の注記一行で伝える。
- 一覧は ③a にする。行の色はそのままにして、文字の無い小さな印を付ける。説明はカーソルを乗せると出す。消えかけの会話には琥珀の「まもなく削除」を付ける。
- 設定画面は D2 にする。期間の切り替えの帯と、見込みのバーを置く。

## 範囲の外

- 消えた本文を取り戻すこと。Time Machine もクラウドの控えも無い本文は、どこにも無い。
- hangar 自身が本文の控えを取ること（2026-09-30 に採らないと決めた）。
- プロジェクトの設定（`.claude/settings.json`、`.claude/settings.local.json`）とコマンド行の `--settings` の `cleanupPeriodDays`。ユーザー設定より強いが、hangar はユーザー設定と組織の設定だけを読む。
- 組織の設定のうち、MDM の構成プロファイルと claude.ai のコンソールから配るもの。
- `desktopSessionCleanupPeriodDays` と、本文以外に同じ期限で消える `file-history/` や `plans/` など。
- 帯を閉じた後に、もう一度出すこと。

## Claude Code の保持期間について分かっていること

ドキュメント（code.claude.com の settings-reference と claude-directory、2026-10-01 に確認）から、次のことが分かっている。

- `cleanupPeriodDays` は 1 以上の整数で、既定は 30 である。`0` は検証で弾かれる。
- 削除はセッションを始めたあとに、バックグラウンドの掃除として行われ、通知は出ない。
- 消える対象は `projects/<project>/<session>.jsonl`、その会話の `subagents/` と `tool-results/`、ほかに `file-history/` や `plans/` などである。
- 設定は組織の設定（managed settings）が最も強く、ユーザー設定（`~/.claude/settings.json`）は最も弱い。

「期間を過ぎた」の判定にファイルの更新時刻を使うことは、ドキュメントに書いていない。この設計は更新時刻で判定すると仮定する。手元では最古の本文の更新時刻がちょうど 30 日前であり、この仮定と合っている。

## サーバ

### 保持期間を読む

新しいモジュール `packages/server/src/config/retention.ts` が、実際に効いている保持期間を求める。

```ts
type RetentionSource = 'default' | 'user' | 'managed';
type Retention = {
  days: number;               // 実際に効いている日数
  source: RetentionSource;    // どこで決まったか
  userValue: number | null;   // ユーザー設定の値。キーが無ければ null
  writable: boolean;          // UI から書けるか
  unwritableReason: string | null;
};
```

- 組織の設定は、macOS では `/Library/Application Support/ClaudeCode/managed-settings.json` と、同じ場所の `managed-settings.d/` から読む。MDM の構成プロファイルと、claude.ai のコンソールから配る設定は読まない（範囲の外）。そこに値があれば、`source: 'managed'`、`writable: false` とし、理由は「組織の設定で決まっています」とする。
- 組織の設定が無ければ、`<claudeDir>/settings.json` を読む。
  - キーが 1 以上の整数なら `source: 'user'`。
  - キーが無い、またはファイルが無いときは、`source: 'default'`、`days: 30` とする。ファイルが無くても書ける（新しく作る）。
  - ファイルが JSON として読めないときは、`days: 30`、`writable: false` とし、理由は「設定ファイルを読み取れないので書き換えません」とする。
- 読むのは起動時と、60 秒ごとの設定の送信（`server.ts` の `CONFIG_PUSH_MS`）と同じ周期、それと書き込んだ直後である。値が変わったら、websocket に `retention.changed` を流す。

### 使用量を測る

同じモジュールが、本文の使用量を測る。

```ts
type RetentionUsage = {
  bytes: number;        // <claudeDir>/projects の合計
  dailyBytes: number;   // 1 日あたりの増え方の見積もり
  freeBytes: number;    // <claudeDir> のあるディスクの空き
  measuredAt: number;
};
```

- `bytes` は、`<claudeDir>/projects` の下を lstat でたどって足す。シンボリックリンクはたどらない。
- `dailyBytes` は、更新時刻が直近 30 日以内のファイルの合計を 30 で割る。見込みは `dailyBytes × 日数` の単純な掛け算で、画面では必ず「約」を付けて「いまの増え方で延ばした見込み」と書く。
- `freeBytes` は `fs.statfsSync(claudeDir)` の `bavail × bsize` とする。
- 測るのは起動の 30 秒後と、その後 1 時間ごとである。重い走査なので、要求のたびには測らない。測り終えるまでの値は null にする。

### まもなく消える会話

- `transcript_files` のうち、この PC の本文（`device_id is null`、`agent_id is null`）で、ファイルがまだあり、`mtime + days` が今から 7 日以内に来るものを「まもなく削除」とする。
- `SessionDto` に `transcriptMtime: number | null`（この PC の本文の更新時刻、無ければ null）を足す。`queries.ts` の `SESSION_SELECT` で `transcript_files.mtime` の最大値を取る。期限（`transcriptMtime + days`）は presenter が今の日数から計算する。縮める確認では、新しい日数で数え直す。
- 帯の件数は UI の presenter が `store.sessions` から数える。サーバは数を別に送らない。

### 消えた本文の索引を片付ける（不具合の修正）

今は、本文ファイルが消えても `transcript_files` と `event_index` の行が残る。`selectFilesToIndex` が消えたファイルを `drop` に入れないためである。
2026-10-01 の手元の DB では、この PC の本文として 259 行があり、そのうち 80 行のファイルがもう無かった。
こうした会話は `hasTranscript: true` のまま一覧に出て、開くと `GET /sessions/:id/events` が 404 を返す。文言は「Settings の「索引を作り直す」を試してください」だが、作り直しても直らない。

- `IndexerService` の走査で、`device_id is null` の行のうち、見つかったファイルに含まれず、実際に `lstat` で無いと確かめられたものを `forgetTranscriptFile` に渡す。消すのは DB の行だけで、利用者のファイルには触れない（原則「ファイルを消さない」とはぶつからない）。
- 片付けた会話は `session.upsert` で流し直す。これで `hasTranscript` が false になる。
- 404 の文言は「このセッションの本文はこの PC にありません」に改める。

### 書き込む

エンドポイントを二つ足す。

- `POST /api/retention/preview`（本文は `{ days }`）は、書いたらどうなるかを返す。何も書かない。
  ```ts
  type RetentionPreviewDto = {
    path: string;                          // 実際に書くファイル（シンボリックリンクは解いた先）
    lines: { kind: 'ctx' | 'add' | 'del'; text: string }[];  // 変わる行と、前後 1 行ずつ
    baseSha256: string;                    // 読んだ時点のファイルの sha256。無ければ空文字
    backupDir: string;                     // 控えを置く場所
    projectedBytes: number | null;         // dailyBytes × days
  };
  ```
- `PUT /api/retention`（本文は `{ days, baseSha256 }`）は書き込む。

書き込みの手順は、`~/.claude.json` を書き換える `config/claudeJson.ts` と同じ決まりに従う。

1. ロックを取る。
2. シンボリックリンクを解いて、実際のファイルを得る。
3. 読み直して sha256 を取る。`baseSha256` と違えば、書かずに 409 を返す（下見の後に、ほかの PC からの同期や手の編集で変わったため）。
4. `backupBeforeWrite` で `~/.agent-hangar/backups/claude-config/<時刻>/settings.json` に控えを取る。控えが取れなければ書かない。ファイルが無いときは控えは要らない。
5. 文字列を 1 か所だけ書き換える（次の節）。
6. 一時ファイルに書き、fsync してから rename する。権限は元のファイルに合わせ、新しく作るときは 0600 にする。
7. 保持期間を読み直し、`retention.changed` を流す。

`claudeJson.ts` のロック、控え、一時ファイルへの書き込みは今は非公開なので、`config/claudeFileWrite.ts` に切り出し、`claudeJson.ts` と `retention.ts` の両方から使う。`claudeJson.ts` の振る舞いは変えない。

### 1 行だけ書き換える

手元の `settings.json` は `"key" : value` のように、コロンの前後に空白がある書式で書かれている。`JSON.stringify` で書き直すと全行が変わる。そうなると差分は読めず、設定の同期で送る内容も全体が変わる。
そのため、書き換えは文字列の上で最小にとどめる。

- 文字列と入れ子の深さを追う小さな走査で、最上位の `"cleanupPeriodDays"` の値の位置を探す。入れ子の中の同名のキーは対象にしない。
- キーがあれば、値の数字の部分だけを置き換える。
- キーが無ければ、最上位の最初のメンバーの前に 1 行を差し込む。字下げとコロンの前後の空白は、最初のメンバーに合わせる。オブジェクトが空（`{}`）のときやファイルが無いときは、`{\n  "cleanupPeriodDays": N\n}\n` を書く。
- 書き換えた文字列を `JSON.parse` し、`cleanupPeriodDays` が N であること、ほかのキーが書き換え前と深く等しいことを確かめる。合わなければ書かず、「設定ファイルの書式を読み取れなかったので書き換えませんでした」とする。

### 同期との関係

- 設定の同期が有効なら、`ClaudeConfigSync` の監視が書き換えを拾い、ほかの PC へ送る。この機能から送る処理は足さない。
- ほかの PC で保持期間を変えた後に届いた値は、既存の取り込み（確認、控え、競合なら `.conflict-` のファイル）の決まりのとおりに扱う。
- 確認のダイアログには、同期が有効なときだけ「設定の同期で、ほかの PC にも届きます」と書く。

## UI

### 状態とイベント

- `BootstrapDto` に `retention: RetentionDto | null` を足す。`RetentionDto` は、上の `Retention` に `usage: RetentionUsage | null` を加えたものである。
- `ServerEvent` に `{ type: 'retention.changed'; retention: RetentionDto }` を足し、`store.retention` を差し替える。
- 帯を閉じたことは、`localStorage` の `retention.bannerDismissed` に持つ（`design.md` の「UI の一時的な状態は端末ごとに localStorage」に従う）。読み方は `sidebar.collapsed` と同じにする。
- Intent を四つ足す。
  - `retention.dismiss`：帯を閉じる。
  - `retention.edit { days }`：確認を開く。
  - `retention.write`：書き込む。
  - `retention.settings`：設定画面の保持の節へ移る。
- Mediator の領域を `mediator/retention.ts` に置く。Overlay に `{ kind: 'retention'; days: number }` を足す。開くと effect `api.retentionPreview` を出し、結果は `store.retentionPreview` に入る。

### 帯（A2）

- 出す条件は三つが揃うときである。`store.retention.source === 'default'`、`writable` が真、帯をまだ閉じていない。値を自分で入れた人（30 日を含む）と、組織の設定で決まっている人には出さない。
- 置き場所は、接続が切れたときの帯と同じ grid の 2 行目である。二つの帯を `.banners` の箱に縦に積み、接続の帯を上にする。`.main` の上の余白は、`:has()` で帯の数から計算する。
- ガラスを許す部品の一覧（`glass.test.ts`、`design.md` の「見た目と動き」）に、この帯を足す。
- 文言は presenter が組み立てる。
  - まもなく消える会話が 1 件以上：見出しは「N 件の会話が、まもなく削除されます」、添え書きは「Claude Code は 30 日で本文を消します ・ いま 1.5 GB」。
  - 0 件：見出しは「会話は 30 日で削除されます」、添え書きは「hangar の履歴からも消えます ・ いま 1.5 GB」。
  - 使用量をまだ測っていないときは「・ いま …」の部分を出さない。
- ボタンは二つ置く。「このままでよい」は `retention.dismiss`、「保持期間を延ばす…」は `retention.edit { days: 365 }` を出す。
- `role="status"` のままにし、`aria-label` で接続の帯と区別する。`Shell.test.tsx` の `getByRole('status')` は名前で絞る形に改める。

### 確認（B1）

- `.dialog` の形で次のものを出す。
  - 題：「会話の保持期間を 1 年にします」。日数を題の言い方にするのは presenter で、30 日、90 日、1 年、10 年、それ以外は「N 日」とする。
  - 説明：「Claude Code の設定ファイルに、次の 1 行を足します」。値を変えるときは「次の 1 行を書き換えます」とする。
  - 差分：`lines` をそのまま描く。先頭にファイルのパスを置く。
  - 使用量のバー：いまの使用量と、見込み（`projectedBytes`）と、ディスクの空きを描く。見込みが空きの半分を超えるときは、見込みの数字を警告の色にする。
  - 次の行を並べる。「控え」は `backupDir`。「ほかの PC」は同期が有効なときだけ出す。「もう消えた会話」は「取り戻せません。これから先の会話が残ります」とする。
  - ボタン：「やめる」、「ほかの期間…」（`retention.settings`、帯から開いたときだけ）、「書き込む」（`retention.write`）。
- 縮める向き（今より短い日数）のときは、題を「会話の保持期間を N 日に縮めます」とする。「次に Claude Code を使い始めたとき、M 件の会話の本文が削除されます」の一行も足す。M は、`transcriptMtime + 新しい日数` が今より前になる会話の数である。
- 409 が返ったら、下見を取り直し、「設定ファイルがほかで変わったので、読み直しました」と出す。
- 書けたらダイアログを閉じ、トーストで「保持期間を 1 年にしました」と出す。帯は `retention.changed` で `source` が `user` になって消える。

### 一覧の印（③a）

- 行の props（`presenters/row.ts` の `SessionRowProps`）に `transcript: 'present' | 'expiring' | 'gone' | 'none'` を足す。
  - `expiring` は、`transcriptMtime + days` が今から 7 日以内に来るものである。行の右側に琥珀のチップ「まもなく削除」を置く。
  - `gone` は、本文が無く（`hasTranscript` が偽）、最後に動いてから 30 日を過ぎたものである。日付の左に、文字の無い印を置く。印は `Icon.tsx` に足し、`aria-label` と `title` を「要約のみ。本文は Claude Code の保持期間で削除されたとみられます」とする。
  - `none` は、本文が無いがまだ 30 日を過ぎていないもの（ほかの PC にしか無い、など）である。今と同じく何も付けない。
- 行の文字と状態の点の色は変えない。
- 行の高さ（56px）は変えない。

「30 日を過ぎたもの」の判定に、今の保持期間ではなく 30 日を使うのは、今日延ばしても、過去の本文は 30 日の規則で消えているからである。30 日より前に別の理由で消えた本文も同じ印になるので、文言は「とみられます」とする。

### 開いたとき（C2）

- `transcript` が `gone` のセッション詳細では、次のようにする。
  - 見出しのチップ「本文がありません」を「要約のみ」に改める。
  - 要約の上に注記を一行置く。「本文は、Claude Code の保持期間（30 日）を過ぎたため削除されたとみられます。残っているのは要約だけです。」
  - 保持期間が既定のままなら、注記の末尾に「保持期間を延ばす…」を付ける（`retention.edit { days: 365 }`）。
  - 要約の詳細は、最初から開いた状態にする。
  - 「要約を作り直す」は本文が無いと失敗するので出さない。
  - 要約も無いときは、注記の下に「要約もありません」とだけ書く。
- 本文が無いので、会話の欄（Transcript）とターンの目次は出さない。

### 設定画面（D2）

- 「索引」の節の前に、「会話の保持」の節を置く。
- 1 行めは「保持期間」で、添え書きは「Claude Code の cleanupPeriodDays」とする。右に切り替えの帯（30 日 / 90 日 / 1 年 / 10 年）を置く。
  - 今の値が四つのどれでもないとき（例：3650 以外の手入力の値）は、その値を 5 つめとして帯に足す。
  - 押しても、その場では保存しない。`retention.edit { days }` を出して、確認（B1）を開く。今の値と同じものを押したときは何もしない。
  - `writable` が偽のときは切り替えの帯を出さず、値と `unwritableReason` だけを出す。
- 2 行めは使用量のバーで、確認と同じ部品を使う。見込みは今の日数で計算する。
- 添え書きは「変えるときは、差分を確かめてから書き込みます」とする。同期が有効なら「値は設定の同期でほかの PC にも届きます」も足す。

## 原則の書き足し（`docs/design.md`）

「読み取り専用」の例外に、4 つめとして次を足す。

> - 利用者が確認のダイアログで押した「書き込む」で、`~/.claude/settings.json` の `cleanupPeriodDays` の 1 か所だけを書き換えること。書く前に差分を見せ、`~/.agent-hangar/backups/claude-config/<時刻>/` へ控えを取り、控えが取れなければ書かない。ほかのキーと書式には触れない。

Settings の節の「書き込むボタンは持たない」の記述の近くに、会話の保持の節だけは確認を挟んで書く旨を足す。

## テスト

- サーバ
  - `retention.test.ts`：保持期間の求め方（組織の設定、ユーザーの値、キーが無い、ファイルが無い、JSON が壊れている）を確かめる。
  - 1 行の書き換えを確かめる。
    - キーがある、キーが無い、`{}`、ファイルが無い。
    - `" : "` と `": "` の二つの書式。
    - 入れ子に同名のキーがある。
    - 文字列の中に `{` や `"cleanupPeriodDays"` がある。
    - 書き換えの後の検証で弾く場合。
  - 書き込みを確かめる。
    - sha256 の不一致で 409 になる。
    - 控えが取れないと書かない。
    - シンボリックリンクの先に書く。
    - 権限を保つ。
  - 使用量を確かめる。シンボリックリンクをたどらないこと、直近 30 日の割り算。
  - `claudeJson.test.ts` が切り出しの後もそのまま通ること。
  - `indexer/service.test.ts`：消えたファイルの行を片付けて `session.upsert` を流すこと。別の PC の本文（`device_id` あり）の行は片付けないこと。
  - `http/app.test.ts`：二つのエンドポイントの入力の検証（1 以上の整数だけを受け付ける）と 404 の文言。
- UI
  - `presenters.test.ts`：帯の出る条件と文言の 2 通り、日数の言い方、行の `transcript` の 4 通りを確かめる。
  - `transition.test.ts`：`retention.edit` から `retention.write` までの流れ、409 で読み直すこと、`retention.dismiss` で `storage.save` が出ること。
  - `SessionRows.test.tsx`：印とチップ、行の高さが変わらないこと。
  - `Shell.test.tsx`：帯を二つ積むこと。`glass.test.ts` と `rows.test.ts` は、足した部品に合わせて改める。
  - `dialogs.test.tsx`：確認の差分、バー、縮める向きの一行。
  - `screens.test.tsx`：設定画面の節、書けないときの表示。セッション詳細の注記。

## 決めた前提

- 「期間を過ぎた」はファイルの更新時刻で判定する（ドキュメントには書いていない）。
- 見込みの容量は、直近 30 日の増え方を延ばした単純な掛け算である。
- 本文が消えた理由は区別できないので、30 日を過ぎて本文が無いものを、保持期間で消えたとみなす。
