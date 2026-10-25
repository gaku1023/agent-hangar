# opencode 2.1.4 の見本

- 採った日：2026-10-25
- 版：`opencode --version` の出力は `opencode v2.1.4`（`version.txt`）。
- 入れ方：Homebrew の `opencode`（`/opt/homebrew/bin/opencode`）。
- 採り方：空の環境から次の形で打ち、標準出力をそのまま保存した。
  serve は起こしていない。

```sh
/usr/bin/env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" SHELL=/bin/zsh TMPDIR="$TMPDIR" \
  PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=en_US.UTF-8 opencode --help > help.txt
```

`help.txt` は手で直さない。
`provider/opencode/compat/cli.ts` の組み込みの一覧は、最も新しい見本の `help.txt` と揃える（`cli.test.ts` が突き合わせる）。

## serve の出来事の流れ（`/api/event`）と、取り直しの答え

- 採った日：2026-10-25。版は同じ 2.1.4（Homebrew）。
- 採り方：空の環境（上と同じ鍵に、試験用に分けた `XDG_CONFIG_HOME`・`XDG_DATA_HOME`・`XDG_STATE_HOME`・`XDG_CACHE_HOME` と `OPENCODE_SERVER_PASSWORD` を足した）から `opencode serve --hostname 127.0.0.1 --port 4632` を 1 本だけ起こした。
  LLM は呼んでいない。設定の `provider` に OpenAI 互換の模擬（手元の 127.0.0.1 で、1 回目は `shell` を、2 回目は `question` を呼び、3 回目は文で終える）を置き、`permission` を `{"shell":"ask"}` にした。
  `/api/event` の流れを生のまま書き留めながら、`POST /api/session`（ID なし）→ `POST /api/session/{id}/prompt` → 許可に `once` で答える → form に `{"q0":"Red"}` で答える、の順に進めた。
- 書き留めた後で、手元のパスだけを置き換えた（作業のフォルダは `/work/repo`、試験用の置き場は `/work/env2`）。ほかは手で直していない。

| ファイル | 中身 |
| --- | --- |
| `events-turn.sse` | 1 ターンの流れ。`session.execution.started` → `permission.asked`（action は `shell`）→ `permission.replied` → `form.created`（metadata.kind は `question`）→ `form.replied` → `session.execution.succeeded`。 |
| `events-interrupt.sse` | 別の会話で、許可の待ちの途中に `POST /api/session/{id}/interrupt` を送った流れ。`permission.replied` は来ず、`session.step.failed` と `session.execution.interrupted` で終わる。 |
| `events-reconnect.sse` | 待ちの途中でもう 1 本つないだときの頭。`server.connected` と heartbeat だけで、それまでの状態は流れてこない。 |
| `rest.json` | 取り直しに使う道の答え。`idle`・`running` は `GET /api/session/active`、`permission`・`noPermission` は `GET /api/session/{id}/permission`、`form`・`noForm` は `GET /api/session/{id}/form`。 |
