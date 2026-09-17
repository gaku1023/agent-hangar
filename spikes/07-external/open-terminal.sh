#!/usr/bin/env bash
# AppleEvent を使わない経路：.command ファイルを Terminal.app で開く（自動化の許可が不要）
set -euo pipefail
NAME="$1"; DIR="$HOME/.agent-hangar-spike/cmd"; mkdir -p "$DIR"
F="$DIR/attach-$NAME.command"
printf '#!/usr/bin/env bash\nexec /opt/homebrew/bin/tmux attach -t %s\n' "$NAME" > "$F"; chmod +x "$F"
open -g -a Terminal "$F"
