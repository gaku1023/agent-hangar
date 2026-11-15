/**
 * メモリの索引（プロジェクトのメモリの MEMORY.md）の競合を、行の和で解く（設計書の設定の同期の節「メモリの索引の統合」）。
 * 純粋な関数で、ファイルも DB も触らない。
 *
 * 2 台の PC は、それぞれ自分を手元、相手を相手として、同じ規則で合わせる。
 * 結果を次の送信で互いに届け合い「一致」になるには、手元と相手を入れ替えても同じバイト列が出なければならない。
 * だから並べ方は「どちらが手元か」に頼らず、2 つの中身だけで決める。
 *
 * 1. 行ごとに名前を付ける。本文のファイルへのリンクを持つ行はそのファイル、持たない行は行の文字列で、同じ名前が重なるときは何番目かを添える。
 * 2. 指す本文のファイルが無い行は、どちらの側からも落とす（present）。
 * 3. 両方にある名前（共通の行）を骨にする。骨の並びが両側で同じならそれを使い、違えば中身の文字列が小さい側の並びを使う。
 * 4. 片側にしか無い行は、その側で直前にあった共通の行の後ろに、その側の順のまま置く。
 *    同じ所に両側の行があるときは、続いた行のかたまりを文字列で比べ、小さい方を先に置く。
 * 5. 同じファイルを指す行の文字列が違えば、本文が新しい側（newer）の行を採る。決められなければ文字列の小さい方を採る。
 *
 * 4 の決まりで、合わせた結果はどちらの側の行の並びも崩さない。
 * そのため、結果をもう一度片方と合わせても変わらない（次の周や 3 台目で揺れない）。
 */

export type MergeOptions = {
  /** 本文のファイル（MEMORY.md からの相対パス）が、合わせた後に手元にあるか。無ければ、その行を落とす。 */
  present: (file: string) => boolean;
  /** そのファイルの本文が新しい側。手元が a、相手が b。決められなければ null。 */
  newer: (file: string) => 'a' | 'b' | null;
};

type Line = { id: string; text: string; file: string | null };

const LINK = /^\s*[-*+]\s+\[[^\]]*\]\(([^)\s]+)\)/;

/** 行頭の箇条にある、MEMORY.md からの相対の .md へのリンク。外への URL、絶対パス、上へ出るパスはリンクと読まない。 */
export function memoryLinkOf(line: string): string | null {
  const m = LINK.exec(line);
  if (!m) return null;
  const target = m[1]!;
  if (!target.endsWith('.md') || target.includes(':') || target.startsWith('/') || target.includes('\\')) return null;
  if (target.split('/').some((s) => s === '..' || s === '.' || s === '')) return null;
  return target;
}

function linesOf(s: string, present: MergeOptions['present']): Line[] {
  if (s === '') return [];
  const raw = s.split(/\r?\n/);
  if (raw[raw.length - 1] === '') raw.pop();
  const seen = new Map<string, number>();
  const out: Line[] = [];
  for (const text of raw) {
    const file = memoryLinkOf(text);
    if (file !== null && !present(file)) continue;
    const key = file !== null ? `f:${file}` : `t:${text}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    out.push({ id: `${key}#${n}`, text, file });
  }
  return out;
}

const join = (ls: readonly Line[]): string => ls.map((l) => l.text).join('\n');
/** 文字列の比べ。言語の設定に左右されないよう、符号の順で比べる。 */
const less = (x: string, y: string): boolean => x < y;

export function mergeMemoryIndex(a: string, b: string, o: MergeOptions): string {
  const la = linesOf(a, o.present);
  const lb = linesOf(b, o.present);
  const byIdA = new Map(la.map((l) => [l.id, l]));
  const byIdB = new Map(lb.map((l) => [l.id, l]));
  const common = new Set(la.filter((l) => byIdB.has(l.id)).map((l) => l.id));

  const ca = la.filter((l) => common.has(l.id)).map((l) => l.id);
  const cb = lb.filter((l) => common.has(l.id)).map((l) => l.id);
  const sameOrder = ca.length === cb.length && ca.every((id, i) => id === cb[i]);
  const spine = sameOrder || !less(join(lb), join(la)) ? ca : cb;

  // 片側だけの行を、その側で直前にあった共通の行（先頭は ''）ごとに集める。
  const gaps = new Map<string, { a: Line[]; b: Line[] }>();
  const gap = (anchor: string) => { let g = gaps.get(anchor); if (!g) { g = { a: [], b: [] }; gaps.set(anchor, g); } return g; };
  for (const [side, ls] of [['a', la], ['b', lb]] as const) {
    let anchor = '';
    for (const l of ls) {
      if (common.has(l.id)) anchor = l.id;
      else gap(anchor)[side].push(l);
    }
  }

  const out: string[] = [];
  const emitGap = (anchor: string): void => {
    const g = gaps.get(anchor);
    if (!g) return;
    const [first, second] = g.a.length && g.b.length && less(join(g.b), join(g.a)) ? [g.b, g.a] : [g.a, g.b];
    for (const l of [...first, ...second]) out.push(l.text);
  };
  const pick = (id: string): string => {
    const x = byIdA.get(id)!;
    const y = byIdB.get(id)!;
    if (x.text === y.text) return x.text;
    const side = x.file !== null ? o.newer(x.file) : null;
    if (side === 'a') return x.text;
    if (side === 'b') return y.text;
    return less(y.text, x.text) ? y.text : x.text;
  };

  emitGap('');
  for (const id of spine) { out.push(pick(id)); emitGap(id); }
  if (out.length === 0) return '';
  const eol = a.includes('\r\n') && b.includes('\r\n') ? '\r\n' : '\n';
  const trailing = a.endsWith('\n') || b.endsWith('\n');
  return out.join(eol) + (trailing ? eol : '');
}
