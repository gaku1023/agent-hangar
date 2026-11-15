#!/usr/bin/env bash
# 声の補助 hangar-voice を作り、Mac の .app の Resources/voice に入る束（apps/desktop/voice-dist/）へ写す。
# tauri.macos.conf.json の beforeBuildCommand から、macOS の build でだけ呼ばれる。
# HANGAR_SKIP_VOICE=1 なら補助を作らず、README だけの束を置く。CI の .app の試験の build で使い、Metal Toolchain と xcodebuild を省く。
# 束は空にしない。cargo build（tauri-build）が resources の在りかを確かめるので、README はチェックアウトにも置いてある。
#
#   bash scripts/build-voice.sh [出力先]   # 出力先の既定は apps/desktop/voice-dist
set -euo pipefail

desktop="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$desktop/../.." && pwd)"
out="${1:-$desktop/voice-dist}"

mkdir -p "$out"
find "$out" -mindepth 1 -maxdepth 1 ! -name README.md -exec rm -rf {} +
cat > "$out/README.md" <<'README'
# voice-dist

Mac の .app の `Contents/Resources/voice/` に入る、声の補助 `hangar-voice` の束です。
`scripts/build-voice.sh` が `apps/voice-mac/scripts/build.sh` の出力をここへ写します。
`HANGAR_SKIP_VOICE=1` のときは、この README だけになります。
README

if [ "${HANGAR_SKIP_VOICE:-}" = 1 ]; then
  echo "HANGAR_SKIP_VOICE=1: 声の補助を入れずに build する（${out}）"
  exit 0
fi

bash "$repo/apps/voice-mac/scripts/build.sh"
cp -R "$repo/apps/voice-mac/dist/." "$out/"
echo "voice-dist: $out"
ls "$out"
