import { execFile } from 'node:child_process';
import { needsShell } from '../../../platform/exec.ts';
import type { Drift } from './types.ts';

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

/** claude --help を時間を区切って読む。起動できない、時間切れ、0 以外で終わったときは null。 */
export function readClaudeHelp(bin: string, timeoutMs = 5_000): Promise<string | null> {
  // .cmd と .bat は cmd.exe を通さないと起こせない。引数は固定の --help だけなので、引用の心配は無い。
  const viaShell = needsShell(bin);
  return new Promise((resolve) => {
    execFile(viaShell ? `"${bin}"` : bin, ['--help'], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, shell: viaShell, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}
