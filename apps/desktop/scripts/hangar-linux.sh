#!/bin/sh
# Linux の tar に入れる hangar コマンド。同梱の Node で、同梱の CLI を起こす。
# Mac 用の hangar.sh と違い、Node を探して回らない（Node は tar の中にある）。
set -e
# $0 が symlink（~/.local/bin/hangar など）のときは実体まで辿る。readlink -f は環境で挙動が違うので、一段ずつ辿る。
self="$0"
hops=0
while [ -L "$self" ]; do
  hops=$((hops + 1))
  if [ "$hops" -gt 40 ]; then
    echo "$0 のシンボリックリンクが循環しています。" >&2
    exit 1
  fi
  target="$(readlink "$self")"
  case "$target" in
    /*) self="$target" ;;
    *) self="$(cd "$(dirname "$self")" && pwd)/$target" ;;
  esac
done
root="$(cd "$(dirname "$self")/.." && pwd)"
if [ ! -x "$root/node/bin/node" ] || [ ! -f "$root/app/cli.mjs" ]; then
  echo "$root のファイルがそろっていません。インストールし直してください。" >&2
  exit 1
fi
export HANGAR_UI_DIST="$root/app/ui"
exec "$root/node/bin/node" "$root/app/cli.mjs" "$@"
