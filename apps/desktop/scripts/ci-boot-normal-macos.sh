#!/bin/bash
# Node のある Mac で、入れた殻が同梱のサーバを起こし、本当の画面へ移ることを確かめる。
# CI の desktop ジョブ（build した .app）と、release の macos ジョブ（署名した .app）が呼ぶ。
# 使い方: bash apps/desktop/scripts/ci-boot-normal-macos.sh [--node <path>] [--require-probe] [--timeout <秒>] <Hangar.app> <成果物の置き場>
#
# build した .app を一時の場所へ写し、一時のホーム（HOME と HANGAR_HOME）と最小の PATH だけを渡して起こす（env -i）。
#   PATH は Finder から起きたときと同じ /usr/bin:/bin:/usr/sbin:/sbin にし、殻がサーバへ渡すときに置き場を足すこと（server.rs の augmented_path）を確かめる。
#   settings.json の nodePath に --node の Node（CI では setup-node の Node 22）を書く。省けば PATH の先頭の node を使う。
#   ランナーには Homebrew の Node もあるので、殻が nodePath のものを選んだことまで確かめる。
# 殻には HANGAR_BOOT_PROBE で書き出しの先を渡す。起動画面が読み込みの合図を描くと、殻がそこへ書く（bootprobe.rs）。
# 判定は boot-normal-check.ts が行う（/health の ok と ready、使った Node、サーバの環境、UI の配信、画面の移り、殻を止めたときのサーバの降り方）。
# --require-probe を付けると、合図の書き出しが無いときに落とす（CI の build）。付けなければ警告だけにする（release の build）。
# 画面を撮れれば app-screen.png を、殻の記録（desktop.log）と一緒に成果物の置き場に残す。撮れなくても落とさない。
set -u

node_bin=""
require_probe=0
timeout=150
while [ $# -gt 0 ]; do
  case "$1" in
    --node) node_bin="$2"; shift 2 ;;
    --require-probe) require_probe=1; shift ;;
    --timeout) timeout="$2"; shift 2 ;;
    *) break ;;
  esac
done
if [ $# -ne 2 ]; then
  echo "使い方: ci-boot-normal-macos.sh [--node <path>] [--require-probe] [--timeout <秒>] <Hangar.app> <成果物の置き場>" >&2
  exit 2
fi
app="$1"
out="$2"
here="$(cd "$(dirname "$0")" && pwd)"
[ -n "$node_bin" ] || node_bin="$(command -v node)"
if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
  echo "Node が無い（--node で渡す）" >&2
  exit 2
fi
# 殻のポートは決まっている（server.rs の PORT）。
port=4177
mkdir -p "$out"
out="$(cd "$out" && pwd)"
# 殻（Tauri）は、実行ファイルのパスにシンボリックリンクが混じると、リソースの場所を決められずに落ちる。
# mktemp の置き場（/var/folders/...）の /var はリンクなので、実の名前に直してから使う。
work="$(cd "$(mktemp -d)" && pwd -P)"
base_path=/usr/bin:/bin:/usr/sbin:/sbin

pid=""
cleanup() {
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$pid" 2>/dev/null
  fi
  # 殻が先に死んでも、サーバは HANGAR_PARENT_PID の見張りで降りる。降りきらないものは、写した .app から起きたものだけを止める。
  if [ -n "$work" ]; then
    pkill -f "$work/Hangar.app/" 2>/dev/null
  fi
  # 写した .app と一時のホームを消す。成果物の置き場（out）には触らない。
  [ -n "$work" ] && [ -d "$work" ] && rm -rf "$work"
}
trap cleanup EXIT

# 誰かが既にポートで応えていると、殻はそれを採ってサーバを起こさない。
if curl -s -m 2 "http://127.0.0.1:$port/health" >/dev/null; then
  echo "殻を起こす前から $port が応えている" >&2
  exit 1
fi

ditto "$app" "$work/Hangar.app" || exit 1
mkdir -p "$work/home" "$work/hangar-home"
printf '{ "nodePath": "%s" }\n' "$node_bin" >"$work/hangar-home/settings.json"

/usr/bin/env -i HOME="$work/home" USER="${USER:-runner}" TMPDIR="${TMPDIR:-/tmp}" \
  HANGAR_HOME="$work/hangar-home" HANGAR_BOOT_PROBE="$out/probe.json" \
  PATH="$base_path" \
  "$work/Hangar.app/Contents/MacOS/hangar-desktop" >"$out/stdout.log" 2>&1 &
pid=$!
echo "殻を起こした（pid ${pid}、Node は ${node_bin}）"

set -- --port "$port" --hangar-home "$work/hangar-home" --server-dir "$work/Hangar.app/Contents/Resources/server" \
  --node "$node_bin" --shell-pid "$pid" --user-home "$work/home" --path-base "$base_path" \
  --probe "$out/probe.json" --timeout "$timeout" --shot "$out/app-screen.png"
[ "$require_probe" = 1 ] && set -- "$@" --require-probe

rc=0
"$node_bin" --experimental-strip-types --no-warnings "$here/boot-normal-check.ts" run "$@" || rc=$?

log="$work/hangar-home/desktop.log"
if [ -f "$log" ]; then
  cp "$log" "$out/desktop.log"
  echo "--- desktop.log ---"
  tail -40 "$log"
fi
exit "$rc"
