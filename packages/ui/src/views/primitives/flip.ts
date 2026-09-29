import { useLayoutEffect, useRef } from 'react';
import { motionEase, motionMs, motionValue } from './motion.ts';

/**
 * 並びが変わったカードを元の位置から現在位置へ滑らせる（FLIP）。
 * 新しく入ったカードは、ぼかしが晴れながら現れる。
 * ぼかしは 20% で晴らし切る（base.css の @keyframes enter と同じ理由で、WebKit が細いぼかしを 1px に丸めるため）。
 * 最初の描画では全部が新しいので、画面の入る動き（.screen の enter）に任せて動かさない。
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
      if (!after) continue;
      if (!before) {
        if (prev.current.size > 0 && typeof el.animate === 'function') {
          el.animate([{ opacity: 0, transform: `translateY(${motionValue('--rise')})`, filter: `blur(${motionValue('--blur-in')})` }, { offset: 0.2, filter: 'none' }, { opacity: 1, transform: 'none', filter: 'none' }], { duration: motionMs('--dur'), easing: motionEase('--ease-out') });
        }
        continue;
      }
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (dx === 0 && dy === 0) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => { el.style.transition = 'transform var(--dur) var(--ease-out)'; el.style.transform = ''; });
    }
    prev.current = now;
  }, [keys.join('|')]);
  return (key) => (el) => { if (el) nodes.current.set(key, el); else nodes.current.delete(key); };
}
