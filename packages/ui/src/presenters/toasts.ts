import { overlayReplaceable } from '../mediator/overlay.ts';
import type { State, Toast } from '../mediator/types.ts';
import { settingsSectionOf, stopReasonOf, type Translate } from '@agent-hangar/shared';
import { PERMISSION_BYPASS, permissionLabel } from '../views/primitives/permissionModel.ts';
import { projectDisplayName } from './projectName.ts';
import { presentSessionMenu, type SessionMenuStop } from './sessionMenu.ts';
import { osLabel, sasText } from './cloudMember.ts';
import type { Store } from '../store/store.ts';
import { durationLabel } from './format.ts';
import { translatorOf } from './i18n.ts';
import { presentLaunchPrep } from './launchPrep.ts';
import { arrivedCount } from './unresolved.ts';
import { presentUpdateCard, presentWhatsNew, type UpdateCardProps, type WhatsNewCardProps } from './update.ts';
import { presentOpencodeVersionCard, type OpencodeVersionCardProps } from './opencodeNotice.ts';

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
 * opencodeVersion は、未検証の opencode の版の札（C7、presenters/opencodeNotice.ts）。同じ版では一度だけ出す。
 * join は、発行した参加コードへの参加リクエストの通知（試作 C1）。承認か拒否か期限切れで消える。設定のクラウド同期を開いている間は、そこの欄が同じことを言うので出さない。
 * phoneUndo は、スマホの解除の「元に戻す」（試作 E2）。Runtime が 5 秒を数え、解除を送るか元に戻すと消える。どの画面でも出す。
 * phoneLaunches は、スマホからの依頼でこの PC が起こした会話の通知（試作 F1）。受信した順で、その会話の画面を開いている間は出さない。
 * 入力待ちと同じく新しい SHOWN 枚までを並べ、並べきれない数を phoneLaunchMore に置く。
 */
export type ToastsProps = { toasts: Toast[]; waiting: WaitingCardProps[]; more: number; blocked: boolean; arrived: { count: number } | null; update: UpdateCardProps | null; whatsNew: WhatsNewCardProps | null; opencodeVersion?: OpencodeVersionCardProps | null; join: JoinCardProps | null; phoneUndo?: { name: string } | null; phoneLaunches?: PhoneLaunchCardProps[]; phoneLaunchMore?: number; prepProgress?: PrepProgressCardProps | null; contextShorts?: ContextShortCardProps[] };

/**
 * ダイアログを閉じた後に走り続けている起動前の準備の進みの札（試作の「途中で閉じる」）。line は今の段の 1 行、startedAt から経過時間を数える。
 * 準備が走っている間だけ出し、済んだら「開始しました」の知らせ（mediator/launch.ts）に替わる。key は「準備を中止」に添える。
 */
export type PrepProgressCardProps = { key: string; line: string; startedAt: number };
/**
 * 起動した後にコンテキストが足りなかった会話の札（試作の §3）。fix は整え直しの最中の 1 行（鍵の進みがまだ届かなければ確認中の文、startedAt は null）、done は済んだこと。
 */
export type ContextShortCardProps = { sessionId: string; fix: { text: string; startedAt: number | null } | null; done: boolean };

function presentPrepProgress(state: State, store: Store, t: Translate): PrepProgressCardProps | null {
  const mark = state.launchPrep;
  const prep = mark ? store.launchPreps[mark.key] : undefined;
  if (!mark || !prep || prep.phase !== 'running' || state.overlay.kind === 'newSession' || (!state.newSessionSent && !mark.resume)) return null;
  return { key: mark.key, line: presentLaunchPrep(prep, t, mark.model).line.text, startedAt: prep.startedAt };
}

function presentContextShorts(state: State, store: Store, t: Translate): ContextShortCardProps[] {
  return state.contextShorts.map((c) => {
    const prep = c.fix ? store.launchPreps[c.fix.key] : undefined;
    return { sessionId: c.sessionId, fix: c.fix ? { text: prep ? presentLaunchPrep(prep, t, null).line.text : t('launchPrep.step.check'), startedAt: prep?.startedAt ?? null } : null, done: c.done };
  });
}

/**
 * スマホから起動した会話の通知の中身（試作 F1）。
 * title は「〈スマホの名前〉から起動：〈プロジェクト〉（〈権限モード〉）」、name は会話の名前（まだ一覧に無ければ依頼の題）。
 * bypass は Bypass permissions で起こしたことで、赤い通知にして「停止」を置く。stop は止める run（セッションのメニューの停止と同じ中身）で、動いていなければ null。
 */
export type PhoneLaunchCardProps = { sessionId: string; title: string; name: string; bypass: boolean; stop: SessionMenuStop | null };

function presentPhoneLaunches(state: State, store: Store, t: Translate): PhoneLaunchCardProps[] {
  return state.phoneLaunches.flatMap((l): PhoneLaunchCardProps[] => {
    if (state.screen.name === 'session' && state.screen.id === l.sessionId) return [];
    const s = store.sessions[l.sessionId];
    const projectId = s?.projectId ?? l.projectId;
    const p = projectId ? store.projects[projectId] : undefined;
    const project = p ? projectDisplayName(p, t) : l.scratch ? t('project.name.quick') : t('common.label.uncategorized');
    const mode = permissionLabel(l.permissionMode, t);
    const title = l.phone ? t('phoneLaunch.notice.title', { phone: l.phone, project, mode }) : t('phoneLaunch.notice.titleUnknown', { project, mode });
    const menu = s ? presentSessionMenu(store, s, t).stop : null;
    return [{ sessionId: l.sessionId, title, name: s?.name ?? l.title, bypass: l.permissionMode === PERMISSION_BYPASS, stop: menu && menu !== 'external' ? menu : null }];
  });
}

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
 * 入力待ちは 4 件目からは数だけにして、ホームの要対応へ案内する。
 * スマホから起動した会話の通知も 4 件目からは数だけにする（前の通知を下げると、隠れていた古いものが順に出る）。
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
  const launches = presentPhoneLaunches(state, store, t);
  const phoneLaunches = launches.slice(-SHOWN);
  return { toasts: state.toasts, waiting, more: cards.length - waiting.length, blocked: !overlayReplaceable(state.overlay), arrived: arrived > 0 ? { count: arrived } : null, update: presentUpdateCard(store), whatsNew: presentWhatsNew(store), opencodeVersion: presentOpencodeVersionCard(state, store), join: presentJoinCard(state, store), phoneUndo: store.cloudMember.phoneUndo ? { name: store.cloudMember.phoneUndo.name } : null, phoneLaunches, phoneLaunchMore: launches.length - phoneLaunches.length, prepProgress: presentPrepProgress(state, store, t), contextShorts: presentContextShorts(state, store, t) };
}
