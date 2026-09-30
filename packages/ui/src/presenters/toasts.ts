import type { State, Toast } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { durationLabel } from './format.ts';
import { NO_QUESTION } from './home.ts';

/** 入力待ちのカード 1 枚。押すとそのセッションを開いてターミナルにフォーカスする。 */
export type WaitingCardProps = { sessionId: string; name: string; projectName: string | null; waited: string; question: string };
/**
 * 右下に積む知らせ。
 * waiting は入力待ちのカードで、古いものが上、新しいものが下（窓の角に近い側）に来る。
 * more は並べきれなかった入力待ちの数で、ホームへの案内に使う。
 * offerNotify は、通知を出せるのに受け取っていないときにカードへ添える「通知を受け取る」の有無である。
 */
export type ToastsProps = { toasts: Toast[]; waiting: WaitingCardProps[]; more: number; offerNotify: boolean };

/** 並べるカードの上限。4 件目からは数だけにして、ホームの要対応へ案内する。 */
const SHOWN = 3;

export function presentToasts(state: State, store: Store, now: number): ToastsProps {
  const cards = state.waitingToasts.flatMap((id): WaitingCardProps[] => {
    const s = store.sessions[id];
    if (!s) return [];
    const projectName = s.projectId ? store.projects[s.projectId]?.name ?? null : null;
    return [{ sessionId: s.id, name: s.name ?? '（名前なし）', projectName, waited: durationLabel(now - (s.lastActivityAt ?? now)), question: s.activity?.question ?? NO_QUESTION }];
  });
  const waiting = cards.slice(-SHOWN);
  return { toasts: state.toasts, waiting, more: cards.length - waiting.length, offerNotify: state.notify.available && !state.notify.on };
}
