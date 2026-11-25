import { findReplyRange } from './termReplyMatch.ts';

/**
 * ターミナルの英語の返答のマスを、日本語の訳で直に上書きする（docs/design.md「英語の返答の翻訳」のターミナルの節）。
 * 行の数は変えない。訳を英語と同じ行の数に折り返し、余りは空白にし、はみ出しは末尾を … で切る。
 * 訳は端末の本物の文字になるので、選択もコピーも日本語で取れる。
 * Claude Code や tmux が描き直して英語に戻ったら、次の見回りで書き直す。
 */

export type RewriteMarker = { readonly line: number; readonly isDisposed: boolean; dispose(): void };
export type RewriteDecoration = { readonly isDisposed: boolean; onRender(cb: (el: HTMLElement) => void): { dispose(): void }; dispose(): void };

/** 上書きに要る、xterm のうちの一部（runtime/xtermRewrite.ts が作る。試験では偽物を使う）。 */
export type RewriteTerm = {
  readonly cols: number;
  /** いまの画面（使っている方の buffer）の全部の行の文字（右の空白は落とす）。添字は buffer の行の番号。 */
  lines(): readonly string[];
  /** buffer の行の、x 桁目から右の文字（右の空白は落とす）。 */
  cellsFrom(line: number, x: number): string;
  /** buffer の行の、x0 桁目から x1 桁目の手前までの文字。 */
  cellsRange(line: number, x0: number, x1: number): string;
  /** 文字の列が端末で占める桁の数。 */
  width(s: string): number;
  /** buffer の行の x 桁目から右を、色と飾りごと書き戻せる列にする（原文に戻すため）。 */
  snapshot(line: number, x: number): string;
  /**
   * buffer の行の x 桁目から右を書き換える。seq は、そのまま端末へ流す列（文字と SGR）。行の残りは消す。
   * 見えていない行と、出力がエスケープの途中で切れているときは書かずに false を返す（次の見回りでやり直す）。
   */
  paint(x: number, rows: readonly { line: number; seq: string }[]): boolean;
  /** buffer の行に印を付ける。付けられなければ null。 */
  mark(line: number): RewriteMarker | null;
  /** 印の行の x 桁目から、width 桁の 1 行の小さな板を付ける（原文に戻すアイコンを置く）。 */
  decorate(marker: RewriteMarker, box: { x: number; width: number }): RewriteDecoration | null;
  /**
   * 端末が OSC 52 で写したもの（Claude Code の選択や tmux のコピーモードの写し）を、クリップボードへ書く前に通す口。null で外す。
   * drag は、写しの直前に端末の上でドラッグした範囲（無ければ null）。
   */
  setCopyMap(map: ((text: string, drag: CopyDrag | null) => string) | null): void;
  /**
   * tmux に画面を全部描き直させる。上書きした行の一部だけが英語で描き直され、英語と訳の混ざった行が残ったときに使う。
   * 無い（tmux を挟まない端末、試験の偽物）なら頼まない。
   */
  redraw?(): void;
  /** 中身か寸法が変わったら呼ぶ。 */
  onChange(cb: () => void): { dispose(): void };
};

/** 端末の上でドラッグした範囲。x は桁、y は buffer の行の番号。 */
export type CopyDrag = { start: { x: number; y: number }; end: { x: number; y: number } };

/** 返答ごとの様子。wait は訳を待っている、ja は訳を書いた、orig は利用者が原文に戻した。 */
export type ReplyState = 'wait' | 'ja' | 'orig';
/** アイコンを置いた返答。el は xterm が板を描くまで null。 */
export type PlacedReply = { text: string; state: ReplyState; el: HTMLElement | null };

/** 見回りの間。書き込みのたびに先送りせず、最初の書き込みから数えてこの間で 1 度見る（描き直しの最中でも遅れない）。 */
export const REWRITE_DELAY_MS = 40;
/** 書き込みの最中で書けなかったときに、もう一度見るまでの間。 */
const RETRY_MS = 16;
/** 書き換える左端。Claude Code は返答の印（⏺）を 1 桁目に置き、本文を 2 桁字下げする。印は残し、本文だけを書き換える。 */
export const INDENT = 2;
/** アイコンの板の幅（桁）。 */
const BUTTON_COLS = 2;

/** Markdown の記号を、Claude Code が画面で落とす分だけ落とす。 */
export function plainOf(md: string): string {
  return md
    .replace(/^```[^\n]*$/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1')
    // 端末の制御になる文字は書かない。
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/** 幅 width の桁に折り返す。続く空行は 1 つにまとめ、頭と末尾の空行は落とす。 */
export function wrapCells(text: string, width: number, cellWidth: (ch: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let cur = '';
    let w = 0;
    for (const ch of Array.from(para.trimEnd())) {
      const cw = cellWidth(ch);
      if (w + cw > width && cur !== '') {
        out.push(cur);
        cur = '';
        w = 0;
        if (ch === ' ') continue;
      }
      cur += ch;
      w += cw;
    }
    out.push(cur);
  }
  const rows = out.filter((l, i) => !(l === '' && out[i - 1] === ''));
  while (rows[0] === '') rows.shift();
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return rows;
}

/**
 * 訳の行を height 行に収める。
 * 短ければ下を空ける。cut（返答の頭が画面の上に切れていて、見えているのは英語の下の部分）なら、訳の末尾を下端にそろえて上を空ける。
 * 長ければ、cut でなければ下を切って最後の行の末尾を …、cut なら上を切って最初の行を … にする。
 */
export function fitRows(rows: readonly string[], height: number, cut: boolean): string[] {
  if (height <= 0) return [];
  if (rows.length <= height) {
    const pad = Array<string>(height - rows.length).fill('');
    return cut ? [...pad, ...rows] : [...rows, ...pad];
  }
  if (cut) return ['…', ...rows.slice(rows.length - height + 1)];
  const head = rows.slice(0, height);
  head[height - 1] = `${Array.from(head[height - 1]!).slice(0, -1).join('')}…`;
  return head;
}


type Painted = { text: string; line: number; ja: string[]; enSeq: string[] };
type Spot = { text: string; line: number; state: ReplyState; marker: RewriteMarker; deco: RewriteDecoration; el: HTMLElement | null; sub: { dispose(): void } };

export type TranslateFn = { cached(text: string): string | null; translate(text: string): Promise<string | null> };

export function createReplyRewrites(term: RewriteTerm, api: TranslateFn, onPlaced: (list: PlacedReply[]) => void) {
  let replies: string[] = [];
  let orig = new Set<string>();
  /** 訳。null は訳せなかったこと。無ければまだ訳していない。 */
  const ja = new Map<string, string | null>();
  const asked = new Set<string>();
  const painted = new Map<string, Painted>();
  const spots = new Map<string, Spot>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dead = false;

  const kick = (ms = REWRITE_DELAY_MS) => {
    if (dead || timer) return;
    timer = setTimeout(() => { timer = null; scan(); }, ms);
  };

  const translated = (text: string): string | null | undefined => {
    if (ja.has(text)) return ja.get(text);
    const hit = api.cached(text);
    if (hit !== null) { ja.set(text, hit); return hit; }
    if (!asked.has(text)) {
      asked.add(text);
      void api.translate(text).then((out) => { ja.set(text, out); kick(0); }, () => { ja.set(text, null); });
    }
    return undefined;
  };

  const emit = () => {
    if (dead) return;
    onPlaced(replies.flatMap((text) => { const s = spots.get(text); return s ? [{ text, state: s.state, el: s.el }] : []; }));
  };
  const dropSpot = (s: Spot) => { s.sub.dispose(); s.deco.dispose(); s.marker.dispose(); spots.delete(s.text); };
  /** アイコンを返答の頭の行に置く。同じ行に同じ様子で置いてあれば触らない。 */
  const place = (text: string, line: number, state: ReplyState): boolean => {
    const had = spots.get(text);
    if (had && !had.marker.isDisposed && had.marker.line === line) {
      if (had.state === state) return false;
      had.state = state;
      return true;
    }
    if (had) dropSpot(had);
    const marker = term.mark(line);
    if (!marker) return !!had;
    const deco = term.decorate(marker, { x: Math.max(0, term.cols - BUTTON_COLS), width: BUTTON_COLS });
    if (!deco) { marker.dispose(); return !!had; }
    const s: Spot = { text, line, state, marker, deco, el: null, sub: { dispose() {} } };
    s.sub = deco.onRender((el) => { if (s.el === el) return; s.el = el; emit(); });
    spots.set(text, s);
    return true;
  };

  const same = (line: number, rows: readonly string[]) => line >= 0 && rows.every((row, n) => term.cellsFrom(line + n, INDENT) === row.trimEnd());
  /** 書いた訳が行ごと動いた先の頭の行。見つからなければ null。 */
  const moved = (count: number, p: Painted): number | null => {
    const k = p.ja.findIndex((r) => r !== '');
    if (k < 0) return null;
    for (let l = count - 1; l >= 0; l--) {
      if (l === p.line + k || term.cellsFrom(l, INDENT) !== p.ja[k]!.trimEnd()) continue;
      if (same(l - k, p.ja)) return l - k;
    }
    return null;
  };

  const scan = () => {
    if (dead) return;
    const lines = term.lines();
    const width = Math.max(1, term.cols - INDENT);
    let changed = false;
    let retry = false;
    let redraw = false;
    const seen = new Set<string>();
    const taken: [number, number][] = [];
    const overlaps = (a: number, b: number) => taken.some(([s, e]) => a <= e && s <= b);

    for (const text of [...replies].reverse()) {
      const p = painted.get(text);
      // tmux が画面を上へずらすと、書いた訳は行ごと動く。動いた先を探す。
      if (p && !same(p.line, p.ja)) { const to = moved(lines.length, p); if (to !== null) p.line = to; }
      if (p && same(p.line, p.ja)) {
        taken.push([p.line, p.line + p.ja.length - 1]);
        if (orig.has(text)) {
          // 原文に戻す。書いたときに取っておいた英語を、色と飾りごと書き戻す。
          if (term.paint(INDENT, p.enSeq.map((seq, n) => ({ line: p.line + n, seq })))) painted.delete(text);
          else retry = true;
          changed = place(text, p.line, 'orig') || changed;
        } else {
          changed = place(text, p.line, 'ja') || changed;
        }
        seen.add(text);
        continue;
      }
      // 描き直されて英語に戻ったか、押し出された。英語の行を探し直す。
      if (p) painted.delete(text);
      const range = findReplyRange(lines, text);
      // 訳も英語も見つからないのは、行の一部だけが英語で描き直されて混ざったか、画面から消えたときである。混ざりを残さないよう、tmux に描き直させる。
      if (p && !range) redraw = true;
      if (!range || overlaps(range.start, range.end)) continue;
      taken.push([range.start, range.end]);
      if (orig.has(text)) { seen.add(text); changed = place(text, range.start, 'orig') || changed; continue; }
      const out = translated(text);
      // 訳せなかったものは英語のまま、アイコンも置かない。
      if (out === null) continue;
      seen.add(text);
      if (out === undefined) { changed = place(text, range.start, 'wait') || changed; continue; }
      const height = range.end - range.start + 1;
      const rows = fitRows(wrapCells(plainOf(out), width, (ch) => term.width(ch)), height, range.cut === true);
      const enSeq = Array.from({ length: height }, (_, n) => term.snapshot(range.start + n, INDENT));
      if (term.paint(INDENT, rows.map((r, n) => ({ line: range.start + n, seq: r })))) {
        painted.set(text, { text, line: range.start, ja: rows, enSeq });
        changed = place(text, range.start, 'ja') || changed;
      } else {
        retry = true;
        changed = place(text, range.start, 'wait') || changed;
      }
    }
    for (const s of [...spots.values()]) if (!seen.has(s.text)) { dropSpot(s); changed = true; }
    for (const text of [...painted.keys()]) if (!seen.has(text)) painted.delete(text);
    if (changed) emit();
    if (redraw) term.redraw?.();
    if (retry) kick(RETRY_MS);
  };

  /**
   * ドラッグで写したもの（OSC 52）を、画面に見えている文字に取り直す。
   * 写しを作るのは中のアプリ（Claude Code の選択、tmux のコピーモード）で、どちらも英語の本文から写す。
   * ドラッグの範囲が訳を書いた行にかかっていれば、その範囲のマスの文字（訳）を写しにする。かかっていなければ写しのまま。
   * 訳の行は折り返しなので、同じ返答の中の続く行は改行を挟まずにつなぎ、字下げ（印の 2 桁）は落とす。
   */
  const mapCopy = (copied: string, drag: CopyDrag | null): string => {
    if (!drag) return copied;
    const [a, b] = drag.start.y < drag.end.y || (drag.start.y === drag.end.y && drag.start.x <= drag.end.x) ? [drag.start, drag.end] : [drag.end, drag.start];
    if (a.y === b.y && a.x === b.x) return copied;
    const owner = (y: number) => [...painted.values()].find((p) => !orig.has(p.text) && y >= p.line && y < p.line + p.ja.length) ?? null;
    let hit = false;
    for (let y = a.y; y <= b.y && !hit; y++) hit = owner(y) !== null;
    if (!hit) return copied;
    let out = '';
    let prev: { p: Painted | null; text: string } | null = null;
    for (let y = a.y; y <= b.y; y++) {
      const p = owner(y);
      const from = Math.max(y === a.y ? a.x : 0, p ? INDENT : 0);
      const to = y === b.y ? b.x + 1 : term.cols;
      const text = term.cellsRange(y, from, to).trimEnd();
      if (prev) out += prev.p && prev.p === p && prev.text !== '' && text !== '' ? '' : '\n';
      out += text;
      prev = { p, text };
    }
    return out.replace(/\n{3,}/g, '\n\n').trim();
  };
  term.setCopyMap(mapCopy);

  const change = term.onChange(() => kick());

  return {
    /** 訳を書く返答（古い順）。同じ中身を渡し直しても見直さない。 */
    setReplies(next: readonly string[]) {
      if (next.length === replies.length && next.every((x, n) => x === replies[n])) return;
      replies = [...next];
      scan();
    },
    /** 原文に戻した返答。 */
    setOriginal(next: ReadonlySet<string>) {
      orig = new Set(next);
      scan();
    },
    dispose() {
      dead = true;
      if (timer) clearTimeout(timer);
      change.dispose();
      term.setCopyMap(null);
      for (const s of [...spots.values()]) dropSpot(s);
      // 外すとき（設定を切った、タブを閉じた）は、書いた訳を英語に戻しておく。
      for (const p of painted.values()) term.paint(INDENT, p.enSeq.map((seq, n) => ({ line: p.line + n, seq })));
      painted.clear();
    },
  };
}
