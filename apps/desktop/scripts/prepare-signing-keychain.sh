#!/bin/bash
# 自作の証明書で codesign が署名できるように、署名する機械を整える。
# macOS 26 の CI のランナーでは、これをしないと codesign が「no identity found」で落ちた（実測）。
#   1. 証明書をコード署名用に信頼する（信頼されていない証明書は「有効な識別」に数えられない）。
#   2. 秘密鍵の入ったキーチェーンを、ユーザーの検索リストの先頭に足す。
# 1 は機械全体（System のキーチェーン、管理者の信頼設定）を書き換える。使い捨ての CI のランナーで使う想定で、
# 手元の Mac で走らせるなら、信頼を外す手順（docs/signing.md）も一緒に読む。
# 新しい macOS（27 で確かめた）では、これをしなくても署名できる。
#
# 使い方: bash prepare-signing-keychain.sh --cer <公開の証明書> --keychain <キーチェーンのパス>
# sudo を使う。パスワードの尋ね方は sudo に任せる（CI では不要）。
set -euo pipefail

CER=""; KC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cer) CER="${2:?--cer に公開の証明書を渡す}"; shift 2 ;;
    --keychain) KC="${2:?--keychain にパスを渡す}"; shift 2 ;;
    *) echo "知らない引数: $1" >&2; exit 2 ;;
  esac
done
[ -f "$CER" ] || { echo "証明書が無い: $CER" >&2; exit 1; }
[ -e "$KC" ] || { echo "キーチェーンが無い: $KC" >&2; exit 1; }

sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$CER"

# 検索リストの先頭に足す。もとの並びは保つ。
EXISTING=()
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"; line="${line%\"}"; line="${line#\"}"
  [ -n "$line" ] && EXISTING+=("$line")
done < <(security list-keychains -d user)
security list-keychains -d user -s "$KC" ${EXISTING[@]+"${EXISTING[@]}"}
echo "整えた: 信頼（codeSign）と、検索リストへのキーチェーン $KC"
