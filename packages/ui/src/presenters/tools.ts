import { stepKind, type StepCell, type ToolCallEvent } from '@agent-hangar/shared';
import { diffHunk, snippetStart, type DiffHunk } from './diff.ts';
import { safeHref } from './markdown.ts';

/**
 * 本文のツールの行と中身の見せ方。種類ごとに中身を描き分ける。
 * 札の色は手の種類（packages/shared の steps.ts）に従い、live-explainer の色帯と同じ種類を同じ色にする。
 * 生の入力の JSON は「生の記録」のトグルの側にだけ出す（presenters/session.ts）。
 */

export type MetaTone = 'add' | 'del' | 'ok' | 'ng' | 'plain';
export type ToolMeta = { text: string; tone: MetaTone };
export type ArgRow = { key: string; value: string };
export type SearchLink = { title: string; url: string; domain: string };

export type ToolBody =
  | { kind: 'diff'; hunks: DiffHunk[] }
  | { kind: 'code'; lang: string; text: string; note: string }
  | { kind: 'bash'; command: string; output: string; exit: number | null; failed: boolean }
  | { kind: 'read'; path: string; range: string | null }
  | { kind: 'fetch'; url: string; prompt: string | null; text: string | null }
  | { kind: 'search'; query: string; links: SearchLink[] }
  | { kind: 'args'; rows: ArgRow[] };

/**
 * 1 つのツールの見せ方。
 * head は畳んだ 1 行（要約、薄い添え書き、結果の印）、body は開いた中身、
 * result は中身とは別に下へ出す結果の文（引数だけを並べる種類と、失敗したとき）。
 */
export type ToolView = { step: StepCell; head: { main: string; dim: string | null; meta: ToolMeta[] }; body: ToolBody; result: string | null };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** 作業ディレクトリの下のパスは、その中からの相対にして短く見せる。 */
export function relPath(p: string, cwd: string): string {
  if (cwd && p.startsWith(cwd.endsWith('/') ? cwd : `${cwd}/`)) return p.slice(cwd.length + (cwd.endsWith('/') ? 0 : 1)) || p;
  return p;
}

const LANG: Record<string, string> = { mjs: 'js', cjs: 'js', mts: 'ts', cts: 'ts', yml: 'yaml', markdown: 'md', zsh: 'sh', bash: 'sh' };
/** 拡張子から言語名を出す。無ければ空。 */
function langOf(p: string): string {
  const base = p.split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  if (i <= 0) return '';
  const ext = base.slice(i + 1).toLowerCase();
  return LANG[ext] ?? ext;
}

const lineCount = (s: string) => (s === '' ? 0 : s.split('\n').length);
const firstLine = (s: string) => s.split('\n')[0] ?? '';

/** Bash の結果の頭にある「Exit code N」を読み、出力からは外す。 */
function bashResult(result: { text: string; isError: boolean } | null): { output: string; exit: number | null; failed: boolean } {
  if (!result) return { output: '', exit: null, failed: false };
  const m = /^Exit code (\d+)[ \t]*\n?/.exec(result.text);
  if (m) return { output: result.text.slice(m[0].length), exit: Number(m[1]), failed: Number(m[1]) !== 0 || result.isError };
  if (result.isError) return { output: result.text, exit: null, failed: true };
  return { output: result.text, exit: 0, failed: false };
}

/** cat -n の形の行番号から、読んだ行の範囲を出す。 */
function numberedRange(text: string): string | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)(?:→|\t)/.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    if (first === null) first = n;
    last = n;
  }
  return first === null || last === null ? null : `${first}〜${last} 行`;
}

/** WebSearch の結果に入る「Links: [...]」を読む。読めなければ空。 */
function searchLinks(text: string): SearchLink[] {
  const m = /Links:\s*(\[[\s\S]*?\])\s*(?:\n|$)/.exec(text);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[1]!) as unknown;
    if (!Array.isArray(arr)) return [];
    const out: SearchLink[] = [];
    for (const x of arr) {
      if (!isRec(x)) continue;
      const url = str(x.url);
      const href = url ? safeHref(url) : null;
      if (!href) continue;
      out.push({ title: str(x.title) ?? href, url: href, domain: new URL(href).hostname });
    }
    return out;
  } catch { return []; }
}

/** 引数の値を 1 つの文字にする。文字でないものは整形した JSON にする。 */
function argValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v, null, 2) ?? String(v);
}

const TODO_LABEL: Record<string, string> = { completed: '済み', in_progress: '作業中', pending: '未着手' };

export function presentTool(call: ToolCallEvent, result: { text: string; isError: boolean } | null, cwd: string): ToolView {
  const input: Rec = isRec(call.input) ? call.input : {};
  const step: StepCell = result?.isError ? 'fail' : stepKind(call);
  const failText = result?.isError ? result.text : null;
  const path = str(input.file_path) ?? str(input.notebook_path) ?? '';
  const rel = relPath(path, cwd);
  const view = (main: string, dim: string | null, meta: ToolMeta[], body: ToolBody, res: string | null = failText): ToolView => ({ step, head: { main, dim, meta }, body, result: res });

  switch (call.name) {
    case 'Edit': {
      const before = str(input.old_string) ?? '';
      const after = str(input.new_string) ?? '';
      // 行番号は結果に付く cat -n の抜粋から読む。抜粋の無い版の Claude Code もあるので、読めなければ番号を付けない。
      const start = result && !result.isError ? snippetStart(result.text, after) : null;
      const d = diffHunk(before, after, { start });
      return view(rel, input.replace_all === true ? 'すべて置き換え' : null, counts(d.added, d.removed), { kind: 'diff', hunks: [d.hunk] });
    }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits.filter(isRec) : [];
      let added = 0;
      let removed = 0;
      const hunks = edits.map((e, i) => {
        const d = diffHunk(str(e.old_string) ?? '', str(e.new_string) ?? '', { start: null });
        added += d.added; removed += d.removed;
        return { ...d.hunk, header: `@@ ${i + 1} か所目 @@` };
      });
      return view(rel, `${edits.length} か所`, counts(added, removed), { kind: 'diff', hunks });
    }
    case 'Write': {
      const content = typeof input.content === 'string' ? input.content : '';
      const n = `${lineCount(content)} 行`;
      const created = !!result && !result.isError && /created/i.test(result.text);
      return view(rel, created ? '新しいファイル' : null, [{ text: n, tone: 'plain' }], { kind: 'code', lang: langOf(path), text: content, note: n });
    }
    case 'Bash': {
      const command = str(input.command) ?? '';
      const r = bashResult(result);
      const meta: ToolMeta[] = !result ? [] : r.exit === 0 ? [{ text: '0', tone: 'ok' }] : r.exit !== null ? [{ text: `終了 ${r.exit}`, tone: 'ng' }] : [{ text: '失敗', tone: 'ng' }];
      // 出力は中身に入っているので、下へ重ねて出さない。
      return view(firstLine(command), str(input.description) ?? null, meta, { kind: 'bash', command, output: r.output, exit: r.exit, failed: r.failed }, null);
    }
    case 'Read': {
      const offset = num(input.offset);
      const limit = num(input.limit);
      const range = offset !== undefined || limit !== undefined
        ? (limit !== undefined ? `${offset ?? 1}〜${(offset ?? 1) + limit - 1} 行` : `${offset} 行から`)
        : result && !result.isError ? numberedRange(result.text) : null;
      return view(rel, range, [], { kind: 'read', path: rel, range });
    }
    case 'WebFetch': {
      const url = str(input.url) ?? '';
      return view(url.replace(/^https?:\/\//i, ''), null, [], { kind: 'fetch', url, prompt: str(input.prompt) ?? null, text: result && !result.isError ? result.text : null });
    }
    case 'WebSearch': {
      const query = str(input.query) ?? '';
      const links = result && !result.isError ? searchLinks(result.text) : [];
      // 結果の形が読めなかったときは、結果の文をそのまま下に出す。
      const res = links.length === 0 && result ? result.text : failText;
      return view(query, null, links.length > 0 ? [{ text: `${links.length} 件`, tone: 'plain' }] : [], { kind: 'search', query, links }, res);
    }
    case 'Grep': case 'Glob': {
      const where = [str(input.path) ? relPath(str(input.path)!, cwd) : undefined, str(input.glob)].filter((x): x is string => !!x);
      const rows = Object.entries(input).map(([key, v]) => ({ key, value: key === 'path' && typeof v === 'string' ? relPath(v, cwd) : argValue(v) }));
      return view(str(input.pattern) ?? '', where.length > 0 ? `in ${where.join(' ')}` : null, findCount(result), { kind: 'args', rows }, result?.text ?? null);
    }
    case 'Agent': case 'Task': {
      const rows = ['description', 'subagent_type', 'prompt'].filter((k) => input[k] !== undefined).map((key) => ({ key, value: argValue(input[key]) }));
      const kind = str(input.subagent_type);
      return view(str(input.description) ?? call.summary, null, kind ? [{ text: kind, tone: 'plain' }] : [], { kind: 'args', rows }, result?.text ?? null);
    }
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos.filter(isRec) : [];
      const done = todos.filter((t) => t.status === 'completed').length;
      const rows = todos.map((t) => ({ key: TODO_LABEL[str(t.status) ?? ''] ?? (str(t.status) ?? ''), value: str(t.content) ?? '' }));
      return view(`TODO ${todos.length} 件`, `済み ${done}`, [], { kind: 'args', rows }, failText);
    }
    default: {
      const rows = isRec(call.input) ? Object.entries(input).map(([key, v]) => ({ key, value: argValue(v) })) : call.input === undefined ? [] : [{ key: 'input', value: argValue(call.input) }];
      const main = call.summary.startsWith(`${call.name} `) ? call.summary.slice(call.name.length + 1) : call.summary === call.name ? '' : call.summary;
      return view(main, null, [], { kind: 'args', rows }, result?.text ?? null);
    }
  }
}

function counts(added: number, removed: number): ToolMeta[] {
  return [{ text: `+${added}`, tone: 'add' }, { text: `−${removed}`, tone: 'del' }];
}

/** Grep と Glob の結果の件数。「Found N files」を読み、無ければ行を数える。 */
function findCount(result: { text: string; isError: boolean } | null): ToolMeta[] {
  if (!result || result.isError) return [];
  const m = /^Found (\d+) files?/m.exec(result.text);
  if (m) return [{ text: `${m[1]} ファイル`, tone: 'plain' }];
  if (/^No (files|matches) found/m.test(result.text)) return [{ text: 'なし', tone: 'plain' }];
  return [];
}

/**
 * 描く順に並べた文字の葉。本文の中の検索は、この葉ごとに一致を数える。
 * ツールの行と中身の View（views/ToolBody.tsx）は、同じ順に同じ文字を印の部品へ渡す。
 */
export function toolLeaves(v: ToolView): string[] {
  const out = [v.head.main];
  if (v.head.dim) out.push(v.head.dim);
  const b = v.body;
  switch (b.kind) {
    case 'diff': for (const h of b.hunks) for (const l of h.lines) if (l.t !== 'gap') out.push(l.text); break;
    case 'code': out.push(b.text); break;
    case 'bash': out.push(b.command, b.output); break;
    case 'read': break;
    case 'fetch': out.push(b.url); if (b.prompt) out.push(b.prompt); if (b.text) out.push(b.text); break;
    case 'search': for (const l of b.links) out.push(l.title); break;
    case 'args': for (const r of b.rows) out.push(r.value); break;
  }
  if (v.result) out.push(v.result);
  return out;
}
