import type { PaneNode, PaneSplit } from '../mediator/panes.ts';

/** 節とペインの id。mediator の PaneId（文字列）と同じ。 */
export type PaneId = string;

/**
 * 画面の分割の角。節の境目と、それに接する直交する子の節の境目の交点（T 字）である。
 * 親の節の両方の子が直交する節で、分け目がそろっているとき（十字）は 1 つの角にまとめ、3 本をいっしょに動かす。
 * 木だけから求める純関数で、描画と操作の両方が使う。
 */
export type PaneCorner = {
  /** 親の節の id と子の id から決まる角の id。 */
  id: string;
  node: PaneId;
  dir: 'row' | 'col';
  /** 交わる子の節。a 側の子は親の境目の手前にあり、b 側の子は向こうにある。十字のときは 2 つ。 */
  children: { id: PaneId; side: 'a' | 'b' }[];
};

/** 十字とみなす、2 つの子の分け目の比率の差。両方とも親の全体にわたるので、比率が同じなら画面の位置も同じ。 */
const ALIGNED = 0.001;

/** 節 n 1 つにある角（子の中は見ない）。 */
export function cornersAt(n: PaneSplit): PaneCorner[] {
  const a = n.a.kind === 'split' && n.a.dir !== n.dir ? n.a : null;
  const b = n.b.kind === 'split' && n.b.dir !== n.dir ? n.b : null;
  if (a && b && Math.abs(a.ratio - b.ratio) < ALIGNED) {
    return [{ id: `${n.id}:${a.id}+${b.id}`, node: n.id, dir: n.dir, children: [{ id: a.id, side: 'a' }, { id: b.id, side: 'b' }] }];
  }
  const out: PaneCorner[] = [];
  if (a) out.push({ id: `${n.id}:${a.id}`, node: n.id, dir: n.dir, children: [{ id: a.id, side: 'a' }] });
  if (b) out.push({ id: `${n.id}:${b.id}`, node: n.id, dir: n.dir, children: [{ id: b.id, side: 'b' }] });
  return out;
}

/** 木のすべての角を、深さ優先の順で返す。 */
export function findCorners(root: PaneNode | null): PaneCorner[] {
  const out: PaneCorner[] = [];
  const walk = (n: PaneNode | null) => {
    if (!n || n.kind === 'pane') return;
    out.push(...cornersAt(n));
    walk(n.a);
    walk(n.b);
  };
  walk(root);
  return out;
}

/** 親の節 node の角のうち、子 child の境目に出すもの。十字は先頭の子（a 側）にだけ出す。 */
export function cornerCarriedBy(corners: PaneCorner[], node: PaneId, child: PaneId): PaneCorner | undefined {
  return corners.find((c) => c.node === node && c.children[0]!.id === child);
}

export type PaneRect = { left: number; top: number; width: number; height: number };
export type CornerAxis = 'x' | 'y';

/** つかんだ点からの動きが大きいほうの軸。⇧ を押している間、動くのはこの軸だけ。 */
export function dominantAxis(start: { x: number; y: number }, at: { x: number; y: number }): CornerAxis {
  return Math.abs(at.x - start.x) >= Math.abs(at.y - start.y) ? 'x' : 'y';
}

/**
 * 角をポインタの位置 point まで動かしたときの、各節の比率（pane.resize の中身）。
 * 親の節は dir の向きの軸、子の節はその直交の軸を追う。
 * rects はつかんだときに測った節の矩形。大きさの最小は clamp（clampPaneRatio）に任せる。
 * lock が軸を指すとき、もう一方の軸の節は start の比率のまま動かさない。
 */
export function cornerResizes(
  corner: PaneCorner,
  rects: Record<PaneId, PaneRect>,
  point: { x: number; y: number },
  clamp: (ratio: number, size: number) => number,
  lock: CornerAxis | null = null,
  start: Record<PaneId, number> = {},
): { node: PaneId; ratio: number }[] {
  const parentAxis: CornerAxis = corner.dir === 'row' ? 'x' : 'y';
  const childAxis: CornerAxis = corner.dir === 'row' ? 'y' : 'x';
  const ratioOn = (id: PaneId, axis: CornerAxis): number => {
    if (lock !== null && lock !== axis && start[id] !== undefined) return start[id]!;
    const r = rects[id];
    if (!r) return start[id] ?? 0.5;
    const size = axis === 'x' ? r.width : r.height;
    const at = axis === 'x' ? point.x - r.left : point.y - r.top;
    return size > 0 ? clamp(at / size, size) : (start[id] ?? 0.5);
  };
  return [
    { node: corner.node, ratio: ratioOn(corner.node, parentAxis) },
    ...corner.children.map((c) => ({ node: c.id, ratio: ratioOn(c.id, childAxis) })),
  ];
}

/** 角のダブルクリック。その角に関わる境目だけを 0.5 にする。 */
export function cornerEqualize(corner: PaneCorner): { node: PaneId; ratio: number }[] {
  return [corner.node, ...corner.children.map((c) => c.id)].map((node) => ({ node, ratio: 0.5 }));
}
