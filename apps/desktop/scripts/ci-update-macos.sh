#!/bin/bash
# 本当の更新の経路を 1 回通す（macOS）。CI の desktop-update ジョブが呼ぶ（.app の段の desktop ジョブと並んで回る）。
# 使い方: bash apps/desktop/scripts/ci-update-macos.sh <成果物の置き場>
#
# 1. CI の中で使い捨ての updater の鍵を作る（tauri signer generate）。本物の secret は使わない。
# 2. 版 A（今の版）と版 B（版を一時的に上げたもの）の .app と .app.tar.gz を、その鍵とローカルの目録を重ねて build する（update-rehearsal.ts の config）。
#    版のファイルは build の後で git checkout で元に戻す。
# 3. 版 B の .app.tar.gz と目録（latest.json）を 127.0.0.1 で配り、版 A の .app を一時の場所へ写す。
# 4. 写した版 A の UI に、確認、取得、インストールを殻へ頼む台本を差し込み（update-rehearsal.ts の inject）、殻を起こす。
#    殻はふだんと同じ updater の経路で .app.tar.gz を取って署名を確かめ、.app を入れ替えてから、終了の手続きを通って起き直す。
# 5. 起き直した殻のサーバが /health で版 B を名乗ること、入れ替えた .app の Info.plist の版（CFBundleShortVersionString）、desktop.log の印、目録と更新物が取られたことを確かめる。
# 殻には一時のホーム（HANGAR_HOME）の settings.json の nodePath で setup-node の Node を指す。起き直した殻は環境をそのまま受け継ぐ（tauri の restart）。
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "使い方: ci-update-macos.sh <成果物の置き場>" >&2
  exit 2
fi
mkdir -p "$1"
out="$(cd "$1" && pwd)"
here="$(cd "$(dirname "$0")" && pwd)"
desktop="$(cd "$here/.." && pwd)"
root="$(cd "$desktop/../.." && pwd)"
helper="$here/update-rehearsal.ts"
# 殻（Tauri）は、実行ファイルのパスにシンボリックリンクが混じると、リソースの場所を決められずに落ちる。/var はリンクなので実の名前に直す。
work="$(cd "$(mktemp -d)" && pwd -P)"
port=47180
health="http://127.0.0.1:4177/health"
bundle="$desktop/src-tauri/target/release/bundle/macos"
# 版の在りか（release-plan.ts の VERSION_FILES）。set-version で上げた版 B の build の後で元に戻す。
version_files=(apps/desktop/src-tauri/tauri.conf.json apps/desktop/package.json apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock package-lock.json)
app="$work/apps/Hangar.app"
hangar_home="$work/hangar-home"
log="$hangar_home/desktop.log"
restore_versions=0
serve_pid=""

h() { node --experimental-strip-types --no-warnings "$helper" "$@"; }

cleanup() {
  # 写した .app から起きたもの（殻と、殻が起こしたサーバ）だけを止める。
  pkill -f "$work/apps/" 2>/dev/null || true
  for _ in $(seq 1 20); do pgrep -f "$work/apps/" >/dev/null || break; sleep 0.5; done
  pkill -9 -f "$work/apps/" 2>/dev/null || true
  [ -n "$serve_pid" ] && kill "$serve_pid" 2>/dev/null || true
  if [ "$restore_versions" = 1 ]; then (cd "$root" && git checkout -- "${version_files[@]}") || true; fi
  [ -f "$log" ] && cp "$log" "$out/desktop.log"
  rm -rf "$work"
}
trap cleanup EXIT

plist_version() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist"; }

health_version() { curl -s -m 2 "$health" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).version??""))}catch{}})' || true; }

# 版 A と版 B の .app を、使い捨ての鍵とローカルの目録を重ねて build し、.app と .app.tar.gz と署名を $2 へ写す。
build() {
  local version="$1" dest="$2"
  rm -rf "$bundle"
  (cd "$desktop" && TAURI_SIGNING_PRIVATE_KEY="$(cat "$key")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$password" npm run tauri -- build --bundles app --config "$work/rehearsal.conf.json")
  local got
  got="$(plist_version "$bundle/Hangar.app")"
  if [ "$got" != "$version" ]; then echo "build した .app の版が ${got}（期待は ${version}）" >&2; exit 1; fi
  mkdir -p "$dest"
  ditto "$bundle/Hangar.app" "$dest/Hangar.app"
  cp "$bundle/Hangar.app.tar.gz" "$bundle/Hangar.app.tar.gz.sig" "$dest/"
}

# --- 1. 使い捨ての鍵と、重ねる設定 ---
version_a="$(node -p "require('$desktop/src-tauri/tauri.conf.json').version")"
version_b="$(h next-version "$version_a")"
echo "版 A: ${version_a}、版 B: $version_b"
case "$(uname -m)" in
  arm64) platform=darwin-aarch64 ;;
  x86_64) platform=darwin-x86_64 ;;
  *) echo "知らないアーキテクチャ $(uname -m)" >&2; exit 1 ;;
esac
key="$work/updater.key"
password=ci-update-rehearsal
(cd "$desktop" && npx tauri signer generate --ci -p "$password" -w "$key")
h config "$key.pub" "$port" "$work/rehearsal.conf.json"
cat "$work/rehearsal.conf.json"

# --- 2. 版 A と版 B の build ---
t0=$SECONDS
build "$version_a" "$work/a"
echo "版 A の build: $((SECONDS - t0)) 秒"
restore_versions=1
node --experimental-strip-types --no-warnings "$here/release-plan.ts" set-version "$version_b" "$root"
t0=$SECONDS
build "$version_b" "$work/b"
echo "版 B の build: $((SECONDS - t0)) 秒"
(cd "$root" && git checkout -- "${version_files[@]}")
restore_versions=0

# --- 3. 目録と更新物を配り、版 A を写す ---
h stage "$work/serve" "$version_b" "$platform" "$work/b/Hangar.app.tar.gz" "$port"
node --experimental-strip-types --no-warnings "$helper" serve "$work/serve" "$port" >"$out/serve.log" 2>&1 &
serve_pid=$!
for _ in $(seq 1 100); do grep -q 'listening on' "$out/serve.log" 2>/dev/null && break; sleep 0.2; done
grep -q 'listening on' "$out/serve.log" || { echo '目録を配る HTTP が起きない' >&2; exit 1; }

if curl -s -m 2 "$health" >/dev/null; then
  echo "版 A を起こす前から 4177 が応えている" >&2
  exit 1
fi
mkdir -p "$work/apps" "$hangar_home"
ditto "$work/a/Hangar.app" "$app"

# --- 4. 版 A の UI に更新を進める台本を差し込み、殻を起こす ---
h inject "$app/Contents/Resources/server/ui"
injected="$app/Contents/Resources/server/ui/assets/ci-update-rehearsal.js"
printf '{ "nodePath": "%s" }\n' "$(command -v node)" >"$hangar_home/settings.json"
HANGAR_HOME="$hangar_home" "$app/Contents/MacOS/hangar-desktop" >"$out/stdout.log" 2>&1 &
echo "版 A の殻を起こした（pid $!）"

# --- 5. 版 B が起き直すのを待つ ---
saw_a=0
got=""
deadline=$((SECONDS + 300))
while [ $SECONDS -lt $deadline ]; do
  got="$(health_version)"
  if [ "$got" = "$version_a" ] && [ "$saw_a" = 0 ]; then saw_a=1; echo "版 A のサーバーが応えた"; fi
  [ "$got" = "$version_b" ] && break
  if [ -f "$log" ] && grep -Eq 'update: (check|download|install) failed' "$log"; then
    grep -E 'update: (check|download|install) failed' "$log" >&2
    echo "殻の更新が失敗した" >&2
    break
  fi
  sleep 1
done
echo '--- desktop.log ---'
[ -f "$log" ] && tail -n 60 "$log"
echo '--- serve.log ---'
cat "$out/serve.log"
fail() { echo "$1" >&2; exit 1; }
[ "$saw_a" = 1 ] || fail "版 A のサーバーが応えなかった"
[ "$got" = "$version_b" ] || fail "更新のあと $health が版 $version_b を名乗らなかった（最後の答え: ${got:-なし}）"
echo "起き直した殻のサーバーが版 $version_b を名乗った"
[ "$(plist_version "$app")" = "$version_b" ] || fail "入れ替えた .app の版が $(plist_version "$app")（期待は ${version_b}）"
[ ! -e "$injected" ] || fail "版 A に差し込んだ台本が残っている（.app が入れ替わっていない）"
for mark in "update: checked, found $version_b" "update: downloaded $version_b" "update: installed, restarting"; do
  grep -qF "$mark" "$log" || fail "desktop.log に「${mark}」が無い"
done
grep -q 'GET /latest.json 200' "$out/serve.log" || fail "殻が目録を取りに来ていない"
grep -q 'GET /Hangar.app.tar.gz 200' "$out/serve.log" || fail "殻が版 B の .app.tar.gz を取りに来ていない"
pgrep -f "$app/Contents/MacOS/" >/dev/null || fail "起き直した殻が見つからない"
echo "更新の経路を通し終えた"
