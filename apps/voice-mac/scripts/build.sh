#!/usr/bin/env bash
# hangar-voice を Release で作り、実行ファイルと、実行時に要る束（*.bundle）を dist/ にそろえる。
# MLX の Metal のシェーダ（default.metallib）は mlx-swift_Cmlx.bundle に入るので、xcodebuild で作る（swift build では入らない）。
# Metal Toolchain が無いときは、先に `xcodebuild -downloadComponent MetalToolchain` を打つ。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dist="$root/dist"

# MLX をゼロから作ると数分（CI では 5〜10 分）かかるので、build の中間物（DerivedData）を作り直さずに使い回す。
# 置き場は HANGAR_VOICE_DERIVED、無ければ worktree の外の決まった場所。CI とリリースは同じ場所を actions/cache で戻す。
# xcodebuild はソースの場所が変わると Swift のモジュールを全部作り直すので、ソースも決まった場所（src）へ写してから作る。
# こうすると、どの worktree から作っても同じ中間物に当たる（2026-11-17 の手元の実測：場所が違うと 130 秒、同じなら 6 秒）。
cache="${HANGAR_VOICE_DERIVED:-$HOME/Library/Caches/agent-hangar/voice-mac-xcode}"
src="$cache/src"
derived="$cache/derived"
mkdir -p "$cache"

# 2 つの worktree から同時に作ると、写したソースと中間物を取り合う。先の build が終わるまで待つ。
# 持ち主のプロセスが居ない鍵（強制終了の残り）は取り直す。
lock="$cache/lock"
until mkdir "$lock" 2>/dev/null; do
  owner="$(cat "$lock/pid" 2>/dev/null || true)"
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
    rm -rf "$lock"
    continue
  fi
  echo "ほかの hangar-voice の build を待っている（${lock}）"
  sleep 5
done
echo $$ > "$lock/pid"
trap 'rm -rf "$lock"' EXIT

# 時刻を保って写す（-a）。変わっていないファイルは作り直さない。
rsync -a --delete --exclude .build --exclude dist --exclude .swiftpm "$root/" "$src/"

# CI は中間物を actions/cache で戻す。戻したファイルは時刻が同じでも inode が変わり、Xcode の build は
# Swift のモジュールを全部作り直す（CI で 431 秒）。compilation caching は中身の指紋で引くので、戻した後でも当たる
# （2026-11-17 の手元の実測：tar で戻した後が 120 秒 → 19 秒。置き場は 1.7GB → 2.4GB）。
cd "$src"
xcodebuild -scheme hangar-voice -destination platform=macOS -configuration Release \
  -derivedDataPath "$derived" CLANG_ENABLE_CODE_COVERAGE=NO CLANG_COVERAGE_MAPPING=NO \
  COMPILATION_CACHE_ENABLE_CACHING=YES build

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
