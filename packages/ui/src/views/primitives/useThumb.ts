import { useEffect, useLayoutEffect, useRef, useState, type DependencyList } from 'react';

/**
 * 選んだ項目の下に敷く 1 つの塗り（玉）を、選んだ項目の位置と大きさに置く。選び直すと、塗りが前の位置から滑る（CSS の transition）。
 * 設定の切替（Segmented）、一覧の状態のタブ、ページ送りの番号が使う。
 * selector は器の中で選んだ項目を指す。見つからなければ幅 0 にして隠す。
 * block を真にすると、縦の位置と高さも合わせる（折り返す帯、器と高さの違う項目）。
 * 最初の配置で塗りが端から滑ってこないよう、1 コマ置いてから動きを有効にする（ready を器の data-ready に出す）。
 * 書体が読み込まれると文字の幅が変わるので、器の大きさの変化にも付いていく。
 */
export function useThumb<B extends HTMLElement>(selector: string, deps: DependencyList, opts: { block?: boolean } = {}) {
  const box = useRef<B>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const place = () => {
      const t = thumb.current;
      if (!t) return;
      const b = box.current?.querySelector<HTMLElement>(selector);
      t.style.left = b ? `${b.offsetLeft}px` : '0px';
      t.style.width = b ? `${b.offsetWidth}px` : '0px';
      if (opts.block) {
        t.style.top = b ? `${b.offsetTop}px` : '0px';
        t.style.height = b ? `${b.offsetHeight}px` : '0px';
      }
    };
    place();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (box.current) ro?.observe(box.current);
    return () => ro?.disconnect();
    // 置き直すのは、呼び手が渡した値が替わったときだけ。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return { box, thumb, ready };
}
