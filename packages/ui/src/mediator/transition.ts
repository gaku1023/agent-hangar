import { connectionStep } from './connection.ts';
import { launchStep } from './launch.ts';
import { liveStep, settleWaiting } from './live.ts';
import { returnStep, settleReturn } from './returnDue.ts';
import { notifyStep } from './notify.ts';
import { overlayStep, settleQueue } from './overlay.ts';
import { PAGE_SIZE_DEFAULT } from './paging.ts';
import { promoteStep } from './promote.ts';
import { resumeHereStep } from './resumeHere.ts';
import { retentionStep } from './retention.ts';
import { screenStep } from './screen.ts';
import { sectionsStep } from './sections.ts';
import { sessionViewStep } from './sessionView.ts';
import { settingsStep } from './settings.ts';
import { LIVE_PANE_SPLIT_DEFAULT, livePaneSplitStep, sidebarOrderStep, sidebarStep } from './sidebar.ts';
import { syncStep } from './sync.ts';
import { workbenchStep } from './workbench.ts';
import { NOT_YET, type Input, type State, type Step } from './types.ts';

export type { State, Input, Effect, Step } from './types.ts';
export { defaultSessionView } from './sessionView.ts';

export function initialState(): State {
  return { screen: { name: 'booting' }, overlay: { kind: 'none' }, connection: 'connecting', reconnectAttempt: 0, staleSince: null, nextRetryAt: null, sessionView: {}, search: { text: '', filter: {}, page: 1 }, pageSize: PAGE_SIZE_DEFAULT, listPages: {}, launch: { kind: 'idle' }, waitingSeen: [], returnSeen: [], returnToasts: [], focusOnOpen: null, promote: { kind: 'idle' }, summaryFailed: {}, toasts: [], unresolvedQueue: [], resolveDeferred: [], sidebarCollapsed: false, sidebarOrder: [], sectionsOpen: {}, livePaneSplit: LIVE_PANE_SPLIT_DEFAULT, retentionBannerDismissed: false, newSessionDraft: null, newSessionSent: false, launchPrefs: {}, waitingToasts: [], notify: { available: false, on: false, blocked: false }, nextToastId: 1, indexPhase: 'idle', sync: { kind: 'off' }, pending: 0, settingsSave: {}, copied: null };
}

function pushToast(state: State, level: 'info' | 'error', message: string): State {
  return { ...state, toasts: [...state.toasts, { id: String(state.nextToastId), level, message }], nextToastId: state.nextToastId + 1 };
}

/** フェーズ 4 以降に残る操作だけ。フェーズ 3 で実装した Intent はここから外した。 */
const NOT_YET_INTENTS = new Set(['session.takeover', 'project.new.open', 'project.new.submit']);

/** 直交する領域の状態機械を順に試し、最初に応答した領域の結果を採る。残りは横断的な入力。 */
export function transition(state: State, input: Input): Step {
  // promoteStep と retentionStep は overlay.close を横取りするので overlayStep より前に置く。
  // syncStep と resumeHereStep は overlayStep の後ろに置く。
  // 確認ダイアログと下見のダイアログは overlay.close で閉じたいので、横取りする領域の後ろでなければならない。
  // workbenchStep は summary.* の server イベントを見るので最後に置き、他の領域が先に応答した入力には触れない。
  for (const step of [connectionStep, screenStep, launchStep, promoteStep, retentionStep, overlayStep, syncStep, resumeHereStep, settingsStep, sessionViewStep, sidebarStep, sidebarOrderStep, sectionsStep, livePaneSplitStep, liveStep, returnStep, notifyStep, workbenchStep]) {
    const r = step(state, input);
    // 閉じた後に未解決のキューが残っていれば、次を出す（overlay.ts の settleQueue）。
    // 開いたセッションの入力待ちのカードは、見えているので下げる（live.ts の settleWaiting）。戻る時刻の札も同じ（returnDue.ts の settleReturn）。
    if (r) { const settled = settleReturn(settleWaiting(settleQueue(r.state))); return settled === r.state ? r : { ...r, state: settled }; }
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
    default:
      if (NOT_YET_INTENTS.has(i.type)) return { state, effects: [{ kind: 'toast', level: 'info', message: NOT_YET }] };
      return { state, effects: [] };
  }
}
