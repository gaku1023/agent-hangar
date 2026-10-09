import { captureOutput } from '../../../platform/capture.ts';
import { needsShell } from '../../../platform/exec.ts';
import { isRec, type Drift } from './types.ts';

/**
 * --help を読めないときに使う、シェルの包みがそのまま渡すサブコマンド。2.1.292 の `claude --help` の Commands である。
 * 別名（plugin|plugins、stop|kill、update|upgrade）は両方を入れる。
 * 見本を足すときは、最も新しい見本の help.txt と揃える（見本の試験が突き合わせる）。
 */
export const BUILTIN_SUBCOMMANDS: readonly string[] = [
  'agents', 'attach', 'auth', 'auto-mode', 'doctor', 'gateway', 'import', 'install', 'kill', 'logs', 'mcp',
  'plugin', 'plugins', 'purge', 'respawn', 'rm', 'setup-token', 'stop', 'ultrareview', 'update', 'upgrade',
];
/** サブコマンドの名前として受け付ける形。シェルの case に書くので、これ以外の文字は通さない。 */
export const SUBCOMMAND_NAME = /^[a-z][a-z0-9-]*$/;

export type ClaudeHelp = { subcommands: string[]; options: string[] };

/**
 * claude --help の出力から、Commands の節のサブコマンドと、Options の節の引数を読む。どちらも並べ替えて返す。
 * 項目の行は 2 つの空白で始まる。説明の続きの行はもっと深く下がっているので読まない。
 * 項目の行の頭（2 つ以上の空白の手前まで）だけを見る。説明の中の語を拾わないためである。
 * Commands の節が無いか、サブコマンドが 1 つも読めなければ null を返す。
 */
export function parseHelp(text: string): ClaudeHelp | null {
  let section: 'options' | 'commands' | null = null;
  const subs = new Set<string>();
  const opts = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (/^Options:\s*$/.test(line)) { section = 'options'; continue; }
    if (/^Commands:\s*$/.test(line)) { section = 'commands'; continue; }
    if (/^\S/.test(line)) { section = null; continue; }
    const m = /^ {2}(\S.*)$/.exec(line);
    if (!m || section === null) continue;
    const head = m[1]!.split(/\s{2,}/)[0]!;
    if (section === 'commands') {
      for (const n of head.split(/\s/)[0]!.split('|')) if (SUBCOMMAND_NAME.test(n)) subs.add(n);
    } else {
      for (const t of head.matchAll(/(?:^|[\s,])(--?[A-Za-z][\w-]*)/g)) opts.add(t[1]!);
    }
  }
  if (subs.size === 0) return null;
  return { subcommands: [...subs].sort(), options: [...opts].sort() };
}

/** claude --version の出力（`2.1.292 (Claude Code)`）から版を取り出す。 */
export function claudeVersionOf(out: string): string | null {
  return /\d+\.\d+\.\d+/.exec(out)?.[0] ?? null;
}

const cliDrift = (value: string): Drift => ({ contract: 'cli', value, version: null });

/**
 * --help の出力から、シェルの包みに書くサブコマンドの一覧を作る。
 * 出力が無い（claude が無い、時間切れ）ときは、ずれ無しで組み込みの一覧を使う。
 * 出力はあるのに読めない（Commands の節が無い）ときは、組み込みの一覧を使い、ずれを 1 件返す。
 * 読めたときは、組み込みの一覧との差を 1 つずつずれとして返す。
 */
export function subcommandsFromHelp(text: string | null): { subcommands: readonly string[]; drifts: Drift[] } {
  if (text === null || text.trim() === '') return { subcommands: BUILTIN_SUBCOMMANDS, drifts: [] };
  const help = parseHelp(text);
  if (!help) return { subcommands: BUILTIN_SUBCOMMANDS, drifts: [cliDrift('help.commands=(missing)')] };
  const builtin = new Set(BUILTIN_SUBCOMMANDS);
  const got = new Set(help.subcommands);
  return {
    subcommands: help.subcommands,
    drifts: [
      ...help.subcommands.filter((s) => !builtin.has(s)).map((s) => cliDrift(`subcommand.added=${s}`)),
      ...BUILTIN_SUBCOMMANDS.filter((s) => !got.has(s)).map((s) => cliDrift(`subcommand.removed=${s}`)),
    ],
  };
}

/**
 * claude --help を時間を区切って読む。起動できない、時間切れ、0 以外で終わったときは null。
 * 標準出力はファイルへ書かせて読む（platform/capture.ts）。2.1.293 の --help は 22KB あり、パイプで読むと Commands の節の手前で切れた。
 */
export async function readClaudeHelp(bin: string, timeoutMs = 5_000): Promise<string | null> {
  // .cmd と .bat は cmd.exe を通さないと起こせない。引数は固定の --help だけなので、引用の心配は無い。
  // 空や NUL 入りのパス、ENOTDIR などで投げても、「読めない」にする。
  try {
    const r = await captureOutput(bin, ['--help'], { timeoutMs, shell: needsShell(bin) });
    return r.code === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

/** JSON として読む。読めなければ undefined。 */
function parseJson(stdout: string): unknown {
  try { return JSON.parse(stdout); } catch { return undefined; }
}

/**
 * `claude auth status --json` の形。必ずある loggedIn だけを見る（未ログインと API キーでは、ほかの項目が無い）。
 * 出力が空なら見ない（claude を起こせなかったのは形のずれではない）。
 */
export function authStatusDrifts(stdout: string): Drift[] {
  if (stdout.trim() === '') return [];
  const raw = parseJson(stdout);
  if (raw === undefined) return [cliDrift('auth-status=(not-json)')];
  if (!isRec(raw)) return [cliDrift('auth-status=(not-object)')];
  return typeof raw.loggedIn === 'boolean' ? [] : [cliDrift('auth-status.loggedIn=(missing)')];
}

/** `claude agents --json` の行の種類。 */
export const KNOWN_AGENT_KINDS: ReadonlySet<string> = new Set(['interactive', 'background']);

/**
 * `claude agents --json --all` の形。hangar が読むのはバックグラウンドの行の id と sessionId だけなので、そこだけを見る（runs/procs.ts の parseJobs）。
 * 同じ形の違いは 1 つにまとめる。出力が空なら見ない。
 */
export function agentsJsonDrifts(stdout: string): Drift[] {
  if (stdout.trim() === '') return [];
  const raw = parseJson(stdout);
  if (raw === undefined) return [cliDrift('agents-json=(not-json)')];
  if (!Array.isArray(raw)) return [cliDrift('agents-json=(not-array)')];
  const out = new Map<string, Drift>();
  const add = (v: string) => { if (!out.has(v)) out.set(v, cliDrift(v)); };
  for (const r of raw) {
    if (!isRec(r)) { add('agents-json.row=(not-object)'); continue; }
    if (typeof r.kind !== 'string') add('agents-json.kind=(missing)');
    else if (!KNOWN_AGENT_KINDS.has(r.kind)) add(`agents-json.kind=${r.kind}`);
    if (r.kind !== 'interactive') {
      if (typeof r.id !== 'string') add('agents-json.id=(missing)');
      if (typeof r.sessionId !== 'string') add('agents-json.sessionId=(missing)');
    }
  }
  return [...out.values()];
}

/** `claude -p --output-format json` の形。要約が読む structured_output があるか（summary/claude.ts）。 */
export function printJsonDrifts(stdout: string): Drift[] {
  const raw = parseJson(stdout);
  if (raw === undefined) return [cliDrift('print-json=(not-json)')];
  if (!isRec(raw)) return [cliDrift('print-json=(not-object)')];
  return raw.structured_output === undefined ? [cliDrift('print-json.structured_output=(missing)')] : [];
}
