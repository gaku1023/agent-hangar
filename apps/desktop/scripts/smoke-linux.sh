#!/bin/sh
# Linux の tar を、install.sh で空の HOME に入れ、サーバーを起こして応えるところまで見る。
# 使い方: smoke-linux.sh <tar> <install.sh> [ポート]
# CI（ci.yml の linux-package）と release.yml の linux ジョブが同じ手順で回す。
set -eu
tarball="$1"
installer="$2"
port="${3:-4199}"
work="$(mktemp -d)"
pid=""
cleanup() {
  [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

export HOME="$work/home"
mkdir -p "$HOME"
export HANGAR_TARBALL="$tarball"
export HANGAR_NO_SERVICE=1
sh "$installer"
hangar="$HOME/.local/bin/hangar"

echo "== hangar --help"
"$hangar" --help >/dev/null

echo "== サーバーを起こす"
"$hangar" start --no-open --port "$port" >"$work/start.log" 2>&1 &
pid=$!
i=0
until curl -fsS "http://127.0.0.1:$port/health" >"$work/health.json" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "サーバーが 30 秒で応えませんでした" >&2
    cat "$work/start.log" >&2
    exit 1
  fi
  sleep 0.5
done
cat "$work/health.json"
echo

echo "== 画面（UI）が配られる"
token="$(cat "$HOME/.agent-hangar/token")"
code="$(curl -s -o "$work/index.html" -w '%{http_code}' "http://127.0.0.1:$port/?t=$token")"
[ "$code" = "200" ] || { echo "UI が $code を返しました" >&2; exit 1; }
grep -qi '<html' "$work/index.html" || { echo "UI の中身が HTML ではありません" >&2; exit 1; }

echo "== ネイティブ（better-sqlite3 と node-pty）が読める"
root="$HOME/.local/share/agent-hangar/current"
"$root/node/bin/node" -e "
const { createRequire } = require('node:module');
const r = createRequire('$root/app/');
r('better-sqlite3');
r('node-pty');
console.log('native ok');
"

echo "smoke ok"
