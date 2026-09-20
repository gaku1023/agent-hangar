import { formatRoute, parseRoute, type BootstrapDto, type Intent, type LaunchResultDto, type ServerEvent, type SyncStatusBody } from '@agent-hangar/shared';
import { initialState, transition, type Effect, type Input, type State } from '../mediator/transition.ts';
import { defaultSessionView } from '../mediator/sessionView.ts';
import type { FocusTarget, SessionViewState } from '../mediator/types.ts';
import { aliveRunOf, applyBootstrap, applyConfigPreview, applyEventsPage, applyJoinToken, applyLaunch, applySearch, applyServerEvent, applySubagents, currentRunOf, eventsKey, initialStore, pruneEvents, pruneRuns, setEventsLoading, tabsOf, type Store } from '../store/store.ts';
import { ApiConflictError, type ApiClient, type EventsQuery } from './api.ts';
import type { TerminalHost } from './terminals.ts';
import type { WsClient } from './ws.ts';

export type RuntimeDeps = {
  api: ApiClient;
  ws: (handlers: { onOpen(): void; onClose(): void; onEvent(ev: ServerEvent): void }) => WsClient;
  location: { getHash(): string; setHash(h: string): void; onHashChange(cb: () => void): () => void };
  storage: { get(key: string): unknown; set(key: string, value: unknown): void; keys(): string[] };
  setTimeout: (fn: () => void, ms: number) => unknown;
  terminals: TerminalHost;
  /** terminal だけはランタイムが自分で処理するので、ここへは渡らない。 */
  focus?: (target: Exclude<FocusTarget, 'terminal'>) => void;
  /** 窓が前面に来たことを知らせる。返り値で購読を外す。 */
  onWindowFocus?: (cb: () => void) => () => void;
};

export type Runtime = {
  dispatch(input: Input): void; emit(intent: Intent): void;
  getState(): State; getStore(): Store;
  subscribe(cb: () => void): () => void;
  start(): void; stop(): void;
};

const FELL_BACK = 'iTerm2 で開けなかったので Terminal.app で開きました';
/** 参加トークンをストアに置いておく上限。全セッションの読み書き権を持つ秘密なので、写し終わる頃に自分で消す。 */
const JOIN_TOKEN_TTL_MS = 120_000;

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
  let unsubFocus: (() => void) | null = null;

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const fail = (e: unknown) => dispatch({ kind: 'runtime', event: { type: 'api.failed', message: errMsg(e) } });
  const toast = (message: string) => dispatch({ kind: 'server', event: { type: 'toast', level: 'info', message } });
  const launched = (r: LaunchResultDto) => { setStore(applyLaunch(store, r)); dispatch({ kind: 'runtime', event: { type: 'launch.done', sessionId: r.sessionId, runId: r.run.id } }); };
  const launchFailed = (e: unknown) => dispatch({ kind: 'runtime', event: { type: 'launch.failed', message: errMsg(e) } });
  /**
   * HTTP の応答をそのまま sync.status の経路に載せる。
   * sync.status の型は SyncStatusDto だが、HTTP は付録（諦めた本文と取り残しの件数）も運ぶ。
   * 捨てずに渡すために、ここは SyncStatusBody で受ける。付録の拾い方は applySyncStatus にある。
   */
  const syncStatus = (status: SyncStatusBody) => dispatch({ kind: 'server', event: { type: 'sync.status', status } });

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
          // 本文も同じ基準で落とす。
          const open = state.screen.name === 'session' ? [state.screen.id] : [];
          setStore(pruneEvents(pruneRuns(applyBootstrap(store, b), open), open));
          // 同期の状態と端末の一覧は Mediator が持つので、読み込み直すたびに入れ直す。
          // ここで流さないと、次の sync.status が届くまでヘッダの同期表示が空になる。
          // 古いサーバはこの 2 つを持たないので、そのときは何もしない。
          const older = b as Partial<BootstrapDto>;
          if (older.sync) dispatch({ kind: 'server', event: { type: 'sync.status', status: older.sync } });
          if (older.devices) dispatch({ kind: 'server', event: { type: 'devices.update', devices: older.devices } });
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
        // 持っている行の seq の幅。古い側にも新しい側にも足すので、両端が要る。
        // 遡ったページは後ろに足されて並びが崩れるため、最小と最大は走査で出す。
        let lo = Infinity;
        let hi = -Infinity;
        for (const ev of cur?.items ?? []) { if (ev.seq < lo) lo = ev.seq; if (ev.seq > hi) hi = ev.seq; }
        const have = cur !== undefined && cur.items.length > 0;
        let q: EventsQuery;
        let append = true;
        if (e.fromSeq === 0) {
          // 画面を開いた。最新の側から読み、持っていたものは置き換える。
          append = false;
          q = { latest: true, agentId: view.agentId };
          // 画面に入るたび読み直すので、この時点で開いていないセッションの本文を落とす。
          setStore(pruneEvents(store, [e.sessionId]));
        } else if (e.fromSeq === -1) {
          // 過去へ遡る。読み終えていれば何も求めない。
          if (!have) q = { latest: true, agentId: view.agentId };
          else if (cur!.total > cur!.items.length) q = { beforeSeq: lo, agentId: view.agentId };
          else return;
        } else {
          // 追記が届いた。持っている中でいちばん新しい seq の次から前向きに読み、末尾に足す。
          q = { fromSeq: have ? hi + 1 : 0, agentId: view.agentId };
        }
        setStore(setEventsLoading(store, key, true));
        deps.api.events(e.sessionId, q).then((p) => setStore(applyEventsPage(store, key, p, append))).catch((err) => { setStore(setEventsLoading(store, key, false)); fail(err); });
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
      case 'api.addTodo': deps.api.addTodo(e.projectId, e.text).catch(fail); return;
      case 'api.toggleTodo': {
        // 反転の基準はストアの現在値にする。View は done の値を持たない。
        const t = store.todos[e.id];
        if (!t) return;
        deps.api.setTodoDone(e.id, !t.done).catch(fail);
        return;
      }
      case 'api.removeTodo': deps.api.removeTodo(e.id).catch(fail); return;
      case 'api.loadMemo': deps.api.memo(e.projectId).then((m) => setStore({ ...store, memos: { ...store.memos, [m.projectId]: m } })).catch(fail); return;
      // 保存した結果はサーバの memo.update より先に入れる。書いた本人の画面が一瞬古い本文に戻らないようにする。
      case 'api.saveMemo': deps.api.saveMemo(e.projectId, e.markdown).then((m) => setStore({ ...store, memos: { ...store.memos, [m.projectId]: m } })).catch(fail); return;
      case 'api.setSessionMemo': deps.api.setSessionMemo(e.sessionId, e.text).then((s) => setStore({ ...store, sessions: { ...store.sessions, [s.id]: s } })).catch(fail); return;
      case 'api.openArtifact': deps.api.openArtifact(e.id).catch(fail); return;
      case 'api.openArtifactEditor': deps.api.openArtifactEditor(e.id).catch(fail); return;
      case 'api.addArtifact': deps.api.addArtifact(e.projectId, e.url).then((a) => setStore({ ...store, artifacts: { ...store.artifacts, [a.id]: a } })).catch(fail); return;
      case 'api.promote':
        deps.api.promote(e.sessionId, { name: e.name, gitInit: e.gitInit, moveFiles: e.moveFiles })
          .then((r) => {
            setStore({ ...store, projects: { ...store.projects, [r.project.id]: r.project }, sessions: { ...store.sessions, [r.session.id]: r.session } });
            dispatch({ kind: 'runtime', event: { type: 'promote.done', projectId: r.project.id, moved: r.moved, reason: r.reason } });
          })
          .catch((err) => dispatch({ kind: 'runtime', event: { type: 'promote.failed', message: errMsg(err) } }));
        return;
      // 進みと結果は summary.pending と summary.updated で届くので、ここでは待たない。
      case 'api.regenerateSummary': deps.api.regenerateSummary(e.sessionId).catch(fail); return;
      case 'api.loadSettingsExtras':
        deps.api.statusline().then((s) => setStore({ ...store, statusline: s })).catch(fail);
        deps.api.usageAggregate(30).then((a) => setStore({ ...store, usageAggregate: a })).catch(fail);
        // LM Studio が起動していないのは普通の状態なので、失敗は空の一覧にして黙る。
        deps.api.summarizerModels().then((m) => setStore({ ...store, summarizerModels: m.models })).catch(() => setStore({ ...store, summarizerModels: [] }));
        return;
      case 'api.testSummarizer':
        // 前回の結果を先に消して、試している最中だと分かるようにする。
        setStore({ ...store, summarizerTest: null });
        deps.api.testSummarizer().then((r) => setStore({ ...store, summarizerTest: r })).catch(fail);
        return;
      case 'split.resolve': {
        // 左は選択中のタブ、無ければ先頭。右はそれと違う最初のタブ。2 つ無ければ null を返す。
        const view = state.sessionView[e.sessionId] ?? defaultSessionView();
        const run = currentRunOf(store, e.sessionId);
        const tabs = run ? tabsOf(store, run.id) : [];
        const left = view.selectedTab ?? tabs[0]?.id ?? null;
        const right = tabs.find((t) => t.id !== left) ?? null;
        dispatch({ kind: 'runtime', event: { type: 'split.resolved', sessionId: e.sessionId, tabId: right ? right.id : null } });
        return;
      }
      case 'storage.save': deps.storage.set(e.key, e.value); return;
      // 返ってきた状態は sync.status と同じ経路に載せる。ストアと Mediator の両方が一度に揃う。
      case 'api.syncNow': deps.api.syncNow().then(syncStatus).catch(fail); return;
      case 'api.syncPause': deps.api.syncPause(e.paused).then(syncStatus).catch(fail); return;
      // 前面化は静かに失敗させる。窓を触るたびに赤い通知が出ると邪魔になる。
      case 'api.syncFocus': deps.api.syncFocus().catch(() => {}); return;
      case 'api.resumeHere':
        deps.api.resumeHere(e.sessionId, e.overwrite).then(launched).catch((err: unknown) => {
          // 手元の本文の方が小さいときの 409 だけは、トーストではなく確認ダイアログにする。
          if (err instanceof ApiConflictError) dispatch({ kind: 'runtime', event: { type: 'api.conflict', kind: 'resumeHere', sessionId: e.sessionId, localSize: err.body.localSize, remoteSize: err.body.remoteSize } });
          // それ以外は起動の失敗である。launch.failed でないと送信中が解けず、二度と押せなくなる。
          else launchFailed(err);
        });
        return;
      case 'api.configPreview': deps.api.configPreview().then((p) => setStore(applyConfigPreview(store, p))).catch(fail); return;
      case 'api.configPull': deps.api.configPull().then((r) => toast(`${r.applied} 件を取り込みました（競合 ${r.conflicts} 件）`)).catch(fail); return;
      case 'api.joinToken':
        deps.api.joinToken().then((r) => {
          setStore(applyJoinToken(store, r.token));
          // 秘密をストアに残し続けない。同じトークンがまだ出ているときだけ消す。
          if (r.token !== null) deps.setTimeout(() => { if (store.joinToken === r.token) setStore(applyJoinToken(store, null)); }, JOIN_TOKEN_TTL_MS);
        }).catch(fail);
        return;
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
      for (const k of deps.storage.keys()) {
        if (!k.startsWith('sv:')) continue;
        const v = deps.storage.get(k);
        if (!v || typeof v !== 'object') continue;
        // follow は残さない決まりだが、古い保存に残っていることがある。読み戻すときに落として既定（真）に戻す。
        const { follow: _ignore, ...rest } = v as Partial<SessionViewState>;
        sv[k.slice(3)] = { ...defaultSessionView(), ...rest };
      }
      state = { ...state, sessionView: sv };
      ws = deps.ws({
        onOpen: () => dispatch({ kind: 'runtime', event: { type: 'ws.open' } }),
        onClose: () => dispatch({ kind: 'runtime', event: { type: 'ws.close' } }),
        onEvent: (ev) => dispatch({ kind: 'server', event: ev }),
      });
      unsubHash = deps.location.onHashChange(() => dispatch({ kind: 'runtime', event: { type: 'hash.changed', route: parseRoute(deps.location.getHash()) } }));
      unsubFocus = deps.onWindowFocus?.(() => dispatch({ kind: 'runtime', event: { type: 'window.focus' } })) ?? null;
      ws.connect();
    },
    stop() { ws?.close(); unsubHash?.(); unsubFocus?.(); unsubFocus = null; deps.terminals.dispose(); },
  };
}
