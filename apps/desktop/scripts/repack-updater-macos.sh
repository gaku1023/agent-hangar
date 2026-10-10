#!/bin/bash
# 自動更新の更新物（<名前>.app.tar.gz と .sig）を、署名を終えた .app から作り直し、確かめる。手順の全体は docs/signing.md。
#
# 使い方:
#   bash apps/desktop/scripts/repack-updater-macos.sh pack <Hangar.app>
#   bash apps/desktop/scripts/repack-updater-macos.sh verify <Hangar.app> [--expect-signed]
#
# なぜ作り直すのか:
#   tauri build の createUpdaterArtifacts は、build の中で、署名の前の .app から更新物を詰める。
#   そのままだと、更新で配られる .app は自作の証明書の署名を持たず、更新のたびに macOS の許可が外れる。
#   だから release の署名の段の後で、署名済みの .app から詰め直し、更新の署名（minisign の .sig）も付け直す。
#
# pack:
#   .app の隣の <名前>.app.tar.gz と .sig を消し、tauri と同じ形（.app をそのまま 1 つ入れた gzip の tar）で詰め直す。
#   macOS の拡張属性（._ のファイル）は入れない。
#   .sig は、tauri の CLI（npm ci が入れたもの）の signer sign で作る。鍵は環境変数
#   TAURI_SIGNING_PRIVATE_KEY と TAURI_SIGNING_PRIVATE_KEY_PASSWORD（tauri が読む名前のまま）で受け取る。鍵が無ければ止まる。
#
# verify:
#   tar.gz を一時の場所に展開し、展開した .app の署名の識別子と DR が元の .app と同じで、
#   codesign --verify --deep --strict が通ることを確かめる。
#   --expect-signed を付けると、識別子が tauri.conf.json の identifier で、DR が
#   certificate-sha1.txt（HANGAR_SIGN_FINGERPRINT_FILE で差し替えられる）の指紋で縛られていることも確かめる。
set -euo pipefail

usage='使い方: repack-updater-macos.sh pack <Hangar.app> | verify <Hangar.app> [--expect-signed]'
MODE="${1:-}"; APP="${2:-}"
[ -n "$MODE" ] && [ -n "$APP" ] || { echo "$usage" >&2; exit 2; }
EXPECT_SIGNED=""
if [ "$MODE" = verify ] && [ "${3:-}" = "--expect-signed" ]; then EXPECT_SIGNED=1
elif [ -n "${3:-}" ]; then echo "$usage" >&2; exit 2; fi
case "$MODE" in pack|verify) ;; *) echo "$usage" >&2; exit 2 ;; esac
[ -d "$APP" ] || { echo ".app が無い: $APP" >&2; exit 1; }
APP="$(cd "$APP" && pwd -P)"
DIR="$(dirname "$APP")"
NAME="$(basename "$APP")"
TARGZ="$DIR/$NAME.tar.gz"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DESKTOP="$(cd "$HERE/.." && pwd -P)"
ROOT="$(cd "$DESKTOP/../.." && pwd -P)"

if [ "$MODE" = pack ]; then
  [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || { echo "更新の署名鍵（TAURI_SIGNING_PRIVATE_KEY）が無い。署名の無い更新物は置かない" >&2; exit 1; }
  TAURI="$ROOT/node_modules/.bin/tauri"
  [ -x "$TAURI" ] || { echo "tauri の CLI が無い: $TAURI（npm ci を先に）" >&2; exit 1; }
  rm -f "$TARGZ" "$TARGZ.sig"
  # COPYFILE_DISABLE と --no-mac-metadata で、拡張属性を ._ のファイルとして入れない。
  COPYFILE_DISABLE=1 tar --no-mac-metadata -czf "$TARGZ" -C "$DIR" "$NAME"
  "$TAURI" signer sign "$TARGZ" >/dev/null
  [ -s "$TARGZ.sig" ] || { echo "更新の署名（.sig）ができていない: $TARGZ.sig" >&2; exit 1; }
  echo "更新物を、署名済みの .app から作り直した: $TARGZ（と .sig）"
  exit 0
fi

# verify
[ -f "$TARGZ" ] || { echo "更新物が無い: $TARGZ" >&2; exit 1; }
TMP="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/hangar-updater.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
tar -xzf "$TARGZ" -C "$TMP"
TOP="$(ls -A "$TMP")"
[ "$TOP" = "$NAME" ] || { echo "更新物の中身が $NAME 1 つではない: $(echo "$TOP" | tr '\n' ' ')" >&2; exit 1; }
GOT_APP="$TMP/$NAME"

ident() { codesign -dvv "$1" 2>&1 | sed -n 's/^Identifier=//p'; }
dr() { codesign -d -r- "$1" 2>&1 | sed -n 's/^# *//; /^designated =>/p'; }

WANT_ID="$(ident "$APP")"; GOT_ID="$(ident "$GOT_APP")"
WANT_DR="$(dr "$APP")"; GOT_DR="$(dr "$GOT_APP")"
[ -n "$WANT_ID" ] || { echo "元の .app に署名の識別子が無い: $APP" >&2; exit 1; }
if [ "$GOT_ID" != "$WANT_ID" ]; then
  echo "更新物の .app の識別子が元と違う（元 $WANT_ID、更新物 ${GOT_ID:-無し}）。署名の前の .app から詰めていないか" >&2; exit 1
fi
if [ "$GOT_DR" != "$WANT_DR" ]; then
  printf '更新物の .app の DR が元と違う\n元: %s\n更新物: %s\n' "$WANT_DR" "${GOT_DR:-無し}" >&2; exit 1
fi
if ! codesign --verify --deep --strict "$GOT_APP" 2>"$TMP/verify.err"; then
  echo "更新物の .app で codesign --verify が通らない" >&2; cat "$TMP/verify.err" >&2; exit 1
fi

if [ -n "$EXPECT_SIGNED" ]; then
  CONF_ID="$(node -p "require('$DESKTOP/src-tauri/tauri.conf.json').identifier")"
  FP_FILE="${HANGAR_SIGN_FINGERPRINT_FILE:-$DESKTOP/signing/certificate-sha1.txt}"
  FP="$(grep -v '^[[:space:]]*#' "$FP_FILE" 2>/dev/null | tr -d ' \t:\r' | grep -v '^$' | head -n 1 | tr 'A-F' 'a-f' || true)"
  [ -n "$FP" ] || { echo "期待する指紋が $FP_FILE に無い" >&2; exit 1; }
  [ "$GOT_ID" = "$CONF_ID" ] || { echo "更新物の .app の識別子が $CONF_ID でない（$GOT_ID）" >&2; exit 1; }
  WANT_CERT_DR="designated => certificate leaf = H\"$FP\""
  [ "$GOT_DR" = "$WANT_CERT_DR" ] || { echo "更新物の .app の DR が証明書の指紋で縛られていない（期待 $WANT_CERT_DR、更新物 ${GOT_DR:-無し}）" >&2; exit 1; }
fi

echo "更新物の .app の署名は保たれている"
echo "識別子: $GOT_ID"
echo "DR: $GOT_DR"
