#!/bin/bash
# 既にある署名の証明書（p12）を、手元の専用のキーチェーンへ取り込む（手元で署名する開発者が、一度だけ）。
# 手順の全体は docs/signing.md の手順 6。
#
# make-signing-cert.sh は新しい証明書を作るので、手元の取り込みに使ってはいけない。
# 作り直すと指紋が変わり、DR が変わって、利用者の許可が全員分外れる。
# この台本は、p12 の葉の証明書の指紋がリポジトリの値（certificate-sha1.txt）と一致するときだけ取り込む。
#
# 使い方:
#   bash apps/desktop/scripts/import-signing-cert.sh --p12 <リポジトリの外の p12> --keychain <新しいキーチェーンのパス>
#
# パスワード（p12 とキーチェーン）は引数に取らない。環境変数 HANGAR_SIGN_P12_PASSWORD か、端末での入力で受け取る。
# キーチェーンの検索リストには足さず、ログインのキーチェーンには触らない。
# p12 は取り込んだあとも消さない。取り出し先から消すのは呼び手の仕事である。
#
# 環境変数:
#   HANGAR_SIGN_FINGERPRINT_FILE  期待する指紋の置き場。既定は apps/desktop/signing/certificate-sha1.txt。試験が差し替える。
set -euo pipefail

P12=""; KC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --p12) P12="${2:?--p12 に p12 のパスを渡す}"; shift 2 ;;
    --keychain) KC="${2:?--keychain にパスを渡す}"; shift 2 ;;
    *) echo "知らない引数: $1" >&2; exit 2 ;;
  esac
done
[ -n "$P12" ] || { echo "--p12 を渡す" >&2; exit 2; }
[ -n "$KC" ] || { echo "--keychain を渡す" >&2; exit 2; }
[ -f "$P12" ] || { echo "p12 が無い: $P12" >&2; exit 1; }
[ ! -e "$KC" ] || { echo "キーチェーンが既にある: $KC" >&2; exit 1; }

# 秘密鍵をリポジトリの中へ置いたままにしない（うっかり commit しないため）
P12_DIR="$(cd "$(dirname "$P12")" && pwd -P)"
if TOP="$(git -C "$P12_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
  echo "p12 がリポジトリの中（${TOP}）にある。リポジトリの外へ移してから渡す" >&2; exit 1
fi

DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
FP_FILE="${HANGAR_SIGN_FINGERPRINT_FILE:-$DESKTOP/signing/certificate-sha1.txt}"
[ -f "$FP_FILE" ] || { echo "指紋の置き場が無い: $FP_FILE" >&2; exit 1; }
EXPECT="$(grep -v '^[[:space:]]*#' "$FP_FILE" | tr -d '[:space:]:' | tr 'A-F' 'a-f' | head -c 80)"
case "$EXPECT" in
  *[!0-9a-f]*|'') echo "指紋の置き場の中身が 40 桁の 16 進ではない: $FP_FILE" >&2; exit 1 ;;
esac
[ "${#EXPECT}" -eq 40 ] || { echo "指紋の置き場の中身が 40 桁の 16 進ではない: $FP_FILE" >&2; exit 1; }

if [ -z "${HANGAR_SIGN_P12_PASSWORD:-}" ]; then
  read -r -s -p "p12 のパスワード（取り込み先のキーチェーンにも同じものを使う）: " HANGAR_SIGN_P12_PASSWORD; echo
fi
[ -n "$HANGAR_SIGN_P12_PASSWORD" ] || { echo "空のパスワードは使えない" >&2; exit 1; }
export HANGAR_SIGN_P12_PASSWORD

# macOS 標準の LibreSSL を使う（Homebrew の OpenSSL 3 の p12 は security が読めないことがある）
OSSL=/usr/bin/openssl
GOT="$("$OSSL" pkcs12 -in "$P12" -clcerts -nokeys -passin env:HANGAR_SIGN_P12_PASSWORD 2>/dev/null \
  | "$OSSL" x509 -noout -fingerprint -sha1 2>/dev/null | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f')" || true
[ -n "$GOT" ] || { echo "p12 を読めなかった（パスワードか、ファイルが違う）" >&2; exit 1; }
if [ "$GOT" != "$EXPECT" ]; then
  echo "p12 の証明書の指紋がリポジトリの値と違う。取り込まない。" >&2
  echo "  p12 の指紋:       $GOT" >&2
  echo "  リポジトリの指紋: $EXPECT" >&2
  echo "別の証明書で署名すると身元（DR）が変わり、利用者の許可が全員分外れる。本物の p12 を取り出し直す" >&2
  exit 1
fi

# security の -p と -P はパスワードを引数に取る。1 人の手元で一瞬だけ見える（make-signing-cert.sh と同じ）。
KC_CREATED=1
cleanup() { [ "${KC_CREATED:-0}" -eq 0 ] || security delete-keychain "$KC" >/dev/null 2>&1 || true; }
trap cleanup EXIT
security create-keychain -p "$HANGAR_SIGN_P12_PASSWORD" "$KC"
security set-keychain-settings -t 7200 "$KC"
security unlock-keychain -p "$HANGAR_SIGN_P12_PASSWORD" "$KC"
security import "$P12" -k "$KC" -P "$HANGAR_SIGN_P12_PASSWORD" -T /usr/bin/codesign >/dev/null
# 秘密鍵を codesign が確認なしで使えるように
security set-key-partition-list -S apple-tool:,apple: -s -k "$HANGAR_SIGN_P12_PASSWORD" "$KC" >/dev/null
KC_CREATED=0

echo "取り込んだ: 指紋 $GOT"
echo "キーチェーン: $KC"
echo "手元で署名するときは、環境変数 HANGAR_SIGN_KEYCHAIN にこのパスを渡す（docs/signing.md）。p12 は、取り出した場所から消す。"
