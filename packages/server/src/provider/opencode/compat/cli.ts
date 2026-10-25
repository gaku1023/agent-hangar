import { SUBCOMMAND_NAME } from '../../claude-code/compat/cli.ts';
import { splitDriftValue, type Drift } from '../../claude-code/compat/types.ts';

/**
 * --help を読めないときに使う、opencode の包みがそのまま渡すサブコマンド。2.1.4 の `opencode --help` の SUBCOMMANDS の全部である。
 * 別名（upgrade, update）は両方を入れる。並びは名前の順にする（parseOpencodeHelp の返す順と同じ）。
 * 1.x にだけあった attach、export、import、db、agent、github、pr、web は入れない（2.1.4 で打つと root の help が出る）。
 * 見本を足すときは、最も新しい見本の help.txt と揃える（cli.test.ts の見本の試験が突き合わせる）。
 */
export const BUILTIN_OPENCODE_SUBCOMMANDS: readonly string[] = [
  'acp', 'api', 'auth', 'debug', 'mcp', 'mini', 'models', 'pair', 'plugin', 'reload',
  'run', 'serve', 'service', 'session', 'stats', 'uninstall', 'update', 'upgrade',
];

/** 2.1.4 の root の FLAGS と GLOBAL FLAGS の全部。短い名前も入れる。これに無いフラグが help に増えたら、ずれとして知らせる。 */
export const BUILTIN_OPENCODE_FLAGS: readonly string[] = [
  '--auto', '--completions', '--continue', '--help', '--log-level', '--print-logs', '--prompt',
  '--server', '--session', '--standalone', '--version', '--wizard', '-c', '-h', '-s', '-v',
];

/** BUILTIN_OPENCODE_FLAGS のうち、値を取るもの。シェルの包みが、値を位置引数（ディレクトリ）と取り違えないために使う。 */
export const BUILTIN_OPENCODE_VALUE_FLAGS: readonly string[] = [
  '--completions', '--log-level', '--prompt', '--server', '--session', '-s',
];

/** subcommands と flags は全部の名前、valueFlags はそのうち値を取るもの。どれも並べ替えて返す。 */
export type OpencodeHelp = { subcommands: string[]; flags: string[]; valueFlags: string[] };

/**
 * opencode --help の出力から、SUBCOMMANDS の節のサブコマンドと、FLAGS と GLOBAL FLAGS の節のフラグを読む。
 * 節の見出しは行頭の大文字だけの行である（Claude の `Commands:` の形とは違う）。
 * 項目の行は 2 つの空白で始まり、別名はカンマで区切る（`upgrade, update`、`--session, -s string`）。
 * 項目の行の頭（2 つ以上の空白の手前まで）だけを見る。説明の中の語と、もっと深く下がった続きの行は読まない。
 * フラグの名前の後ろに語（`string`、`<a|b>` など）があれば、値を取るフラグとする。
 * SUBCOMMANDS の節が無いか、サブコマンドが 1 つも読めなければ null を返す。
 */
export function parseOpencodeHelp(text: string): OpencodeHelp | null {
  let section: 'flags' | 'subcommands' | null = null;
  const subs = new Set<string>();
  const flags = new Set<string>();
  const valueFlags = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      const heading = line.trim();
      section = heading === 'SUBCOMMANDS' ? 'subcommands' : heading === 'FLAGS' || heading === 'GLOBAL FLAGS' ? 'flags' : null;
      continue;
    }
    const m = /^ {2}(\S.*)$/.exec(line);
    if (!m || section === null) continue;
    const head = m[1]!.split(/\s{2,}/)[0]!;
    if (section === 'subcommands') {
      for (const part of head.split(',')) {
        const n = part.trim().split(/\s/)[0]!;
        if (SUBCOMMAND_NAME.test(n)) subs.add(n);
      }
    } else {
      const names: string[] = [];
      let takesValue = false;
      for (const part of head.split(',')) {
        const [name, ...rest] = part.trim().split(/\s+/);
        if (name && /^--?[A-Za-z][\w-]*$/.test(name)) names.push(name);
        if (rest.length > 0) takesValue = true;
      }
      for (const n of names) {
        flags.add(n);
        if (takesValue) valueFlags.add(n);
      }
    }
  }
  if (subs.size === 0) return null;
  return { subcommands: [...subs].sort(), flags: [...flags].sort(), valueFlags: [...valueFlags].sort() };
}

/** opencode のずれは 'opencode-cli' で返す。Claude の 'cli' に混ぜると、Claude の見直し（isCliDrift）が Claude の一覧で読んでしまう。 */
const cliDrift = (value: string): Drift => ({ contract: 'opencode-cli', value, version: null });

/**
 * --help の出力から、opencode の包みに書くサブコマンドの一覧を作る。
 * 出力が無い（opencode が無い、時間切れ）ときは、ずれ無しで組み込みの一覧を使う。
 * 出力はあるのに読めない（SUBCOMMANDS の節が無い）ときは、組み込みの一覧を使い、ずれを 1 件返す。
 * 読めたときは、組み込みの一覧とのサブコマンドの差と、組み込みの一覧に無いフラグを、1 つずつずれとして返す。
 * 包みは知っているフラグだけを横取りし、知らないフラグがあれば素通しにするので、フラグが増えても動作は変わらない。知らせるだけである。
 */
export function opencodeSubcommandsFromHelp(text: string | null): { subcommands: readonly string[]; drifts: Drift[] } {
  if (text === null || text.trim() === '') return { subcommands: BUILTIN_OPENCODE_SUBCOMMANDS, drifts: [] };
  const help = parseOpencodeHelp(text);
  if (!help) return { subcommands: BUILTIN_OPENCODE_SUBCOMMANDS, drifts: [cliDrift('help.subcommands=(missing)')] };
  const builtin = new Set(BUILTIN_OPENCODE_SUBCOMMANDS);
  const got = new Set(help.subcommands);
  const knownFlags = new Set(BUILTIN_OPENCODE_FLAGS);
  return {
    subcommands: help.subcommands,
    drifts: [
      ...help.subcommands.filter((s) => !builtin.has(s)).map((s) => cliDrift(`subcommand.added=${s}`)),
      ...BUILTIN_OPENCODE_SUBCOMMANDS.filter((s) => !got.has(s)).map((s) => cliDrift(`subcommand.removed=${s}`)),
      ...help.flags.filter((f) => !knownFlags.has(f)).map((f) => cliDrift(`flag.added=${f}`)),
    ],
  };
}

/**
 * 記録に残った opencode の CLI の値が、今の一覧でもずれかを返す。
 * サブコマンドとフラグの増は組み込みの一覧に入っていれば、サブコマンドの減は組み込みの一覧から外れていればずれでない。
 * 欠けと、知らない形の値はずれのままにする。
 */
export function isOpencodeCliDrift(value: string): boolean {
  const kv = splitDriftValue(value);
  if (kv === null) return true;
  const [key, got] = kv;
  switch (key) {
    case 'subcommand.added': return !BUILTIN_OPENCODE_SUBCOMMANDS.includes(got);
    case 'subcommand.removed': return BUILTIN_OPENCODE_SUBCOMMANDS.includes(got);
    case 'flag.added': return !BUILTIN_OPENCODE_FLAGS.includes(got);
    default: return true;
  }
}
