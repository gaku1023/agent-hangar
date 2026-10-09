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
 * ホームと、そのセッション自身の画面では、その件のカードは出さない（shownOnScreen）。
 * more は並べきれなかった入力待ちの数で、ホームへの案内に使う。
 * toasts は操作の結果（保存しました、コピーしました）と、操作の失敗である。
 * 戻る時刻の札、通知の誘い、保持期間の帯、互換の知らせは右下に積まない。ヘッダーのベルの一覧の行になった（presenters/notices.ts）。
 * blocked は、確認や入力のあるダイアログが開いていてカードを押せないことを表す。
 * 押しても Mediator が画面を移さないので、押せないように見せる。
 */
export type ToastsProps = { toasts: Toast[]; waiting: WaitingCardProps[]; more: number; blocked: boolean };

/**
 * 並べるカードの上限。
 * 4 件目からは数だけにして、ホームの要対応へ案内する。
 */
const SHOWN = 3;

/**
 * いま見ている画面が、その入力待ちを既に知らせているか。
 * ホームは「要対応」の札が、そのセッション自身の画面は端末の縁の灯と端末そのものが言っている。
 * 同じ件を右下にも積むと、一覧や右の欄を覆うだけになる。ほかの画面では今までどおり出す。
 */
function shownOnScreen(state: State, sessionId: string): boolean {
  return state.screen.name === 'home' || (state.screen.name === 'session' && state.screen.id === sessionId);
}

export function presentToasts(state: State, store: Store, now: number): ToastsProps {
  const cards = state.waitingToasts.flatMap((id): WaitingCardProps[] => {
    const s = store.sessions[id];
    if (!s || shownOnScreen(state, id)) return [];
    return [{ sessionId: s.id, name: s.name ?? '（名前なし）', waited: durationLabel(now - (s.lastActivityAt ?? now)), question: s.activity?.question ?? null }];
  });
  const waiting = cards.slice(-SHOWN);
  return { toasts: state.toasts, waiting, more: cards.length - waiting.length, blocked: !overlayReplaceable(state.overlay) };
}
