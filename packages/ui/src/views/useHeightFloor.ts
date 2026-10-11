import { useLayoutEffect, useRef, type RefObject } from 'react';

/** 下限が親の高さのこれを超えないようにする。小さい窓で、札が目次を押しつぶさないため。 */
const FLOOR_SHARE = 0.6;

/**
 * 箱の高さの下限を、見た一番高い高さまで上げていく（縮めない）。
 * 右の列は札の下に目次を積むので、札の中身（意図の折り返し、手の数、問い、サブエージェント）で札の高さが替わるたびに、
 * 目次が押されて跳ねる。下限を引き上げ続ければ、札は伸びるだけで縮まず、跳ねるのは新しい最大を見た一度だけになる。
 * 幅が変わったときは折り返しが替わるので、下限を捨てて測り直す。key（セッション）が替わったときも捨てる。
 * 下限は style.minHeight に直に書く（描き直さない）。
 */
export function useHeightFloor<T extends HTMLElement>(key: string): RefObject<T | null> {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let floor = 0;
    let lastWidth = -1;
    const measure = () => {
      let rect = el.getBoundingClientRect();
      if (rect.width !== lastWidth) { lastWidth = rect.width; floor = 0; el.style.minHeight = ''; rect = el.getBoundingClientRect(); }
      // 下限を掛けた高さは下限より低くならない。下限を超えたとき（中身が新しい最大になったとき）だけ引き上げる。
      const natural = Math.ceil(rect.height);
      if (natural <= floor) return;
      floor = natural;
      const parent = el.parentElement?.clientHeight ?? 0;
      el.style.minHeight = `${parent > 0 ? Math.min(floor, Math.floor(parent * FLOOR_SHARE)) : floor}px`;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { ro.disconnect(); el.style.minHeight = ''; };
  }, [key]);
  return ref;
}
