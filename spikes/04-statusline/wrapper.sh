#!/usr/bin/env bash
# 既存の statusline スクリプトは触らず、同じ stdin を受信サーバにも流す。
__hangar_input=$(cat)
printf '%s' "$__hangar_input" | curl -s -m 0.3 -X POST -H 'Content-Type: application/json' \
  --data-binary @- http://127.0.0.1:4192/ingest >/dev/null 2>&1 &
printf '%s' "$__hangar_input" | bash "$HOME/.claude/statusline-command.sh"
