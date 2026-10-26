import { useLayoutEffect } from 'react';
import { agentOnlyAttr } from './agentSwap.ts';
import { useT } from './primitives/language.tsx';
import { collapseOut, growIn, motionOn } from './primitives/motionKit.ts';
import { usePresence } from './primitives/usePresence.ts';

/**
 * Codex の権限をフルアクセスにしたときの注意（試作 prototype の A、赤い 1 行）。
 * 新しいセッションのダイアログの札の列の下に置く。入るときは高さを 0 から伸ばし（growIn）、選び直したら高さを畳んで外れる（collapseOut）。
 * 畳む間は読み上げから外す。起動のボタンは赤くしない（札の赤い縁と、この注意で伝える）。
 */
export function CodexFullAccessNote(props: { open: boolean }) {
  const t = useT();
  const note = usePresence<HTMLDivElement>(props.open, (el) => (motionOn(el) ? collapseOut(el) : null));
  useLayoutEffect(() => {
    if (props.open && note.ref.current) growIn(note.ref.current);
    // 入る向きの変わり目だけで動かす。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);
  if (!note.mounted) return null;
  return (
    <div ref={note.ref} className="codex-full-note" role={note.leaving ? undefined : 'status'} aria-hidden={note.leaving ? 'true' : undefined} {...agentOnlyAttr('modelList')}>
      {t('launch.codexPermission.fullAccessWarn')}
    </div>
  );
}
