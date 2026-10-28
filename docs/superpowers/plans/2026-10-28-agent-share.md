# エージェント間の共有（0.13.0）

Codex と opencode を hangar から起動するとき、Claude Code の指示（CLAUDE.md）と MCP の登録を渡す。
TODO 01a17a2d-0c65-7609-8bfe-ac3b9ea4031c。

## 決めたこと

- S1 渡し方：起動のときに渡すだけにする。Codex・opencode の設定ファイルも、プロジェクトのファイル（AGENTS.md など）も書き換えない。hangar 自身の MCP と同じ道を使う。Codex は app-server の `-c` と環境変数、opencode は serve の `OPENCODE_CONFIG_CONTENT`。
- S2 指示の範囲：`~/.claude/CLAUDE.md`（Claude の置き場。アカウントの CLAUDE_CONFIG_DIR に従う）、作業フォルダとその祖先の `CLAUDE.md`・`.claude/CLAUDE.md`、作業フォルダの `CLAUDE.local.md`。同じフォルダに `AGENTS.md` があれば、そのフォルダの CLAUDE.md は重ねない。`@` の取り込みは展開しない（範囲外。rc の確かめで要否を見る）。
- S3 MCP の範囲：Claude の `.claude.json` の利用者の登録（`mcpServers`）と、そのフォルダの登録（`projects[cwd].mcpServers`）。`.mcp.json` は Claude で承認済み（`enabledMcpjsonServers`、`enableAllProjectMcpServers`）のものだけ。Claude で切ったもの（`disabledMcpServers`、`disabledMcpjsonServers`）は渡さない。claude.ai のコネクタとプラグインの MCP は渡さない。
- S4 名前がぶつかったら相手（Codex・opencode）の登録を使い、渡さない。`hangar` の名前は渡さない。
- S5 秘密：argv に載せない。Codex は `env_vars`・`env_http_headers` で環境変数の名前だけを書き、値は app-server の環境に置く。opencode は `OPENCODE_CONFIG_CONTENT`（環境変数）の中に置く（hangar の token と同じ）。`${VAR}`・`${VAR:-既定}` は hangar の環境で展開する。
- S6 設定：エージェントごとに指示と MCP の 2 つの真偽（`codexShareInstructions`・`codexShareMcp`・`opencodeShareInstructions`・`opencodeShareMcp`）。画面の形（案 A・B・C）はどれでもこの 4 つで表せる。画面は案 B（Codex と opencode の節に、指示と MCP の 2 つのスイッチ）。はじめの値は、指示が入、MCP が切（2026-10-28 に利用者が決めた）。
- S7 Codex の追記の長さ：Windows は cmd.exe 越しに起こすので、引数の長さに上限（8191 字）がある。追記に入れる CLAUDE.md の本文は合わせて上限（既定 4000 字）までにし、超えたファイルは「このファイルも読んで従う」の 1 行と場所だけを入れる。作業フォルダの CLAUDE.md は Codex が自分で読む（`project_doc_fallback_filenames` に `CLAUDE.md` を足す。利用者の値があれば後ろに足す）。

## 変換の表

| Claude | Codex（`mcp_servers.<名前>.*`） | opencode（`mcp.servers.<名前>`） |
|---|---|---|
| stdio `{command, args, env}` | `command`、`args`、`env_vars=[鍵]`（値は環境） | `{type:'local', command:[command, ...args], environment}` |
| http `{url, headers}` | `url`、`env_http_headers={見出し: 環境変数}` | `{type:'remote', url, headers}` |
| sse | 渡さない（理由：Codex は SSE を使えない） | `{type:'remote', url, headers}` |

環境変数の名前は Codex で衝突しないよう `HANGAR_MCP_<名前>_<鍵>` の形に付け替える（stdio の env は `env_vars` が親の同じ名前を渡すので、元の名前を使い、同じ名前で違う値が 2 つあれば後のものを渡さない）。

## 受け入れテスト

- A1 指示：作業フォルダに CLAUDE.md だけがあるとき、Codex の `codex debug prompt-input` に本文が入る。AGENTS.md もあるときは AGENTS.md だけが入る。
- A2 指示：~/.claude/CLAUDE.md と CLAUDE.local.md の本文が Codex の developer_instructions と opencode の system に入る。
- A3 MCP：Claude に登録した stdio と http の MCP が、Codex と opencode の道具の一覧に出る。秘密の値が argv（`ps`）に出ない。
- A4 切にすると何も渡さない（今と同じ argv と環境）。
- A5 名前がぶつかったら相手の登録が使われる。
- A6 設定の画面で、渡すもの・渡さないもの（理由つき）が一覧で見える。

## タスク

- T1 shared：設定の 4 つの鍵、読み手（`codexShareOf` など）、既定。
- T2 server：`share/` に読み手（指示のファイルの一覧、MCP の一覧）と、中立の形への読み替え（渡さない理由つき）。
- T3 server：Codex への変換と起動への組み込み（`codexAppServerConfig` の `-c`、環境、追記の上限）。
- T4 server：opencode への変換と起動への組み込み（`hangarServeConfig` の `instructions` と `mcp.servers`）。利用者の `instructions` は重ねて保つ。
- T5 server：設定の画面向けの口（GET `/api/share/preview?agent=`）。
- T6 ui：利用者が選んだ案の画面と動き（試作 https://claude.ai/artifact/4oWDR5oku1cCzEsWY3Vzh4）。文言は Gemini に当てる。
- T7 docs/design.md の「Codex の起動」「opencode の起動」「指示の注入」に節を足す。
- T8 回帰の試験：Codex の 2 つ目のアカウントで起こした会話が `AccountsDto.codex.sessions` に載る。

## 付録：文言（Gemini の web UI に当てた。{agent} は節のエージェント名）

- 行の題：「Claude Code の指示を渡す」「Claude Code の MCP を渡す」
- 行の説明（指示）：「起動時に CLAUDE.md の内容を {agent} に渡します。{agent} の設定ファイルは変更しません。」
- 行の説明（MCP）：「起動時に、Claude Code に登録した MCP サーバを {agent} の形式に変換して渡します。{agent} がこの PC でサーバを起動します。」
- 一覧の見出し：「渡すファイル」「渡す MCP」「渡さないもの」。札：「コマンド」（stdio）「URL」（http・sse）
- 渡さない理由：agentsMd「同じフォルダに AGENTS.md があるため」、conflict「{agent} に同じ名前の登録があるため」、sse「{agent} は SSE 形式に対応していないため」、missingEnv「環境変数 {name} が設定されていないため」、disabled「Claude Code で無効にしているため」、unapproved「Claude Code で承認していないため（.mcp.json）」、invalid「形式を読み取れないため」、reserved「hangar が使う名前のため」
- 注記：「作業フォルダの CLAUDE.md と CLAUDE.local.md は、セッションごとに読み込みます。」（Codex だけ）「長い指示はファイルの場所だけを渡し、Codex に読み込ませます。」
- 空：「渡すものはありません。」
