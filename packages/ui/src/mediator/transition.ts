import { accountsStep } from './accounts.ts';
import { connectionStep } from './connection.ts';
import { launchStep } from './launch.ts';
import { liveStep, settleWaiting } from './live.ts';
import { returnStep, settleReturn } from './returnDue.ts';
import { noticesStep } from './notices.ts';
import { notifyStep } from './notify.ts';
import { overlayStep, settleQueue } from './overlay.ts';
import { projectCreateStep } from './projectCreate.ts';
import { PAGE_SIZE_DEFAULT } from './paging.ts';
import { promoteStep } from './promote.ts';
import { resumeHereStep } from './resumeHere.ts';
import { retentionStep } from './retention.ts';
import { screenStep } from './screen.ts';
import { sectionsStep } from './sections.ts';
import { sessionViewStep } from './sessionView.ts';
import { settingsStep } from './settings.ts';
import { sidebarLiveStep, sidebarOrderStep, sidebarStep } from './sidebar.ts';
import { syncStep } from './sync.ts';
import { workbenchStep } from './workbench.ts';
import type { Input, State, Step } from './types.ts';
import type { Store } from '../store/store.ts';

export type { State, Input, Effect, Step } from './types.ts';
export { defaultSessionView } from './sessionView.ts';

export function initialState(): State {
  return { screen: { name: 'booting' }, overlay: { kind: 'none' }, connection: 'connecting', reconnectAttempt: 0, staleSince: null, nextRetryAt: null, sessionView: {}, search: { text: '', filter: {}, page: 1 }, pageSize: PAGE_SIZE_DEFAULT, listPages: {}, launch: { kind: 'idle' }, waitingSeen: [], returnSeen: [], returnToasts: [], focusOnOpen: null, promote: { kind: 'idle' }, projectCreate: { kind: 'idle' }, toasts: [], unresolvedQueue: [], resolveDeferred: [], sidebarCollapsed: false, sidebarOrder: [], sectionsOpen: {}, retentionBannerDismissed: false, noticesRead: [], newSessionDraft: null, newSessionSent: false, launchPrefs: {}, waitingToasts: [], nextToastId: 1, settingsSave: {}, copied: null };
}

function pushToast(state: State, level: 'info' | 'error', message: string): State {
  return { ...state, toasts: [...state.toasts, { id: String(state.nextToastId), level, message }], nextToastId: state.nextToastId + 1 };
}

/**
 * 直交する領域の状態機械を順に試し、最初に応答した領域の結果を採る。残りは横断的な入力。
 * Store は読むだけで、変えない。Store を変えるのは Runtime である。
 */
export function transition(state: State, store: Store, input: Input): Step {
  // promoteStep、projectCreateStep、retentionStep は overlay.close を横取りするので overlayStep より前に置く。
  // accountsStep は確認を出す領域なので、overlayStep より前に置く。
  // syncStep と resumeHereStep は overlayStep の後ろに置く。
  // 確認ダイアログと下見のダイアログは overlay.close で閉じたいので、横取りする領域の後ろでなければならない。
  if (input.kind === 'store') return storeChanged(state, store);
  // ストアを読む領域には、ここでストアを添える。
  const screen = (s: State, i: Input) => screenStep(s, store, i);
  const sessionView = (s: State, i: Input) => sessionViewStep(s, store, i);
  const workbench = (s: State, i: Input) => workbenchStep(s, store, i);
  for (const step of [connectionStep, screen, launchStep, promoteStep, projectCreateStep, retentionStep, accountsStep, overlayStep, syncStep, resumeHereStep, settingsStep, sessionView, sidebarStep, sidebarOrderStep, sectionsStep, returnStep, noticesStep, notifyStep, workbench]) {
    const r = step(state, input);
    if (r) return settled(state, r);
  }
  if (input.kind === 'server') {
    if (input.event.type === 'toast') return { state: pushToast(state, input.event.level, input.event.message), effects: [] };
    return { state, effects: [] };
  }
  if (input.kind === 'runtime') {
    if (input.event.type === 'api.failed') return { state: pushToast(state, 'error', input.event.message), effects: [] };
    return { state, effects: [] };
  }
  const i = input.intent;
  switch (i.type) {
    case 'index.rebuild': return { state, effects: [{ kind: 'api.rebuildIndex' }] };
    case 'toast.dismiss': return { state: { ...state, toasts: state.toasts.filter((t) => t.id !== i.id) }, effects: [] };
    default: return { state, effects: [] };
  }
}

/**
 * ストアが変わった。ストアから決まる状態を、順に合わせる。
 * 入力待ちの知らせ（live.ts の liveStep）、サイドバーの「動いている」の並び（sidebar.ts の sidebarLiveStep）の順である。
 * どちらも、ストアの顔ぶれが前に見たものと同じなら何もしない。
 */
function storeChanged(state: State, store: Store): Step {
  const waiting = liveStep(state, store);
  const live = sidebarLiveStep(waiting.state, store);
  // どちらも動かなかったら、整え（settled）を通さずそのまま返す。
  // ストアは本文が伸びるたびに変わるので、そのたびに未解決のキューや札を触ると、無関係な更新で問いが開いてしまう。
  if (live.state === state && waiting.effects.length === 0 && live.effects.length === 0) return { state, effects: [] };
  return settled(state, { state: live.state, effects: [...waiting.effects, ...live.effects] });
}

/**
 * 領域が応答した後の整え。
 * 閉じた後に未解決のキューが残っていれば、次を出す（overlay.ts の settleQueue）。
 * 開いたセッションの入力待ちのカードは、見えているので下げる（live.ts の settleWaiting）。戻る時刻の札も同じ（returnDue.ts の settleReturn）。
 */
function settled(prev: State, r: Step): Step {
  const state = settleReturn(settleWaiting(settleQueue(r.state)));
  return fetchDirsOnOpen(prev, state === r.state ? r : { ...r, state });
}

/**
 * 新しいセッションのダイアログか作成のダイアログが開いたら、未登録のフォルダの一覧を取りに行く。
 * 開く経路（⌘N、ヘッダー、カード、パレット、作成して始める）が多いので、開いた瞬間をここで 1 か所で見る。
 */
function fetchDirsOnOpen(prev: State, r: Step): Step {
  const k = r.state.overlay.kind;
  const opened = (k === 'newSession' || k === 'newProject') && prev.overlay.kind !== k;
  return opened ? { ...r, effects: [...r.effects, { kind: 'api.workspaceDirs' }] } : r;
}
