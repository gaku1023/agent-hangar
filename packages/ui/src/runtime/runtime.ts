import { formatRoute, parseRoute, type Intent, type ServerEvent } from '@agent-hangar/shared';
import { initialState, transition, type Effect, type Input, type State } from '../mediator/transition.ts';
import { defaultSessionView } from '../mediator/sessionView.ts';
import type { FocusTarget, SessionViewState } from '../mediator/types.ts';
import { applyBootstrap, applyEventsPage, applySearch, applyServerEvent, eventsKey, initialStore, setEventsLoading, type Store } from '../store/store.ts';
import type { ApiClient } from './api.ts';
import type { WsClient } from './ws.ts';

export type RuntimeDeps = {
  api: ApiClient;
  ws: (handlers: { onOpen(): void; onClose(): void; onEvent(ev: ServerEvent): void }) => WsClient;
  location: { getHash(): string; setHash(h: string): void; onHashChange(cb: () => void): () => void };
  storage: { get(key: string): unknown; set(key: string, value: unknown): void; keys(): string[] };
  setTimeout: (fn: () => void, ms: number) => unknown;
  focus?: (target: FocusTarget) => void;
};

export type Runtime = {
  dispatch(input: Input): void; emit(intent: Intent): void;
  getState(): State; getStore(): Store;
  subscribe(cb: () => void): () => void;
  start(): void; stop(): void;
};

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

  const fail = (e: unknown) => dispatch({ kind: 'runtime', event: { type: 'api.failed', message: e instanceof Error ? e.message : String(e) } });

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
          setStore(applyBootstrap(store, b));
          // 起動時の通知は誰も繋がっていないうちに流れてしまうので、今ある未解決のプロジェクトをここで入力に変える。
          for (const p of b.projects) if (p.path && !p.resolved) dispatch({ kind: 'server', event: { type: 'project.unresolved', projectId: p.id } });
          dispatch({ kind: 'runtime', event: { type: 'hash.changed', route: parseRoute(deps.location.getHash()) } });
        }).catch(fail);
        return;
      case 'api.loadEvents': {
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
      case 'ws.connect': ws?.connect(); return;
      case 'ws.reconnectAfter': deps.setTimeout(() => ws?.connect(), e.ms); return;
      case 'focus': deps.focus?.(e.target); return;
      case 'toast': dispatch({ kind: 'server', event: { type: 'toast', level: e.level, message: e.message } }); return;
      case 'storage.save': deps.storage.set(e.key, e.value); return;
    }
  }

  function dispatch(input: Input): void {
    if (input.kind === 'server') setStore(applyServerEvent(store, input.event));
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
    stop() { ws?.close(); unsubHash?.(); },
  };
}
