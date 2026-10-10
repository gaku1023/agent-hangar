#!/bin/bash
# Hangar.app の署名に使う自己署名のコード署名証明書を作る（利用者の手元で、一度だけ）。
# 手順の全体は docs/signing.md。
#
# 使い方:
#   bash apps/desktop/scripts/make-signing-cert.sh --out <リポジトリの外のディレクトリ> [--keychain <新しいキーチェーンのパス>] [--days <日数>] [--cn <名前>]
#
# 出力（--out の中）:
#   hangar-signing.p12        秘密鍵と証明書。秘密。1Password と CI の secret にだけ置く。リポジトリへ入れない。
#   hangar-signing.cer        公開の証明書（DER）。リポジトリに置いてよい。
#   certificate-sha1.txt      葉の証明書の指紋（SHA-1）。DR の H"..." に使う。リポジトリに置いてよい。
#
# パスワード（p12 とキーチェーン）は引数に取らない。環境変数 HANGAR_SIGN_P12_PASSWORD か、端末での入力で受け取る。
# --keychain を付けると、専用の新しいキーチェーンを作って p12 を入れる（検索リストには足さない。ログインのキーチェーンには触らない）。
set -euo pipefail

OUT=""; KC=""; DAYS=7300; CN="Hangar Signing"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?--out にディレクトリを渡す}"; shift 2 ;;
    --keychain) KC="${2:?--keychain にパスを渡す}"; shift 2 ;;
    --days) DAYS="${2:?--days に日数を渡す}"; shift 2 ;;
    --cn) CN="${2:?--cn に名前を渡す}"; shift 2 ;;
    *) echo "知らない引数: $1" >&2; exit 2 ;;
  esac
done
[ -n "$OUT" ] || { echo "--out を渡す" >&2; exit 2; }
case "$DAYS" in ''|*[!0-9]*) echo "--days は整数" >&2; exit 2 ;; esac
[ "$DAYS" -ge 3653 ] || { echo "有効期間は 10 年（3653 日）以上にする。短いと、更新のたびに macOS の許可が外れる" >&2; exit 2; }

# 秘密鍵をリポジトリの中へ書き出さない（うっかり commit しないため）
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd -P)"
if TOP="$(git -C "$OUT" rev-parse --show-toplevel 2>/dev/null)"; then
  echo "出力先がリポジトリの中（${TOP}）にある。リポジトリの外を --out に渡す" >&2; exit 1
fi
chmod 700 "$OUT"
for f in hangar-signing.p12 hangar-signing.cer certificate-sha1.txt; do
  [ ! -e "$OUT/$f" ] || { echo "既にある: $OUT/${f}（上書きしない。作り直すと身元が変わり、利用者の許可が外れる）" >&2; exit 1; }
done
[ -z "$KC" ] || [ ! -e "$KC" ] || { echo "キーチェーンが既にある: $KC" >&2; exit 1; }

if [ -z "${HANGAR_SIGN_P12_PASSWORD:-}" ]; then
  read -r -s -p "p12 とキーチェーンのパスワード（新しく決める）: " HANGAR_SIGN_P12_PASSWORD; echo
fi
[ -n "$HANGAR_SIGN_P12_PASSWORD" ] || { echo "空のパスワードは使えない" >&2; exit 1; }
export HANGAR_SIGN_P12_PASSWORD

# macOS 標準の LibreSSL を使う（Homebrew の OpenSSL 3 の p12 は security が読めないことがある）
OSSL=/usr/bin/openssl
TMP="$(mktemp -d)"; chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $CN
[ext]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
CNF

"$OSSL" req -x509 -newkey rsa:2048 -nodes -days "$DAYS" -sha256 \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/cert.cnf" 2>/dev/null
"$OSSL" pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$CN" \
  -out "$OUT/hangar-signing.p12" -passout env:HANGAR_SIGN_P12_PASSWORD
chmod 600 "$OUT/hangar-signing.p12"
"$OSSL" x509 -in "$TMP/cert.pem" -outform DER -out "$OUT/hangar-signing.cer"
FP="$("$OSSL" x509 -in "$TMP/cert.pem" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f')"
echo "$FP" > "$OUT/certificate-sha1.txt"

if [ -n "$KC" ]; then
  # security の -p と -P はパスワードを引数に取る。1 人の手元で一瞬だけ見える（CI の使い捨てのキーチェーンも同じ）。
  security create-keychain -p "$HANGAR_SIGN_P12_PASSWORD" "$KC"
  security set-keychain-settings -t 7200 "$KC"
  security unlock-keychain -p "$HANGAR_SIGN_P12_PASSWORD" "$KC"
  security import "$OUT/hangar-signing.p12" -k "$KC" -P "$HANGAR_SIGN_P12_PASSWORD" -T /usr/bin/codesign >/dev/null
  # 秘密鍵を codesign が確認なしで使えるように
  security set-key-partition-list -S apple-tool:,apple: -s -k "$HANGAR_SIGN_P12_PASSWORD" "$KC" >/dev/null
fi

echo "指紋（SHA-1）: $FP"
echo "出力先: $OUT"
[ -z "$KC" ] || echo "キーチェーン: $KC"
echo "次: p12 を 1Password と CI の secret に置き、このディレクトリから p12 を消す（docs/signing.md の手順 3 と 4）。"
