import type { PeerChatAsk, Translate } from '@agent-hangar/shared';
import type { Store } from '../store/store.ts';
import { answeredText, askModelOf, type AskCardModel } from './peerChat.ts';

/**
 * この PC の会話の札（許可と質問。Claude Code、Codex、opencode）を、札の部品（views/AskCard.tsx）が描く値にする。
 * 本文の真上の帯とホームの行が使う。札が無い会話は null。
 * 答えられない札（answerable: false）は hostOnly を立てる。画面は「ターミナルを開く」ボタンだけを出す。
 */
export function presentLocalAsk(store: Store, sessionId: string, t: Translate): AskCardModel | null {
  const cur = store.localAsks[sessionId];
  if (!cur) return null;
  const hostOnly = cur.answered === null && cur.ask.answerable === false ? t('peerChat.ask.unanswerable', { device: store.device?.name ?? '' }) : null;
  return askModelOf(t, cur.ask, { answered: cur.answered, hostOnly, pending: cur.pending, locked: false });
}

/** 本文の真上の帯の値。開いている会話に札があるときだけ持つ。 */
export type LocalAskBandProps = { sessionId: string; row: AskCardModel };

export function presentLocalAskBand(store: Store, sessionId: string | null, t: Translate): LocalAskBandProps | null {
  if (sessionId === null) return null;
  const row = presentLocalAsk(store, sessionId, t);
  return row ? { sessionId, row } : null;
}

/** 答えが通ったあとの記録の文（「Mac で 1 回だけ許可」）。 */
export function localAnsweredLine(t: Translate, ask: PeerChatAsk, label: string, device: string): string {
  return answeredText(t, ask.kind, ask.secret === true, device, label);
}
