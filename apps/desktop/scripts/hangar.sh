#!/bin/sh
# agent-hangar の CLI を、配布版の .app に同梱したバンドルから起動する。
# Node は PATH に頼らず、HANGAR_NODE、settings.json の nodePath のあと、アプリ本体と同じ場所（下の node-places の印の間）を同じ順で探し、
# manifest.json と同じメジャー版とアーキテクチャのものだけを使う。
# 候補は空白区切りの一本の文字列ではなく、改行区切りで持ち回る。
# 一本の文字列にすると、空白を含むパス（利用者名の入ったホームや Application Support の下）で語分割され、
# settings.json の nodePath による指定がそのまま効かなくなる。
set -e
# $0 が symlink のときは実体まで辿る。
# README が案内する /usr/local/bin/hangar はリンクなので、辿らないと dist が /usr/local になり、
# manifest.json もバンドルも見失う。
# readlink -f は環境によって挙動が違うので使わず、一段ずつ辿る。
# 相対のリンク先は、そのリンクが置かれている場所からの相対として解く。
self="$0"
hops=0
while [ -L "$self" ]; do
  hops=$((hops + 1))
  if [ "$hops" -gt 40 ]; then
    echo "$0 の symlink が輪になっています。リンクを張り直してください。" >&2
    exit 1
  fi
  target="$(readlink "$self")"
  case "$target" in
    /*) self="$target" ;;
    *) self="$(cd "$(dirname "$self")" && pwd)/$target" ;;
  esac
done
here="$(cd "$(dirname "$self")" && pwd)"
dist="$(cd "$here/.." && pwd)"
if [ ! -f "$dist/manifest.json" ]; then
  echo "$dist/manifest.json がありません。アプリの中身が壊れています。agent-hangar を入れ直してください。" >&2
  exit 1
fi
want="$(sed -n 's/.*"nodeMajor": *\([0-9]*\).*/\1/p' "$dist/manifest.json")"
want_arch="$(sed -n 's/.*"arch": *"\([^"]*\)".*/\1/p' "$dist/manifest.json")"
# 読めないまま先へ進むと、空の版と突き合わせて全部の候補を外し、
# 「Node  が見つかりません」という意味を成さない案内で終わる。
if [ -z "$want" ] || [ -z "$want_arch" ]; then
  echo "$dist/manifest.json から Node の版とアーキテクチャを読めません。アプリの中身が壊れています。agent-hangar を入れ直してください。" >&2
  exit 1
fi
home="${HANGAR_HOME:-$HOME/.agent-hangar}"
custom=""
[ -f "$home/settings.json" ] && custom="$(sed -n 's/.*"nodePath": *"\([^"]*\)".*/\1/p' "$home/settings.json")"
# 版ごとのディレクトリの下の node を、新しい版から並べる。
# $1 は版のディレクトリを並べた親、$2 は版のディレクトリから node までの相対。
# 版と読むのは node@<数>（Homebrew の keg）と v<数>.<数>.<数>、<数>.<数>.<数> だけで、殻（node.rs の parse_dir_version）と同じ。
# mise の別名（22、lts）は実体の版と重なるので見ない。
# 文字列として並べると v22.9.0 が v22.10.0 より前に来るので、-V で版として並べる。
# 名前は展開だけで切り出す。/opt/homebrew/opt には keg が数百並ぶので、1 つごとに外のコマンドを起こさない。
versions() {
  for d in "$1"/*/; do
    [ -d "$d" ] || continue
    d="${d%/}"
    printf '%s\n' "${d##*/}"
  done | grep -E '^(node@[0-9]+|v?[0-9]+\.[0-9]+\.[0-9]+)$' | sort -rV | while IFS= read -r v; do
    if [ -f "$1/$v/$2" ]; then
      printf '%s\n' "$1/$v/$2"
    fi
  done
}
candidates="$(
  printf '%s\n' "${HANGAR_NODE:-}" "$custom"
  # node-places: begin
  # この印の間は、殻（src-tauri の node.rs の UNIX_NODE_PLACES）と同じ並びにする。
  # 並びの一致は、node.rs の試験がこの間の行を読んで縛る。
  # Homebrew の node@22 は keg-only で /opt/homebrew/bin にリンクされないので、keg の場所（opt/node@N）も見る。
  # 版の管理ツールは、PATH を切り替える仕掛けではなく、版ごとの実体の場所を見る。
  printf '%s\n' /opt/homebrew/bin/node
  printf '%s\n' /usr/local/bin/node
  versions /opt/homebrew/opt bin/node
  versions /usr/local/opt bin/node
  versions "$HOME/.nvm/versions/node" bin/node
  versions "$HOME/Library/Application Support/fnm/node-versions" installation/bin/node
  versions "$HOME/.local/share/fnm/node-versions" installation/bin/node
  versions "$HOME/.fnm/node-versions" installation/bin/node
  versions "$HOME/.volta/tools/image/node" bin/node
  versions "$HOME/.local/share/mise/installs/node" bin/node
  versions "$HOME/.asdf/installs/nodejs" bin/node
  versions "$HOME/.nodenv/versions" bin/node
  # node-places: end
)"
# 見つからないときに、調べた場所とそれぞれが合わなかった理由を並べる（殻の describe_error と同じ形）。
tried=""
# 同じ場所は 1 度しか調べない。HANGAR_NODE や nodePath が探索先と重なることがあるためである。
seen="
"
while IFS= read -r n; do
  [ -n "$n" ] || continue
  case "$seen" in
    *"
$n
"*) continue ;;
  esac
  seen="${seen}${n}
"
  if [ ! -f "$n" ]; then
    tried="${tried}  ${n}: ありません
"
    continue
  fi
  if [ ! -x "$n" ]; then
    tried="${tried}  ${n}: 起動できません（実行権を確かめてください）
"
    continue
  fi
  # 版だけでなくアーキテクチャも見る。
  # 同梱したネイティブモジュールは ABI に縛られるので、版が合っても別のアーキでは読めない。
  # Rosetta の x64 Node が先に当たると、hangar コマンドだけが起動の途中で落ちる。
  # 前置きや後置きの行を出す候補（NODE_OPTIONS の警告、包みの script）があるので、1 行ずつ見る。
  # 求める答えがどこかの行にあれば、その候補を採る。
  # アプリ本体（node.rs の parse_probe）も全行から v<版> <アーキ> の行を探すので、扱いを揃えてある。
  probe="$("$n" -p 'process.versions.node.split(".")[0] + " " + process.arch' 2>/dev/null)" || probe=""
  if printf '%s\n' "$probe" | grep -qxF -- "$want $want_arch"; then
    # 同梱した UI の場所を、バンドルの中から渡す。
    # 単一ファイルにまとめた時点で、コードの置き場からの相対では探せなくなる。
    # hangar start が子として起こす server.mjs も、この値を継ぐ。
    export HANGAR_UI_DIST="$dist/ui"
    exec "$n" "$dist/cli.mjs" "$@"
  fi
  answer="$(printf '%s\n' "$probe" | grep -E '^[0-9]+ [a-z0-9]+$' | tail -n 1)" || answer=""
  if [ -n "$answer" ]; then
    tried="${tried}  ${n}: v${answer}（要る版は ${want} ${want_arch}）
"
  else
    tried="${tried}  ${n}: Node ではありません（別の実行ファイルのようです）
"
  fi
done <<CANDIDATES
$candidates
CANDIDATES
# 変数は波括弧で括る。
# bash 3.2 は UTF-8 のロケールのとき、$want の直後の「（」の先頭バイトを変数名の一部として食い、
# 版もアーキも消えた不正な UTF-8 を出す。
{
  echo "Node ${want}（${want_arch}）が見つかりません。"
  echo "brew install node@${want} で入れれば見つかります（nvm、fnm、Volta、mise、asdf、nodenv で入れた版も探します）。"
  echo "ほかの場所に入れたなら、環境変数 HANGAR_NODE か ${home}/settings.json の nodePath で場所を指定してください。"
  echo "調べた場所:"
  printf '%s' "$tried"
} >&2
exit 1
