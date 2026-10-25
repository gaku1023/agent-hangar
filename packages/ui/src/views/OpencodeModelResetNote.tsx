import { useLayoutEffect, useRef } from 'react';
import { AGENT_ONLY_ATTR } from './agentSwap.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { collapseOut, growIn, motionOn } from './primitives/motionKit.ts';
import { usePresence } from './primitives/usePresence.ts';

/**
 * 前回のモデルが opencode の一覧から消えていて、デフォルトに戻したことの注記（C7、試作の M1）。
 * 新しいセッションのダイアログの札の列の下に、ⓘ 付きの 1 行で置く。読み逃しても残る。
 * 入るときは高さを 0 から伸ばし（growIn）、✕ かモデルを選び直したときは高さを畳んで外れる（collapseOut）。畳む間は前の文のまま描き、読み上げからは外す。
 * model は前回のモデルの ID（provider/id）。一覧に無いので名前は引けない。
 */
export function OpencodeModelResetNote(props: { open: boolean; model: string; onClose: () => void }) {
  const t = useT();
  const note = usePresence<HTMLDivElement>(props.open, (el) => (motionOn(el) ? collapseOut(el) : null));
  // 畳む間も文を読めるように、最後に出していた ID を控えておく。
  const last = useRef(props.model);
  if (props.open) last.current = props.model;
  useLayoutEffect(() => {
    if (props.open && note.ref.current) growIn(note.ref.current);
    // 入る向きの変わり目だけで動かす。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);
  if (!note.mounted) return null;
  return (
    <div ref={note.ref} className="oc-model-note" role={note.leaving ? undefined : 'status'} aria-hidden={note.leaving ? 'true' : undefined} {...{ [AGENT_ONLY_ATTR]: 'opencode' }}>
      <Icon name="info" />
      <span>{t('launch.opencode.modelReset', { model: last.current })}</span>
      <button type="button" className="oc-model-note-x" aria-label={t('common.button.close')} onClick={props.onClose}><Icon name="close" /></button>
    </div>
  );
}
