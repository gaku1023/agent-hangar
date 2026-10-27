# opencode 2.2.0 の見本

- 採った日：2026-10-27
- 版：`opencode --version` の出力（`version.txt`）。
- 入れ方：Homebrew の `opencode`。
- 採り方：`npm run capture-opencode-fixtures`（`packages/server/test/capture-opencode/run.ts`）。
  空の環境（`HOME`、`USER`、`LOGNAME`、`SHELL`、`TMPDIR`、`LANG` と最小の `PATH`）に、試しの置き場の `XDG_CONFIG_HOME`・`XDG_DATA_HOME`・`XDG_STATE_HOME`・`XDG_CACHE_HOME` を足して、`opencode serve` を 1 本だけ起こした。
  LLM は呼んでいない。試しの置き場の `opencode.json` の `provider` に OpenAI 互換の模擬（手元の 127.0.0.1）を置き、`permission` は shell を `ask`、edit と write を `allow` にした。
  hangar の MCP の代わりに同じ形の小さな MCP（道具は `set_turn_intent`）を、hangar と同じく `OPENCODE_CONFIG_CONTENT` で渡した。
- 書き留めた後で、手元のパスだけを置き換えた（作業のフォルダは `/work/repo`、試しの置き場は `/work/env2`、一時ディレクトリは `/work/tmp`、ホームは `/work/home`）。ほかは手で直していない。

`help.txt` と `version.txt` は空の環境での標準出力そのままで、手で直さない。
`provider/opencode/compat/cli.ts` の組み込みの一覧は、最も新しい見本の `help.txt` と揃える（`cli.test.ts` が突き合わせる）。

## 筋書き

1. 会話 1 を ID なしの `POST /api/session` で作り、`POST /api/session/{id}/prompt` で 1 つ目の発言を送る。
   模擬は shell → execute（中で `hangar.set_turn_intent`）→ write → edit → read → question → 文、の順に呼ぶ。
   許可に `once` で、form に `Red` で答える。
2. 同じ会話の 2 つ目の発言で、shell の `sleep 20` を許し、動いている間に `POST /api/session/{id}/interrupt` を送る。
3. 3 つ目の発言は文だけ。
4. 会話 2 で 1 つ目と同じ発言を送り、許可の待ちの途中で interrupt を送る。

| ファイル | 中身 |
| --- | --- |
| `events-turn.sse` | 筋書き 1 の `/api/event` の流れ（つないだときから、ターンが終わるまで）。 |
| `events-interrupt.sse` | 筋書き 4 のために新しく開いた `/api/event` の流れ。`permission.replied` は来ず、`session.execution.interrupted` で終わる。 |
| `events-reconnect.sse` | 筋書き 1 の許可の待ちの途中で、もう 1 本つないだときの頭。 |
| `rest.json` | 取り直しに使う道の答え。`idle`・`running` は `GET /api/session/active`、`permission`・`noPermission` は `GET /api/session/{id}/permission`、`form`・`noForm` は `GET /api/session/{id}/form`、`permissionRequest` は `GET /api/permission/request`、`formRequest` は `GET /api/form`（後の 2 つは `location[directory]` 付き。hangar はこちらを使う）。 |
| `messages.json` | 筋書き 3 の後の `GET /api/session/{id}/message?limit=100` の答え。data は新しい順。 |
| `messages-pages.json` | 同じ時点で `limit=4` と `cursor` で送った答えの並び（`query`、`status`、`body`）。 |
| `messages-while-form.json` | 筋書き 1 で form を待っている間の答え。 |
| `messages-while-running.json` | 筋書き 2 で `sleep 20` が動いている間の答え。 |
