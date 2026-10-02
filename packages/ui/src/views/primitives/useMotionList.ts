import { useLayoutEffect, useReducer, useRef } from 'react';
import { collapseOut, growIn, markHit, motionOn, riseIn, slideFrom } from './motionKit.ts';

export type MotionListOpts = {
  /** 入る形。rise は浮かぶだけ、grow は高さ（横なら幅）も伸ばして下の行を押す。 */
  enter: 'rise' | 'grow';
  axis?: 'y' | 'x';
  /** 入った行の地を淡い黄から薄れさせる。 */
  hit?: boolean;
  /** 残った行を前の位置から滑らせる。既定は真。 */
  flip?: boolean;
  /** 先頭に足された行（古いものの読み込み）は動かさない。 */
  ignorePrepended?: boolean;
};
export type MotionEntry<T> = { item: T; key: string; leaving: boolean };

type Ghost<T> = { item: T; after: string | null };

/**
 * リストの出入り（設計書「共通の部品」）。
 * 新しい key は入る形で入れ、消えた key は leaving のまま元の位置に残して、畳んで出る形が終わってから落とす。
 * 最初の描画、前の描画が空だった描画、key が全部入れ替わった描画では動かさない（一度に入れ替わったものは、新しい出来事ではない）。
 * 動かない環境（jsdom、reduced motion）では、消えた key をすぐ落とす。
 */
export function useMotionList<T>(items: T[], keyOf: (t: T) => string, opts: MotionListOpts): { list: MotionEntry<T>[]; ref: (key: string) => (el: HTMLElement | null) => void } {
  const nodes = useRef(new Map<string, HTMLElement>());
  const rects = useRef(new Map<string, DOMRect>());
  const ghosts = useRef(new Map<string, Ghost<T>>());
  const leavingStarted = useRef(new Set<string>());
  const prev = useRef<{ item: T; key: string }[]>([]);
  const reset = useRef(false);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  const cur = items.map((item) => ({ item, key: keyOf(item) }));
  const curKeys = new Set(cur.map((c) => c.key));
  const prevKeys = new Set(prev.current.map((p) => p.key));
  // key が全部入れ替わったら、前の行は残さず、入る動きも出さない。
  reset.current = prev.current.length > 0 && cur.length > 0 && !cur.some((c) => prevKeys.has(c.key));
  if (reset.current) ghosts.current.clear();
  else if (motionOn()) {
    prev.current.forEach((p, i) => {
      if (!curKeys.has(p.key) && !ghosts.current.has(p.key)) ghosts.current.set(p.key, { item: p.item, after: i > 0 ? prev.current[i - 1]!.key : null });
    });
  }
  for (const k of [...ghosts.current.keys()]) if (curKeys.has(k)) { ghosts.current.delete(k); leavingStarted.current.delete(k); }

  const list: MotionEntry<T>[] = cur.map((c) => ({ ...c, leaving: false }));
  for (const [key, g] of ghosts.current) {
    const at = g.after === null ? 0 : list.findIndex((e) => e.key === g.after) + 1;
    list.splice(at > 0 || g.after === null ? at : list.length, 0, { item: g.item, key, leaving: true });
  }
  const before = prev.current;
  prev.current = cur;

  useLayoutEffect(() => {
    const now = new Map<string, DOMRect>();
    for (const [k, el] of nodes.current) now.set(k, el.getBoundingClientRect());
    const wasEmpty = rects.current.size === 0;
    if (!wasEmpty && !reset.current) {
      const firstOld = before.find((b) => curKeys.has(b.key))?.key;
      const prepended = new Set<string>();
      if (opts.ignorePrepended && firstOld !== undefined) for (const c of cur) { if (c.key === firstOld) break; prepended.add(c.key); }
      for (const [k, el] of nodes.current) {
        if (ghosts.current.has(k)) {
          if (leavingStarted.current.has(k)) continue;
          leavingStarted.current.add(k);
          void collapseOut(el, opts.axis).then(() => { ghosts.current.delete(k); leavingStarted.current.delete(k); tick(); });
          continue;
        }
        const was = rects.current.get(k);
        if (!was) {
          if (prepended.has(k)) continue;
          if (opts.enter === 'grow') growIn(el, opts.axis); else riseIn(el);
          if (opts.hit) markHit(el);
          continue;
        }
        if (opts.flip !== false) slideFrom(el, was, now.get(k)!);
      }
    }
    rects.current = now;
  });

  return { list, ref: (key) => (el) => { if (el) nodes.current.set(key, el); else nodes.current.delete(key); } };
}
