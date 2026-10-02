import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * 閉じても、出る動きが終わるまで描き続ける。
 * open が偽になった描画では、まだ mounted のまま leaving を真にする。exit(el) が返す Promise が解決したら外す。
 * exit が null を返す（動かない）ときは、その描画のうちに外す（layout effect の中の更新は描く前に反映される）。
 * 出る途中で開き直したら、外さずに戻す。
 */
export function usePresence<E extends HTMLElement>(open: boolean, exit: (el: E) => Promise<unknown> | null): { mounted: boolean; leaving: boolean; ref: RefObject<E | null> } {
  const ref = useRef<E | null>(null);
  const [shown, setShown] = useState(open);
  useLayoutEffect(() => {
    if (open) { setShown(true); return; }
    const el = ref.current;
    const p = el ? exit(el) : null;
    if (!p) { setShown(false); return; }
    let alive = true;
    const done = () => { if (alive) setShown(false); };
    p.then(done, done);
    return () => { alive = false; };
    // exit は描画ごとに作り直される関数なので、依存に入れない。open が替わったときだけ動く。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return { mounted: open || shown, leaving: !open && shown, ref };
}
