import { mdLeaves, parseMarkdown, type Block, type Inline } from '../presenters/markdown.ts';

/**
 * リリースノート（docs/release-notes/<版>.md）を、アプリの中で見せる形に読む。
 * version は版、body は表題の行（`# Hangar <版>`）を外した本文の Markdown である。
 * before は「更新の前に」（か「上げる前に」）の節の最初の段落か小見出しで、無ければ null。上げる前に他の PC や Worker とそろえる注意を、札で目立たせるために持つ。
 * points は要点で、見出しが文の節はその見出しを、小見出しのある節は小見出しを、ほかは箇条書きの各項目の最初の 1 文を、出てくる順に並べる。「更新の前に」の節は要点に入れない。
 */
export type ReleaseNote = { version: string; body: string; before: string | null; points: string[] };

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
/** 動いている版の形。rc などのプレリリース（`0.11.0-rc.1`）も読む。ノートの名前は VERSION の形だけである。 */
const ANY_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
/** 注意の節の見出し。0.7.0 は「上げる前に」、0.7.1 は「更新の前に（…）」、それより前は「… から上げる人へ（先にお読みください）」と書いた。 */
const BEFORE_HEADING = /^(更新|上げる)の?前に|先にお読みください|必要がある人へ/;
/** 見出しが文になっている節（「エディタを選べるようになりました」）は、見出しそのものが要点である。 */
const SENTENCE_HEADING = /(ます|ました|ません)$/;

/**
 * 版を semver の順序で比べる。プレリリースの付いた版は、付かない同じ数字の版より古い。形の違う版は 0.0.0 として扱う。
 * 以前は x.y.z の形しか読まず、rc を入れていると 0.0.0 と比べて、設定の履歴から同梱のノートが全部外れていた。
 */
export function compareVersions(a: string, b: string): number {
  const ma = ANY_VERSION.exec(a);
  const mb = ANY_VERSION.exec(b);
  const pa = ma?.slice(1, 4).map(Number) ?? [0, 0, 0];
  const pb = mb?.slice(1, 4).map(Number) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  const xa = ma?.[4]?.split('.') ?? [];
  const xb = mb?.[4]?.split('.') ?? [];
  if (xa.length === 0 || xb.length === 0) return xb.length - xa.length;
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const p = xa[i];
    const q = xb[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    // 数字だけの識別子は数として比べ、文字を含む識別子より古い。
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** rc などのプレリリースが目指す正式版（`0.11.0-rc.1` なら `0.11.0`）。rc の中身はその版のノートに書くので、ノートはこの版で引く。 */
export function releaseOf(version: string): string {
  return version.replace(/-.*$/, '');
}

/** 行の中の文字だけを 1 本にする。改行は、日本語どうしの間では詰め、英数字が並ぶ所では空白にする。 */
function plain(inl: Inline[] | Block[], inline: boolean): string {
  const leaves: string[] = [];
  if (inline) mdLeaves([{ t: 'p', inl: inl as Inline[] }], leaves); else mdLeaves(inl as Block[], leaves);
  return leaves.join('').replace(/\s*\n\s*/g, (_m, off: number, s: string) => {
    const prev = s[off - 1] ?? '';
    const next = s[off + _m.length] ?? '';
    return /[\x21-\x7e]/.test(prev) && /[\x21-\x7e]/.test(next) ? ' ' : '';
  }).trim();
}

/** 箇条書きの項目の最初の 1 文。md は文の途中でも改行するので、行でなく句点で切る。 */
function firstSentence(item: Block[]): string | null {
  const head = item[0];
  if (!head || head.t !== 'p') return null;
  const text = plain(head.inl, true);
  const end = text.indexOf('。');
  const line = end >= 0 ? text.slice(0, end + 1) : text;
  return line === '' ? null : line;
}

export function parseNote(version: string, text: string): ReleaseNote {
  const body = text.replace(/\r\n?/g, '\n').replace(/^\s*# [^\n]*\n+/, '').trim();
  const blocks = parseMarkdown(body);
  // 2 段目の見出しで節に割る。最初の見出しより前は前書きで、要点にも注意にも使わない。
  const sections: { title: string; blocks: Block[] }[] = [];
  for (const b of blocks) {
    if (b.t === 'h' && b.level <= 2) sections.push({ title: plain(b.inl, true), blocks: [] });
    else sections[sections.length - 1]?.blocks.push(b);
  }
  let before: string | null = null;
  const points: string[] = [];
  for (const s of sections) {
    if (BEFORE_HEADING.test(s.title)) {
      if (before !== null) continue;
      const first = s.blocks.find((b) => b.t === 'p' || b.t === 'h');
      if (first && (first.t === 'p' || first.t === 'h')) before = plain(first.inl, true);
      continue;
    }
    if (SENTENCE_HEADING.test(s.title)) { points.push(s.title); continue; }
    const subs = s.blocks.filter((b): b is Extract<Block, { t: 'h' }> => b.t === 'h');
    if (subs.length > 0) { for (const h of subs) points.push(plain(h.inl, true)); continue; }
    for (const b of s.blocks) {
      if (b.t !== 'list') continue;
      for (const it of b.items) { const line = firstSentence(it); if (line) points.push(line); }
    }
  }
  return { version, body, before, points };
}

/**
 * 同梱した md（パスから中身へ）を読み、新しい版から順に並べる。
 * ファイルの名前が版の形（0.7.2.md）でないものと、中身の空のものは捨てる。
 */
export function bundledNotes(files: Record<string, string>): ReleaseNote[] {
  const out: ReleaseNote[] = [];
  for (const [p, text] of Object.entries(files)) {
    const version = /([^/\\]+)\.md$/.exec(p)?.[1];
    if (!version || !VERSION.test(version) || text.trim() === '') continue;
    out.push(parseNote(version, text));
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * 前に見た版（seen）より新しく、いまの版（current）までのノートを、新しい順に返す。
 * 前に見た版が無ければ（この仕組みが入って初めて開いた）、いまの版の分だけを返す。
 */
export function notesBetween(notes: ReleaseNote[], seen: string | null, current: string): ReleaseNote[] {
  // rc はその rc が目指す版として数える。rc で見たノートは、正式版に上げても見せ直さない。
  const to = releaseOf(current);
  if (seen === null) return notes.filter((n) => n.version === to);
  const from = releaseOf(seen);
  return notes.filter((n) => compareVersions(n.version, from) > 0 && compareVersions(n.version, to) <= 0);
}
