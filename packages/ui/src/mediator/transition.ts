import { accountsStep } from './accounts.ts';
import { connectionStep } from './connection.ts';
import { launchStep } from './launch.ts';
import { liveStep, settleWaiting } from './live.ts';
import { returnStep, settleReturn } from './returnDue.ts';
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
import { LIVE_PANE_SPLIT_DEFAULT, livePaneSplitStep, sidebarLiveStep, sidebarOrderStep, sidebarStep } from './sidebar.ts';
import { syncStep } from './sync.ts';
import { workbenchStep } from './workbench.ts';
import type { Input, State, Step } from './types.ts';
import type { Store } from '../store/store.ts';

export type { State, Input, Effect, Step } from './types.ts';
export { defaultSessionView } from './sessionView.ts';

export function initialState(): State {
  return { screen: { name: 'booting' }, overlay: { kind: 'none' }, connection: 'connecting', reconnectAttempt: 0, staleSince: null, nextRetryAt: null, sessionView: {}, search: { text: '', filter: {}, page: 1 }, pageSize: PAGE_SIZE_DEFAULT, listPages: {}, launch: { kind: 'idle' }, waitingSeen: [], returnSeen: [], returnToasts: [], focusOnOpen: null, promote: { kind: 'idle' }, projectCreate: { kind: 'idle' }, workspaceDirs: null, pickedFolder: null, summaryFailed: {}, toasts: [], unresolvedQueue: [], resolveDeferred: [], sidebarCollapsed: false, sidebarOrder: [], sectionsOpen: {}, livePaneSplit: LIVE_PANE_SPLIT_DEFAULT, retentionBannerDismissed: false, newSessionDraft: null, newSessionSent: false, launchPrefs: {}, waitingToasts: [], notify: { available: false, on: false, blocked: false }, nextToastId: 1, indexPhase: 'idle', sync: { kind: 'off' }, pending: 0, settingsSave: {}, copied: null };
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
  // workbenchStep は summary.* の server イベントを見るので最後に置き、他の領域が先に応答した入力には触れない。
  // ストアを読む領域には、ここでストアを添える。
  const sessionView = (s: State, i: Input) => sessionViewStep(s, store, i);
  for (const step of [connectionStep, screenStep, launchStep, promoteStep, projectCreateStep, retentionStep, accountsStep, overlayStep, syncStep, resumeHereStep, settingsStep, sessionView, sidebarStep, sidebarOrderStep, sidebarLiveStep, sectionsStep, livePaneSplitStep, liveStep, returnStep, notifyStep, workbenchStep]) {
    const r = step(state, input);
    // 閉じた後に未解決のキューが残っていれば、次を出す（overlay.ts の settleQueue）。
    // 開いたセッションの入力待ちのカードは、見えているので下げる（live.ts の settleWaiting）。戻る時刻の札も同じ（returnDue.ts の settleReturn）。
    if (r) {
      const settled = settleReturn(settleWaiting(settleQueue(r.state)));
      const next = settled === r.state ? r : { ...r, state: settled };
      return fetchDirsOnOpen(state, next);
    }
  }
  if (input.kind === 'server') {
    if (input.event.type === 'toast') return { state: pushToast(state, input.event.level, input.event.message), effects: [] };
    if (input.event.type === 'index.progress') {
      // 走査中に開いた UI は、そのときの bootstrap にプロジェクトも紐づけも載っていない。
      // 走査が終わった瞬間に取り直す。
      const phase = input.event.progress.phase;
      const done = phase === 'idle' && state.indexPhase !== 'idle';
      return { state: { ...state, indexPhase: phase }, effects: done ? [{ kind: 'api.bootstrap' }] : [] };
    }
    return { state, effects: [] };
  }
  if (input.kind === 'runtime') {
    if (input.event.type === 'api.failed') return { state: pushToast(state, 'error', input.event.message), effects: [] };
    return { state, effects: [] };
  }
  const i = input.intent;
  switch (i.type) {
    case 'project.setStatus': return { state, effects: [{ kind: 'api.setProjectStatus', projectId: i.id, status: i.status }] };
    case 'index.rebuild': return { state, effects: [{ kind: 'api.rebuildIndex' }] };
    case 'toast.dismiss': return { state: { ...state, toasts: state.toasts.filter((t) => t.id !== i.id) }, effects: [] };
    default: return { state, effects: [] };
  }
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
