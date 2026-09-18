import { formatRoute, parseRoute, type Intent, type LaunchResultDto, type ServerEvent } from '@agent-hangar/shared';
import { initialState, transition, type Effect, type Input, type State } from '../mediator/transition.ts';
import { defaultSessionView } from '../mediator/sessionView.ts';
import type { FocusTarget, SessionViewState } from '../mediator/types.ts';
import { aliveRunOf, applyBootstrap, applyEventsPage, applyLaunch, applySearch, applyServerEvent, applySubagents, currentRunOf, eventsKey, initialStore, pruneRuns, setEventsLoading, tabsOf, type Store } from '../store/store.ts';
import type { ApiClient } from './api.ts';
import type { TerminalHost } from './terminals.ts';
import type { WsClient } from './ws.ts';

export type RuntimeDeps = {
  api: ApiClient;
  ws: (handlers: { onOpen(): void; onClose(): void; onEvent(ev: ServerEvent): void }) => WsClient;
  location: { getHash(): string; setHash(h: string): void; onHashChange(cb: () => void): () => void };
  storage: { get(key: string): unknown; set(key: string, value: unknown): void; keys(): string[] };
  setTimeout: (fn: () => void, ms: number) => unknown;
  terminals: TerminalHost;
  focus?: (target: FocusTarget) => void;
};

export type Runtime = {
  dispatch(input: Input): void; emit(intent: Intent): void;
  getState(): State; getStore(): Store;
  subscribe(cb: () => void): () => void;
  start(): void; stop(): void;
};

const FELL_BACK = 'iTerm2 で開けなかったので Terminal.app で開きました';

/** Mediator の効果を実行し、サーバとブラウザの出来事を入力に変える。 */
export function createRuntime(deps: RuntimeDeps): Runtime {
  let state = initialState();
  let store = initialStore();
  const listeners = new Set<() => void>();
  const notify = () => { for (const l of listeners) l(); };
  const setStore = (next: Store) => { if (next !== store) { store = next; notify(); } };
  let ws: WsClient | null = null;
  let searchSeq = 0;
  let unsubHash: (() => void) | null = null;

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const fail = (e: unknown) => dispatch({ kind: 'runtime', event: { type: 'api.failed', message: errMsg(e) } });
  const toast = (message: string) => dispatch({ kind: 'server', event: { type: 'toast', level: 'info', message } });
  const launched = (r: LaunchResultDto) => { setStore(applyLaunch(store, r)); dispatch({ kind: 'runtime', event: { type: 'launch.done', sessionId: r.sessionId, runId: r.run.id } }); };
  const launchFailed = (e: unknown) => dispatch({ kind: 'runtime', event: { type: 'launch.failed', message: errMsg(e) } });

  /** サブエージェントの一覧を 1 回だけ取る。
   * 本文の読み込みと同じ経路で呼ぶが、ページを継ぎ足すたびに取り直す必要はない。
   * 失敗したセッションも覚えておき、画面を行き来するたびに同じ失敗を繰り返さない。
   */
  const subagentsAsked = new Set<string>();
  function loadSubagents(sessionId: string): void {
    if (subagentsAsked.has(sessionId)) return;
    subagentsAsked.add(sessionId);
    deps.api.subagents(sessionId).then((ids) => setStore(applySubagents(store, sessionId, ids))).catch(fail);
  }

  /** 繋ぐタブを決める。
   * 指定が無ければ選択中のタブ、無ければ現在の run の Claude タブ。
   * 終了した run の Claude タブには繋がない。
   */
  function resolveTab(sessionId: string, tabId: string | null): string | null {
    const run = currentRunOf(store, sessionId);
    if (!run) return null;
    const open = tabsOf(store, run.id);
    const pick = tabId ?? state.sessionView[sessionId]?.selectedTab ?? run.id;
    const tab = open.find((t) => t.id === pick) ?? open[0];
    if (!tab || (tab.kind === 'agent' && run.endedAt !== null)) return null;
    return tab.id;
  }

  function runEffect(e: Effect): void {
    switch (e.kind) {
      case 'navigate': {
        const h = formatRoute(e.route);
        if (deps.location.getHash() === h) dispatch({ kind: 'runtime', event: { type: 'hash.changed', route: e.route } });
        else deps.location.setHash(h);
        return;
      }
      case 'api.bootstrap':
        deps.api.bootstrap().then((b) => {
          // 取り直しは混ぜるので、そのついでに参照されなくなった run を落とす。
          // 見ているセッションの run は、まだ画面が引くので残す。
          setStore(pruneRuns(applyBootstrap(store, b), state.screen.name === 'session' ? [state.screen.id] : []));
          // 起動時の通知は誰も繋がっていないうちに流れてしまうので、今ある未解決のプロジェクトをここで入力に変える。
          for (const p of b.projects) if (p.path && !p.resolved) dispatch({ kind: 'server', event: { type: 'project.unresolved', projectId: p.id } });
          dispatch({ kind: 'runtime', event: { type: 'hash.changed', route: parseRoute(deps.location.getHash()) } });
        }).catch(fail);
        return;
      case 'api.loadEvents': {
        loadSubagents(e.sessionId);
        const view = state.sessionView[e.sessionId] ?? defaultSessionView();
        const key = eventsKey(e.sessionId, view.agentId);
        const cur = store.events[key];
        if (cur?.loading) return;
        let from = e.fromSeq;
        let append = true;
        if (from === 0) append = false;
        else if (from === -1) { from = cur?.nextSeq ?? (cur && cur.total > cur.items.length ? cur.items.length : -1); if (from < 0) return; }
        setStore(setEventsLoading(store, key, true));
        deps.api.events(e.sessionId, from, view.agentId).then((p) => setStore(applyEventsPage(store, key, p, append))).catch((err) => { setStore(setEventsLoading(store, key, false)); fail(err); });
        return;
      }
      case 'api.search': {
        const seq = ++searchSeq;
        setStore(applySearch(store, e.params, store.search.result, true));
        deps.api.search(e.params).then((r) => { if (seq === searchSeq) setStore(applySearch(store, e.params, r, false)); }).catch(fail);
        return;
      }
      case 'api.setProjectStatus': deps.api.setProjectStatus(e.projectId, e.status).catch(fail); return;
      case 'api.resolveProject': deps.api.resolveProject(e.projectId, e.action).catch(fail); return;
      case 'api.updateSettings': deps.api.updateSettings(e.patch).then((s) => setStore({ ...store, settings: s })).catch(fail); return;
      case 'api.rebuildIndex': deps.api.rebuildIndex().catch(fail); return;
      case 'api.launch': deps.api.launch(e.params).then(launched).catch(launchFailed); return;
      case 'api.resume': deps.api.resume(e.sessionId).then(launched).catch(launchFailed); return;
      case 'api.fork': deps.api.fork(e.sessionId).then(launched).catch(launchFailed); return;
      case 'api.killRun': deps.api.killRun(e.runId).then((run) => setStore(applyServerEvent(store, { type: 'run.ended', run }))).catch(fail); return;
      case 'api.openTab': {
        const run = aliveRunOf(store, e.sessionId);
        if (!run) { fail(new Error('実行中の run がありません')); return; }
        deps.api.openTab(run.id).then((tab) => setStore(applyServerEvent(store, { type: 'tab.upsert', tab }))).catch(fail);
        return;
      }
      case 'api.closeTab': {
        const tab = store.tabs[e.tabId];
        if (!tab) return;
        deps.api.closeTab(tab.runId, tab.id).then((t) => setStore(applyServerEvent(store, { type: 'tab.upsert', tab: t }))).catch(fail);
        return;
      }
      case 'api.openTerminalApp': deps.api.openTerminalApp(e.runId, e.tabId).then((r) => { if (r.fellBack) toast(FELL_BACK); }).catch(fail); return;
      case 'api.openEditor': deps.api.openEditor(e.sessionId).catch(fail); return;
      case 'api.projectOpenEditor': deps.api.projectOpenEditor(e.projectId).catch(fail); return;
      case 'api.projectOpenTerminal': deps.api.projectOpenTerminal(e.projectId).then((r) => { if (r.fellBack) toast(FELL_BACK); }).catch(fail); return;
      case 'terminal.connect': { const id = resolveTab(e.sessionId, e.tabId); if (id) deps.terminals.connect(id); return; }
      case 'terminal.disconnect': deps.terminals.disconnect(e.tabId); return;
      case 'terminal.disconnectSession':
        for (const t of Object.values(store.tabs)) if (t.sessionId === e.sessionId) deps.terminals.disconnect(t.id);
        return;
      case 'ws.connect': ws?.connect(); return;
      case 'ws.reconnectAfter': deps.setTimeout(() => ws?.connect(), e.ms); return;
      case 'focus':
        if (e.target === 'terminal') { if (state.screen.name === 'session') { const id = resolveTab(state.screen.id, null); if (id) deps.terminals.focus(id); } }
        else deps.focus?.(e.target);
        return;
      case 'toast': dispatch({ kind: 'server', event: { type: 'toast', level: e.level, message: e.message } }); return;
      case 'storage.save': deps.storage.set(e.key, e.value); return;
      default: {
        // 効果を足したときに処理を忘れると、ここで型が合わなくなる。
        const _exhaustive: never = e;
        return _exhaustive;
      }
    }
  }

  function dispatch(input: Input): void {
    if (input.kind === 'server') {
      setStore(applyServerEvent(store, input.event));
      // 本文が伸びたセッションは、サブエージェントが増えているかもしれない。
      // ここでは取りに行かず、次に本文を読むときに取り直させる。
      // 本文を読むのは画面に出ているセッションだけなので、見ていないセッションの分は無駄に取らない。
      if (input.event.type === 'transcript.appended') subagentsAsked.delete(input.event.sessionId);
    }
    const r = transition(state, input);
    if (r.state !== state) { state = r.state; notify(); }
    for (const eff of r.effects) runEffect(eff);
  }

  return {
    dispatch,
    emit: (intent) => dispatch({ kind: 'intent', intent }),
    getState: () => state,
    getStore: () => store,
    subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    start() {
      const sv: Record<string, SessionViewState> = {};
      for (const k of deps.storage.keys()) if (k.startsWith('sv:')) { const v = deps.storage.get(k); if (v && typeof v === 'object') sv[k.slice(3)] = { ...defaultSessionView(), ...(v as Partial<SessionViewState>) }; }
      state = { ...state, sessionView: sv };
      ws = deps.ws({
        onOpen: () => dispatch({ kind: 'runtime', event: { type: 'ws.open' } }),
        onClose: () => dispatch({ kind: 'runtime', event: { type: 'ws.close' } }),
        onEvent: (ev) => dispatch({ kind: 'server', event: ev }),
      });
      unsubHash = deps.location.onHashChange(() => dispatch({ kind: 'runtime', event: { type: 'hash.changed', route: parseRoute(deps.location.getHash()) } }));
      ws.connect();
    },
    stop() { ws?.close(); unsubHash?.(); deps.terminals.dispose(); },
  };
}
