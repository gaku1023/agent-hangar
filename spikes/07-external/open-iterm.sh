#!/usr/bin/env bash
set -euo pipefail
NAME="$1"
osascript <<EOS
tell application "iTerm"
  activate
  create window with default profile command "/opt/homebrew/bin/tmux attach -t ${NAME}"
end tell
EOS
