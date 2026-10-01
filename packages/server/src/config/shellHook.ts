import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { statuslineHeaderPath } from './statusline.ts';

/** ~/.zshrc に足す行の目印。外すときはこの目印の付いた行だけを消す。 */
export const SHELL_MARKER = '# agent-hangar';

/** 書き出したファイルにポートが無いときに使うポート。サーバの既定と同じ。 */
export const DEFAULT_SHELL_PORT = 4177;

/** 包み方の本体の置き場。hangar が起動のたびに書き直す。 */
export function shellScriptPath(home: string): string {
  return path.join(home, 'shell', 'claude.zsh');
}

/** 利用者の ~/.zshrc。ZDOTDIR を立てている人はそちらを読む。 */
export function zshrcPath(env: NodeJS.ProcessEnv = process.env, homedir: string = os.homedir()): string {
  return path.join(env.ZDOTDIR && env.ZDOTDIR !== '' ? env.ZDOTDIR : homedir, '.zshrc');
}

/**
 * ~/.zshrc に足す 1 行。
 * 本体のファイルが無ければ何もしない形にする。hangar を消した後でも、新しいターミナルがエラーを出さないようにするため。
 * ホームの下なら $HOME からの相対で書く。同期で設定を写した先の PC でも、同じ行がそのまま通る。
 */
export function shellHookLine(home: string, homedir: string = os.homedir()): string {
  const file = shellScriptPath(home);
  const rel = path.relative(homedir, file);
  const p = !rel.startsWith('..') && !path.isAbsolute(rel) ? `"$HOME/${rel}"` : JSON.stringify(file);
  return `[ -f ${p} ] && source ${p}  ${SHELL_MARKER}`;
}

/**
 * 包み方の本体。
 * ターミナルで対話として起動した claude を、Claude のバックグラウンドのサービスで起こし、すぐこのターミナルにつなぐ。
 * そうしておくと、hangar からも同じセッションを開ける。
 * 抜けたときは、hangar が同じセッションを開いていなければ止める。作業中と、許可や質問への答えを待っているときは尋ねる。
 * 何もしないと、抜けても claude はバックグラウンドで動き続け、終えたつもりのセッションが残る。
 * 包めないとき（古い Claude Code、管理設定で切られている、信頼していないフォルダ）は、素の claude を起動する。
 * 本文のある会話を抜けたときは、セッションの状態（Done か明日の Paused）を 1 打鍵で聞き、hangar へ送る。
 * 送り先のポートと鍵のヘッダのファイルは、書き出すときに埋め込む。
 */
export function shellScript(o: { port: number; headerFile: string }): string {
  return `# agent-hangar が置くファイルです。hangar が起動のたびに書き直すので、手で直しても戻ります。
# ターミナルで起動した claude を Claude のバックグラウンドのサービスで起こし、すぐこのターミナルにつなぎます。
# そうしておくと、hangar からも同じセッションを開けます。
# 抜けたとき、hangar で開いていないセッションは止めます。作業中か答えを待っているときは、止めるかを尋ねます。
# 1 回だけ包まずに起動するときは \`command claude\`、ずっとやめるときは \`hangar shell uninstall\` です。
# 本文のある会話を抜けたときは、そのセッションを Done にするか明日の Paused にするかを 1 打鍵で聞きます。

# 状態を送る hangar のポートと、curl に読ませる鍵のヘッダのファイル。hangar が書き出すときに埋め込む。
__agent_hangar_port=${o.port}
__agent_hangar_header=${zshQuote(o.headerFile)}

# 動いているセッションの一覧から、その会話の kind と短い id を拾う。見つからなければ何も出さない。
__agent_hangar_job() {
  command claude agents --json 2>/dev/null | awk -v want="$1" '
    /"id":/ { j = $2; gsub(/[",]/, "", j) }
    /"kind":/ { k = $2; gsub(/[",]/, "", k) }
    /"sessionId":/ { s = $2; gsub(/[",]/, "", s) }
    /^  }/ { if (s == want) { print k " " j; exit } j = ""; k = ""; s = "" }'
}

# 動いているセッションの一覧から、その短い id の state、status、会話の id を拾う。
# 止まっている（pid が無い）ものは、state の代わりに stopped と出す。/exit で抜けたときはこの形になる。一覧に無ければ何も出さない。
__agent_hangar_state() {
  command claude agents --json 2>/dev/null | awk -v want="$1" '
    /^    "pid":/ { p = 1 }
    /^    "id":/ { j = $2; gsub(/[",]/, "", j) }
    /^    "sessionId":/ { s = $2; gsub(/[",]/, "", s) }
    /^    "status":/ { u = $2; gsub(/[",]/, "", u) }
    /^    "state":/ { t = $2; gsub(/[",]/, "", t) }
    /^  }/ { if (j == want) { print (p ? t : "stopped") " " (u == "" ? "-" : u) " " s; exit } p = 0; j = ""; s = ""; u = ""; t = "" }'
}

# 抜けた会話の状態を 1 打鍵で聞き、hangar へ送る。引数は Claude 側のセッション ID。
# 鍵のヘッダが無い、hangar が 1 秒で返らない、索引にまだ無い、状態がもう付いている、のどれかなら聞かない。
# 送れなかったときは 1 行だけ知らせる。後始末はこの関数の外で続く。
__agent_hangar_ask_status() {
  local url="http://127.0.0.1:$__agent_hangar_port/api/sessions/by-provider/$1" res key body day note
  [[ -r "$__agent_hangar_header" ]] || return 0
  # 1 行目が ask か skip、2 行目が頭に出す提案、3 行目が Paused の理由の下書き。
  res=$(command curl -sf -m 1 -H @"$__agent_hangar_header" "$url/exit-prompt" 2>/dev/null) || return 0
  local -a l
  l=("\${(@f)res}")
  [[ "$l[1]" == ask ]] || return 0
  [[ -n "$l[2]" ]] && print -r -- "$l[2]"
  read -k 1 "key?このセッションをどうしますか？ [d] Done  [p] 明日の Paused  [Enter] そのまま "
  print
  case "$key" in
    d|D) body='{"status":"done"}' ;;
    p|P)
      # 明日は手元の暦で数える。macOS の date に無ければ GNU の書き方を試す。
      day=$(command date -v+1d +%F 2>/dev/null || command date -d tomorrow +%F 2>/dev/null)
      [[ "$day" =~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' ]] || { print -r -- "明日の日付を作れませんでした。hangar から付けてください。"; return 0; }
      # 理由は JSON の文字列に入れる。サーバが改行と制御文字を除いて渡すので、逃がすのは \\ と " だけでよい。
      note=\${l[3]//\\\\/\\\\\\\\}
      note=\${note//\\"/\\\\\\"}
      body="{\\"status\\":\\"paused\\",\\"returnOn\\":\\"$day\\",\\"note\\":\\"$note\\"}" ;;
    *) return 0 ;;
  esac
  if print -r -- "$body" | command curl -sf -m 2 -X POST -H 'Content-Type: application/json' -H @"$__agent_hangar_header" --data-binary @- "$url/state" >/dev/null 2>&1; then
    [[ -n "$day" ]] && print -r -- "$day に戻る Paused にしました。" || print -r -- "Done にしました。"
  else
    print -r -- "hangar に届きませんでした。状態は hangar の画面から付けられます。"
  fi
}

# attach から抜けたときの後始末。hangar が同じセッションを開いていれば残す。ほかのターミナルでつないでいるかは見ない。
# 答え終えて次の指示を待っていれば止め、作業中と、許可や質問への答えを待っているときは尋ねる。
# 止めても会話は残り、claude attach <id> か hangar から続きを開ける。
__agent_hangar_leave() {
  local id="$1" st
  if pgrep -f "hangar-run\\.sh .* attach $id$" >/dev/null 2>&1; then return; fi
  st=$(__agent_hangar_state "$id")
  [[ -z "$st" ]] && return
  local -a f t
  f=(\${=st})
  # 本文があるかは、状態を聞くかどうかと、入力待ちのまま黙って止めるかどうかの両方に使う。
  t=("\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$f[3]".jsonl(N))
  # もう止まっている（/exit で抜けた）ときは、止めるかは聞かず、本文があれば状態だけを聞く。
  if [[ "$f[1]" == stopped ]]; then
    (( \${#t} )) && __agent_hangar_ask_status "$f[3]"
    return
  fi
  if [[ "$f[1]" == done && "$f[2]" != busy ]]; then
    command claude stop "$id" >/dev/null 2>&1 && print -r -- "hangar で開いていないので、このセッションを止めました。続きは claude attach $id か hangar から開けます。"
    (( \${#t} )) && __agent_hangar_ask_status "$f[3]"
    return
  fi
  # 何も打たずに抜けたセッションも入力待ちに見える。本文がまだ無ければ、黙って止める。
  if [[ "$f[1]" == blocked && "$f[2]" != busy && \${#t} -eq 0 ]]; then
    command claude stop "$id" >/dev/null 2>&1
    return
  fi
  local what="まだ作業中です"
  [[ "$f[1]" == blocked ]] && what="許可か答えを待っています"
  if read -q "?このセッションは\${what}。止めますか？ [y/N] "; then
    print
    command claude stop "$id" >/dev/null 2>&1 && print -r -- "止めました。続きは claude attach $id か hangar から開けます。"
  else
    print
    print -r -- "残しました。claude attach $id か hangar から開けます。止めるときは claude stop $id です。"
  fi
  (( \${#t} )) && __agent_hangar_ask_status "$f[3]"
}

claude() {
  # 端末でないとき（パイプやスクリプトの中）と、HANGAR_NO_WRAP を立てたときは包まない。
  if [[ ! -t 0 || ! -t 1 || -n "$HANGAR_NO_WRAP" ]]; then command claude "$@"; return; fi
  # サブコマンドはそのまま渡す。
  case "$1" in
    agents|attach|auth|auto-mode|daemon|doctor|gateway|import|install|kill|logs|mcp|plugin|plugins|project|respawn|rm|setup-token|stop|ultrareview|update|upgrade) command claude "$@"; return ;;
  esac
  local a resume="" want=0
  for a in "$@"; do
    if (( want )); then resume="$a"; want=0; continue; fi
    case "$a" in
      # 対話でない起動、自分でバックグラウンドを選んだ起動、包むと意味が変わる起動はそのまま渡す。
      # -c は --bg と組むと写しを作り、同じ会話を続けない。
      -p|--print|-h|--help|-v|--version|--bg|--background|-c|--continue|--cloud|--cloud=*|--fork-session|--teleport|--teleport=*|--from-pr|--from-pr=*|--remote-control|--rc) command claude "$@"; return ;;
      -r|--resume) want=1; resume="-" ;;
      --resume=*) resume="\${a#--resume=}" ;;
    esac
  done
  if [[ -n "$resume" ]]; then
    # id を付けない -r と、検索の語を付けた -r は選ぶ画面を出すので、そのまま渡す。
    if [[ ! "$resume" =~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ]]; then command claude "$@"; return; fi
    local job
    job=$(__agent_hangar_job "$resume")
    # もうバックグラウンドで動いているなら、つなぐだけにする。--bg --resume は写しを作ってしまう。
    if [[ "\${job%% *}" == background ]]; then
      local rc
      command claude attach "\${job#* }"; rc=$?
      __agent_hangar_leave "\${job#* }"
      return $rc
    fi
    # 別のターミナルで動いている対話の claude は、素の claude に任せる（二重に開かないよう Claude が断る）。
    if [[ "\${job%% *}" == interactive ]]; then command claude "$@"; return; fi
  fi
  local out id
  if ! out=$(command claude --bg "$@" 2>&1); then
    # 信頼していないフォルダ、古い Claude Code、管理設定で切られているとき。素の claude なら信頼の確認も出る。
    command claude "$@"
    return
  fi
  id=$(print -r -- "$out" | sed -n 's/^backgrounded · \\([0-9a-f][0-9a-f]*\\).*/\\1/p' | head -n 1)
  if [[ -z "$id" ]]; then print -r -- "$out" >&2; return 1; fi
  # 写しを作ったときなどの知らせは見せる。
  print -r -- "$out" | grep '^note:' >&2
  local rc
  command claude attach "$id"; rc=$?
  __agent_hangar_leave "$id"
  return $rc
}
`;
}

/** zsh の単一引用符で包む。中の ' は '\'' で閉じて開き直す。 */
function zshQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** 書き出したファイルに埋め込んだポート。ファイルが無いか読めなければ null。 */
export function embeddedShellPort(file: string): number | null {
  const m = /^__agent_hangar_port=(\d+)$/m.exec(readText(file) ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * <home>/shell/claude.zsh を置く。中身が同じなら書かない。
 * ポートはサーバが待ち受けているものを渡す。
 * 渡さないとき（hangar shell install）は、前に書き出したポートを引き継ぎ、無ければ 4177 にする。
 * CLI が 4177 で上書きすると、別のポートで動くサーバへ次の起動まで届かなくなるためである。
 */
export function ensureShellScript(home: string, port?: number): string {
  const file = shellScriptPath(home);
  const body = shellScript({ port: port ?? embeddedShellPort(file) ?? DEFAULT_SHELL_PORT, headerFile: statuslineHeaderPath(home) });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) fs.writeFileSync(file, body, { mode: 0o644 });
  return file;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * この PC の包み方の状態。同期で他の PC にも見せる。
 * on は ~/.zshrc に行があり、Claude Code がバックグラウンドを使えること。
 * unsupported は Claude Code がバックグラウンドを使えないこと（古い版、管理設定で切られている、claude が見つからない）。
 */
export type ShellHookState = 'on' | 'off' | 'unsupported';

/**
 * Claude Code がバックグラウンドを使えるか。`claude agents --json` が通るかで見る。
 * 管理設定で切られていると、この呼び出しは「disabled」と言って 1 で終わる。
 */
export function claudeSupportsBackground(claudeBin: string | null): boolean {
  if (!claudeBin) return false;
  const r = spawnSync(claudeBin, ['agents', '--json'], { stdio: 'ignore', timeout: 5000 });
  return r.status === 0;
}

export function shellHookState(zshrc: string, supported: boolean): ShellHookState {
  if (!supported) return 'unsupported';
  return shellHookInstalled(zshrc) ? 'on' : 'off';
}

/**
 * Settings に出す、入れるためのコマンド。
 * hangar に PATH が通っていなくても貼るだけで動くよう、アプリに同梱された hangar は絶対パスで書く。
 * 同梱物が無い（リポジトリから動かしている）ときは、リポジトリの中での呼び方にする。
 */
export function shellInstallCommand(o: { hangarOnPath: string | null; bundledHangar: string | null }): string {
  // npm から起こしたサーバの PATH には node_modules/.bin が入る。そこの hangar は利用者のターミナルからは引けない。
  if (o.hangarOnPath && !o.hangarOnPath.includes('/node_modules/.bin/')) return 'hangar shell install';
  if (o.bundledHangar) return `${o.bundledHangar.includes(' ') ? JSON.stringify(o.bundledHangar) : o.bundledHangar} shell install`;
  return 'npm run hangar -- shell install';
}

/** ~/.zshrc に目印の行があるか。 */
export function shellHookInstalled(zshrc: string): boolean {
  return (readText(zshrc) ?? '').split('\n').some((l) => l.includes(SHELL_MARKER));
}

/** ~/.zshrc に、目印の行が今の形でちょうど 1 行あるか。 */
export function shellHookUpToDate(zshrc: string, line: string): boolean {
  const marked = (readText(zshrc) ?? '').split('\n').filter((l) => l.includes(SHELL_MARKER));
  return marked.length === 1 && marked[0] === line;
}

const stamp = (d: Date) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

/**
 * ~/.zshrc の末尾に 1 行を足す。書き換える前に同じディレクトリへ控えを取る。
 * もう目印の行があれば、その行を今の形に置き換える（置き場を変えたときに古い行を残さない）。
 */
export function installShellHook(zshrc: string, line: string, now: Date = new Date()): { changed: boolean; backup: string | null } {
  const cur = readText(zshrc);
  const lines = cur === null ? [] : cur.split('\n');
  if (shellHookUpToDate(zshrc, line)) return { changed: false, backup: null };
  const kept = lines.filter((l) => !l.includes(SHELL_MARKER));
  const backup = cur === null ? null : `${zshrc}.bak-${stamp(now)}`;
  if (backup) fs.copyFileSync(zshrc, backup);
  const body = kept.join('\n').replace(/\n*$/, '');
  fs.writeFileSync(zshrc, `${body === '' ? '' : `${body}\n`}${line}\n`);
  return { changed: true, backup };
}

/** 目印の付いた行だけを消す。控えを取ってから書く。 */
export function uninstallShellHook(zshrc: string, now: Date = new Date()): { changed: boolean; backup: string | null } {
  const cur = readText(zshrc);
  if (cur === null) return { changed: false, backup: null };
  const lines = cur.split('\n');
  const kept = lines.filter((l) => !l.includes(SHELL_MARKER));
  if (kept.length === lines.length) return { changed: false, backup: null };
  const backup = `${zshrc}.bak-${stamp(now)}`;
  fs.copyFileSync(zshrc, backup);
  fs.writeFileSync(zshrc, kept.join('\n'));
  return { changed: true, backup };
}
