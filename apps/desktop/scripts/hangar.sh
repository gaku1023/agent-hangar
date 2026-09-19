#!/bin/sh
# agent-hangar の CLI を、配布版の .app に同梱したバンドルから起動する。
# Node は PATH に頼らず、アプリ本体と同じ順（HANGAR_NODE、settings.json の nodePath、Homebrew、/usr/local、nvm）で探し、
# manifest.json と同じメジャー版だけを使う。
# 候補は空白区切りの一本の文字列ではなく、改行区切りで持ち回る。
# 一本の文字列にすると、空白を含むパス（利用者名の入ったホームや Application Support の下）で語分割され、
# settings.json の nodePath による指定がそのまま効かなくなる。
set -e
# $0 が symlink のときは実体まで辿る。
# README が案内する /usr/local/bin/hangar はリンクなので、辿らないと dist が /usr/local になり、
# manifest.json もバンドルも見失う。
# readlink -f は環境によって挙動が違うので使わず、一段ずつ辿る。
# 相対のリンク先は、そのリンクが置かれている場所からの相対として解く。
self="$0"
hops=0
while [ -L "$self" ]; do
  hops=$((hops + 1))
  if [ "$hops" -gt 40 ]; then
    echo "$0 の symlink が輪になっています。リンクを張り直してください。" >&2
    exit 1
  fi
  target="$(readlink "$self")"
  case "$target" in
    /*) self="$target" ;;
    *) self="$(cd "$(dirname "$self")" && pwd)/$target" ;;
  esac
done
here="$(cd "$(dirname "$self")" && pwd)"
dist="$(cd "$here/.." && pwd)"
if [ ! -f "$dist/manifest.json" ]; then
  echo "$dist/manifest.json がありません。アプリの中身が壊れています。agent-hangar を入れ直してください。" >&2
  exit 1
fi
want="$(sed -n 's/.*"nodeMajor": *\([0-9]*\).*/\1/p' "$dist/manifest.json")"
home="${HANGAR_HOME:-$HOME/.agent-hangar}"
custom=""
[ -f "$home/settings.json" ] && custom="$(sed -n 's/.*"nodePath": *"\([^"]*\)".*/\1/p' "$home/settings.json")"
candidates="$(
  printf '%s\n' "${HANGAR_NODE:-}" "$custom" /opt/homebrew/bin/node /usr/local/bin/node
  # nvm は新しい版から見る。
  # 文字列として並べると v22.9.0 が v22.10.0 より前に来るので、-V で版として並べる。
  for d in "$HOME"/.nvm/versions/node/*/; do
    [ -d "$d" ] && printf '%s\n' "${d}bin/node"
  done | sort -rV
)"
while IFS= read -r n; do
  [ -n "$n" ] || continue
  [ -x "$n" ] || continue
  major="$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  if [ "$major" = "$want" ]; then
    # 同梱した UI と Worker のソースの場所を、バンドルの中から渡す。
    # 単一ファイルにまとめた時点で、コードの置き場からの相対では探せなくなる。
    export HANGAR_UI_DIST="$dist/ui"
    export HANGAR_CLOUD_DIR="${HANGAR_CLOUD_DIR:-$dist/cloud}"
    exec "$n" "$dist/cli.mjs" "$@"
  fi
done <<CANDIDATES
$candidates
CANDIDATES
echo "Node $want が見つかりません。nvm install $want を実行するか、$home/settings.json の nodePath で場所を指定してください。" >&2
exit 1
