import { useLayoutEffect, useRef } from 'react';
import { useEmit } from '../action/chain.tsx';
import { Icon, type IconName } from './primitives/Icon.tsx';
import { collapseOut, growIn, motionOn } from './primitives/motionKit.ts';
import { RollingText } from './primitives/RollingText.tsx';
import { usePresence } from './primitives/usePresence.ts';

const SYNC_SETTINGS = { name: 'settings', at: 'sync' } as const;

/**
 * ヘッダの同期の横の札（P1）。確認の件数（kind=ask）は waiting の色、自動で入った件数（kind=quiet）は静かな色。
 * 0 から増えたら横に伸びて出て（growIn）、数が替わるときは数字だけ下から差し替わり（RollingText）、0 に戻ったら畳んで消える（collapseOut）。
 * 押すと設定の同期の節を開く。見えるのは数字だけなので、label を読み上げに添える。消える間は最後の数と文のまま置く。
 */
export function CountBadge(props: { n: number; label: string; kind: 'ask' | 'quiet'; icon: IconName }) {
  const emit = useEmit();
  const open = props.n > 0;
  const last = useRef({ n: props.n, label: props.label });
  if (open) last.current = { n: props.n, label: props.label };
  const p = usePresence<HTMLButtonElement>(open, (el) => (motionOn(el) ? collapseOut(el, 'x') : null));
  const was = useRef(open);
  useLayoutEffect(() => {
    const el = p.ref.current;
    if (el && open && !was.current) growIn(el, 'x');
    was.current = open;
    // 出入りだけを動かす。数の差し替えは RollingText が持つ。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!p.mounted) return null;
  const shown = open ? props : last.current;
  return (
    <button ref={p.ref} type="button" className="sync-badge" data-kind={props.kind} title={shown.label} aria-label={shown.label} aria-hidden={p.leaving ? true : undefined}
      onClick={() => emit({ type: 'nav.go', to: SYNC_SETTINGS })}>
      <Icon name={props.icon} />
      <RollingText text={String(shown.n)} />
    </button>
  );
}
