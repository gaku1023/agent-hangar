import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import { applyFold, chooseFoldLevel, FOLD_LEVELS } from './headerFold.ts';

/** 戻すときに見るゆとり（px）。これだけ空くまでは、畳んだ段を戻さない。 */
const SLACK = 24;

/**
 * ヘッダーの右の列（.header-row）を、はみ出さない段まで畳む。
 * 測るあいだは行に data-fold-measuring を付け、部品が縮まない形（base.css）で、段ごとの要る幅を測る。
 * 要る幅は、行の左端から最後の子の右の外側の端までである。
 * 段を決め終えたら印を外し、決めた段の印だけを残す。
 * どれも描画の直後、塗る前に済むので、途中の段が画面に出ることはない。
 * 測り直すのは、行の幅が変わったとき（窓、サイドバーの開閉）、描き直したとき（同期の文や件数の変化）、字形を読み込んだときである。
 */
export function useHeaderFold(ref: RefObject<HTMLElement | null>): void {
  const level = useRef(0);
  const fit = useCallback(() => {
    const row = ref.current;
    if (!row) return;
    const last = row.lastElementChild;
    const left = row.getBoundingClientRect().left;
    const measured = new Map<number, number>();
    const need = (k: number) => {
      const known = measured.get(k);
      if (known !== undefined) return known;
      applyFold(row, k);
      let w = 0;
      if (last) w = last.getBoundingClientRect().right + (parseFloat(getComputedStyle(last).marginRight) || 0) - left;
      measured.set(k, w);
      return w;
    };
    row.setAttribute('data-fold-measuring', '');
    const next = chooseFoldLevel({ need, levels: FOLD_LEVELS, available: row.clientWidth, current: level.current, slack: SLACK });
    row.removeAttribute('data-fold-measuring');
    applyFold(row, next);
    level.current = next;
    row.setAttribute('data-fold-level', String(next));
  }, [ref]);

  // 描き直すたびに測る。中身の長さは props で変わり、行の幅が変わらなくても収まらなくなることがある。
  useLayoutEffect(fit);

  useLayoutEffect(() => {
    const row = ref.current;
    if (!row) return;
    let alive = true;
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => fit());
    ro?.observe(row);
    // 字形の読み込みの前と後では、文字の幅が違う。
    void document.fonts?.ready.then(() => { if (alive) fit(); });
    return () => { alive = false; ro?.disconnect(); };
  }, [ref, fit]);
}
