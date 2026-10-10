#!/bin/bash
# まっさらな Mac（Node も tmux も無い）で、入れた殻が失敗の札を出すことを確かめる。CI の desktop ジョブが呼ぶ。
# 使い方: bash apps/desktop/scripts/ci-boot-probe-macos.sh [--hide-system-node] [--port <n>] <Hangar.app> <成果物の置き場>
#
# build した .app を一時の場所へ写し、Node が見つからない状態で起こす。
#   一時のホーム（HOME と HANGAR_HOME）、settings.json の nodePath は無いパス、PATH は最小にし、ほかの環境は渡さない（env -i）。
#   --hide-system-node を付けると、殻が固定で探す場所（node.rs の platform_node_paths）にある node を、終わるまで脇へ退ける（sudo）。
#   ランナーには Homebrew の Node が入っていて、そのままでは殻が見つけてしまう。手元の Mac では付けない。
# 殻には HANGAR_BOOT_PROBE で書き出しの先を渡す。起動画面が描いた様子を殻がそこへ書き（bootprobe.rs）、
# boot-probe-check.ts が、札が出て種類が other、詳細が「Node <版>」を含む文になるまで待つ（上限 60 秒）。
# 画面を撮れれば boot-screen.png を、殻の記録（desktop.log）と一緒に成果物の置き場に残す。撮れなくても落とさない。
set -u

hide=0
port=4177
while [ $# -gt 0 ]; do
  case "$1" in
    --hide-system-node) hide=1; shift ;;
    --port) port="$2"; shift 2 ;;
    *) break ;;
  esac
done
if [ $# -ne 2 ]; then
  echo "使い方: ci-boot-probe-macos.sh [--hide-system-node] [--port <n>] <Hangar.app> <成果物の置き場>" >&2
  exit 2
fi
app="$1"
out="$2"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
# 殻（Tauri）は、実行ファイルのパスにシンボリックリンクが混じると、リソースの場所を決められずに落ちる。
# mktemp の置き場（/var/folders/...）の /var はリンクなので、実の名前に直してから使う。
work="$(cd "$(mktemp -d)" && pwd -P)"

# 殻が固定で探す場所。node.rs の platform_node_paths と同じ並び。
fixed=(/opt/homebrew/bin/node /usr/local/bin/node)
hidden=()
pid=""
cleanup() {
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$pid" 2>/dev/null
  fi
  for p in "${hidden[@]+"${hidden[@]}"}"; do sudo mv "$p.hidden-by-ci" "$p" && echo "戻した: $p"; done
  # 写した .app と一時のホームを消す。成果物の置き場（out）には触らない。
  [ -n "$work" ] && [ -d "$work" ] && rm -rf "$work"
}
trap cleanup EXIT

# 誰かが既にポートで応えていると、殻はそれを採って Node を探さない。
if curl -s -m 2 "http://127.0.0.1:$port/health" >/dev/null; then
  echo "殻を起こす前から $port が応えている" >&2
  exit 1
fi

if [ "$hide" = 1 ]; then
  for p in "${fixed[@]}"; do
    if [ -e "$p" ] || [ -L "$p" ]; then
      sudo mv "$p" "$p.hidden-by-ci" || exit 1
      hidden+=("$p")
      echo "脇へ退けた: $p"
    fi
  done
fi

ditto "$app" "$work/Hangar.app" || exit 1
mkdir -p "$work/home" "$work/hangar-home"
printf '{ "nodePath": "%s" }\n' "$work/no-such-node" >"$work/hangar-home/settings.json"

/usr/bin/env -i HOME="$work/home" USER="${USER:-runner}" TMPDIR="${TMPDIR:-/tmp}" \
  HANGAR_HOME="$work/hangar-home" HANGAR_BOOT_PROBE="$out/probe.json" \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  "$work/Hangar.app/Contents/MacOS/hangar-desktop" >"$out/stdout.log" 2>&1 &
pid=$!
echo "殻を起こした（pid ${pid}）"

rc=0
node --experimental-strip-types --no-warnings "$here/boot-probe-check.ts" wait "$out/probe.json" \
  --kind other --detail 'Node [0-9]+' --timeout 60 --pid "$pid" || rc=$?

# 札が描き終わるのを少し待ってから撮る。ランナーで画面の収録が許されていなければ撮れない。
sleep 1
if screencapture -x "$out/boot-screen.png" 2>"$out/screencapture.err" && [ -s "$out/boot-screen.png" ]; then
  echo "画面を撮った: boot-screen.png"
else
  echo "::warning::画面を撮れなかった（$(cat "$out/screencapture.err" 2>/dev/null)）"
fi

log="$work/hangar-home/desktop.log"
if [ -f "$log" ]; then
  cp "$log" "$out/desktop.log"
  echo "--- desktop.log ---"
  tail -40 "$log"
  # 殻が Node を見つけてサーバを起こしたなら、探す場所が増えたか、ランナーの Node を退けきれていない。
  if grep -q '\[desktop\] node ' "$log"; then
    echo "殻が Node を見つけた: $(grep '\[desktop\] node ' "$log" | head -1)" >&2
    echo "node.rs の探す場所が増えたなら、この台本の fixed も合わせる" >&2
    rc=1
  fi
fi
exit "$rc"
