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
  /** 同じ key が別のものを指す範囲（セッション、サブエージェントなど）。替わった描画は、新しい出来事ではなく切り替えとして動かさない。 */
  scope?: string;
};
export type MotionEntry<T> = { item: T; key: string; leaving: boolean };

type Ghost<T> = { item: T; after: string | null };

/**
 * リストの出入り（設計書「共通の部品」）。
 * 新しい key は入る形で入れ、消えた key は leaving のまま元の位置に残して、畳んで出る形が終わってから落とす。
 * 最初の描画、前の描画が空だった描画、key が全部入れ替わった描画では動かさない（一度に入れ替わったものは、新しい出来事ではない）。
 * 空になる描画と scope が替わった描画も、同じく切り替えとして扱う（消えた行を畳まず、次の描画の入りも動かさない）。
 * 動かない環境（jsdom、reduced motion）では、消えた key をすぐ落とす。
 * 出る途中で戻った key は、動きを取り消して元の姿に戻す。並べ替えの滑りは、残った行の並びが替わった描画だけで出す（スクロールや resize で位置が替わっただけの描画では出さない）。
 * 描画の中で ref を書き換えるので、StrictMode や、捨てられる並行描画のもとでは安全ではない（この画面では使っていない）。
 */
export function useMotionList<T>(items: T[], keyOf: (t: T) => string, opts: MotionListOpts): { list: MotionEntry<T>[]; ref: (key: string) => (el: HTMLElement | null) => void } {
  const nodes = useRef(new Map<string, HTMLElement>());
  // 前の描画で描いていた行。滑らせるときだけ位置も持つ（flip が偽なら測らず null を置く）。
  const rects = useRef(new Map<string, DOMRect | null>());
  const ghosts = useRef(new Map<string, Ghost<T>>());
  const leavingStarted = useRef(new Map<string, object>());
  const prev = useRef<{ item: T; key: string }[]>([]);
  const reset = useRef(false);
  const lastScope = useRef(opts.scope);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  const cur = items.map((item) => ({ item, key: keyOf(item) }));
  const curKeys = new Set(cur.map((c) => c.key));
  const prevKeys = new Set(prev.current.map((p) => p.key));
  // key が全部入れ替わったら、前の行は残さず、入る動きも出さない。
  const scopeChanged = lastScope.current !== opts.scope;
  lastScope.current = opts.scope;
  reset.current = scopeChanged || cur.length === 0 || (prev.current.length > 0 && !cur.some((c) => prevKeys.has(c.key)));
  if (reset.current) { ghosts.current.clear(); leavingStarted.current.clear(); }
  else if (motionOn()) {
    prev.current.forEach((p, i) => {
      if (!curKeys.has(p.key) && !ghosts.current.has(p.key)) ghosts.current.set(p.key, { item: p.item, after: i > 0 ? prev.current[i - 1]!.key : null });
    });
  }
  const revived: string[] = [];
  for (const k of [...ghosts.current.keys()]) if (curKeys.has(k)) { ghosts.current.delete(k); leavingStarted.current.delete(k); revived.push(k); }

  const list: MotionEntry<T>[] = cur.map((c) => ({ ...c, leaving: false }));
  for (const [key, g] of ghosts.current) {
    const at = g.after === null ? 0 : list.findIndex((e) => e.key === g.after) + 1;
    list.splice(at > 0 || g.after === null ? at : list.length, 0, { item: g.item, key, leaving: true });
  }
  // 並びの比べは、前の描画と今の描画の両方にある行の、互いの順だけで見る。
  // 足した行や消えた行は並びの替わりではない（足した行の下の行は、伸びる行に押されて動くので、さらに滑らせると二重に動く）。
  const before = prev.current;
  const kept = cur.filter((c) => prevKeys.has(c.key)).map((c) => c.key);
  const keptBefore = before.filter((b) => curKeys.has(b.key)).map((b) => b.key);
  const reordered = kept.some((k, i) => k !== keptBefore[i]);
  prev.current = cur;
  const flip = opts.flip !== false;

  useLayoutEffect(() => {
    const now = new Map<string, DOMRect | null>();
    for (const [k, el] of nodes.current) now.set(k, flip ? el.getBoundingClientRect() : null);
    const wasEmpty = rects.current.size === 0;
    // 出る途中で戻った行は、畳む動きの最後の形（高さ 0、薄れ切り）を残さず取り消す。
    for (const k of revived) nodes.current.get(k)?.getAnimations?.().forEach((a) => a.cancel());
    if (!wasEmpty && !reset.current) {
      const firstOld = before.find((b) => curKeys.has(b.key))?.key;
      const prepended = new Set<string>();
      if (opts.ignorePrepended && firstOld !== undefined) for (const c of cur) { if (c.key === firstOld) break; prepended.add(c.key); }
      for (const [k, el] of nodes.current) {
        if (ghosts.current.has(k)) {
          if (leavingStarted.current.has(k)) continue;
          const mine = {};
          leavingStarted.current.set(k, mine);
          // 取り消されても解決するので、まだ自分の出る動きのときだけ落とす（戻って、また消えた行を巻き込まない）。
          void collapseOut(el, opts.axis).then(() => { if (leavingStarted.current.get(k) !== mine) return; ghosts.current.delete(k); leavingStarted.current.delete(k); tick(); });
          continue;
        }
        if (!rects.current.has(k)) {
          if (prepended.has(k)) continue;
          if (opts.enter === 'grow') growIn(el, opts.axis); else riseIn(el);
          if (opts.hit) markHit(el);
          continue;
        }
        const was = rects.current.get(k);
        if (reordered && was) slideFrom(el, was, now.get(k)!);
      }
    }
    // 切り替えの描画のあとは、空から埋まる描画と同じに扱う（次の描画の入りも動かさない）。
    rects.current = reset.current ? new Map() : now;
  });

  return { list, ref: (key) => (el) => { if (el) nodes.current.set(key, el); else nodes.current.delete(key); } };
}
