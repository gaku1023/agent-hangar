import { overlayReplaceable } from '../mediator/overlay.ts';
import type { State, Toast } from '../mediator/types.ts';
import { settingsSectionOf, stopReasonOf } from '@agent-hangar/shared';
import { osLabel, sasText } from './cloudMember.ts';
import type { Store } from '../store/store.ts';
import { durationLabel } from './format.ts';
import { translatorOf } from './i18n.ts';
import { arrivedCount } from './unresolved.ts';
import { presentUpdateCard, presentWhatsNew, type UpdateCardProps, type WhatsNewCardProps } from './update.ts';

/**
 * 入力待ちのカード 1 枚。
 * 押すとそのセッションを開いてターミナルにフォーカスする。
 * question は、問いが取れない入力待ち（許可待ちなど）では null である。
 * reason は止まっている理由（試作 stop-reason-proto の K1）。許可待ちは見出しを「許可待ち」にし、ask（道具と命令）を問いの場所に出す。
 * リセット済みは見出しを「リセット済み」にし、question に続きを指示するよう言う文を入れる。使用制限そのものは手を出せないので札にしない。
 */
export type WaitingCardProps = { sessionId: string; name: string; waited: string; question: string | null; reason: 'permission' | 'reset' | null; ask: { tool: string; input: string } | null };
/**
 * 右下に積む知らせ。
 * waiting は入力待ちのカードで、古いものが上、新しいものが下（窓の角に近い側）に来る。
 * ホームと、そのセッション自身の画面では、その件のカードは出さない（shownOnScreen）。
 * more は並べきれなかった入力待ちの数で、ホームへの案内に使う。
 * toasts は操作の結果（保存しました、コピーしました）と、操作の失敗である。
 * 戻る時刻の札、通知の誘い、保持期間の帯、互換の知らせは右下に積まない。戻る時刻はホームの帯に、通知の誘いは始める前の確認に、残りはヘッダーの注意の行にある（presenters/notices.ts）。
 * blocked は、確認や入力のあるダイアログが開いていてカードを押せないことを表す。
 * 押しても Mediator が画面を移さないので、押せないように見せる。
 * arrived は、同期で他の PC から届いたプロジェクトの札（設計書 2.11.5）で、count は、いまも届いたままのものの数である。0 なら null で、札は出さない。
 * update は、アプリの更新の札（presenters/update.ts）。どの画面でも出す（画面を移さないので、ダイアログが開いていても押せる）。
 * join は、発行した参加コードへの参加リクエストの通知（試作 C1）。承認か拒否か期限切れで消える。設定のクラウド同期を開いている間は、そこの欄が同じことを言うので出さない。
 */
export type ToastsProps = { toasts: Toast[]; waiting: WaitingCardProps[]; more: number; blocked: boolean; arrived: { count: number } | null; update: UpdateCardProps | null; whatsNew: WhatsNewCardProps | null; join: JoinCardProps | null };

/** 参加リクエストの通知の中身。os は表示名、sas は区切りつきの確認コード（123 456）。 */
export type JoinCardProps = { name: string; os: string; sas: string };

function presentJoinCard(state: State, store: Store): JoinCardProps | null {
  const a = store.cloudMember.add;
  if (a.kind !== 'requested') return null;
  if (state.screen.name === 'settings' && settingsSectionOf(state.screen.at) === 'cloud') return null;
  return { name: a.request.name, os: osLabel(a.request.os), sas: sasText(a.request.sas) };
}

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
  const t = translatorOf(store);
  const cards = state.waitingToasts.flatMap((id): WaitingCardProps[] => {
    const s = store.sessions[id];
    if (!s || shownOnScreen(state, id)) return [];
    const reason = stopReasonOf(s);
    const name = s.name ?? t('common.label.noName');
    if (reason === 'permission') return [{ sessionId: s.id, name, waited: durationLabel(t, now - (s.lastActivityAt ?? now)), question: null, reason, ask: s.permission ? { tool: s.permission.tool, input: s.permission.input } : null }];
    if (reason === 'reset') return [{ sessionId: s.id, name, waited: durationLabel(t, Math.max(0, now - (s.limit?.resetsAt ?? now))), question: t('stop.notify.reset'), reason, ask: null }];
    return [{ sessionId: s.id, name, waited: durationLabel(t, now - (s.lastActivityAt ?? now)), question: s.activity?.question ?? null, reason: null, ask: null }];
  });
  const waiting = cards.slice(-SHOWN);
  const arrived = arrivedCount(store, state.arrivedProjects);
  return { toasts: state.toasts, waiting, more: cards.length - waiting.length, blocked: !overlayReplaceable(state.overlay), arrived: arrived > 0 ? { count: arrived } : null, update: presentUpdateCard(store), whatsNew: presentWhatsNew(store), join: presentJoinCard(state, store) };
}
