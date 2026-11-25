import { useEffect, useLayoutEffect, useRef } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { LocalAskBandProps } from '../presenters/localAsk.ts';
import { AskCard } from './AskCard.tsx';
import { collapseOut, growIn } from './primitives/motionKit.ts';
import { usePresence } from './primitives/usePresence.ts';

/** 答えの記録を見せてから札を片付けるまでの長さ。 */
export const ASK_SETTLE_MS = 3000;

/**
 * 本文の真上の帯に出す、開いている会話の札（許可と質問）。Claude Code、Codex、opencode のどの会話でも同じ。
 * 札が出ると growIn で開き、片付くと collapseOut で閉じる。答えると札の中で選択肢が閉じ、答えの記録が開く（views/AskCard.tsx）。
 * 答えの記録は ASK_SETTLE_MS のあいだ見せ、それから ask.settle で片付ける。
 * 答えられない札は「ターミナルを開く」だけを出す。
 */
export function AskBand({ ask }: { ask: LocalAskBandProps | null }) {
  const emit = useEmit();
  // 閉じる動きの間も中身を描けるよう、最後の札を持っておく。
  const last = useRef<LocalAskBandProps | null>(ask);
  if (ask) last.current = ask;
  const shown = ask ?? last.current;
  const box = usePresence<HTMLDivElement>(ask !== null, (el) => collapseOut(el));
  const born = useRef(ask !== null);
  useLayoutEffect(() => {
    if (ask !== null && !born.current && box.ref.current) growIn(box.ref.current);
    born.current = ask !== null;
  }, [ask !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const sessionId = ask?.sessionId;
  const answered = ask?.row.answered != null;
  const askId = ask?.row.askId;
  useEffect(() => {
    if (!answered || sessionId === undefined) return;
    const id = setTimeout(() => emit({ type: 'ask.settle', sessionId }), ASK_SETTLE_MS);
    return () => clearTimeout(id);
  }, [answered, sessionId, askId, emit]);
  if (!box.mounted || !shown) return null;
  return (
    <div ref={box.ref} className="ask-band">
      <AskCard key={shown.row.askId} row={shown.row}
        onAnswer={(askId, keys, text) => emit({ type: 'ask.answer', sessionId: shown.sessionId, askId, keys, ...(text ? { text } : {}) })}
        onOpenTerminal={() => emit({ type: 'session.open', id: shown.sessionId, focus: 'terminal' })} />
    </div>
  );
}
