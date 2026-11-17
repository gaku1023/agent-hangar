import type { Store } from '../store/store.ts';
import type { SessionRowProps } from './row.ts';
import { nestForest, nestTopsOf, type NestNode } from '@agent-hangar/shared';
import { spawnFoldKey, type NestDot } from './spawnTree.ts';

/**
 * 一覧の根の行。起動元が見えている行（visible）の中に無い行である。ページ送りはこの数で数える。
 * 起動元をたどって輪になるものは、先に出てきた方を根にする。
 */
export function nestTops<T extends { id: string }>(visible: T[], store: Store): T[] {
  // サーバの一覧の形の検索と同じ数え方にする（shared の sessionList.ts）。
  return nestTopsOf(visible, store.sessions);
}

/**
 * 根の行に、起動元の下の子の行を足して並べる（深さ優先）。
 * 子は pool（いまの条件の、状態の絞り込み前の全部）から引くので、状態が起動元と違う子も起動元の下に出る。その子は、自分の区分でも根として平らに出る。
 * 同じ一覧に同じ行を 2 度並べないよう、ほかの根になっている子は起動元の下には足さない。
 * 畳んだ起動元（state.sidebarFolded の spawn:id）の子は並べず、丸だけを toggle に持たせる。
 * tops と pool は id を持つ軽い札で、並べる行だけを rowOf で組む（全件の行を組むと重いため）。
 */
export function nestRows<T extends { id: string }>(tops: T[], pool: T[], store: Store, folded: ReadonlySet<string>, rowOf: (x: T) => SessionRowProps): SessionRowProps[] {
  // 木の組み方（どの子をどの起動元の下に置くか）は、サーバの一覧の形の検索と同じものを使う（shared の sessionList.ts）。
  type Node = { row: SessionRowProps; kids: Node[] };
  const toNode = (n: NestNode<T>): Node => ({ row: rowOf(n.item), kids: n.kids.map(toNode) });
  const flat = (n: Node): SessionRowProps[] => [n.row, ...n.kids.flatMap(flat)];
  const out: SessionRowProps[] = [];
  const emit = (n: Node, depth: number) => {
    const sub = n.kids.flatMap(flat);
    const open = !folded.has(spawnFoldKey(n.row.id));
    const dots: NestDot[] = sub.map((k) => ({ live: k.live, aside: k.aside, reason: k.reason ?? null }));
    out.push({ ...n.row, nest: { depth, toggle: sub.length > 0 ? { open, dots } : null } });
    if (open) for (const k of n.kids) emit(k, depth + 1);
  };
  for (const n of nestForest(tops, pool, store.sessions)) emit(toNode(n), 0);
  return out;
}
