import path from 'node:path';
import type { AgentKind } from '../agent/types.ts';
import { CODEX_PERMISSION_FLAGS, CODEX_PERMISSIONS, type CodexPermission } from '@agent-hangar/shared';
import { CLAUDE_CHILD_ENV } from '../provider/claude-code/compat/childEnv.ts';
import { BUILTIN_OPENCODE_SUBCOMMANDS, BUILTIN_OPENCODE_VALUE_FLAGS, OPENCODE_INTERCEPT_FLAGS } from '../provider/opencode/compat/cli.ts';
import { BUILTIN_CODEX_SUBCOMMANDS, CODEX_INTERCEPT_FLAGS, CODEX_SESSION_ID } from '../provider/codex/compat/cli.ts';
import { RunError } from './errors.ts';
import { msg } from '../i18n/message.ts';

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
  const args = text(b.args);
  const envText = text(b.env);
  const env: Record<string, string> = {};
  // env -0 は各項目の後ろに NUL を置くので、末尾の空の項目は捨てる。
  for (const kv of envText === '' ? [] : envText.replace(/\0$/, '').split('\0')) {
    const i = kv.indexOf('=');
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return { cwd, args: args === '' ? [] : args.split('\0'), env };
}

/**
 * どのエージェントの起動か。包み方は opencode と codex のときだけ本文に agent を足す。
 * agent の無い本文（claude の包み、古い包み方）は Claude Code にする。知らない値は null（400 で断る）。
 */
export function terminalAgentOf(body: unknown): AgentKind | null {
  const a = body && typeof body === 'object' ? (body as Record<string, unknown>).agent : undefined;
  if (a === undefined || a === 'claude' || a === 'claude-code') return 'claude-code';
  if (a === 'opencode') return 'opencode';
  if (a === 'codex') return 'codex';
  return null;
}

/** 外のターミナルの opencode の引数のうち、hangar の起動に写すもの。dir は作業ディレクトリからの相対のまま返す。 */
export type OpencodeTerminalArgs = { session: string | null; prompt: string | null; autoApprove: boolean; dir: string | null };

/** opencode の会話の ID の形。hangar は ID を決めず、opencode が振った ID（ses_…）を記録する。 */
const OPENCODE_SESSION_ID = /^ses_[0-9A-Za-z]+$/;

/**
 * 外のターミナルの opencode の引数を読む。許可リスト方式で、包み方（config/shellHook.ts の opencode()）と同じ一覧を使う。
 * 写せるのは --auto（自動承認）、--prompt（初期プロンプト）、-s と --session（再開する会話）、位置引数のディレクトリ 1 つだけである。
 * ほかのフラグ、サブコマンド、2 つ目の位置引数、値の無い値を取るフラグは 400 で断り、包み方は素の opencode を起動する。
 * 包み方が先に素通しにしているので、ここに届くのは古い包み方か、包み方を通さない頼みだけである。
 */
export function splitOpencodeTerminalArgs(args: string[]): OpencodeTerminalArgs {
  const out: OpencodeTerminalArgs = { session: null, prompt: null, autoApprove: false, dir: null };
  const takesValue = new Set(OPENCODE_INTERCEPT_FLAGS.filter((f) => BUILTIN_OPENCODE_VALUE_FLAGS.includes(f)));
  const refuse = (flag: string): never => { throw new RunError(400, msg('run.terminal.flagRefused', { flag })); };
  const put = (flag: string, v: string) => {
    if (flag === '--prompt') out.prompt = v;
    else if (flag === '-s' || flag === '--session') out.session = v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('-')) {
      const eq = a.startsWith('--') ? a.indexOf('=') : -1;
      const flag = eq > 0 ? a.slice(0, eq) : a;
      if (!OPENCODE_INTERCEPT_FLAGS.includes(flag)) refuse(flag);
      if (!takesValue.has(flag)) {
        if (eq > 0) refuse(flag);
        if (flag === '--auto') out.autoApprove = true;
        continue;
      }
      const v = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (v === undefined) refuse(flag);
      put(flag, v!);
      continue;
    }
    if (out.dir !== null || BUILTIN_OPENCODE_SUBCOMMANDS.includes(a)) refuse(a);
    out.dir = a;
  }
  if (out.session !== null && !OPENCODE_SESSION_ID.test(out.session)) throw new RunError(404, msg('run.terminal.notInHangar'));
  return out;
}

/** 外のターミナルの codex の引数のうち、hangar の起動に写すもの。 */
export type CodexTerminalArgs = { resume: string | null; prompt: string | null; model: string | null; effort: string | null; permission: CodexPermission | null };

const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
const APPROVALS = ['on-request', 'never'];

/**
 * 外のターミナルの codex の引数を読む。許可リスト方式で、包み方（config/shellHook.ts の codex()）と同じ一覧を使う。
 * 写せるのは、プロンプト 1 つ、-m と --model、-c model_reasoning_effort=…、-s と -a（権限の 3 段へ）、resume <ID> だけである。
 * -s と -a は、hangar の 3 段（read-only、auto、full-access）のどれかに当たる組だけを受ける。省いた側は codex の既定（workspace-write と on-request）とみる。
 * ほかのフラグ、サブコマンド、写せない -c、2 つ目の位置引数、値の無いフラグ、ID の形でない resume は 400 で断り、包み方は素の codex を起動する。
 * 包み方が先に素通しにしているので、ここに届くのは古い包み方か、包み方を通さない頼みだけである。
 */
export function splitCodexTerminalArgs(args: string[]): CodexTerminalArgs {
  const out: CodexTerminalArgs = { resume: null, prompt: null, model: null, effort: null, permission: null };
  const refuse = (what: string): never => { throw new RunError(400, msg('run.terminal.flagRefused', { flag: what })); };
  let sandbox: string | null = null;
  let approval: string | null = null;
  const positional: string[] = [];
  const put = (flag: string, v: string) => {
    if (flag === '-m' || flag === '--model') out.model = v;
    else if (flag === '-s' || flag === '--sandbox') { if (!SANDBOXES.includes(v)) refuse(`${flag} ${v}`); sandbox = v; }
    else if (flag === '-a' || flag === '--ask-for-approval') { if (!APPROVALS.includes(v)) refuse(`${flag} ${v}`); approval = v; }
    else {
      // -c は model_reasoning_effort だけを写す。値は TOML なので、引用符で囲まれていれば外す。
      const m = /^model_reasoning_effort=(.*)$/s.exec(v);
      if (!m) return refuse(`${flag} ${v.split('=')[0] ?? ''}`);
      out.effort = m[1]!.replace(/^(["'])(.*)\1$/s, '$2');
    }
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('-')) {
      const eq = a.startsWith('--') ? a.indexOf('=') : -1;
      const flag = eq > 0 ? a.slice(0, eq) : a;
      if (!CODEX_INTERCEPT_FLAGS.includes(flag)) refuse(flag);
      const v = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (v === undefined) refuse(flag);
      put(flag, v!);
      continue;
    }
    positional.push(a);
  }
  if (positional[0] === 'resume') {
    if (positional.length !== 2 || !CODEX_SESSION_ID.test(positional[1]!)) refuse('resume');
    out.resume = positional[1]!;
  } else if (positional.length > 1 || (positional[0] !== undefined && BUILTIN_CODEX_SUBCOMMANDS.includes(positional[0]))) refuse(positional[0]!);
  else if (positional.length === 1) out.prompt = positional[0]!;
  if (sandbox !== null || approval !== null) {
    const s = sandbox ?? 'workspace-write';
    const ap = approval ?? 'on-request';
    const hit = CODEX_PERMISSIONS.find((p) => CODEX_PERMISSION_FLAGS[p].sandbox === s && CODEX_PERMISSION_FLAGS[p].approval === ap);
    if (!hit) refuse('-s/-a');
    out.permission = hit!;
  }
  return out;
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
    if (REFUSED.has(flag)) throw new RunError(400, msg('run.terminal.flagRefused', { flag }));
    if (a === '-r' || a === '--resume' || a.startsWith('--resume=')) {
      const v = a.startsWith('--resume=') ? a.slice('--resume='.length) : args[++i];
      if (!v || !UUID.test(v)) throw new RunError(400, msg('run.terminal.resumeNeedsId'));
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
 * シェルの状態と、hangar が中で立てる印（HANGAR_ で始まるもの）も渡さない。
 * Claude Code が子に立てる印は、run の起こし方と同じ一覧（provider/claude-code/compat/childEnv.ts）で落とす。
 * 外の端末が Claude Code のセッションの中から起きていると、そのセッションの印を持っている。
 */
const DROPPED = new Set(['TMUX', 'TMUX_PANE', 'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID', 'ITERM_SESSION_ID', 'ITERM_PROFILE', 'LC_TERMINAL', 'LC_TERMINAL_VERSION', 'SHLVL', 'PWD', 'OLDPWD', '_', 'COLUMNS', 'LINES', ...CLAUDE_CHILD_ENV]);

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
