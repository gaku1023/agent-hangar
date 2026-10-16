import { useEffect, useLayoutEffect, useState } from 'react';

/**
 * 出入りの段階。
 * - initial：最初に並べたもの。薄れから現す（styles.css の .m-fade、PC の motionKit の fadeIn）。
 * - enter：あとから増えたもの。高さを伸ばして入る（.m-grow、growIn）。
 * - stay：前からあるもの。動かさない。
 * - leave：消えたもの。畳んで出る（.m-collapse、collapseOut）。畳み終わるまで前の中身のまま残す。
 */
export type Phase = 'initial' | 'enter' | 'stay' | 'leave';
export type Present<T> = { key: string; item: T; phase: Phase };

export const phaseClass = (p: Phase): string => (p === 'initial' ? 'm-fade' : p === 'enter' ? 'm-grow' : p === 'leave' ? 'm-collapse' : '');

/** CSS の長さのトークン（200ms、0.25s など）を ms で読む。読めないとき（jsdom）と動きを減らす設定では 0。 */
function tokenMs(name: string): number {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const m = /^(-?[\d.]+)(ms|s)$/.exec(v);
    if (!m) return 0;
    const n = Number(m[1]) * (m[2] === 's' ? 1000 : 1);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** 畳んで出る長さ。styles.css の .m-collapse と同じ式（--dur-exit と --dur-fast の和）。 */
export const exitMs = (): number => tokenMs('--dur-exit') + tokenMs('--dur-fast');

function merge<T>(prev: Present<T>[], items: readonly T[], keyOf: (t: T) => string, keepLeaving: boolean): Present<T>[] {
  const before = new Map(prev.map((p) => [p.key, p]));
  const next: Present<T>[] = items.map((item) => {
    const key = keyOf(item);
    const was = before.get(key);
    const phase: Phase = !was || was.phase === 'leave' ? 'enter' : was.phase === 'initial' ? 'initial' : was.phase === 'enter' ? 'enter' : 'stay';
    return { key, item, phase };
  });
  if (!keepLeaving) return next;
  const now = new Set(next.map((p) => p.key));
  prev.forEach((p, i) => {
    if (now.has(p.key)) return;
    next.splice(Math.min(i, next.length), 0, { key: p.key, item: p.item, phase: 'leave' });
  });
  return next;
}

/**
 * 並びの出入りを持つ。消えたものは畳み終わるまで残し、増えたものと最初からあるものに段階を付ける。
 * 動きの長さが 0 のとき（動きを減らす設定、jsdom）は、消えたものをすぐ外す。
 */
export function usePresence<T>(items: readonly T[], keyOf: (t: T) => string): Present<T>[] {
  const [list, setList] = useState<Present<T>[]>(() => items.map((item) => ({ key: keyOf(item), item, phase: 'initial' })));

  // 描画の前に揃える（古い並びが画面に出ない）。
  useLayoutEffect(() => {
    const keep = exitMs() > 0;
    setList((prev) => {
      const same = prev.length === items.length && prev.every((p, i) => p.phase !== 'leave' && p.item === items[i]);
      if (same) return prev;
      // 揃え直しても key、段階、item が前と同じなら前の並びのまま返す（畳んでいる行があると same が成り立たず、返さないと描き直しが止まらない）。
      // item を同じものと見るのは参照が同じときだけである。描くたびに item のオブジェクトを作り直す呼び手は、ここでは守れないので、呼び手が useMemo などで並びを保つこと。
      const next = merge(prev, items, keyOf, keep);
      const unchanged = next.length === prev.length && next.every((n, i) => n.key === prev[i]!.key && n.phase === prev[i]!.phase && n.item === prev[i]!.item);
      return unchanged ? prev : next;
    });
    // keyOf は呼び手ごとに作り直されることがあるので、並びが変わったときだけ揃える。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const leaving = list.filter((p) => p.phase === 'leave').map((p) => p.key).join('\n');
  useEffect(() => {
    if (!leaving) return;
    const keys = new Set(leaving.split('\n'));
    const t = setTimeout(() => setList((prev) => prev.filter((p) => !(p.phase === 'leave' && keys.has(p.key)))), exitMs());
    return () => clearTimeout(t);
  }, [leaving]);

  return list;
}
