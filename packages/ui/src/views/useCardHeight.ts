import { useLayoutEffect, useRef, type RefObject } from 'react';
import { resizeFrom } from './primitives/motionKit.ts';

/** 保つ背が右の列の背のこれを超えないようにする。小さい窓で、札が目次を押しつぶさないため。 */
const HOLD_SHARE = 0.6;

/**
 * 札の背を中身に合わせる（2026-10-12 の試作の案 k）。
 * 右の列は札の下に目次を積むので、札の背が替わるたびに目次が押されて跳ねる。
 * そこで、伸びるのはすぐ（動きつき）にし、縮むのは節目（phase が替わったとき）だけにする。時間では縮めない。
 * 節目の間は前の背を保つので、手の数や意図の折り返しで背が上下しても目次は動かない。
 * 中身の箱（body）を ResizeObserver で測り、札（card）の style.height に書く。札の余白は中身の箱が持つ。
 * 保つ背には右の列の 6 割の上限を掛ける。中身がそれより高ければ中身に合わせる（中身を切らない）。
 * 幅が替わったとき（折り返しが替わる）とセッションが替わったときは、保った背を捨て、動かさずに中身へ合わせ直す。
 */
export function useCardHeight<C extends HTMLElement, B extends HTMLElement>(sessionId: string, phase: string): { card: RefObject<C | null>; body: RefObject<B | null> } {
  const card = useRef<C>(null);
  const body = useRef<B>(null);
  // 節目の鍵の見た値と、合わせ直す手。セッションごとの setup が作り、節目の effect が呼ぶ。
  const live = useRef<{ phase: string; fit: ((shrink: boolean) => void) | null }>({ phase, fit: null });

  useLayoutEffect(() => {
    const c = card.current;
    const b = body.current;
    if (!c || !b || typeof ResizeObserver === 'undefined') return;
    let held = 0;
    let width = -1;
    let anim: Animation | null = null;
    const apply = (h: number, move: boolean) => {
      const next = `${h}px`;
      if (c.style.height === next) return;
      // 動いている途中なら、いま見えている背から動かし直す。
      const from = c.getBoundingClientRect().height;
      anim?.cancel();
      anim = null;
      c.style.height = next;
      if (move) anim = resizeFrom(c, from);
    };
    const fit = (shrink: boolean) => {
      const rect = b.getBoundingClientRect();
      const natural = Math.ceil(rect.height);
      const reset = rect.width !== width;
      width = rect.width;
      if (reset || shrink || natural > held) held = natural;
      const column = c.parentElement?.clientHeight ?? 0;
      const cap = column > 0 ? Math.floor(column * HOLD_SHARE) : Infinity;
      apply(Math.max(natural, Math.min(held, cap)), !reset);
    };
    // この描画の鍵を見た値にする（setup はセッションが替わったときだけ走る）。
    live.current = { phase, fit };
    fit(true);
    const ro = new ResizeObserver(() => fit(false));
    ro.observe(b);
    if (c.parentElement) ro.observe(c.parentElement);
    return () => {
      ro.disconnect();
      anim?.cancel();
      c.style.height = '';
      live.current.fit = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 鍵が替わっただけでは測り直さない（下の節目の effect が縮める）。
  }, [sessionId]);

  // 節目。セッションの setup の後に走るので、セッションが替わった描画では見た値がそろっていて何もしない。
  useLayoutEffect(() => {
    if (live.current.phase === phase) return;
    live.current.phase = phase;
    live.current.fit?.(true);
  }, [phase]);

  return { card, body };
}
