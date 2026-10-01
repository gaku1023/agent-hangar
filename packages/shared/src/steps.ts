import type { TranscriptEvent } from './transcript.ts';

export type ToolCallEvent = Extract<TranscriptEvent, { kind: 'tool_call' }>;
/** 手の種類。色帯と、2 回目で入れる層のタイルに使う。 */
export type StepKind = 'read' | 'write' | 'run' | 'git' | 'other';
/** 色帯の 1 升。失敗は種類より優先する（結果が isError のとき）。 */
export type StepCell = StepKind | 'fail';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'LS']);
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const READ_CMDS = new Set(['cat', 'head', 'tail', 'ls', 'grep', 'rg', 'find', 'jq', 'wc', 'less', 'tree', 'stat', 'file', 'pwd', 'which', 'du', 'diff']);
const WRITE_CMDS = new Set(['tee', 'mkdir', 'cp', 'mv', 'touch', 'ln']);
const RUN_CMDS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'vitest', 'tsc', 'node', 'tsx', 'cargo', 'pytest', 'python', 'python3', 'make', 'go', 'bun', 'deno']);
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'blame', 'ls-files', 'worktree']);
const GIT_WRITE = new Set(['commit', 'merge', 'push', 'rebase', 'cherry-pick']);

/** コマンドの頭の語の並び。`cd <dir> &&` と、先頭の環境変数の代入を読み飛ばす。 */
export function commandWords(command: string): string[] {
  let words = command.trim().split(/\s+/).filter(Boolean);
  for (;;) {
    if (words[0] === 'cd') {
      const i = words.indexOf('&&');
      if (i < 0) return [];
      words = words.slice(i + 1);
      continue;
    }
    if (words[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) { words = words.slice(1); continue; }
    return words;
  }
}

function bashKind(command: string): StepKind {
  const w = commandWords(command.split('\n')[0] ?? '');
  const head = w[0] ?? '';
  if (head === 'git') {
    // `git -C <dir> log` のような大域の引数を読み飛ばして、サブコマンドを取る。
    let i = 1;
    while (w[i]?.startsWith('-')) i += w[i] === '-C' || w[i] === '-c' ? 2 : 1;
    const sub = w[i] ?? '';
    if (GIT_WRITE.has(sub)) return 'git';
    if (GIT_READ.has(sub)) return 'read';
    return 'other';
  }
  if (head === 'sed') return w.some((x) => /^-i/.test(x)) ? 'write' : 'read';
  if (READ_CMDS.has(head)) return 'read';
  if (WRITE_CMDS.has(head)) return 'write';
  if (RUN_CMDS.has(head)) return 'run';
  return 'other';
}

/** 手の種類。決めきれないものは other にし、無理に当てはめない。 */
export function stepKind(call: ToolCallEvent): StepKind {
  if (READ_TOOLS.has(call.name)) return 'read';
  if (WRITE_TOOLS.has(call.name)) return 'write';
  if (call.name === 'Bash' && isRec(call.input) && typeof call.input.command === 'string') return bashKind(call.input.command);
  return 'other';
}

const baseName = (p: string): string => p.split('/').filter(Boolean).pop() ?? p;

/**
 * 手の 1 行の文。Bash は Claude が書いた description を使う。
 * description は 1 手ごとに書かれ、隣に結果があるので、引用符は付けない（自己申告の扱いは仕様書の「意図」の節）。
 * mono はコマンドをそのまま出すときだけ真にする。
 */
export function stepLine(call: ToolCallEvent): { text: string; mono: boolean } {
  const i = isRec(call.input) ? call.input : {};
  const fp = str(i.file_path) ?? str(i.notebook_path) ?? str(i.path);
  switch (call.name) {
    case 'Bash': {
      const d = str(i.description);
      if (d) return { text: d, mono: false };
      return { text: ((str(i.command) ?? 'Bash').split('\n')[0] ?? '').slice(0, 80), mono: true };
    }
    case 'Read': return { text: fp ? `読んだ：${baseName(fp)}` : '読んだ', mono: false };
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return { text: fp ? `${baseName(fp)} を書き換えた` : call.name, mono: false };
    case 'Write': return { text: fp ? `${baseName(fp)} を書いた` : call.name, mono: false };
    case 'Grep': case 'Glob': { const p = str(i.pattern); return { text: p ? `探した：${p}` : '探した', mono: false }; }
    case 'Agent': case 'Task': return { text: str(i.description) ?? call.summary, mono: false };
    default: return { text: call.summary, mono: false };
  }
}

/** ターンの区切りになる指示か。中断の知らせは user の行として残るが、利用者の発言ではない。 */
export function isTurnPrompt(text: string): boolean {
  return !text.startsWith('[Request interrupted');
}
