import { useLayoutEffect, useRef } from 'react';

/**
 * 並びが変わったカードを元の位置から現在位置へ滑らせる（FLIP）。
 * 返した関数を ref に渡すと、その要素の位置を毎回の描画で覚える。
 */
export function useFlip(keys: string[]): (key: string) => (el: HTMLElement | null) => void {
  const nodes = useRef(new Map<string, HTMLElement>());
  const prev = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    // 先に全部の現在位置を測る。測る前に transform を入れると値がずれる。
    const now = new Map<string, DOMRect>();
    for (const [key, el] of nodes.current) now.set(key, el.getBoundingClientRect());
    for (const [key, el] of nodes.current) {
      const before = prev.current.get(key);
      const after = now.get(key);
      if (!before || !after) continue;
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (dx === 0 && dy === 0) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => { el.style.transition = 'transform var(--dur) var(--ease)'; el.style.transform = ''; });
    }
    prev.current = now;
  }, [keys.join('|')]);
  return (key) => (el) => { if (el) nodes.current.set(key, el); else nodes.current.delete(key); };
}
