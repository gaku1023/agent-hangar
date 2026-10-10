#!/bin/bash
# CI（release.yml の macOS のジョブ）で Hangar.app に署名する。手順の全体は docs/signing.md。
#
# 使い方:
#   bash apps/desktop/scripts/ci-sign-macos.sh <Hangar.app>
#
# 環境変数（GitHub の同じ名前の secret から渡す）:
#   HANGAR_SIGN_P12_BASE64     p12（秘密鍵と証明書）の base64。
#   HANGAR_SIGN_P12_PASSWORD   p12 のパスワード。
#   HANGAR_SIGN_FINGERPRINT_FILE  期待する指紋の置き場。既定は apps/desktop/signing/certificate-sha1.txt。
#                                 ci.yml の試しの署名だけが、その場で作った証明書の指紋を指すのに使う。
#
# 振る舞い:
#   - secret が 2 つとも無い（fork や、まだ入れていないとき）：警告を出し、未署名のまま 0 で終わる。
#   - 片方だけある：設定の誤りとして止まる。
#   - 2 つともある：p12 の葉の証明書の指紋がリポジトリの値と一致するかを先に確かめ、一時のキーチェーンに入れて
#     sign-macos.ts で署名し、署名に入った葉の証明書の指紋をもう一度確かめる。違えば止まる。
#   - 一時のキーチェーン、取り出した p12、足した信頼の設定は、成否にかかわらず終わりに消す。
#
# 秘密（p12 とパスワード）は画面にもファイルの残りにも出さない。set -x は使わない。
set -euo pipefail

APP="${1:-}"
[ -n "$APP" ] || { echo "署名する .app のパスを渡す（例: ci-sign-macos.sh path/to/Hangar.app）" >&2; exit 2; }
[ -d "$APP" ] || { echo ".app が無い: $APP" >&2; exit 2; }
APP="$(cd "$APP" && pwd -P)"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DESKTOP="$(cd "$HERE/.." && pwd -P)"
FP_FILE="${HANGAR_SIGN_FINGERPRINT_FILE:-$DESKTOP/signing/certificate-sha1.txt}"
P12_B64="${HANGAR_SIGN_P12_BASE64:-}"
P12_PW="${HANGAR_SIGN_P12_PASSWORD:-}"
on_actions() { [ "${GITHUB_ACTIONS:-}" = "true" ]; }

if [ -z "$P12_B64" ] && [ -z "$P12_PW" ]; then
  msg="署名の secret（HANGAR_SIGN_P12_BASE64 と HANGAR_SIGN_P12_PASSWORD）が無いので、未署名のまま続ける。手順は docs/signing.md"
  if on_actions; then echo "::warning title=未署名::$msg"; else echo "::warning:: $msg"; fi
  exit 0
fi
if [ -z "$P12_B64" ] || [ -z "$P12_PW" ]; then
  echo "署名の secret が片方しか無い。HANGAR_SIGN_P12_BASE64 と HANGAR_SIGN_P12_PASSWORD を 2 つとも入れる" >&2
  exit 1
fi

# 期待する指紋。# の行と空行を読み飛ばした最初の値を、小文字の 40 桁に直す。
EXPECTED=""
if [ -f "$FP_FILE" ]; then
  EXPECTED="$(grep -v '^[[:space:]]*#' "$FP_FILE" | tr -d ' \t:\r' | grep -v '^$' | head -n 1 | tr 'A-F' 'a-f' || true)"
fi
if [ -z "$EXPECTED" ]; then
  echo "secret はあるが、期待する指紋が $FP_FILE に無い。指紋を書いてから署名する（確かめられないまま配らない）" >&2
  exit 1
fi
case "$EXPECTED" in
  *[!0-9a-f]*) echo "指紋の置き場の値が SHA-1 の 40 桁の 16 進でない: $FP_FILE" >&2; exit 1 ;;
esac
[ "${#EXPECTED}" -eq 40 ] || { echo "指紋の置き場の値が SHA-1 の 40 桁の 16 進でない: $FP_FILE" >&2; exit 1; }

# macOS 標準の LibreSSL を使う（make-signing-cert.sh と同じ）
OSSL=/usr/bin/openssl
sha1_of() { "$OSSL" x509 "$@" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f'; }

TMP="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/hangar-sign.XXXXXX")"
chmod 700 "$TMP"
KC="$TMP/hangar-sign.keychain-db"
TRUSTED=""
ORIG_LIST=()
# sudo が認可を待って固まらないように、時間を切る（perl の alarm。macOS に timeout は無い）。
bounded() { local s="$1"; shift; perl -e 'alarm shift; exec @ARGV or exit 127' "$s" "$@"; }
cleanup() {
  set +e
  if [ "${#ORIG_LIST[@]}" -gt 0 ]; then security list-keychains -d user -s "${ORIG_LIST[@]}" >/dev/null 2>&1; fi
  if [ -n "$TRUSTED" ]; then
    bounded 30 sudo -n security remove-trusted-cert -d "$TMP/cert.cer" >/dev/null 2>&1
    bounded 30 sudo -n security delete-certificate -Z "$(printf %s "$EXPECTED" | tr a-f A-F)" /Library/Keychains/System.keychain >/dev/null 2>&1
  fi
  [ -e "$KC" ] && security delete-keychain "$KC" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

umask 077
printf '%s' "$P12_B64" | base64 -D -o "$TMP/sign.p12" 2>/dev/null || printf '%s' "$P12_B64" | base64 --decode > "$TMP/sign.p12"
export HANGAR_SIGN_P12_PASSWORD="$P12_PW"
if ! "$OSSL" pkcs12 -in "$TMP/sign.p12" -nokeys -clcerts -passin env:HANGAR_SIGN_P12_PASSWORD -out "$TMP/cert.pem" 2>/dev/null; then
  echo "p12 を開けない。HANGAR_SIGN_P12_BASE64 が p12 の base64 か、HANGAR_SIGN_P12_PASSWORD が合っているかを確かめる" >&2
  exit 1
fi
GOT="$(sha1_of -in "$TMP/cert.pem")"
if [ "$GOT" != "$EXPECTED" ]; then
  echo "p12 の証明書の指紋がリポジトリの値と違う（期待 $EXPECTED、p12 $GOT）。署名しない" >&2
  exit 1
fi
echo "p12 の証明書の指紋はリポジトリの値と一致した: $EXPECTED"

# 一時のキーチェーン。パスワードはその場で作り、この実行の中でだけ使う。
KC_PW="$("$OSSL" rand -hex 24)"
if on_actions; then echo "::add-mask::$KC_PW"; fi
security create-keychain -p "$KC_PW" "$KC"
security set-keychain-settings -t 3600 "$KC"
security unlock-keychain -p "$KC_PW" "$KC"
security import "$TMP/sign.p12" -k "$KC" -f pkcs12 -P "$P12_PW" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$KC_PW" "$KC" >/dev/null
rm -f "$TMP/sign.p12"

if on_actions; then
  # macOS 26 のランナーでは、自作の証明書をコード署名用に信頼し、キーチェーンを検索リストへ足さないと、
  # codesign が「no identity found」で落ちる（docs/signing.md の「署名する機械の前提」）。
  # 信頼は機械全体の設定を書き換えるので、使い捨てのランナーの中でだけ行い、終わりに外す。利用者の手元ではこの道を通らない。
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"; line="${line%\"}"; line="${line#\"}"
    [ -n "$line" ] && ORIG_LIST+=("$line")
  done < <(security list-keychains -d user)
  "$OSSL" x509 -in "$TMP/cert.pem" -outform DER -out "$TMP/cert.cer"
  TRUSTED=1
  bounded 120 bash "$HERE/prepare-signing-keychain.sh" --cer "$TMP/cert.cer" --keychain "$KC"
fi

(
  cd "$DESKTOP"
  HANGAR_SIGN_KEYCHAIN="$KC" HANGAR_SIGN_KEYCHAIN_PASSWORD="$KC_PW" HANGAR_SIGN_CERT_SHA1="$EXPECTED" \
    node --import tsx scripts/sign-macos.ts "$APP"
)

# 署名に入った葉の証明書を取り出して、もう一度指紋を確かめる。
codesign -d --extract-certificates="$TMP/signed-" "$APP" >/dev/null 2>&1
[ -f "$TMP/signed-0" ] || { echo "署名から証明書を取り出せない: $APP" >&2; exit 1; }
SIGNED="$(sha1_of -inform DER -in "$TMP/signed-0")"
if [ "$SIGNED" != "$EXPECTED" ]; then
  echo "署名に入った証明書の指紋がリポジトリの値と違う（期待 $EXPECTED、署名 $SIGNED）" >&2
  exit 1
fi
echo "署名に入った証明書の指紋はリポジトリの値と一致した: $SIGNED"
