import path from 'node:path';
import { RunError } from './errors.ts';

/** ターミナルの包み方から届く起動の頼み。 */
export type TerminalRequest = { cwd: string; args: string[]; env: Record<string, string> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 包み方は、作業ディレクトリ、引数、環境変数を base64 にして送る。
 * zsh だけで JSON の文字列を正しくエスケープするのは難しいので、引数と環境変数は NUL で区切った列を base64 にする（`env -0` の出力そのもの）。
 * 形が違えば null を返す。作業ディレクトリは絶対パスに限る。
 */
export function decodeTerminalRequest(body: unknown): TerminalRequest | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.cwd !== 'string' || typeof b.args !== 'string' || typeof b.env !== 'string') return null;
  const text = (s: string) => Buffer.from(s, 'base64').toString('utf8');
  const cwd = text(b.cwd);
  if (!cwd || !path.isAbsolute(cwd)) return null;
  const list = (s: string) => {
    const t = text(s);
    if (t === '') return [];
    return (t.endsWith('\0') ? t.slice(0, -1) : t).split('\0');
  };
  const env: Record<string, string> = {};
  for (const kv of list(b.env)) {
    const i = kv.indexOf('=');
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return { cwd, args: list(b.args), env };
}

/**
 * hangar が自分で組み立てる引数と重なるもの、包むと意味が変わるもの。
 * 付いていたら断り、包み方は素の claude に回す。
 */
const REFUSED = new Set(['--session-id', '--append-system-prompt', '--append-system-prompt-file', '--fork-session', '-c', '--continue', '-p', '--print', '--bg', '--background']);

/**
 * 引数から、再開する会話の id（`-r <id>`、`--resume <id>`、`--resume=<id>`）を抜き出す。残りはそのまま claude に渡す。
 * id の無い -r と検索の語の -r は選ぶ画面を出すので、hangar では開かずに断る。
 * `--` より後ろは本文なので見ない。
 */
export function splitTerminalArgs(args: string[]): { resume: string | null; rest: string[] } {
  const rest: string[] = [];
  let resume: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      rest.push(...args.slice(i));
      break;
    }
    const flag = a.startsWith('--') ? a.split('=')[0]! : a;
    if (REFUSED.has(flag)) throw new RunError(400, `${flag} を付けた起動は hangar では開けません`);
    if (a === '-r' || a === '--resume' || a.startsWith('--resume=')) {
      const v = a.startsWith('--resume=') ? a.slice('--resume='.length) : args[++i];
      if (!v || !UUID.test(v)) throw new RunError(400, '会話の id を付けない再開は hangar では開けません');
      resume = v;
      continue;
    }
    rest.push(a);
  }
  return { resume, rest };
}

/**
 * tmux のセッションに渡さない変数。
 * 端末の種類と大きさは tmux が自分の値を入れる。外の端末の名前（TERM_PROGRAM など）を渡すと、中の claude が iTerm2 だと思って tmux を越えない列を送る。
 * シェルの状態と、hangar と Claude Code が中で立てる印も渡さない。
 */
const DROPPED = new Set(['TMUX', 'TMUX_PANE', 'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID', 'ITERM_SESSION_ID', 'ITERM_PROFILE', 'LC_TERMINAL', 'LC_TERMINAL_VERSION', 'SHLVL', 'PWD', 'OLDPWD', '_', 'COLUMNS', 'LINES', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_KIND', 'CLAUDE_CODE_ENTRYPOINT']);

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** シェルの環境変数のうち、tmux のセッションへ渡すもの。 */
export function terminalEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!NAME.test(k) || DROPPED.has(k) || k.startsWith('HANGAR_')) continue;
    out[k] = v;
  }
  return out;
}
