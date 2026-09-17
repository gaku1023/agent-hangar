#!/usr/bin/env bash
# 可変長オプション（--mcp-config, --add-dir）は他のオプションの前に置き、初期プロンプトは最後に置く。
set -euo pipefail
SID=$(uuidgen | tr 'A-Z' 'a-z')
CWD="$HOME/.agent-hangar-spike/launch"; mkdir -p "$CWD"
tmux new-session -d -s spike-launch -x 120 -y 40 -- bash "$(cd "$(dirname "$0")" && pwd)/run.sh" "$SID" "$CWD"
echo "session id: $SID"
echo "expected file: $HOME/.claude/projects/$(echo "$CWD" | sed 's#[^A-Za-z0-9]#-#g')/$SID.jsonl"
