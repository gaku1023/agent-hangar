/** ペインの外枠の矩形（getBoundingClientRect の値）。 */
export type PaneRect = { id: string; left: number; top: number; right: number; bottom: number };
export type PaneDir = 'left' | 'right' | 'up' | 'down';

/** 向きの先に置かれているとみなす許し幅（境目の太さや丸めの分）。 */
const EPS = 2;

/**
 * 隣のペインを、位置で決める（⌘⌥矢印）。木の順ではなく、画面の矩形で見る。
 * 向きの先にあり、向きと直角の軸で重なる（同じ高さか同じ幅の帯に掛かる）ものを選び、近いものを先にし、近さが同じなら重なりの長いものにする。
 * 重なる相手が無いとき（角どうし）は、向きの先で最も近いものにする。
 * 隣が無ければ null。
 */
export function neighborPane(rects: PaneRect[], from: string, dir: PaneDir): string | null {
  const me = rects.find((x) => x.id === from);
  if (!me) return null;
  const horizontal = dir === 'left' || dir === 'right';
  const cands: { id: string; gap: number; overlap: number; off: number }[] = [];
  for (const o of rects) {
    if (o.id === from) continue;
    // 向きの先までの隙間。負（めり込み）は許し幅の中だけ認める。
    const gap = dir === 'right' ? o.left - me.right : dir === 'left' ? me.left - o.right : dir === 'down' ? o.top - me.bottom : me.top - o.bottom;
    if (gap < -EPS) continue;
    const overlap = horizontal ? Math.min(me.bottom, o.bottom) - Math.max(me.top, o.top) : Math.min(me.right, o.right) - Math.max(me.left, o.left);
    const off = horizontal ? Math.abs((o.top + o.bottom) / 2 - (me.top + me.bottom) / 2) : Math.abs((o.left + o.right) / 2 - (me.left + me.right) / 2);
    cands.push({ id: o.id, gap: Math.max(0, gap), overlap, off });
  }
  const touching = cands.filter((c) => c.overlap > EPS);
  const pool = touching.length ? touching : cands;
  // 重なる相手があるときは近さ、同じなら重なりの長さ。重なる相手が無いときは、近さ、同じなら直角の軸のずれの小さい方。
  pool.sort(touching.length ? (a, b) => a.gap - b.gap || b.overlap - a.overlap : (a, b) => a.gap - b.gap || a.off - b.off);
  return pool[0]?.id ?? null;
}
