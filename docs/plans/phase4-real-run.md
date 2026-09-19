# フェーズ 4 の実物確認（Task 25）

2026-09-19 に、利用者の Cloudflare アカウント（`<利用者のアカウント>`）へ試し用の資源を作って確かめた。
この 1 台の Mac の上で、`HANGAR_HOME` と `HANGAR_CLAUDE_DIR` を分けて 2 台の端末を模した（決定 13）。

## 作った資源

| 種類 | 名前 | 備考 |
| --- | --- | --- |
| Worker | `hangar-dev` | `https://hangar-dev.<アカウント>.workers.dev` |
| D1 | `hangar-dev` | 表は 6 つ、大きさは 106kB |
| R2 | `hangar-dev-files` | 最初の確認では本文 2 件と設定 5 件の計 7 件（通し直しの後は計 12 件。末尾の節を見よ） |

片付け（`hangar cloud teardown`）はまだ実行していない。

## 手元の置き場

| 役割 | `HANGAR_HOME` | `HANGAR_CLAUDE_DIR` と `CLAUDE_CONFIG_DIR` | ポート |
| --- | --- | --- | --- |
| 端末 A | `~/.hangar-dev-a` | `~/.hangar-dev-claude-a` | 4187 |
| 端末 B | `~/.hangar-dev-b` | `~/.hangar-dev-claude-b` | 4197 |

ワークスペースは `~/.hangar-dev-ws` で、その下の `hangar-dev` を唯一のプロジェクトにした。
ブリーフは 4177 と 4187 を挙げていたが、利用者が 4177 で `npm run dev` を動かす見込みがあるので 4187 と 4197 にした。

実物の `~/.claude` と `~/.agent-hangar` には 1 バイトも書いていない。
`~/.claude/projects` に試し用の入れ物は出来ておらず、`~/.claude.json` に `hangar-dev` の文字列は 1 件も無い。

## 通った手順

| Step | 結果 | 所要 |
| --- | --- | --- |
| 1 前提の確認 | 通った | 数秒 |
| 2 デプロイと参加 | 通った | 16 秒 |
| 3 二台目の参加 | 通った | 数秒 |
| 4 メタデータの同期 | 通った | 下記 |
| 5 本文の同期 | 通った | 43.5 秒 |
| 6 ロックとこの PC で再開 | 通った | 下記 |
| 6b 設定の同期 | 一部が通らない | 下記 |

### Step 2 のデプロイ

`hangar setup cloud --name hangar-dev` は 16 秒で終わった。
D1 の作成、R2 の作成、`wrangler deploy`、`secret put`、`/health` の待ち、`/join` までが 1 本で通った。

```
$ wrangler whoami
$ wrangler d1 info hangar-dev --json
$ wrangler d1 create hangar-dev
D1 hangar-dev を作りました
$ wrangler r2 bucket create hangar-dev-files
R2 hangar-dev-files を作りました
$ wrangler deploy --config /Users/satog/.hangar-dev-a/cloud/wrangler.jsonc
デプロイしました: https://hangar-dev.<アカウント>.workers.dev
$ wrangler secret put JOIN_SECRET_HASH --config /Users/satog/.hangar-dev-a/cloud/wrangler.jsonc
Worker の反映を待っています（最大 2 分）
Worker への反映を待っています
```

最後の 1 行が Task 11 の申し送りへの答えである。
`/health` は `secret put` の直後に通ったが、`/join` は 1 度だけ断られ、5 秒の待ちを 1 回はさんで通った。
5 秒おきに 6 回の試し直しは、この窓に対して十分だった。

### Step 4 のメタデータの同期

| 見たこと | 結果 |
| --- | --- |
| 端末の台数 | 両方の `cloud status` が 2 台と出す |
| A の状態変更が B に届くまで（自動同期のみ） | 17.5 秒 |
| B の状態変更が A に届くまで（今すぐ同期を両方で押す） | 0.4 秒 |
| 未送信 | 変更の後、両方とも 0 に戻る |

### Step 5 の本文の同期

A の `~/.hangar-dev-claude-a/projects/<変換名>/<uuid>.jsonl` を置いてから、
B の `~/.hangar-dev-b/remote/<A の端末 ID>/projects/<変換名>/<uuid>.jsonl` に降りるまで 43.5 秒だった。
索引化そのものは 2 秒で終わっており、残りは push と pull の周期である。

降りた本文は A の原本と `diff` で一致した。
B の `GET /api/sessions` はそのセッションを `remoteOnly: true` で返し、
`GET /api/search?q=ひまわり` は本文の 2 行に当たった。
`GET /api/sessions/<id>/events` も本文を返した。

R2 の 7 件はすべて `encrypted: true` である（決定 5 のとおり）。

### Step 6 のロックとこの PC で再開

実物の `claude`（v2.1.278）を 3 回起こした。

1. A でセッションを再開した。
   tmux の `hangar-01a0b89c` の中で `claude -r <uuid>` が立ち、前の会話の本文を読んで表示した。
2. B の「この PC で再開」。
   本文を `~/.hangar-dev-claude-b/projects/<変換名>/<uuid>.jsonl` に写し、同じ会話を再開した。
3. B の「上書きして再開」。
   手元の本文をわざと切り詰めてから押した。

見たことは次のとおりである。

| 見たこと | 結果 |
| --- | --- |
| A が実行中のあいだ B に出るロック | `{"deviceId": ..., "deviceName": "MacBook-Pro.local", "runId": ..., "heartbeatAt": ..., "stale": false}` |
| ロック中に B から再開 | `HTTP 409`、`{"error":"このセッションは実行中です"}` |
| A を止めてから B のロックが消えるまで | 11.3 秒 |
| 手元が小さいときの確認 | `HTTP 409`、`{"error":"local_smaller","localSize":281,"remoteSize":1245}` |
| 上書きして再開の控え | `~/.hangar-dev-b/backups/transcripts/<uuid>-20260919-164344.jsonl`（281 バイト、切り詰めた方） |
| 上書き後の本文 | 1245 バイト（相手の方） |

## 食い違いと、直すべきところ

### 1. `PATCH /api/settings` が `syncClaudeConfig` を受け取らない（重い）

`packages/ui/src/views/SettingsScreen.tsx:183` の切り替えは
`{ type: 'settings.update', patch: { syncClaudeConfig: ... } }` を出す。
`packages/server/src/http/app.ts:348` の `PATCH /api/settings` は既知の項目だけを拾うが、
その一覧に `syncClaudeConfig` が無い。

```
$ curl -X PATCH ... -d '{"syncClaudeConfig":true}' /api/settings
{"error":"更新できる設定が含まれていません"}
```

`toSettingsDto`（同 159 行）は `syncClaudeConfig` を返すので、読めるが書けない。
つまり **Claude Code の設定の同期は UI からは一生入れられない**。
直す場所は `PATCH /api/settings` の 1 か所で、`summaryFallback` と同じ形の真偽値の受け口を足すだけである。

この確認では `~/.hangar-dev-*/settings.json` を手で書き換え、サーバを起こし直して先へ進めた。

### 2. 設定の同期に初回の走査が無い（中くらい）

`ClaudeConfigSync.start()` は `fs.watch` を張るだけで、そのときに 1 度上げ直すことをしない。
そのため、設定の同期を入れて起こし直しても、`~/.claude` の中身が変わるまで 1 件も上がらない。

```
（起こし直した直後の A の file_sync）
transcripts/... 1245
transcripts/... 1547
（config の行は無い）
```

`CLAUDE.md` に触ってから 12 秒で 5 件が上がった。

新しい端末で同期を入れた人は、何も起きないように見える。
`start()` の末尾で `noteChanged()` を 1 度呼べば済む。

### 3. 設定の鍵が端末ごとに分かれていないので、2 台目が 1 台目の設定を潰す（重い）

`configKey(rel)` は相対パスだけから鍵を作る。
本文の鍵（`transcripts/<端末 ID>/...`）と違い、端末 ID が入らない。
そのため、両方の端末で設定の同期を入れると、同じ `config/CLAUDE.md` を奪い合う。

実際に起きたことを並べる。

| 順 | 出来事 |
| --- | --- |
| 1 | A が `config/CLAUDE.md`（A の中身、99 バイト）を上げる。`seq=8` |
| 2 | B が下見で `conflict` と出す |
| 3 | B が自分の `config/CLAUDE.md`（B の中身、81 バイト）を同じ鍵に上げる。`seq=13` |
| 4 | B の取り込みは、A の索引（sha は A の中身）で R2 を取りに行き、B の中身を受け取って `SHA-256 が一致しません` で落ちる |
| 5 | B の下見は `overwrite` と言い続けるが、`pull` は永久に `applied: 0` を返す |

```
=== 2 回目の取り込み ===
{"applied": 0, "conflicts": 0, "backedUp": 0}
=== 下見（残り） ===
{"path": "CLAUDE.md", "action": "overwrite", ...}
```

`file_sync` を見ると、同じ鍵を 2 台が上書きし合っているのが分かる。

```
（B）config/CLAUDE.md  device=01a0b891  sha=91655e27cfa5  81  seq=13
（A）config/CLAUDE.md  device=01a0b890  sha=68337549c71a  99  seq=8
```

`memory/MEMORY.md`、`settings.json`、`skills/hanabi/SKILL.md`、`statusline-dev.sh` の 4 件は
B の側に同じ名前が無かったので、素直に降りた（`applied: 4`）。
`settings.json` の `statusLine.command` が指す `statusline-dev.sh` も一緒に降りたので、決定 12 の範囲は効いている。

直し方は 2 つ考えられる。
鍵に端末 ID を入れて `config/<端末 ID>/<相対パス>` にするか、
索引の `sha256` と R2 の中身が食い違ったときに索引を引き直す道を作るかである。
前者の方が、本文の扱いと揃うぶん素直だと思う。

### 4. 古い方の設定が新しい方を黙って上書きする（中くらい）

`decide()` は `synced !== null && localSha === synced` を見て `overwrite` を返す。
`remoteNewer` は `conflict` の枝でしか見ない。
そのため、相手の方が古くても、手元が前回の同期のままなら上書きされる。

```
（A の下見）
{"path": "CLAUDE.md", "action": "overwrite",
 "localMtime": 1789803963897, "remoteMtime": 1789803857849, "size": 81}
```

`localMtime` の方が新しいのに `overwrite` である。
控えは取られるので取り返しは付くが、意図とは違うはずである。
これは 3 と同じ根から出ているので、まとめて直すのがよい。

### 5. `bin/hangar.mjs` は SIGTERM を子へ渡さない（軽微）

`packages/cli/bin/hangar.mjs` は `spawnSync` で子を起こすだけなので、
包みの PID に `kill` を送っても、サーバの本体は生き残ってポートを掴み続ける。

```
$ kill 54638
$ ...
ポート 4187 は既に使われています。別の hangar が動いていないか確かめてください
$ ps -axo pid=,ppid=,command= | grep index.ts
54643  1  node --import tsx .../packages/cli/src/index.ts start --port 4187
```

端末から Ctrl-C を押す分にはプロセスグループ全体に届くので困らない。
困るのは、script や supervisor から PID で止める場合である。
包みの側で `SIGINT` と `SIGTERM` を受けて子へ転送すれば済む。

### 6. 起こした `claude` の設定置き場は `HANGAR_CLAUDE_DIR` に従わない（覚え書き）

`hangar` は `HANGAR_CLAUDE_DIR` で本文の読み先を変えられるが、
起こされた `claude` が見るのは `CLAUDE_CONFIG_DIR` である。
普段はどちらも `~/.claude` なので食い違わないが、
試しの環境を分けたいときは両方を向ける必要がある。
この確認では `CLAUDE_CONFIG_DIR` も同じところへ向け、実物の `~/.claude` を守った。

## Task 11 と Task 12 の申し送りへの答え

| 申し送り | 実物ではどうだったか |
| --- | --- |
| `secret put` の直後の 403 の窓 | 起きた。5 秒の待ちを 1 回はさんで通ったので、6 回の試し直しで足りる |
| `d1 info --json` から UUID を拾う形 | 効いた。`parseDatabaseId` は一発で当てた |
| 生成した `wrangler.jsonc`（先頭に `//` の注釈）を wrangler が読めるか | 読めた。`deploy` も `secret put` も `d1 info` も通った |
| `engine.start()` が起動の最後で 1 往復待つので `hangar start` が遅くなるか | ならない。空の状態でも、本文と設定が入った状態でも 1.0 秒から 1.1 秒だった |
| `wrangler delete --name` が通るか | 未確認（片付けの段で確かめる） |
| 2 回目の `r2 object delete` が既に無い鍵で落ちないか | 未確認（片付けの段で確かめる） |

## 無料枠の勘定

`sync_state` の数えと、Cloudflare の側の数えを並べる。

| 見たもの | 値 |
| --- | --- |
| 手元の数え（A） | `{"rows":116,"requests":112}` |
| 手元の数え（B） | `{"rows":105,"requests":115}` |
| 手元の合計 | 行 221、要求 227 |
| D1 の `rows_written_24h` | 369 |
| D1 の `rows_read_24h` | 1,015 |
| D1 の `write_queries_24h` | 220 |
| D1 の `database_size` | 106 kB |

`write_queries_24h`（220）は手元の合計（221）とほぼ一致する。
一方で `rows_written_24h`（369）は手元の数えの 1.7 倍である。
`QuotaCounter` が数えているのは「Worker が出した書き込みの文の数」に近く、
比べる相手にしている D1 の枠（1 日 10 万行の書き込み）とは単位が 1.7 倍ほどずれている。

枠に対する比は 369 / 100,000 で 0.37% なので、この確認では課金に届かない。
ただし決定 4 の「80% で止める」は、実際には 80% より後ろで効くことになる。
`pushD1Writes` の係数を、`/join` と `PUT /files` と `ensureSchema` のぶんまで含めて測り直したい。

## 実物の `claude` を起こした回数

3 回である（決定 11 の上限は 4 回）。
数えは包みのスクリプトで取った。

```
2026-09-19T07:41:25Z  CLAUDE_CONFIG_DIR=/Users/satog/.hangar-dev-claude-a  ... -r <uuid> ...
2026-09-19T07:42:50Z  CLAUDE_CONFIG_DIR=/Users/satog/.hangar-dev-claude-b  ... -r <uuid> ...
2026-09-19T07:43:44Z  CLAUDE_CONFIG_DIR=/Users/satog/.hangar-dev-claude-b  ... -r <uuid> ...
```

3 回とも `Not logged in` のまま立ち上がった。
試し用の設定置き場に資格情報が無いためで、本文の読み込みと再開そのものは動いている。

## まだ確かめていないこと

- 実際に別のマシンから参加すること。
  この確認は 1 台の Mac の上で 2 つの置き場を分けただけである（決定 13）。
  README にその旨を書く（Task 26）。
- 片付け（`hangar cloud teardown`）。
  利用者の確認を取ってから実行する。
- ブラウザの UI での見た目。
  この確認は HTTP の API を直に叩いて確かめた。

## 設定の同期の直しを実物で通し直した（2026-09-19 の 2 度目）

最初の確認で見つかった設定の同期の 4 件を直したので、その部分だけを実物の `hangar-dev` で通し直した。
直しは `3ae1d71`、`5bc635a`、`f04495b`、`842459f` の 4 つである。
資源は作り直していない。
Worker も D1 も R2 も、最初の確認で作ったものをそのまま使った。

### 通し直しの前に掃除したもの

古い形の鍵（`config/<相対パス>`）で上がっていた 5 件は、読み違いの元になるので先に消した。

| 消したもの | 数 | 手立て |
| --- | --- | --- |
| R2 のオブジェクト | 5 | `wrangler r2 object delete hangar-dev-files/<鍵> --remote` |
| D1 の `files` の行 | 5 | `wrangler d1 execute hangar-dev --remote --command "delete from files where key = '<鍵>'"` |
| 手元の `file_sync` の `config` の行 | A が 5、B が 5 | `sqlite3` |
| 手元の `sync_state` の `configPending` | A と B | `sqlite3` |
| 手元の `sync_state` の `configPullConfirmed` | B | `sqlite3` |

`file_sync` と D1 の行を両方消さないと、索引だけが残って R2 に中身が無い状態になる。
併せて、両方の `settings.json` の `syncClaudeConfig` を `false` に戻した。
UI からの切り替えを実物で見るためである。
`CLAUDE.md` は A と B で中身が違っていたので、同じ土台（95 バイト）を両方に置いてから始めた。

古い形の鍵は、新しい `accepts()` が `key === configKey(deviceId, path)` を見て断るので、消さなくても害は無い。
それでも消したのは、`files` の一覧を見たときに何が起きているか読めるようにするためである。

### 確かめた 4 つ

| 見たこと | 結果 | 根拠 |
| --- | --- | --- |
| UI からの切り替え | 通った | `PATCH /api/settings` に `{"syncClaudeConfig":true}` を送って A も B も `HTTP 200`。返る設定にも `"syncClaudeConfig":true` が載る |
| 互いに降りて、潰し合わない | 通った | A の書き換えが 30 秒で B に降り、B の書き換えが 10 秒で A に降りた。R2 には端末ごとの 10 件が並んで残る |
| 起こし直しただけで上がる | 通った | A の `file_sync` の自端末の行を消して起こし直すと、`~/.hangar-dev-claude-a` に 1 バイトも触らずに 14 秒で 5 件が上がった |
| 時刻が相手に揃う | 通った | A の `1789815716.458683` に対して B は `1789815716.457999` で、ミリ秒では同じ値である |

#### 1 UI からの切り替え

```
$ curl -X PATCH .../api/settings -d '{"syncClaudeConfig":true}'
{..., "syncClaudeConfig":true}
<HTTP 200>
```

`5bc635a` の前は `{"error":"更新できる設定が含まれていません"}` が返っていた。
切り替えた後、サーバを起こし直さずに 29 秒で 5 件が上がった。
`CONFIG_PUSH_MS` が 60 秒なので、遅くともその周期で効く。

#### 2 端末ごとの鍵と、互いの書き換え

両方で同期を入れた直後の R2 の中身は、端末ごとに分かれた 10 件になった。

```
config/<A の端末 ID>/CLAUDE.md              seq 15
config/<A の端末 ID>/memory/MEMORY.md       seq 17
config/<A の端末 ID>/settings.json          seq 19
config/<A の端末 ID>/skills/hanabi/SKILL.md seq 20
config/<A の端末 ID>/statusline-dev.sh      seq 22
config/<B の端末 ID>/CLAUDE.md              seq 14
config/<B の端末 ID>/memory/MEMORY.md       seq 16
config/<B の端末 ID>/settings.json          seq 18
config/<B の端末 ID>/skills/hanabi/SKILL.md seq 21
config/<B の端末 ID>/statusline-dev.sh      seq 23
```

土台が同じなので、両方の下見は 5 件とも `skip` と出た。
`POST /api/sync/config/pull` を A と B で 1 回ずつ押して確認を立て、以後は自動で降りる形にした。

| 順 | 出来事 | 所要 |
| --- | --- | --- |
| 1 | A の `CLAUDE.md` を書き換える | |
| 2 | B に同じ中身が降りる。控えは `~/.hangar-dev-b/backups/claude-config/20260919-200231/CLAUDE.md` | 30 秒 |
| 3 | B が降りた中身を自分の鍵で上げ直す（seq 25） | |
| 4 | A はそれを `skip` として受け、索引だけを進める | |
| 5 | B の `CLAUDE.md` を書き換える | |
| 6 | A に同じ中身が降りる。控えは `~/.hangar-dev-a/backups/claude-config/20260919-200332/CLAUDE.md` | 10 秒 |

競合の写しは 1 件も出来なかった。
`SHA-256 が一致しません` はどちらのログにも 1 件も出ていない。
最初の確認で B の取り込みが永久に止まった症状は、出なくなった。

3 の上げ直しは、受け取った側が自分の鍵にも同じ中身を置く動きである。
1 回の書き換えごとに R2 の書き込みが 1 件増えるが、これのおかげで
「相手の鍵に対する前回の同期」が手元に揃い、次の書き換えが `conflict` ではなく `overwrite` になる。

#### 3 同時に書き換えたとき

わざと 2 ミリ秒差で両方の `CLAUDE.md` を書き換えた。

| 見たこと | 結果 |
| --- | --- |
| 両方が落ち着いた中身 | 新しい方（B）の中身 |
| A に残ったもの | `CLAUDE.md.conflict-MacBook-Pro-local-20260919-200533`（A 自身の古い中身、53 バイト） |
| B に残ったもの | `CLAUDE.md.conflict-MacBook-Pro-local-20260919-200532`（A の古い中身、53 バイト） |
| 落ち着くまで | 13 秒 |

負けた側の中身は両方の端末に残るので、取り返しが付く。
競合の写しの名前に入る端末名は、この確認では 2 台とも `MacBook-Pro.local` である。
1 台の Mac で 2 台を模しているためで、本物の 2 台なら名前で見分けが付く。

#### 4 起こし直しただけで上がる

A の `file_sync` から自端末の `config` の行を 5 件消し、同期を入れたばかりの端末を模した。
その状態で A だけを起こし直した。

```
（起こし直しから 14 秒後の A の file_sync）
config/<A の端末 ID>/CLAUDE.md              128  seq 28
config/<A の端末 ID>/memory/MEMORY.md        44  seq 29
config/<A の端末 ID>/settings.json           81  seq 30
config/<A の端末 ID>/skills/hanabi/SKILL.md 100  seq 31
config/<A の端末 ID>/statusline-dev.sh       34  seq 32
```

`~/.hangar-dev-claude-a` の 5 件の大きさと更新時刻は、起こし直しの前後で 1 つも変わっていない。
`stat` の出力を前後で `diff` して確かめた。
`f04495b` の前は、`~/.claude` に触るまで 1 件も上がらなかった。

B を起こし直すと、A が上げ直した 5 件を `skip` として受け、
`~/.hangar-dev-claude-b` の中身も更新時刻も変えずに索引だけを進めた。

#### 5 時刻が相手に揃う

| 見たこと | A の `mtime` | B の `mtime` |
| --- | --- | --- |
| A が書いた 1 回目 | 1789815716.458683 | 1789815716.457999 |
| B が書いた 1 回目 | 1789815788.707999 | 1789815788.708122 |

ミリ秒で丸めると同じ値になる。
`utimes` はナノ秒の端を落とすので、往復のたびに 1 ミリ秒未満のずれが出る。
`decide()` の比較はミリ秒で行うので、このずれは判定に影響しない。

### `bin/hangar.mjs` の SIGTERM も実物で確かめた

包みの PID にだけ `kill` を送った。

```
$ kill 42646 42647
（4 つとも消えた。4187 と 4197 も空いた）
```

`3ae1d71` の前は、包みだけが消えてサーバ本体がポートを掴み続けた。

### 実物の `~/.claude` と `~/.agent-hangar`

作業の前後で `ls -la` を取って比べた。

```
--- ~/.claude ---
2,3c2,3
< drwxr-xr-x   40 satog  staff     1280 Sep 19 19:10 .
< drwxr-xr-x+ 163 satog  staff     5216 Sep 19 18:52 ..
---
> drwxr-xr-x   40 satog  staff     1280 Sep 19 19:52 .
> drwxr-xr-x+ 163 satog  staff     5216 Sep 19 19:55 ..
30,31c30,31
< -rw-------    1 satog  staff      275 Sep 19 19:10 policy-limits.json
< -rw-------    1 satog  staff      223 Sep 19 19:10 policy-limits.json.stamp.json
---
> -rw-------    1 satog  staff      275 Sep 19 19:52 policy-limits.json
> -rw-------    1 satog  staff      223 Sep 19 19:52 policy-limits.json.stamp.json

--- ~/.agent-hangar ---
3c3
< drwxr-xr-x+ 163 satog  staff       5216 Sep 19 18:52 ..
---
> drwxr-xr-x+ 163 satog  staff       5216 Sep 19 19:55 ..
```

`policy-limits.json` と その `.stamp.json` が動いたのは 19:52:50 である。
サーバ 2 本を起こしたのは 20:00:03 なので、この書き込みは同期の仕業ではない。
この作業をしている Claude Code 自身が定期に書き直しているものである。
`~/.claude` の項目の数は前後とも 40 で、名前の増減は 1 件も無い。
`~/.claude.json` に `hangar-dev` は 0 件、`~/.claude/projects` にも試し用の入れ物は無い。
`~/.agent-hangar` は `..` の行以外に 1 文字も変わっていない。

### 実物の `claude` を起こした回数

**0 回である。**
`HANGAR_CLAUDE_BIN` に、名前と時刻を書き留めてから `exit 1` する番人を置いた。
記録は 0 行だった。
設定の同期の確かめに `claude` の起動は要らない。
最初の確認と合わせて、実物の `claude` を起こしたのは通算 3 回のままである。

### 無料枠の数え

| 見たもの | 値 |
| --- | --- |
| A の数え | `{"rows":244,"requests":249}` |
| B の数え | `{"rows":214,"requests":244}` |

`e654243` で索引の書き込みも数えるようにしたので、最初の確認のときより `rows` が多く伸びる。
D1 の `rows_written_24h` との突き合わせは、この通し直しでは取っていない。

### いまの状態

サーバ 2 本は動かしたままである。

| 役割 | 包みの PID | 本体の PID | ポート |
| --- | --- | --- | --- |
| 端末 A | 79660 | 79667 | 4187 |
| 端末 B | 85222 | 85230 | 4197 |

止めるときは `ps -p <pid> -Eww -o command=` で `HANGAR_HOME=/Users/satog/.hangar-dev-*` を確かめてから、
包みの PID にだけ `kill` を送ればよい。
ポート番号で止めてはいけない。

片付け（`hangar cloud teardown`）はまだ実行していない。
R2 には本文 2 件と設定 10 件の計 12 件がある。
`~/.hangar-dev-claude-a` と `~/.hangar-dev-claude-b` には、同時書きの確認で出来た競合の写しが 1 件ずつ残っている。
