import type { Effect, Input, SessionViewState, State, Step } from './types.ts';

export function defaultSessionView(): SessionViewState {
  return { agentId: null, showThinking: false, showRaw: false, follow: true, summaryOpen: false, selectedTab: null, transcriptOpen: true, split: false, splitTab: null };
}

function patch(state: State, id: string, p: Partial<SessionViewState>): Step {
  const cur = state.sessionView[id] ?? defaultSessionView();
  const next = { ...cur, ...p };
  const effects: Effect[] = [{ kind: 'storage.save', key: `sv:${id}`, value: next }];
  return { state: { ...state, sessionView: { ...state.sessionView, [id]: next } }, effects };
}

/**
 * 閉じたタブが左右どちらかの枠に居たら、その枠を空ける差分を返す。
 * 左右のどちらが閉じても相手だけでは分割が成立しないので、そのときは分割ごと畳む。
 * 片側だけ空けて split を真のまま残すと、次にタブが増えた瞬間に押していない分割が復活してしまう。
 * どちらの枠にも居なければ null を返す。
 */
function closedTabPatch(cur: SessionViewState, tabId: string): Partial<SessionViewState> | null {
  const p: Partial<SessionViewState> = {};
  if (cur.selectedTab === tabId) p.selectedTab = null;
  if (cur.splitTab === tabId || (cur.split && cur.selectedTab === tabId)) { p.split = false; p.splitTab = null; }
  return Object.keys(p).length ? p : null;
}

const currentSession = (state: State): string | null => (state.screen.name === 'session' ? state.screen.id : null);
const viewOf = (state: State, id: string) => state.sessionView[id] ?? defaultSessionView();

/** sessionView 領域：セッション画面の一時状態とターミナル接続の開閉。localStorage に保存し、同期しない。 */
export function sessionViewStep(state: State, input: Input): Step | null {
  if (input.kind === 'server') {
    const ev = input.event;
    switch (ev.type) {
      case 'transcript.appended': {
        const open = currentSession(state) === ev.sessionId;
        // 追記は末尾に足すだけでよい。-1（過去へ遡る）を出すと、全件を読み終えるまで古い側が 500 件ずつ入ってしまう。
        return { state, effects: open ? [{ kind: 'api.loadEvents', sessionId: ev.sessionId, fromSeq: -2 }] : [] };
      }
      case 'run.started': {
        if (currentSession(state) !== ev.run.sessionId) return { state, effects: [] };
        const r = patch(state, ev.run.sessionId, { selectedTab: null });
        return { state: r.state, effects: [...r.effects, { kind: 'terminal.connect', sessionId: ev.run.sessionId, tabId: ev.run.id }] };
      }
      case 'run.ended': return { state, effects: [{ kind: 'terminal.disconnect', tabId: ev.run.id }] };
      case 'tab.upsert': {
        const t = ev.tab;
        if (t.closedAt !== null) {
          const off: Effect = { kind: 'terminal.disconnect', tabId: t.id };
          const cur = viewOf(state, t.sessionId);
          const p = closedTabPatch(cur, t.id);
          if (!p) return { state, effects: [off] };
          const r = patch(state, t.sessionId, p);
          // 繋ぎ直すのは、いま見ているセッションの左のタブが閉じたときだけ。
          const back: Effect[] = cur.selectedTab === t.id && currentSession(state) === t.sessionId ? [{ kind: 'terminal.connect', sessionId: t.sessionId, tabId: null }] : [];
          return { state: r.state, effects: [...r.effects, off, ...back] };
        }
        if (currentSession(state) !== t.sessionId || t.kind !== 'shell') return { state, effects: [] };
        const r = patch(state, t.sessionId, { selectedTab: t.id });
        return { state: r.state, effects: [...r.effects, { kind: 'terminal.connect', sessionId: t.sessionId, tabId: t.id }, { kind: 'focus', target: 'terminal' }] };
      }
      default: return null;
    }
  }
  if (input.kind === 'runtime' && input.event.type === 'split.resolved') {
    const e = input.event;
    // ランタイムが右に置けるタブを見つけられなかったときだけトーストにする。
    if (!e.tabId) return { state, effects: [{ kind: 'toast', level: 'info', message: '分割にはタブが 2 つ必要です' }] };
    return patch(state, e.sessionId, { split: true, splitTab: e.tabId });
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'transcript.showThinking': return patch(state, i.sessionId, { showThinking: i.show });
    case 'transcript.showRaw': return patch(state, i.sessionId, { showRaw: i.show });
    case 'transcript.follow': return patch(state, i.sessionId, { follow: i.follow });
    case 'summary.toggle': return patch(state, i.sessionId, { summaryOpen: !viewOf(state, i.sessionId).summaryOpen });
    case 'transcript.loadMore': return { state, effects: [{ kind: 'api.loadEvents', sessionId: i.sessionId, fromSeq: -1 }] };
    case 'transcript.selectAgent': {
      const r = patch(state, i.sessionId, { agentId: i.agentId });
      return { state: r.state, effects: [...r.effects, { kind: 'api.loadEvents', sessionId: i.sessionId, fromSeq: 0 }] };
    }
    case 'transcript.toggle': {
      const sid = currentSession(state);
      return sid ? patch(state, sid, { transcriptOpen: !viewOf(state, sid).transcriptOpen }) : { state, effects: [] };
    }
    case 'tab.open': {
      if (i.kind === 'shell') return { state, effects: [{ kind: 'api.openTab', sessionId: i.sessionId }] };
      const r = patch(state, i.sessionId, { selectedTab: null });
      return { state: r.state, effects: [...r.effects, { kind: 'terminal.connect', sessionId: i.sessionId, tabId: null }] };
    }
    case 'tab.select': {
      const sid = currentSession(state);
      if (!sid) return { state, effects: [] };
      const cur = viewOf(state, sid);
      // 分割中に右のタブを選んだら左右を入れ替える。
      // そうでなければ左を差し替えるだけにする。
      const p: Partial<SessionViewState> = cur.split && cur.splitTab === i.tabId && cur.selectedTab ? { selectedTab: i.tabId, splitTab: cur.selectedTab } : { selectedTab: i.tabId };
      const r = patch(state, sid, p);
      return { state: r.state, effects: [...r.effects, { kind: 'terminal.connect', sessionId: sid, tabId: i.tabId }, { kind: 'focus', target: 'terminal' }] };
    }
    case 'split.toggle': {
      const sid = currentSession(state);
      if (!sid) return { state, effects: [] };
      // 閉じるのはその場でできる。
      // 開くときに右へ置くタブはストアを見ないと決まらないので、ランタイムに任せる。
      if (viewOf(state, sid).split) return patch(state, sid, { split: false, splitTab: null });
      return { state, effects: [{ kind: 'split.resolve', sessionId: sid }] };
    }
    case 'tab.close': {
      const sid = currentSession(state);
      const close: Effect = { kind: 'api.closeTab', tabId: i.tabId };
      const p = sid ? closedTabPatch(viewOf(state, sid), i.tabId) : null;
      if (sid && p) { const r = patch(state, sid, p); return { state: r.state, effects: [...r.effects, close] }; }
      return { state, effects: [close] };
    }
    default: return null;
  }
}
