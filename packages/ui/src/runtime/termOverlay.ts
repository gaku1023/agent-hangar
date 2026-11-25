import { findReplyRange } from './termReplyMatch.ts';

/**
 * ターミナルの返答の上に、訳を載せる板を付け外しする（docs/design.md「英語の返答の翻訳」のターミナルの節）。
 * 板は xterm の marker と decoration で行に付けるので、スクロールしても付いてくる。
 * 中身は描かない。描くのは画面（views/TermTranslate.tsx）で、ここは板の要素を渡すだけにする。
 */

export type OverlayMarker = { readonly line: number; readonly isDisposed: boolean; dispose(): void };
export type OverlayDecoration = { readonly isDisposed: boolean; onRender(cb: (el: HTMLElement) => void): { dispose(): void }; dispose(): void };
/** 板を付けるのに要る、xterm のうちの一部（runtime/xterm.ts が作る。試験では偽物を使う）。 */
export type OverlayTerm = {
  readonly cols: number;
  /** いまの画面（使っている方の buffer）の全部の行の文字。添字は buffer の行の番号である。 */
  lines(): readonly string[];
  /** buffer の行に印を付ける。付けられなければ null。 */
  mark(line: number): OverlayMarker | null;
  /** 印の行から、x 桁目から width 桁、height 行の板を付ける。付けられなければ null。 */
  decorate(marker: OverlayMarker, box: { x: number; width: number; height: number }): OverlayDecoration | null;
  /** 中身か寸法が変わったら呼ぶ。 */
  onChange(cb: () => void): { dispose(): void };
};

/** 板を付けた返答。el は xterm が板を描くまで null。rows は板の行の数。 */
export type PlacedReply = { text: string; el: HTMLElement | null; rows: number };

/** 書き込みが止んでから探し直すまでの間。Claude Code の描き直しは何回にも分かれて届くので、まとめてから 1 度だけ探す。 */
export const SCAN_DELAY_MS = 150;
/** 板の左端。Claude Code は返答の印（⏺）を 1 桁目に置き、本文を 2 桁字下げする。印は見せたまま、本文だけを覆う。 */
const INDENT = 2;

type Placed = { text: string; marker: OverlayMarker; deco: OverlayDecoration; rows: readonly string[]; el: HTMLElement | null; sub: { dispose(): void } };

export function createReplyOverlays(term: OverlayTerm, onPlaced: (list: PlacedReply[]) => void) {
  let replies: string[] = [];
  const placed = new Map<string, Placed>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dead = false;

  const emit = () => {
    if (dead) return;
    onPlaced(replies.flatMap((text) => { const p = placed.get(text); return p ? [{ text, el: p.el, rows: p.rows.length }] : []; }));
  };
  const drop = (p: Placed) => {
    p.sub.dispose();
    p.deco.dispose();
    p.marker.dispose();
    placed.delete(p.text);
  };
  /** 板の下の行が、付けたときと同じか。違えば Claude Code が描き直したので、板は外す。 */
  const intact = (p: Placed, lines: readonly string[]) => {
    if (p.marker.isDisposed || p.deco.isDisposed || p.marker.line < 0) return false;
    return p.rows.every((row, n) => lines[p.marker.line + n] === row);
  };

  const scan = () => {
    if (dead) return;
    const lines = term.lines();
    let changed = false;
    for (const p of [...placed.values()]) {
      if (replies.includes(p.text) && intact(p, lines)) continue;
      drop(p);
      changed = true;
    }
    const taken = (start: number, end: number) => [...placed.values()].some((p) => start < p.marker.line + p.rows.length && p.marker.line <= end);
    for (const text of replies) {
      if (placed.has(text)) continue;
      const range = findReplyRange(lines, text);
      if (!range || taken(range.start, range.end)) continue;
      const marker = term.mark(range.start);
      if (!marker) continue;
      const deco = term.decorate(marker, { x: INDENT, width: Math.max(1, term.cols - INDENT), height: range.end - range.start + 1 });
      if (!deco) { marker.dispose(); continue; }
      const p: Placed = { text, marker, deco, rows: lines.slice(range.start, range.end + 1), el: null, sub: { dispose() {} } };
      p.sub = deco.onRender((el) => { if (p.el === el) return; p.el = el; emit(); });
      placed.set(text, p);
      changed = true;
    }
    if (changed) emit();
  };

  const change = term.onChange(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; scan(); }, SCAN_DELAY_MS);
  });

  return {
    /** 板を付ける返答（古い順）。同じ中身を渡し直しても付け直さない。 */
    setReplies(next: readonly string[]) {
      if (next.length === replies.length && next.every((x, n) => x === replies[n])) return;
      replies = [...next];
      scan();
    },
    dispose() {
      dead = true;
      if (timer) clearTimeout(timer);
      change.dispose();
      for (const p of [...placed.values()]) drop(p);
    },
  };
}
