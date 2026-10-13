#!/bin/sh
# agent-hangar の CLI を、配布版の .app に同梱したバンドルから起動する。
# Node は PATH に頼らず、HANGAR_NODE、settings.json の nodePath のあと、アプリ本体と同じ場所（下の node-places の印の間）を同じ順で探し、
# Node-API が manifest.json の nodeApi 以上で、アーキテクチャが同じものを使う（規則は packages/server/src/config/nodeRule.ts）。
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
want_api="$(sed -n 's/.*"nodeApi": *\([0-9][0-9]*\).*/\1/p' "$dist/manifest.json")"
want_min="$(sed -n 's/.*"nodeMin": *"\([0-9.]*\)".*/\1/p' "$dist/manifest.json")"
want_arch="$(sed -n 's/.*"arch": *"\([^"]*\)".*/\1/p' "$dist/manifest.json")"
# 案内で入れる Node のメジャー版（brew install node@22）。nodeMin の先頭の数である。
lts="${want_min%%.*}"
# 読めないまま先へ進むと、空の版と突き合わせて全部の候補を外し、
# 「Node  が見つかりません」という意味を成さない案内で終わる。
if [ -z "$want_api" ] || [ -z "$want_min" ] || [ -z "$want_arch" ]; then
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
  # Homebrew の node@22 は、今の Homebrew では /opt/homebrew/bin にもリンクされるが、前の版では keg-only でリンクされなかった。
  # どちらの場合も拾えるよう、bin/node に加えて keg の場所（opt/node@N）も見る。
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
  # HANGAR_NODE と nodePath は、node の実行ファイルの絶対パスだけを受ける。アプリ本体（node.rs）も同じ。
  # 名前や相対のパスは、打った場所や PATH で指す先が変わり、アプリと hangar コマンドで使う Node が食い違う。
  case "$n" in
    /*) ;;
    *)
      tried="${tried}  ${n}: 絶対パスではありません（node の実行ファイルのフルパスを指定してください）
"
      continue
      ;;
  esac
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
  # Node-API の版だけでなくアーキテクチャも見る。
  # 同梱したネイティブモジュールは Node-API で作られていて、Node-API が足りても別のアーキでは読めない。
  # Rosetta の x64 Node が先に当たると、hangar コマンドだけが起動の途中で落ちる。
  # 訊く式と読み方はアプリ本体（node.rs）と同じで、出力は v<版> <アーキ> <Node-API の版> の 1 行である。
  # 前置きや後置きの行を出す候補（NODE_OPTIONS の警告、包みの script）があるので、その形の最後の行を読む（node.rs の parse_probe と同じ）。
  probe="$("$n" -p 'process.version+" "+process.arch+" "+(process.versions.napi||0)' 2>/dev/null)" || probe=""
  answer="$(printf '%s\n' "$probe" | tr -d '\r' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+ [a-z0-9]+ [0-9]+$' | tail -n 1)" || answer=""
  if [ -z "$answer" ]; then
    tried="${tried}  ${n}: Node ではありません（別の実行ファイルのようです）
"
    continue
  fi
  a_ver="${answer%% *}"
  a_rest="${answer#* }"
  a_arch="${a_rest%% *}"
  a_api="${a_rest#* }"
  # 上限は付けない。Node-API が要る版以上で、アーキが同じなら採る。両方が合わなければ版を言う（node.rs の fit と同じ順）。
  if [ "$a_api" -lt "$want_api" ]; then
    tried="${tried}  ${n}: ${a_ver} ${a_arch}（Node-API ${a_api}。Node ${want_min} 以上が要ります）
"
    continue
  fi
  if [ "$a_arch" != "$want_arch" ]; then
    tried="${tried}  ${n}: ${a_ver} ${a_arch}（${want_arch} 用が要ります）
"
    continue
  fi
  # 同梱した UI の場所を、バンドルの中から渡す。
  # 単一ファイルにまとめた時点で、コードの置き場からの相対では探せなくなる。
  # hangar start が子として起こす server.mjs も、この値を継ぐ。
  export HANGAR_UI_DIST="$dist/ui"
  exec "$n" "$dist/cli.mjs" "$@"
done <<CANDIDATES
$candidates
CANDIDATES
# 変数は波括弧で括る。
# bash 3.2 は UTF-8 のロケールのとき、$want_min の直後の「（」の先頭バイトを変数名の一部として食い、
# 版もアーキも消えた不正な UTF-8 を出す。
{
  echo "Node ${want_min} 以上（${want_arch}）が見つかりません。"
  echo "Hangar のデータベースと端末の部品は Node-API ${want_api} を使うため、Node ${want_min} 以上が要ります。"
  echo "今の Node を置き換えずに入れるなら、brew install node@${lts}（既定の node を置き換えません）か nvm install ${lts} で入れれば見つかります（fnm、Volta、mise、asdf、nodenv で入れた版も探します）。"
  echo "ほかの場所に入れたなら、環境変数 HANGAR_NODE か ${home}/settings.json の nodePath で場所を指定してください。"
  echo "調べた場所:"
  printf '%s' "$tried"
} >&2
exit 1
