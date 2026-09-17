#!/usr/bin/env bash
# 他端末から届いた本文を別 cwd の Claude ディレクトリにコピーし、-r と --fork-session が動くかを tmux 越しに確かめる
set -uo pipefail
SRC_SID="$1"; LOG="$2"
SRC_FILE=$(ls ~/.claude/projects/*/"$SRC_SID".jsonl | head -1)
DST_CWD="$HOME/.agent-hangar-spike/resume-copy"; mkdir -p "$DST_CWD"
DST_DIR="$HOME/.claude/projects/$(echo "$DST_CWD" | sed 's#[^A-Za-z0-9]#-#g')"; mkdir -p "$DST_DIR"
cp "$SRC_FILE" "$DST_DIR/$SRC_SID.jsonl"
SRC_SIZE=$(stat -f %z "$SRC_FILE"); DST_SIZE0=$(stat -f %z "$DST_DIR/$SRC_SID.jsonl")
echo "src=$SRC_FILE ($SRC_SIZE bytes)"; echo "dst=$DST_DIR/$SRC_SID.jsonl"
cap() { tmux capture-pane -p -t spike-resume | grep -v '^\s*$' | tail -${1:-12}; }
tmux kill-session -t spike-resume 2>/dev/null || true
echo "T0 $(date +%T) claude -r in copied cwd"
tmux new-session -d -s spike-resume -x 120 -y 40 -c "$DST_CWD" -- bash -c "claude -r $SRC_SID; echo exit=\$?; sleep 300"
sleep 7; echo "--- after 7s ---"; cap 10
if tmux capture-pane -p -t spike-resume | grep -q "trust this folder"; then echo "accept trust"; tmux send-keys -t spike-resume Down Enter; sleep 8; fi
echo "--- after trust ---"; cap 14
tmux send-keys -t spike-resume "先ほど作った hello.txt の中身は何でしたか？ 1 語で。" Enter
sleep 25; echo "--- after prompt ---"; cap 8
echo "sizes: src now $(stat -f %z "$SRC_FILE") (was $SRC_SIZE), dst now $(stat -f %z "$DST_DIR/$SRC_SID.jsonl") (was $DST_SIZE0)"
tmux send-keys -t spike-resume "/exit" Enter; sleep 4
NEW_SID=$(uuidgen | tr 'A-Z' 'a-z')
echo "T1 $(date +%T) fork: claude -r $SRC_SID --fork-session --session-id $NEW_SID"
tmux kill-session -t spike-resume 2>/dev/null || true
tmux new-session -d -s spike-resume -x 120 -y 40 -c "$DST_CWD" -- bash -c "claude -r $SRC_SID --fork-session --session-id $NEW_SID; echo exit=\$?; sleep 300"
sleep 12; echo "--- fork after 12s ---"; cap 12
tmux send-keys -t spike-resume "1 語で：さっきのファイル名は？" Enter
sleep 20; echo "--- fork after prompt ---"; cap 6
echo "files in dst dir:"; ls -la "$DST_DIR" | awk '{print $5, $9}'
echo "src unchanged? $(stat -f %z "$SRC_FILE") == $SRC_SIZE"
tmux send-keys -t spike-resume "/exit" Enter; sleep 3; tmux kill-session -t spike-resume 2>/dev/null || true
echo "cleanup: rm -rf $DST_DIR"; rm -rf "$DST_DIR"
echo TASK11_DONE
