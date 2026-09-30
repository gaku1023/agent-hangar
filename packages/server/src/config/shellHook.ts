import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** ~/.zshrc に足す行の目印。外すときはこの目印の付いた行だけを消す。 */
export const SHELL_MARKER = '# agent-hangar';

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
 * 包めないとき（古い Claude Code、管理設定で切られている、信頼していないフォルダ）は、素の claude を起動する。
 */
export function shellScript(): string {
  return `# agent-hangar が置くファイルです。hangar が起動のたびに書き直すので、手で直しても戻ります。
# ターミナルで起動した claude を Claude のバックグラウンドのサービスで起こし、すぐこのターミナルにつなぎます。
# そうしておくと、hangar からも同じセッションを開けます。
# 1 回だけ包まずに起動するときは \`command claude\`、ずっとやめるときは \`hangar shell uninstall\` です。

# 動いているセッションの一覧から、その会話の kind と短い id を拾う。見つからなければ何も出さない。
__agent_hangar_job() {
  command claude agents --json 2>/dev/null | awk -v want="$1" '
    /"id":/ { j = $2; gsub(/[",]/, "", j) }
    /"kind":/ { k = $2; gsub(/[",]/, "", k) }
    /"sessionId":/ { s = $2; gsub(/[",]/, "", s) }
    /^  }/ { if (s == want) { print k " " j; exit } j = ""; k = ""; s = "" }'
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
    if [[ "\${job%% *}" == background ]]; then command claude attach "\${job#* }"; return; fi
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
  command claude attach "$id"
}
`;
}

/** <home>/shell/claude.zsh を置く。中身が同じなら書かない。 */
export function ensureShellScript(home: string): string {
  const file = shellScriptPath(home);
  const body = shellScript();
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
