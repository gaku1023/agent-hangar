import type { Store } from '../store/store.ts';
import type { SessionRowProps } from './row.ts';
import { spawnFoldKey, spawnParentOf, type NestDot } from './spawnTree.ts';

/**
 * 一覧の根の行。起動元が見えている行（visible）の中に無い行である。ページ送りはこの数で数える。
 * 起動元をたどって輪になるものは、先に出てきた方を根にする。
 */
export function nestTops<T extends { id: string }>(visible: T[], store: Store): T[] {
  const ids = new Set(visible.map((r) => r.id));
  const tops: T[] = [];
  const reach = (id: string): boolean => {
    // 起動元の連なりが、自分に戻らずに見えている行へ着くか。着かなければ根。
    const seen = new Set<string>([id]);
    for (let p = spawnParentOf(store.sessions, id); p !== null; p = spawnParentOf(store.sessions, p)) {
      if (seen.has(p)) return false;
      if (ids.has(p)) return true;
      seen.add(p);
    }
    return false;
  };
  for (const r of visible) {
    const p = spawnParentOf(store.sessions, r.id);
    if (p === null || !ids.has(p) || !reach(r.id)) tops.push(r);
  }
  return tops;
}

/**
 * 根の行に、起動元の下の子の行を足して並べる（深さ優先）。
 * 子は pool（いまの条件の、状態の絞り込み前の全部）から引くので、状態が起動元と違う子も起動元の下に出る。その子は、自分の区分でも根として平らに出る。
 * 同じ一覧に同じ行を 2 度並べないよう、ほかの根になっている子は起動元の下には足さない。
 * 畳んだ起動元（state.sidebarFolded の spawn:id）の子は並べず、丸だけを toggle に持たせる。
 * tops と pool は id を持つ軽い札で、並べる行だけを rowOf で組む（全件の行を組むと重いため）。
 */
export function nestRows<T extends { id: string }>(tops: T[], pool: T[], store: Store, folded: ReadonlySet<string>, rowOf: (x: T) => SessionRowProps): SessionRowProps[] {
  const kids = new Map<string, T[]>();
  for (const r of pool) {
    const p = spawnParentOf(store.sessions, r.id);
    if (p !== null) kids.set(p, [...kids.get(p) ?? [], r]);
  }
  const topIds = new Set(tops.map((r) => r.id));
  // 1 度並べた行は、別の起動元の下にも輪の先にも並べない。
  const seen = new Set<string>(topIds);
  type Node = { row: SessionRowProps; kids: Node[] };
  const build = (x: T): Node => {
    const ks = (kids.get(x.id) ?? []).filter((k) => !seen.has(k.id));
    for (const k of ks) seen.add(k.id);
    return { row: rowOf(x), kids: ks.map(build) };
  };
  const flat = (n: Node): SessionRowProps[] => [n.row, ...n.kids.flatMap(flat)];
  const out: SessionRowProps[] = [];
  const emit = (n: Node, depth: number) => {
    const sub = n.kids.flatMap(flat);
    const open = !folded.has(spawnFoldKey(n.row.id));
    const dots: NestDot[] = sub.map((k) => ({ live: k.live, aside: k.aside, reason: k.reason ?? null }));
    out.push({ ...n.row, nest: { depth, toggle: sub.length > 0 ? { open, dots } : null } });
    if (open) for (const k of n.kids) emit(k, depth + 1);
  };
  for (const r of tops) emit(build(r), 0);
  return out;
}
