import { overlayReplaceable } from '../mediator/overlay.ts';
import type { State, Toast } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { durationLabel } from './format.ts';

/**
 * 入力待ちのカード 1 枚。
 * 押すとそのセッションを開いてターミナルにフォーカスする。
 * question は、問いが取れない入力待ち（許可待ちなど）では null である。
 */
export type WaitingCardProps = { sessionId: string; name: string; waited: string; question: string | null };
/**
 * 右下に積む知らせ。
 * waiting は入力待ちのカードで、古いものが上、新しいものが下（窓の角に近い側）に来る。
 * more は並べきれなかった入力待ちの数で、ホームへの案内に使う。
 * offerNotify は、通知を出せるのに受け取っていないときにカードの積みの上へ添える「通知を受け取る」の有無である。
 * blocked は、確認や入力のあるダイアログが開いていてカードを押せないことを表す。
 * 押しても Mediator が画面を移さないので、押せないように見せる。
 */
export type ToastsProps = { toasts: Toast[]; waiting: WaitingCardProps[]; more: number; offerNotify: boolean; blocked: boolean };

/**
 * 並べるカードの上限。
 * 4 件目からは数だけにして、ホームの要対応へ案内する。
 */
const SHOWN = 3;

export function presentToasts(state: State, store: Store, now: number): ToastsProps {
  const cards = state.waitingToasts.flatMap((id): WaitingCardProps[] => {
    const s = store.sessions[id];
    if (!s) return [];
    return [{ sessionId: s.id, name: s.name ?? '（名前なし）', waited: durationLabel(now - (s.lastActivityAt ?? now)), question: s.activity?.question ?? null }];
  });
  const waiting = cards.slice(-SHOWN);
  return { toasts: state.toasts, waiting, more: cards.length - waiting.length, offerNotify: state.notify.available && !state.notify.on && !state.notify.blocked, blocked: !overlayReplaceable(state.overlay) };
}
