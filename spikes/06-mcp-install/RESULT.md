# spike 06: user スコープの MCP 登録と Origin 検査

判定: 合格
実施日: 2026-09-17

## 確かめたこと
- Hono 上の Streamable HTTP MCP サーバに、`Origin` 検査（許可リスト外は 403）と Bearer 検査（無しは 401）を入れ、正しいトークン付きの initialize は 200 で通る。
- `claude mcp add ... --scope user --header "Authorization: Bearer <token>"` で user スコープに登録すると `claude mcp list` が `Connected` になる。
- `claude -p` から `hangar_ping` を呼ぶと共通 URL（`/mcp`）に届き、`pong from hangar (session=(shared))` が返る。
- `claude mcp remove --scope user` で登録が消える。登録と削除で書き換わるのは `~/.claude.json` である。

## 計測値
- 起動 1 回（`claude -p`）。initialize から tool 呼び出しまで約 7 秒（モデルの応答時間を含む）。

## 設計への影響
- **`claude mcp add` の `--header` も可変長オプション**で、後ろに置いた名前と URL を飲み込む。`hangar mcp install` は位置引数（名前、URL）を先に、`--header` を最後に置く。Task 2 の `--mcp-config` と同じ落とし穴。
- `hangar mcp install` は `~/.claude.json` を Claude 自身のコマンド経由で書き換えることになる。hangar が直接ファイルを書くのではなく `claude mcp add` を呼ぶ方針で、読み取り専用の原則と整合する。
- `claude -p` は stdin をパイプしないと「no stdin data received in 3s」の警告で 3 秒待つ。事後要約などで `-p` を使うときは `< /dev/null` を付けるか、入力をパイプで渡す。
- Enterprise ポリシーで一部の claude.ai MCP が遮断されている旨の警告が毎回出る。hangar 側で `-p` の stderr を捨てるか、既知の警告として無視する。

## 残った疑問
- 対話セッションで user スコープの hangar MCP が、`--mcp-config` のセッション別 URL と同時に読み込まれると、同名ツールが 2 つ見える。ツール名を共通側と別にするか、セッション別起動では `--strict-mcp-config` を使わずに user スコープ側を無効化する方法を、フェーズ 2 で決める。
