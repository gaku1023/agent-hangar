#!/bin/sh
# agent-hangar の CLI を、配布版の .app に同梱したバンドルから起動する。
# Node は PATH に頼らず、アプリ本体と同じ順（HANGAR_NODE、settings.json の nodePath、Homebrew、/usr/local、nvm）で探し、
# manifest.json と同じメジャー版だけを使う。
set -e
here="$(cd "$(dirname "$0")" && pwd)"
dist="$(cd "$here/.." && pwd)"
want="$(sed -n 's/.*"nodeMajor": *\([0-9]*\).*/\1/p' "$dist/manifest.json")"
home="${HANGAR_HOME:-$HOME/.agent-hangar}"
custom=""
[ -f "$home/settings.json" ] && custom="$(sed -n 's/.*"nodePath": *"\([^"]*\)".*/\1/p' "$home/settings.json")"
candidates="${HANGAR_NODE:-} $custom /opt/homebrew/bin/node /usr/local/bin/node"
for d in $(ls -d "$HOME"/.nvm/versions/node/*/ 2>/dev/null | sort -r); do candidates="$candidates ${d}bin/node"; done
for n in $candidates; do
  [ -x "$n" ] || continue
  major="$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  if [ "$major" = "$want" ]; then
    # 同梱した UI と Worker のソースの場所を、バンドルの中から渡す。
    # 単一ファイルにまとめた時点で、コードの置き場からの相対では探せなくなる。
    export HANGAR_UI_DIST="$dist/ui"
    export HANGAR_CLOUD_DIR="${HANGAR_CLOUD_DIR:-$dist/cloud}"
    exec "$n" "$dist/cli.mjs" "$@"
  fi
done
echo "Node $want が見つかりません。nvm install $want を実行するか、$home/settings.json の nodePath で場所を指定してください。" >&2
exit 1
