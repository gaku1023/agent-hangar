import { countHits } from './highlight.ts';
import { mdLeaves, parseMarkdown } from './markdown.ts';
import type { TranscriptItem } from './session.ts';
import { toolLeaves } from './tools.ts';

/**
 * 本文の中の検索（⌘F）の欄の状態。その場の操作なので保存せず、View の側に持つ（views/findStore.tsx）。
 * from は語を打ったときに見ていた行の seq で、そこから後ろの最初の一致から数える。step はそこから進めた数。
 * n は ⌘F を押した回数で、押すたびに欄へフォーカスを戻す合図にする。
 */
export type FindState = { query: string; caseSensitive: boolean; from: number | null; step: number; n: number };

/**
 * 本文の中の検索（⌘F）。
 * 本文は仮想スクロールで、窓の外の行は DOM に無い。一致はデータで数え、描いた印の何番目かへ跳ぶ。
 * 数える単位は、描くときに印の部品（views/primitives/Hl.tsx）へ渡す文字の葉である。
 * 検索語は 1 行なので、葉を行で割っても数は変わらない。
 */

/** Markdown を葉に割った結果の控え。本文の文字を鍵にし、溢れたら捨て直す。 */
const mdCache = new Map<string, string[]>();
const MD_CACHE_MAX = 4000;
function markdownLeaves(text: string): string[] {
  const hit = mdCache.get(text);
  if (hit) return hit;
  const leaves = mdLeaves(parseMarkdown(text));
  if (mdCache.size >= MD_CACHE_MAX) mdCache.clear();
  mdCache.set(text, leaves);
  return leaves;
}

/** 1 行の文字の葉。描く順に並べる。 */
export function itemLeaves(it: TranscriptItem): string[] {
  switch (it.kind) {
    case 'user': case 'system': return [it.text];
    case 'assistant': case 'thinking': return markdownLeaves(it.text);
    case 'tool': return toolLeaves(it.view);
    case 'meta': return [`${it.name} ${it.json}`];
  }
}

/**
 * 検索の結果。hits は seq ごとの一致の数（一致のある行だけ）、ticks は一致のある行の seq（スクロールバーの印）。
 * current は全体の中での今の一致の番号（無ければ -1）、seq と ordinal はその一致がある行と、行の中での番号。
 */
export type FindResult = { total: number; hits: Map<number, number>; ticks: number[]; current: number; seq: number | null; ordinal: number };
/** 本文に渡す検索の形。欄の状態と、数えた結果を合わせたもの。 */
export type TranscriptFind = FindState & FindResult;

export function findIn(items: TranscriptItem[], f: FindState): FindResult {
  const hits = new Map<number, number>();
  const order: { seq: number; count: number }[] = [];
  let total = 0;
  if (f.query !== '') {
    const opts = { literal: true, caseSensitive: f.caseSensitive };
    for (const it of items) {
      let n = 0;
      for (const leaf of itemLeaves(it)) n += countHits(leaf, f.query, opts);
      if (n === 0) continue;
      hits.set(it.seq, n);
      order.push({ seq: it.seq, count: n });
      total += n;
    }
  }
  const ticks = order.map((o) => o.seq);
  if (total === 0) return { total, hits, ticks, current: -1, seq: null, ordinal: 0 };
  // 数え始めは、開いたときに見ていた位置（from）より後ろの最初の一致。後ろに無ければ先頭へ戻る。
  let base = 0;
  if (f.from !== null) {
    let acc = 0;
    const at = order.findIndex((o) => { if (o.seq >= f.from!) return true; acc += o.count; return false; });
    base = at < 0 ? 0 : acc;
  }
  const current = (((base + f.step) % total) + total) % total;
  let rest = current;
  for (const o of order) {
    if (rest < o.count) return { total, hits, ticks, current, seq: o.seq, ordinal: rest };
    rest -= o.count;
  }
  return { total, hits, ticks, current: -1, seq: null, ordinal: 0 };
}
