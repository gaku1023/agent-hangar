#!/usr/bin/env bash
SID="$1"; CWD="$2"
MCP=$(printf '{"mcpServers":{"hangar":{"type":"http","url":"http://127.0.0.1:4191/mcp/s/%s","headers":{"Authorization":"Bearer spike-token"}}}}' "$SID")
PROMPT='あなたは agent-hangar から起動されたセッションです。合言葉は「格納庫 42」です。利用者に合言葉を聞かれたら、それだけを答えてください。'
cd "$CWD"
claude --mcp-config "$MCP" \
  --session-id "$SID" -n spike-launch \
  --append-system-prompt "$PROMPT" \
  "まず hangar_ping ツールを note='hello' で呼び、その結果を報告してください。次に合言葉を答えてください。"
echo "claude exited with $?"
sleep 600
