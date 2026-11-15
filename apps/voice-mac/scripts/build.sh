#!/usr/bin/env bash
# hangar-voice を Release で作り、実行ファイルと、実行時に要る束（*.bundle）を dist/ にそろえる。
# MLX の Metal のシェーダ（default.metallib）は mlx-swift_Cmlx.bundle に入るので、xcodebuild で作る（swift build では入らない）。
# Metal Toolchain が無いときは、先に `xcodebuild -downloadComponent MetalToolchain` を打つ。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
derived="$root/.build/xcode"
dist="$root/dist"

cd "$root"
xcodebuild -scheme hangar-voice -destination platform=macOS -configuration Release \
  -derivedDataPath "$derived" CLANG_ENABLE_CODE_COVERAGE=NO CLANG_COVERAGE_MAPPING=NO build

products="$derived/Build/Products/Release"
rm -rf "$dist"
mkdir -p "$dist"
cp "$products/hangar-voice" "$dist/"
# 実行ファイルの隣の束を探して読む（Bundle.module）。全部を写す。
for b in "$products"/*.bundle; do
  [ -e "$b" ] || continue
  cp -R "$b" "$dist/"
done
echo "dist: $dist"
ls "$dist"
