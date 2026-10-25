import path from 'node:path';
import { splitPathEnv } from '../../../platform/exec.ts';

/**
 * `opencode serve` に渡す空の環境（docs/design.md「opencode の serve の管理」）。
 *
 * 裏のサービスは、起こしたプロセスの環境をそのまま持ち続ける。
 * hangar を Claude Code のセッションから起こすと、サーバの環境に呼び手の印（`CLAUDE` で始まる鍵）と hangar の印（`HANGAR_*`）が入っているので、
 * それを継いだ serve が、そこから動く道具とモデルの全部に印を配ってしまう。
 * opencode は環境から設定（`OPENCODE_*`）とプロバイダーの API キーも読むので、決まった鍵のほかは何も渡さない。
 * 版を読むとき（compat/version.ts の `opencodeProbeEnv`）も、この作りをそのまま使う。
 */

/** macOS と Linux で opencode に渡す PATH の固定の部分。opencode の置き場はこの前に足す。 */
const POSIX_BASE_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
/** macOS と Linux で呼び手の環境から写す鍵。ほかは何も渡さない。 */
const POSIX_KEYS = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG'] as const;

/**
 * 利用者が置いていれば写す XDG の置き場（macOS、Linux、Windows とも）。
 * opencode は設定、DB、キャッシュ、状態をこの 4 つの下に置くので、渡さないと hangar が起こす opencode だけが別の置き場を見て、
 * ふだんの opencode のプロバイダーの接続も会話も見えなくなる。どれも場所であり、呼び手や hangar の印ではない。
 * 空の値は渡さない（opencode は空を既定の置き場として読まないことがある）。
 */
export const XDG_KEYS = ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'] as const;

/** Windows で serve に写す鍵の許可リストの型。 */
export type WindowsServeAllowlist = readonly string[];

/**
 * Windows で serve に写す鍵。
 * Windows では、空の環境から起こしたプロセスは、ソケット（Winsock は SystemRoot を引く）も、ホームと設定の置き場も引けずに落ちることが多い。
 * そこで、OS が配る鍵のうち、場所と機械の形を表すものだけを写す。どれも呼び手や hangar の印ではない。
 * - OS の置き場とシェル：SystemRoot、windir、SystemDrive、ComSpec、PATHEXT、PATH。
 * - ホームと利用者：USERPROFILE（opencode のホーム。設定と DB の置き場は ~/.config、~/.local/share）、HOMEDRIVE、HOMEPATH、USERNAME。
 * - 置き場：APPDATA、LOCALAPPDATA（npm で入れた道具とその設定）、TEMP、TMP。
 * - 入れた道具の置き場と機械の形：ProgramFiles 系、ProgramData、PROCESSOR_ARCHITECTURE、NUMBER_OF_PROCESSORS、OS。
 *   serve の上で動く道具（エージェントが打つ git、node、python など）が、自分の置き場と機械の形をここから引くためである。
 * PSModulePath、COMPUTERNAME、利用者が足した鍵（API キーなど）は渡さない。
 * PATH は固定にせず、呼び手（hangar）の PATH を写す。Windows の hangar の PATH は Explorer から継いだ利用者の PATH で、
 * 固定の最小（System32 だけ）にすると、エージェントが git も node も引けなくなるからである。
 */
export const WINDOWS_SERVE_ALLOWLIST: WindowsServeAllowlist = [
  'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'PATH',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME',
  'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'CommonProgramFiles',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS',
];

/** hangar が serve にだけ足す設定。 */
export type ServeConfig = { configContent?: string };

/**
 * opencode に渡す環境の土台（serve と、版を読む `--version` の両方）。
 * macOS と Linux は `HOME`、`USER`、`LOGNAME`、`SHELL`、`TMPDIR`、`LANG` と、opencode の置き場を先頭に足した固定の最小の `PATH` だけである。
 * 置き場を先頭に足すのは、npm で入れた opencode が隣の node を引く台本だからである。
 * Windows は許可リスト（WINDOWS_SERVE_ALLOWLIST）の鍵だけを写し、PATH の先頭に opencode の置き場を足す。
 * どの OS でも、利用者が置いていれば XDG の置き場 4 つ（XDG_KEYS）を足す。
 * 書き出しと取り込みの CLI（export.ts など）もこの土台を使うので、serve と同じ置き場を見る。
 */
export function opencodeBaseEnv(bin: string, src: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  return platform === 'win32' ? windowsEnv(bin, src) : posixEnv(bin, src);
}

function posixEnv(bin: string, src: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of POSIX_KEYS) if (src[k] !== undefined) env[k] = src[k];
  for (const k of XDG_KEYS) if (src[k]) env[k] = src[k];
  env.LANG ??= 'en_US.UTF-8';
  const dir = path.posix.dirname(bin);
  env.PATH = [...(POSIX_BASE_PATH.includes(dir) ? [] : [dir]), ...POSIX_BASE_PATH].join(':');
  return env;
}

/**
 * Windows の環境変数の名前は大文字小文字を区別しない。
 * 呼び手の環境は `Path` と書くことも `PATH` と書くこともあるので、名前を小文字にして拾い、許可リストの綴りで 1 つだけ渡す。
 * 同じ名前を綴りを変えて 2 つ渡すと、どちらが効くかが子の側で決まらない。
 */
function windowsEnv(bin: string, src: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const byLower = new Map<string, string>();
  for (const [k, v] of Object.entries(src)) {
    const lower = k.toLowerCase();
    if (v !== undefined && !byLower.has(lower)) byLower.set(lower, v);
  }
  const env: NodeJS.ProcessEnv = {};
  for (const k of WINDOWS_SERVE_ALLOWLIST) {
    const v = byLower.get(k.toLowerCase());
    if (v !== undefined) env[k] = v;
  }
  for (const k of XDG_KEYS) {
    const v = byLower.get(k.toLowerCase());
    if (v) env[k] = v;
  }
  const dir = path.win32.dirname(bin);
  const root = env.SystemRoot ?? 'C:\\Windows';
  // PATH が無ければ、OS の置き場（System32 と SystemRoot）だけにする。
  const tail = env.PATH ?? [path.win32.join(root, 'System32'), root].join(';');
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
  const has = splitPathEnv(tail, 'win32').some((p) => norm(p) === norm(dir));
  env.PATH = has ? tail : `${dir};${tail}`;
  return env;
}

/**
 * serve の環境を組む。土台（opencodeBaseEnv）に、hangar がこの serve にだけ足す設定を重ねる。
 * パスワード（`OPENCODE_SERVER_PASSWORD`）は起こす側（spawn.ts）が足す。
 * configContent は hangar の MCP（`mcp.servers.hangar`）で、`OPENCODE_CONFIG_CONTENT` で渡す。
 * opencode 2.1.4 はこれを利用者の設定（`~/.config/opencode/opencode.json`）に重ねて読むので、利用者の設定は書き換えずに済む。
 */
export function serveEnv(bin: string, src: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, o: ServeConfig = {}): NodeJS.ProcessEnv {
  const env = opencodeBaseEnv(bin, src, platform);
  return o.configContent === undefined ? env : { ...env, OPENCODE_CONFIG_CONTENT: o.configContent };
}
