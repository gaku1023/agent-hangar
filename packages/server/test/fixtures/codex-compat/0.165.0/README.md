# codex 0.165.0 の見本

- 採った日：2026-10-27
- 採り方：`npm run capture-codex-fixtures`（採り直すときは `-- --force`）。空の環境と試しの置き場で、ログインもモデルも使わずに採る。
  手で直さない。

| ファイル | 中身 |
| --- | --- |
| `version.txt` | `codex --version` の出力。 |
| `help.txt` | `codex --help` の出力。サブコマンドの一覧（別名も）を、外のターミナルの横取りの一覧と突き合わせる。 |
| `app-server-schema.json` | `codex app-server generate-json-schema` の束のうち、hangar が使う要求・通知・承認の要求（`compat/schemaSubset.ts` の `HANGAR_CODEX_METHODS`）の包みと、参照をたどった定義。説明文は入れない。 |
| `app-server-probe.json` | ログイン無しの app-server に話した答えのキーの名前（initialize、thread/start、thread/started、thread/resume がターンの前は no rollout found になること）。 |
| `features.json` | `codex features list` のうち、rollout を zst に切り替える `local_thread_store_compression` の段階と既定。既定が true になると、同じ会話が jsonl と zst で名前を変える。 |
| `rollout-shape.json` | 模擬のモデルで `codex exec` を 2 本（文で答えるターン、道具を呼ぶターン）走らせてできた rollout の、行の種類ごとの形（キーの道と型）。値は入れない。 |

照合の仕組みは docs/design.md の「Codex の互換の見張り」にある。
