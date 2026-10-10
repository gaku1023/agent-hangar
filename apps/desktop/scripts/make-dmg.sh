#!/bin/bash
# 署名の済んだ Hangar.app から、配布用の dmg を作る。
# 使い方: bash apps/desktop/scripts/make-dmg.sh <Hangar.app> <出力の .dmg>
#
# dmg の中身は .app と、/Applications へのリンクの 2 つだけにする。
# 開いた人は .app をリンクへドラッグして入れる。
#
# tauri の dmg ターゲットは使わない。
# tauri の dmg は build の途中で .app を詰めるので、build の後で署名した .app が入らない。
# tauri bundle --bundles dmg も .app を作り直してから詰めるので、署名が消える。
# だから dmg は、署名を終えた .app を hdiutil で詰めて作る。
# Finder を AppleScript で動かさないので、窓の無い CI でも同じに動く。
set -euo pipefail

usage='使い方: make-dmg.sh <Hangar.app> <出力の .dmg>'
if [ "$#" -ne 2 ]; then
  echo "$usage" >&2
  exit 2
fi
app="$1"
out="$2"

if [ ! -d "$app" ]; then
  echo ".app が見つからない: $app" >&2
  exit 1
fi
if [ ! -d "$(dirname "$out")" ]; then
  echo "出力先のディレクトリが無い: $(dirname "$out")" >&2
  exit 1
fi

name="$(basename "$app")"
volname="${name%.app}"

stage="$(mktemp -d "${TMPDIR:-/tmp}/hangar-dmg.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

# ditto は拡張属性と署名をそのまま写す。
ditto "$app" "$stage/$name"
ln -s /Applications "$stage/Applications"

rm -f "$out"
# 圧縮は LZMA（ULMO）にする。
# macOS 10.15 から開けるので、対象の macOS 13 以降では問題なく、zlib（UDZO）より 4 割ほど小さい。
# GitHub の macOS のランナーでは、hdiutil create がまれに Resource busy で落ちる。
# 少し待って 3 回まで試す。
for attempt in 1 2 3; do
  if hdiutil create -quiet -volname "$volname" -srcfolder "$stage" -fs HFS+ -format ULMO -ov "$out"; then
    break
  fi
  rm -f "$out"
  if [ "$attempt" -eq 3 ]; then
    echo "hdiutil create が 3 回とも失敗した" >&2
    exit 1
  fi
  sleep 5
done

hdiutil verify -quiet "$out"
echo "$out"
