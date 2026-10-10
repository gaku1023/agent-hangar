import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_SUBCOMMANDS, SUBCOMMAND_NAME } from '../provider/claude-code/compat/cli.ts';

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

/** 包み方の本体に埋め込む値。hangar が起動のたびと、tmux のパスが変わったときに書き直す。 */
export type ShellScriptOptions = {
  /** hangar の API の根。例：http://127.0.0.1:4177 */
  url: string;
  /** API のトークンを置いたファイル。トークンそのものは本体に書かず、呼ぶたびに読む。 */
  tokenFile: string;
  /** hangar が使う tmux。無ければ包まない。 */
  tmuxPath: string | null;
  /** 包まずにそのまま渡すサブコマンド。サーバが起動のたびに claude --help から作る。渡さなければ組み込みの一覧。 */
  subcommands?: readonly string[];
};

/** zsh の単一引用符で囲む。中の ' は閉じて \' を挟んで開き直す。 */
const zshQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * case に書くサブコマンドの並び。名前の形（SUBCOMMAND_NAME）に合わないものは書かない。シェルの文として読まれないようにするためである。
 * 1 つも残らなければ組み込みの一覧にする。
 */
function subcommandPattern(list: readonly string[] | undefined): string {
  const ok = (list ?? BUILTIN_SUBCOMMANDS).filter((s) => SUBCOMMAND_NAME.test(s));
  return (ok.length > 0 ? ok : BUILTIN_SUBCOMMANDS).join('|');
}

/**
 * 包み方の本体。
 * ターミナルで対話として起動した claude を、hangar に頼んで hangar の tmux の中で起こし、すぐこのターミナルからつなぐ。
 * hangar の画面から起こした run と同じものになるので、hangar からも同じ tmux を開ける。
 * Claude のバックグラウンドのサービスには移さない。バックグラウンドのセッションは、利用上限の後に自動で続かないからである。
 * hangar がつながらないか断ったとき、tmux が無いとき、包むと意味が変わる起動は、素の claude を起動する。
 */
export function shellScript(o: ShellScriptOptions): string {
  return `# agent-hangar が置くファイルです。hangar が起動のたびに書き直すので、手で直しても戻ります。
# ターミナルで起動した claude を、hangar の tmux の中で起こし、すぐこのターミナルからつなぎます。
# そうしておくと、hangar からも同じセッションを開けます。利用上限に当たっても、上限が戻れば Claude Code が自分で続けます。
# 抜けるときは claude を終えるか、Ctrl+B の後に D で tmux から切り離します。切り離したものは hangar から開けます。
# 1 回だけ包まずに起動するときは \`command claude\`、ずっとやめるときは \`hangar shell uninstall\` です。

__agent_hangar_url=${zshQuote(o.url)}
__agent_hangar_token_file=${zshQuote(o.tokenFile)}
__agent_hangar_tmux=${zshQuote(o.tmuxPath ?? '')}

# 標準入力を、改行の無い base64 にする。
__agent_hangar_b64() { command base64 | command tr -d '\\n'; }

# hangar に起動を頼み、つなぐ tmux のセッション名を出す。頼めなければ 1 で終わる。
# 作業ディレクトリ（シンボリックリンクを解いたもの。claude が記録するのと同じ）、引数、環境変数は base64 にして送る。引数と環境変数は NUL で区切る（環境変数は env -0 の出力のまま）。
# 断られたときは理由を 1 行見せる。つながらないときは黙る。
__agent_hangar_launch() {
  local tok out cwd args env why name
  [[ -r $__agent_hangar_token_file ]] || return 1
  tok=$(<$__agent_hangar_token_file)
  cwd=$(print -rn -- "\${PWD:A}" | __agent_hangar_b64)
  args=$( (( $# )) && print -rn -- "\${(pj:\\0:)@}" | __agent_hangar_b64)
  env=$(command env -0 | __agent_hangar_b64)
  out=$(print -rn -- "{\\"cwd\\":\\"$cwd\\",\\"args\\":\\"$args\\",\\"env\\":\\"$env\\"}" | command curl -sS --fail-with-body --max-time 10 -H "Authorization: Bearer $tok" -H 'content-type: application/json' --data-binary @- "$__agent_hangar_url/api/runs/terminal" 2>/dev/null)
  if (( $? )); then
    why=\${\${out#*\\"error\\":\\"}%%\\"*}
    [[ -n $out && $why != $out ]] && print -r -- "hangar では開けないので、素の claude で起動します（$why）" >&2
    return 1
  fi
  name=\${\${out#*\\"tmuxName\\":\\"}%%\\"*}
  [[ $name =~ '^hangar-[0-9a-f]+$' ]] || return 1
  print -r -- $name
}

claude() {
  # 端末でないとき（パイプやスクリプトの中）、HANGAR_NO_WRAP を立てたとき、tmux が無いときは包まない。
  if [[ ! -t 0 || ! -t 1 || -n "$HANGAR_NO_WRAP" || ! -x "$__agent_hangar_tmux" ]]; then command claude "$@"; return; fi
  # サブコマンドはそのまま渡す。一覧は hangar が起動のたびに claude --help から作る。
  case "$1" in
    ${subcommandPattern(o.subcommands)}) command claude "$@"; return ;;
  esac
  local a resume="" want=0
  for a in "$@"; do
    if (( want )); then resume="$a"; want=0; continue; fi
    case "$a" in
      # ここから後ろは本文なので見ない。
      --) break ;;
      # 対話でない起動、自分でバックグラウンドを選んだ起動、包むと意味が変わる起動、hangar が組み立てる引数と重なる起動はそのまま渡す。
      -p|--print|-h|--help|-v|--version|--bg|--background|-c|--continue|--cloud|--cloud=*|--fork-session|--teleport|--teleport=*|--from-pr|--from-pr=*|--remote-control|--rc|--session-id|--session-id=*|--append-system-prompt|--append-system-prompt=*|--append-system-prompt-file|--append-system-prompt-file=*) command claude "$@"; return ;;
      -r|--resume) want=1; resume="-" ;;
      --resume=*) resume="\${a#--resume=}" ;;
    esac
  done
  # id を付けない -r と、検索の語を付けた -r は選ぶ画面を出すので、そのまま渡す。
  if [[ -n "$resume" && ! "$resume" =~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ]]; then command claude "$@"; return; fi
  # すでに tmux の中なら入れ子にしない。hangar の tmux サーバ（既定のソケット）の中なら switch-client で移り、ほかの tmux の中なら素の claude にする。
  local inside=0
  if [[ -n "$TMUX" ]]; then
    local mine="\${TMUX_TMPDIR:-/tmp}/tmux-$UID/default"
    if [[ "\${\${TMUX%%,*}:A}" == "\${mine:A}" ]]; then inside=1; else command claude "$@"; return; fi
  fi
  local name
  if ! name=$(__agent_hangar_launch "$@"); then command claude "$@"; return; fi
  if (( inside )); then command "$__agent_hangar_tmux" switch-client -t "=$name"; return; fi
  command "$__agent_hangar_tmux" attach -t "=$name"
}
`;
}

/** <home>/shell/claude.zsh を置く。中身が同じなら書かない。 */
export function ensureShellScript(home: string, o: ShellScriptOptions): string {
  const file = shellScriptPath(home);
  const body = shellScript(o);
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
 * on は ~/.zshrc に行があり、包めること。
 * unsupported は包めないこと（tmux が見つからない）。
 */
export type ShellHookState = 'on' | 'off' | 'unsupported';

/**
 * この PC で包めるか。包み方は hangar の tmux の中で claude を起こすので、tmux を実行できることが要る。
 * Claude のバックグラウンドのサービスは使わない。
 * Windows では包みを作らない（2026-10-10 の決定）。包みは zsh のもので、PowerShell の同じ形は壊れやすい。
 */
export function shellWrapSupported(tmuxPath: string | null, platform: NodeJS.Platform = process.platform): boolean {
  if (!shellWrapOsSupported(platform) || !tmuxPath) return false;
  try {
    fs.accessSync(tmuxPath, fs.constants.X_OK);
    return fs.statSync(tmuxPath).isFile();
  } catch {
    return false;
  }
}

/** この OS で包みを作るか。Windows では作らない。 */
export function shellWrapOsSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

export function shellHookState(zshrc: string, supported: boolean): ShellHookState {
  if (!supported) return 'unsupported';
  return shellHookInstalled(zshrc) ? 'on' : 'off';
}

/**
 * Settings に出す、入れるためのコマンド。
 * hangar に PATH が通っていなくても貼るだけで動くよう、アプリに同梱された hangar は絶対パスで書く。
 * 同梱物が無い（リポジトリから動かしている）ときは、リポジトリの中での呼び方にする。
 * Windows の同梱物は bin\hangar.cmd で、貼る先は PowerShell を前提にする。
 * 空白などを含むパスは、呼び出し演算子と単引用符で包む（`& 'C:\…\hangar.cmd'`）。二重引用符で包んだだけでは、PowerShell は文字列として読み、コマンドとして動かさない。
 */
export function shellInstallCommand(o: { hangarOnPath: string | null; bundledHangar: string | null; platform?: NodeJS.Platform }): string {
  const windows = (o.platform ?? process.platform) === 'win32';
  // npm から起こしたサーバの PATH には node_modules/.bin が入る。そこの hangar は利用者のターミナルからは引けない。
  if (o.hangarOnPath && !o.hangarOnPath.replaceAll('\\', '/').includes('/node_modules/.bin/')) return 'hangar shell install';
  if (o.bundledHangar) {
    const p = o.bundledHangar;
    // Windows は、英数字と \ : . _ - 以外の字（空白、単引用符、括弧など）を含めば包む。どれも PowerShell では意味を持つ。
    if (windows) return /^[A-Za-z0-9_.:\\-]+$/.test(p) ? `${p} shell install` : `& '${p.replaceAll("'", "''")}' shell install`;
    return p.includes(' ') ? `${JSON.stringify(p)} shell install` : `${p} shell install`;
  }
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
