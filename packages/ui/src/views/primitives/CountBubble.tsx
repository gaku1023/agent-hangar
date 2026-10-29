import { useLayoutEffect, useRef } from 'react';
import { bumpMark, collapseOut, growIn, motionOn } from './motionKit.ts';
import { usePresence } from './usePresence.ts';

/**
 * 数の丸（ホームの項目の .nav-count、サイドバーの行の .side-live-n）。
 * 0 から増えたら横に伸びて出て（growIn）、増えたら小さく跳ね（bumpMark）、0 に戻ったら畳んで消える（collapseOut）。
 * 見えるのは数字だけなので、読み上げの文（sr）を添える。消える間は最後の数と文のまま、読み上げから外す。
 */
export function CountBubble(props: { n: number; sr: string; className: string }) {
  const open = props.n > 0;
  const last = useRef({ n: props.n, sr: props.sr });
  if (open) last.current = { n: props.n, sr: props.sr };
  const p = usePresence<HTMLSpanElement>(open, (el) => (motionOn(el) ? collapseOut(el, 'x') : null));
  const was = useRef({ open, n: props.n });
  useLayoutEffect(() => {
    const el = p.ref.current;
    if (el && open && !was.current.open) growIn(el, 'x');
    else if (el && open && props.n > was.current.n) bumpMark(el);
    was.current = { open, n: props.n };
    // 数が替わったときだけ動かす。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.n]);
  if (!p.mounted) return null;
  const shown = open ? props : last.current;
  return <span ref={p.ref} className={props.className} aria-hidden={p.leaving ? true : undefined}><span aria-hidden="true">{shown.n}</span><span className="sr-only">{shown.sr}</span></span>;
}
