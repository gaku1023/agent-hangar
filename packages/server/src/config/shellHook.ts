import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_SUBCOMMANDS, SUBCOMMAND_NAME } from '../provider/claude-code/compat/cli.ts';
import { BUILTIN_CODEX_SUBCOMMANDS, CODEX_INTERCEPT_FLAGS } from '../provider/codex/compat/cli.ts';
import { BUILTIN_OPENCODE_SUBCOMMANDS, BUILTIN_OPENCODE_VALUE_FLAGS, OPENCODE_INTERCEPT_FLAGS } from '../provider/opencode/compat/cli.ts';
import { HANGAR_SOCKET } from '../tmux/servers.ts';
import { readUtf8Text } from './textEncoding.ts';

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
  /** opencode の包み（ベータ、docs/design.md「外のターミナルの opencode」）。渡したときだけ opencode() を書く。設定で opencode とコマンドの横取りの両方を入れたときにサーバが渡す。 */
  opencode?: ShellOpencodeOptions | null;
  /** codex の包み（ベータ、docs/design.md「外のターミナルの codex」）。渡したときだけ codex() を書く。設定で Codex とコマンドの横取りの両方を入れたときにサーバが渡す。 */
  codex?: ShellCodexOptions | null;
};

/** codex の包みに埋め込む一覧。渡さなければ組み込みの一覧（provider/codex/compat/cli.ts）にする。 */
export type ShellCodexOptions = {
  /** 包まずにそのまま渡すサブコマンド。 */
  subcommands?: readonly string[];
};

/** opencode の包みに埋め込む一覧。どれも渡さなければ組み込みの一覧（provider/opencode/compat/cli.ts）にする。 */
export type ShellOpencodeOptions = {
  /** 包まずにそのまま渡すサブコマンド。 */
  subcommands?: readonly string[];
  /** 値を取るフラグ。横取りするフラグ（OPENCODE_INTERCEPT_FLAGS）のうち、ここにあるものは次の語を値として読む。 */
  valueFlags?: readonly string[];
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
 * opencode の包みの本体。許可リスト方式である（docs/design.md「外のターミナルの opencode」）。
 * hangar が写せる引数（--auto、--prompt、-s と --session、ディレクトリ 1 つ）だけなら包み、ほかのフラグやサブコマンドが 1 つでもあれば素の opencode を起動する。
 * Claude の包みは素通しの拒否リストだが、opencode は TUI へ渡せる引数が限られ、知らないフラグを hangar の組み立てに混ぜると起動が壊れるからである。
 * opencode の置き場や設定を環境変数で変えた起動も、hangar の管理に入れない。hangar は serve を自分の空の環境で起こし、ふだんの置き場と設定だけを使うからである。
 * alias で opencode を包んでいる人がいても読み込みで壊れないよう、関数は function の形で書く。
 */
function opencodeScript(o: ShellOpencodeOptions): string {
  const subs = (o.subcommands ?? BUILTIN_OPENCODE_SUBCOMMANDS).filter((x) => SUBCOMMAND_NAME.test(x));
  const values = new Set(o.valueFlags ?? BUILTIN_OPENCODE_VALUE_FLAGS);
  const withValue = OPENCODE_INTERCEPT_FLAGS.filter((f) => values.has(f));
  const longWithValue = withValue.filter((f) => f.startsWith('--'));
  const bare = OPENCODE_INTERCEPT_FLAGS.filter((f) => !values.has(f));
  const cases = [
    `      ${(subs.length > 0 ? subs : BUILTIN_OPENCODE_SUBCOMMANDS).join('|')}) command opencode "$@"; return ;;`,
    ...(withValue.length > 0 ? [`      ${withValue.join('|')}) want=$a ;;`] : []),
    ...(longWithValue.length > 0 ? [`      ${longWithValue.map((f) => `${f}=*`).join('|')}) [[ $a == --session=* ]] && sess=\${a#--session=} ;;`] : []),
    ...(bare.length > 0 ? [`      ${bare.join('|')}) ;;`] : []),
  ];
  return `
# opencode の置き場や設定を環境変数で変えているか。変えていれば hangar の管理に入れない。hangar の opencode は、ふだんの置き場と設定で動くからである。
# OPENCODE_ で始まる変数は 1 つでもあれば変えているとみる。XDG の置き場（_HOME で終わる 4 つ）は、既定と違う場所のときだけ変えているとみる。
__agent_hangar_opencode_env() {
  local k v
  for k in \${(k)parameters[(I)OPENCODE_*]}; do [[ \${parameters[$k]} == *export* ]] && return 0; done
  local -A def
  def=(XDG_DATA_HOME .local/share XDG_CONFIG_HOME .config XDG_CACHE_HOME .cache XDG_STATE_HOME .local/state)
  for k in \${(k)def}; do
    [[ \${parameters[$k]} == *export* ]] || continue
    v=\${(P)k}
    [[ -n $v && \${v:A} != \${HOME:A}/$def[$k] ]] && return 0
  done
  return 1
}

# ターミナルで対話として起動した opencode を、hangar の tmux の中で起こし、すぐこのターミナルからつなぐ（ベータ）。
# hangar が写せる引数（--auto、--prompt、-s、ディレクトリ 1 つ）だけなら包み、ほかのフラグやサブコマンドが 1 つでもあれば素の opencode を起動する。
# -s は会話の ID の形のときだけ hangar に頼む。hangar の会話でなければ hangar が断るので、素の opencode になる。
# 1 回だけ包まずに起動するときは \`command opencode\` です。
function opencode {
  # 端末でないとき、HANGAR_NO_WRAP を立てたとき、tmux が無いとき、置き場や設定を変えたときは包まない。
  if [[ ! -t 0 || ! -t 1 || -n "$HANGAR_NO_WRAP" || ! -x "$__agent_hangar_tmux" ]]; then command opencode "$@"; return; fi
  if __agent_hangar_opencode_env; then command opencode "$@"; return; fi
  local a want="" sess="" dir=""
  for a in "$@"; do
    # 値を取るフラグの次の語は値なので、ディレクトリやサブコマンドと取り違えない。
    if [[ -n $want ]]; then
      case $want in -s|--session) sess=$a ;; esac
      want=""; continue
    fi
    case "$a" in
${cases.join('\n')}
      -*) command opencode "$@"; return ;;
      *)
        # ディレクトリでない位置引数（知らないサブコマンドなど）と、2 つ目の位置引数は、そのまま渡す。
        if [[ -n $dir || ! -d $a ]]; then command opencode "$@"; return; fi
        dir=$a ;;
    esac
  done
  # 値の無い値を取るフラグと、会話の ID の形でない -s は、そのまま渡す。
  if [[ -n $want ]]; then command opencode "$@"; return; fi
  if [[ -n $sess && ! $sess =~ '^ses_[0-9A-Za-z]+$' ]]; then command opencode "$@"; return; fi
  __agent_hangar_run opencode "$@"
}
`;
}

/**
 * codex の包みの本体。許可リスト方式である（docs/design.md「外のターミナルの codex」）。
 * hangar が写せる引数（プロンプト 1 つ、-m、-c、-s、-a、resume <ID>）だけなら包み、ほかのフラグやサブコマンドが 1 つでもあれば素の codex を起動する。
 * 写せるかの細かい判定（-c の中身、-s と -a の組）は hangar が行い、断られたら素の codex になる。
 * codex の置き場を環境変数で変えた起動（CODEX_ で始まる変数）も、hangar の管理に入れない。hangar は自分の app-server を、ふだんの置き場で起こすからである。
 * alias で codex を包んでいる人がいても読み込みで壊れないよう、関数は function の形で書く。
 */
function codexScript(o: ShellCodexOptions): string {
  const subs = (o.subcommands ?? BUILTIN_CODEX_SUBCOMMANDS).filter((x) => SUBCOMMAND_NAME.test(x));
  return `
# Whether the codex home or config was changed through the environment: any exported CODEX_ variable counts.
__agent_hangar_codex_env() {
  local k
  for k in \${(k)parameters[(I)CODEX_*]}; do [[ \${parameters[$k]} == *export* ]] && return 0; done
  return 1
}

# Start an interactive codex typed in a terminal inside hangar's tmux and attach to it from this terminal (beta).
# Wrap only arguments hangar can map (one prompt, -m, -c, -s, -a, resume <ID>); any other flag or subcommand runs plain codex.
# resume goes to hangar only when its argument looks like a session ID; hangar refuses a session it does not own, so plain codex runs.
# To run codex unwrapped just once, use \`command codex\`.
function codex {
  # Do not wrap when not on a terminal, when HANGAR_NO_WRAP is set, when tmux is missing, or when the codex home was changed.
  if [[ ! -t 0 || ! -t 1 || -n "$HANGAR_NO_WRAP" || ! -x "$__agent_hangar_tmux" ]]; then command codex "$@"; return; fi
  if __agent_hangar_codex_env; then command codex "$@"; return; fi
  local a want="" pos=()
  for a in "$@"; do
    # The word after a value flag is its value, not a subcommand or a prompt.
    if [[ -n $want ]]; then want=""; continue; fi
    case "$a" in
      ${(subs.length > 0 ? subs : BUILTIN_CODEX_SUBCOMMANDS).join('|')}) command codex "$@"; return ;;
      ${CODEX_INTERCEPT_FLAGS.join('|')}) want=$a ;;
      ${CODEX_INTERCEPT_FLAGS.filter((f) => f.startsWith('--')).map((f) => `${f}=*`).join('|')}) ;;
      -*) command codex "$@"; return ;;
      *) pos+=("$a") ;;
    esac
  done
  # A value flag with no value, or a second positional argument, runs plain codex. resume is sent only with exactly one session ID (UUID).
  if [[ -n $want ]]; then command codex "$@"; return; fi
  if [[ \${pos[1]} == resume ]]; then
    if (( \${#pos} != 2 )) || [[ ! \${pos[2]} =~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ]]; then command codex "$@"; return; fi
  elif (( \${#pos} > 1 )); then command codex "$@"; return; fi
  __agent_hangar_run codex "$@"
}
`;
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
# hangar の tmux は利用者の tmux と別のサーバです。\`tmux -L ${HANGAR_SOCKET} ls\` で hangar のセッションが見えます。
# 1 回だけ包まずに起動するときは \`command claude\`、ずっとやめるときは \`hangar shell uninstall\` です。

__agent_hangar_url=${zshQuote(o.url)}
__agent_hangar_token_file=${zshQuote(o.tokenFile)}
__agent_hangar_tmux=${zshQuote(o.tmuxPath ?? '')}
__agent_hangar_socket=${zshQuote(HANGAR_SOCKET)}

# 標準入力を、改行の無い base64 にする。
__agent_hangar_b64() { command base64 | command tr -d '\\n'; }

# hangar に起動を頼み、つなぐ tmux のセッション名を出す。頼めなければ 1 で終わる。
# 作業ディレクトリ（シンボリックリンクを解いたもの。claude が記録するのと同じ）、引数、環境変数は base64 にして送る。引数と環境変数は NUL で区切る（環境変数は env -0 の出力のまま）。
# 1 つ目の引数はコマンドの名前（claude、opencode、codex）。opencode と codex は本文に agent を足し、環境変数は送らない（hangar が自分の空の環境で起こす）。
# claude の本文は agent を持たない。古いサーバも新しいサーバも Claude Code として読む。
# opencode と codex は hangar が serve（app-server）と会話の下ごしらえを済ませてから答えるので、待つ上限を長くする。待ち切れずに素の opencode を起こすと、hangar の会話と 2 つになる。
# 断られたときは理由を 1 行見せる。つながらないときは黙る。
__agent_hangar_launch() {
  local agent=$1; shift
  local tok out cwd args env="" extra="" why name max=10
  [[ -r $__agent_hangar_token_file ]] || return 1
  tok=$(<$__agent_hangar_token_file)
  cwd=$(print -rn -- "\${PWD:A}" | __agent_hangar_b64)
  args=$( (( $# )) && print -rn -- "\${(pj:\\0:)@}" | __agent_hangar_b64)
  if [[ $agent == opencode ]]; then extra=',"agent":"opencode"'; max=90; elif [[ $agent == codex ]]; then extra=',"agent":"codex"'; max=90; else env=$(command env -0 | __agent_hangar_b64); fi
  out=$(print -rn -- "{\\"cwd\\":\\"$cwd\\",\\"args\\":\\"$args\\",\\"env\\":\\"$env\\"$extra}" | command curl -sS --fail-with-body --max-time $max -H "Authorization: Bearer $tok" -H 'content-type: application/json' --data-binary @- "$__agent_hangar_url/api/runs/terminal" 2>/dev/null)
  if (( $? )); then
    why=\${\${out#*\\"error\\":\\"}%%\\"*}
    [[ -n $out && $why != $out ]] && print -r -- "hangar では開けないため、通常の $agent を起動します（$why）" >&2
    return 1
  fi
  name=\${\${out#*\\"tmuxName\\":\\"}%%\\"*}
  [[ $name =~ '^hangar-[0-9a-f]+$' ]] || return 1
  print -r -- $name
}

# 包む起動を hangar に頼み、返った tmux につなぐ。頼めなければ素のコマンドを起動する。1 つ目の引数はコマンドの名前（claude、opencode、codex）。
# すでに tmux の中なら入れ子にしない。hangar の専用のサーバ（-L hangar）の中なら switch-client で移り、ほかの tmux の中なら素のコマンドにする。
# 利用者の既定のサーバも「ほかの tmux」である。
__agent_hangar_run() {
  local cmd=$1; shift
  local inside=0
  if [[ -n "$TMUX" ]]; then
    local mine="\${TMUX_TMPDIR:-/tmp}/tmux-$UID/$__agent_hangar_socket"
    if [[ "\${\${TMUX%%,*}:A}" == "\${mine:A}" ]]; then inside=1; else command $cmd "$@"; return; fi
  fi
  local name
  if ! name=$(__agent_hangar_launch $cmd "$@"); then command $cmd "$@"; return; fi
  if (( inside )); then command "$__agent_hangar_tmux" -L "$__agent_hangar_socket" switch-client -t "=$name"; return; fi
  command "$__agent_hangar_tmux" -L "$__agent_hangar_socket" attach -t "=$name"
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
  __agent_hangar_run claude "$@"
}
${o.opencode ? opencodeScript(o.opencode) : ''}${o.codex ? codexScript(o.codex) : ''}`;
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
 * 足した後の中身を決める。書かない。今の形の行がちょうど 1 行あれば null。
 * もう目印の行があれば、その行を外してから末尾に今の形を足す（置き場を変えたときに古い行を残さない）。
 */
export function planShellHook(cur: string | null, line: string): string | null {
  const lines = cur === null ? [] : cur.split('\n');
  const marked = lines.filter((l) => l.includes(SHELL_MARKER));
  if (marked.length === 1 && marked[0] === line) return null;
  const body = lines.filter((l) => !l.includes(SHELL_MARKER)).join('\n').replace(/\n*$/, '');
  return `${body === '' ? '' : `${body}\n`}${line}\n`;
}

/** 目印の行を外した後の中身を決める。書かない。目印の行が無ければ null。 */
export function planShellUnhook(cur: string | null): string | null {
  if (cur === null) return null;
  const lines = cur.split('\n');
  const kept = lines.filter((l) => !l.includes(SHELL_MARKER));
  return kept.length === lines.length ? null : kept.join('\n');
}

/**
 * ~/.zshrc の末尾に 1 行を足す。書き換える前に同じディレクトリへ控えを取る。
 * 書く中身は planShellHook が決める（承諾の窓で見せる差分と同じもの）。
 */
export function installShellHook(zshrc: string, line: string, now: Date = new Date()): { changed: boolean; backup: string | null } {
  const read = readUtf8Text(zshrc);
  // UTF-8 でない ~/.zshrc（UTF-16 など）は、UTF-8 で書き戻すと壊れるので触らない（config/textEncoding.ts）。
  if (read !== null && 'problem' in read) return { changed: false, backup: null };
  const cur = read === null ? null : read.text;
  const next = planShellHook(cur, line);
  if (next === null) return { changed: false, backup: null };
  const backup = cur === null ? null : `${zshrc}.bak-${stamp(now)}`;
  if (backup) fs.copyFileSync(zshrc, backup);
  fs.writeFileSync(zshrc, next);
  return { changed: true, backup };
}

/** 目印の付いた行だけを消す。控えを取ってから書く。 */
export function uninstallShellHook(zshrc: string, now: Date = new Date()): { changed: boolean; backup: string | null } {
  const read = readUtf8Text(zshrc);
  if (read === null || 'problem' in read) return { changed: false, backup: null };
  const next = planShellUnhook(read.text);
  if (next === null) return { changed: false, backup: null };
  const backup = `${zshrc}.bak-${stamp(now)}`;
  fs.copyFileSync(zshrc, backup);
  fs.writeFileSync(zshrc, next);
  return { changed: true, backup };
}
