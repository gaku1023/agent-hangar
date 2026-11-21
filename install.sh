#!/bin/sh
# agent-hangar を Linux（x64 または arm64、glibc）に入れる。
#   curl -fsSL https://github.com/gaku1023/agent-hangar/releases/latest/download/install.sh | sh
# Node は tar に同梱されているので、別に入れる必要はない。
# 環境変数（どれも省略できる）:
#   HANGAR_VERSION   入れる版のタグ（例 v0.24.0）。省略すると最新の正式な版
#   HANGAR_PREFIX    展開先（既定は ~/.local/share/agent-hangar）
#   HANGAR_BIN       hangar コマンドを置く場所（既定は ~/.local/bin）
#   HANGAR_NO_SERVICE=1  常駐（systemd のユニット）まで入れない
#   HANGAR_TARBALL   手元の tar を使う（同じ場所の .sha256 で確かめる。ネットに出ない）
# HANGAR_INSTALL_OS、HANGAR_INSTALL_ARCH、HANGAR_INSTALL_UID、HANGAR_DRY_RUN は試験用の上書きである。
set -eu

repo="${HANGAR_REPO:-gaku1023/agent-hangar}"
os="${HANGAR_INSTALL_OS:-$(uname -s)}"
machine="${HANGAR_INSTALL_ARCH:-$(uname -m)}"
uid="${HANGAR_INSTALL_UID:-$(id -u)}"
prefix="${HANGAR_PREFIX:-$HOME/.local/share/agent-hangar}"
bindir="${HANGAR_BIN:-$HOME/.local/bin}"

die() { echo "$*" >&2; exit 1; }

[ "$os" = "Linux" ] || die "install.sh は Linux だけで使えます（この機械は $os です）。macOS と Windows はアプリのインストーラを使ってください。"

if [ "$uid" = "0" ]; then
  die "root では入れられません。Claude Code は root では全許可のモードを断るため、hangar も非 root のユーザーで動かします。
ユーザーを作って、そのユーザーで入れ直してください。
  useradd -m hangar
  su - hangar"
fi

case "$machine" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "この CPU（${machine}）には対応していません。対応するのは x64 と arm64 です。" ;;
esac

# musl（Alpine など）の Node-API のネイティブは同梱していない。
if [ -z "${HANGAR_INSTALL_ARCH:-}" ] && command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
  die "musl（Alpine など）には対応していません。glibc の Linux（Debian、Ubuntu など）で入れてください。"
fi

tag="${HANGAR_VERSION:-}"
if [ -n "${HANGAR_TARBALL:-}" ]; then
  tarball="$HANGAR_TARBALL"
  sha_file="$tarball.sha256"
else
  if [ -n "$tag" ]; then
    base="https://github.com/$repo/releases/download/$tag"
  else
    base="https://github.com/$repo/releases/latest/download"
  fi
  # タグを省くと最新の資産の名前が決まらないので、タグが無いときは最新の版を引く。
  if [ -z "$tag" ]; then
    tag="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest" | sed 's#.*/tag/##')"
    [ -n "$tag" ] || die "最新の版を調べられませんでした。HANGAR_VERSION=v... を指定してください。"
    base="https://github.com/$repo/releases/download/$tag"
  fi
  name="Hangar-$tag-linux-$arch.tar.gz"
  if [ -n "${HANGAR_DRY_RUN:-}" ]; then
    echo "$base/$name"
    exit 0
  fi
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  echo "$name を取得します。"
  curl -fSL --progress-bar -o "$work/$name" "$base/$name"
  curl -fsSL -o "$work/$name.sha256" "$base/$name.sha256"
  tarball="$work/$name"
  sha_file="$work/$name.sha256"
fi

[ -f "$tarball" ] || die "tar が見つかりません: $tarball"
[ -f "$sha_file" ] || die "checksum のファイルが見つかりません: $sha_file"

# ファイルの名前は、手元の tar でも取得したものでも、sha256 の行に書かれた名前に合わせて確かめる。
expected="$(cut -d' ' -f1 "$sha_file")"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tarball" | cut -d' ' -f1)"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tarball" | cut -d' ' -f1)"
else
  die "sha256sum か shasum が必要です。"
fi
[ "$expected" = "$actual" ] || die "checksum が合いません（${tarball}）。壊れているか、書き換えられています。何も入れていません。"

# 版は tar の中の VERSION から読む（手元の tar でも正しい名前で置く）。
extract="$(mktemp -d)"
trap 'rm -rf "$extract" "${work:-}"' EXIT
tar -xzf "$tarball" -C "$extract"
[ -f "$extract/hangar/VERSION" ] || die "tar の形が違います（VERSION がありません）。"
version="$(cat "$extract/hangar/VERSION")"

mkdir -p "$prefix/versions" "$bindir"
dest="$prefix/versions/$version"
rm -rf "$dest.new"
mv "$extract/hangar" "$dest.new"
rm -rf "$dest"
mv "$dest.new" "$dest"

# current を切り替える（rename で 1 手にして、途中の状態を作らない）。
ln -sfn "versions/$version" "$prefix/current.new"
mv -T "$prefix/current.new" "$prefix/current" 2>/dev/null || { rm -f "$prefix/current"; mv "$prefix/current.new" "$prefix/current"; }
ln -sfn "$prefix/current/bin/hangar" "$bindir/hangar"

echo "agent-hangar $version を $prefix に入れました。"

case ":$PATH:" in
  *":$bindir:"*) ;;
  *) echo "PATH に $bindir がありません。次を ~/.profile などに足してください:  export PATH=\"$bindir:\$PATH\"" ;;
esac

if [ -n "${HANGAR_NO_SERVICE:-}" ]; then
  echo "常駐は入れていません。入れるには: hangar service install"
elif command -v systemctl >/dev/null 2>&1; then
  "$bindir/hangar" service install || echo "常駐は入れられませんでした。あとで hangar service install を実行してください。"
else
  echo "systemd が無いので、常駐は入れていません。hangar start で起こせます。"
fi
