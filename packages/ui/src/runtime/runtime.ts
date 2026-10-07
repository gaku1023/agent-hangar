import { formatRoute, parseRoute, type AccountsDto, type BootstrapDto, type Intent, type LaunchResultDto, type ServerEvent, type SyncStatusBody } from '@agent-hangar/shared';
import { initialState, transition, type Effect, type Input, type State } from '../mediator/transition.ts';
import { defaultSessionView } from '../mediator/sessionView.ts';
import { LAUNCH_PREFS_KEY, NEW_SESSION_DRAFT_KEY, readDraft, readLaunchPrefs } from '../mediator/launch.ts';
import { PAGE_SIZE_KEY, readPageSize } from '../mediator/paging.ts';
import { RETENTION_BANNER_KEY } from '../mediator/retention.ts';
import { toSearchParams } from '../mediator/screen.ts';
import { clampLivePaneSplit, cleanSidebarOrder, LIVE_PANE_SPLIT_KEY, readSessionLivePaneSplit, SIDEBAR_KEY, SIDEBAR_ORDER_KEY } from '../mediator/sidebar.ts';
import { NOTIFY_KEY } from '../mediator/notify.ts';
import { dueReturnKeys, nextReturnAt, readReturnSeen, RETURN_SEEN_KEY } from '../mediator/returnDue.ts';
import { NO_QUESTION } from '../presenters/home.ts';
import { daysLabel } from '../presenters/retention.ts';
// 参加トークンをストアに置いておく上限。画面の残りの秒数と同じ値を使う。
import { JOIN_TOKEN_TTL_MS } from '../presenters/settings.ts';
import type { FocusTarget, SessionViewState, TurnJumpStatus } from '../mediator/types.ts';
import { aliveRunOf, applyBootstrap, applyConfigPreview, applyEventsPage, applyJoinToken, applyLaunch, applyLiveDigest, applySearch, applyServerEvent, applySubagents, currentRunOf, eventsKey, initialStore, liveSessionIds, nextWaitingSession, waitingSessionIds, pruneEvents, pruneRuns, setEventsLoading, tabsOf, vanishedOnBootstrap, type Store } from '../store/store.ts';
import { ApiConflictError, RetentionConflictApiError, type ApiClient, type EventsQuery } from './api.ts';
import type { DesktopBridge } from './desktop.ts';
import type { Notifier } from './notifier.ts';
import type { TerminalHost } from './terminals.ts';
import type { WsClient } from './ws.ts';

export type RuntimeDeps = {
  api: ApiClient;
  ws: (handlers: { onOpen(): void; onClose(): void; onEvent(ev: ServerEvent): void }) => WsClient;
  location: { getHash(): string; setHash(h: string): void; onHashChange(cb: () => void): () => void; go(delta: number): void; depth(): number };
  storage: { get(key: string): unknown; set(key: string, value: unknown): void; keys(): string[] };
  setTimeout: (fn: () => void, ms: number) => unknown;
  /** いま何時か。切断の時刻を Mediator へ渡すために要る。テストが差し替えられるように受け口にしてある。 */
  now?: () => number;
  terminals: TerminalHost;
  /** terminal だけはランタイムが自分で処理するので、ここへは渡らない。 */
  focus?: (target: Exclude<FocusTarget, 'terminal'>) => void;
  /** 窓が前面に来たことを知らせる。返り値で購読を外す。 */
  onWindowFocus?: (cb: () => void) => () => void;
  /**
   * 頁が見える状態に戻ったこと（document の visibilitychange で visible）を知らせる。返り値で購読を外す。
   * 隠れていた窓を前に出しただけでは focus が来ないことがあるので、通知の許可の読み直しはこちらでも行う。
   */
  onWindowVisible?: (cb: () => void) => () => void;
  /**
   * 状態の変化を画面へ出す。
   * commit を呼ぶまで、getState は前に描いた状態を返し、React はそれを描き続ける。
   * 画面の移り変わりを View Transitions で包むための口である（runtime/present.ts）。無ければその場で出す。
   */
  present?: (commit: () => void, prev: State, next: State) => void;
  /**
   * 窓の外へ入力待ちを知らせる口（runtime/notifier.ts）。
   * 無ければ通知もバッジも出さない。
   */
  notifier?: Notifier;
  /**
   * デスクトップの殻に頼む口。殻の中でだけ渡り、ブラウザでは無い。
   * 画面はこの有無で、「ログを開く」「再起動」を出すか、ログの場所のコピーと文の案内に落とすかを決める。
   */
  desktop?: DesktopBridge | null;
  /** クリップボードに書く。無ければ navigator.clipboard を使う。テストが差し替える口である。 */
  clipboard?: (text: string) => Promise<void>;
};

export type Runtime = {
  dispatch(input: Input): void; emit(intent: Intent): void;
  getState(): State; getStore(): Store;
  subscribe(cb: () => void): () => void;
  /** アプリの中に戻る先があるか。画面端の矢印を出すかどうかの判断に使う。 */
  canGoBack(): boolean;
  start(): void; stop(): void;
};

const FELL_BACK = 'iTerm2 で開けなかったので Terminal.app で開きました';
/** OS（システム設定）で通知が切られているときの知らせ。 */
const NOTIFY_BLOCKED = '通知が切られています。システム設定の「通知」で Hangar を許可してください';
/** 通知の許可を読み直す間隔の下限。窓に戻ると focus と visibilitychange が続けて来るので、まとめて 1 度にする。 */
export const NOTIFY_RECHECK_MS = 2000;
/** クリップボードに写せなかったときの知らせ。写そうとした中身は出さない。 */
const COPY_FAILED = 'コピーできませんでした。文字を選んで ⌘C で写してください';
/** 検索の結果から開くとき、跳び先より前にどれだけ（seq の幅）読むか。跳び先の前の文脈が見える程度にする。 */
const AROUND_BEFORE = 100;

/** Mediator の効果を実行し、サーバとブラウザの出来事を入力に変える。 */
/** 先の戻る時点を見直す間隔の上限。 */
const RETURN_RECHECK_MAX_MS = 12 * 60 * 60_000;

export function createRuntime(deps: RuntimeDeps): Runtime {
  let state = initialState();
  // React が読む状態。present が commit を呼ぶまで、前に描いた state のままでいる。
  // 遷移の計算は常に最新の state で行い、描く側だけを遅らせる。
  let shown = state;
  // 殻の有無は起動の時に決まり、あとで変わらない。
  let store: Store = { ...initialStore(), desktop: deps.desktop != null };
  const listeners = new Set<() => void>();
  const notify = () => { for (const l of listeners) l(); };
  const commit = () => { if (shown !== state) { shown = state; notify(); } };
  const present = deps.present ?? ((c: () => void) => c());
  const setStore = (next: Store) => { if (next !== store) { store = next; notify(); syncWaiting(); syncLive(); syncReturns(); } };
  /**
   * 入力待ちのセッションが変わったら Mediator へ届ける。
   * live.update はプロバイダの id で届くので、hangar のセッションへの引き当てはストアを持つここで行う。
   * 起動時の bootstrap も、あとから届く session.upsert も、同じ口を通る。
   */
  let waitingKey = '';
  function syncWaiting(): void {
    const ids = waitingSessionIds(store);
    const key = [...ids].sort().join('\n');
    if (key === waitingKey) return;
    waitingKey = key;
    dispatch({ kind: 'runtime', event: { type: 'waiting.changed', ids } });
  }
  /**
   * 動いているセッションの顔ぶれが変わったら Mediator へ届ける。サイドバーの「動いている」の並びに、初めて現れたものを書き足すためである（mediator/sidebar.ts の sidebarLiveStep）。
   * 並びの順ではなく顔ぶれで比べる。ストアは本文が伸びるたびに変わるので、そのたびには送らない。
   */
  let liveKey = '';
  function syncLive(): void {
    const ids = liveSessionIds(store);
    const key = [...ids].sort().join('\n');
    if (key === liveKey) return;
    liveKey = key;
    dispatch({ kind: 'runtime', event: { type: 'live.changed', ids } });
  }
  /**
   * 時刻つきの Paused が、その時刻を過ぎたら Mediator へ届ける（mediator/returnDue.ts）。
   * ストアが変わるたびと、次の戻る時点に入れた予約と、窓が前面に戻ったときに見直す。
   * 予約は次の時点が変わったときだけ入れ直す。ストアは本文が伸びるたびに変わるので、そのたびに積むと予約が溜まる。
   * 予約は取り消せないので、古い予約は世代の番号で空振りさせる。
   */
  let returnDueKey = '';
  let returnTimerAt: number | null = null;
  let returnTimerGen = 0;
  function syncReturns(): void {
    // bootstrap の前はセッションが空で、過ぎたものが無いように見える。そこで届けると、覚えてある鍵を消してしまう。
    if (!store.bootstrapped) return;
    const now = clock();
    const keys = dueReturnKeys(store.sessions, now);
    const key = keys.join('\n');
    if (key !== returnDueKey) {
      returnDueKey = key;
      dispatch({ kind: 'runtime', event: { type: 'return.due', keys } });
    }
    const next = nextReturnAt(store.sessions, now);
    if (next === returnTimerAt) return;
    returnTimerAt = next;
    const gen = ++returnTimerGen;
    if (next === null) return;
    // 予約が少し早く走っても取りこぼさないよう、走ったら予約を忘れてから見直す（まだ過ぎていなければ入れ直す）。
    // 何日も先の時点は、タイマーの上限（約 24 日）を越えないよう 12 時間ごとに見直す。
    deps.setTimeout(() => { if (gen !== returnTimerGen) return; returnTimerAt = null; syncReturns(); }, Math.min(next - now, RETURN_RECHECK_MAX_MS));
  }
  const notifier = deps.notifier;
  let unsubNotify: (() => void) | null = null;
  let ws: WsClient | null = null;
  let searchSeq = 0;
  let unsubHash: (() => void) | null = null;
  // ハッシュの変化が、アプリが自分で書いたもの（navigate）か、ブラウザの戻る・進むかを見分けるための控え。
  // 自分で書いた先は wrote に控え、届いたら消す。それ以外の変化には、履歴の段がいくつ動いたか（moved）を添える。
  let wrote: string | null = null;
  let lastDepth = 0;
  let unsubFocus: (() => void) | null = null;
  let unsubVisible: (() => void) | null = null;
  /** 通知の許可を最後に読み直した時刻。 */
  let notifyCheckedAt = -Infinity;

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const fail = (e: unknown) => dispatch({ kind: 'runtime', event: { type: 'api.failed', message: errMsg(e) } });
  const failWith = (what: string, e: unknown) => dispatch({ kind: 'runtime', event: { type: 'api.failed', message: `${what}: ${errMsg(e)}` } });
  /** 準備の確かめを取りに行く。設定画面の検証と、空のホームの確認リストが同じ値を読む。 */
  const loadReadiness = () => { deps.api.readiness().then((r) => setStore({ ...store, readiness: r })).catch(fail); };
  const toast = (message: string) => dispatch({ kind: 'server', event: { type: 'toast', level: 'info', message } });
  const launched = (r: LaunchResultDto) => { setStore(applyLaunch(store, r)); dispatch({ kind: 'runtime', event: { type: 'launch.done', sessionId: r.sessionId, runId: r.run.id } }); };
  const launchFailed = (e: unknown) => dispatch({ kind: 'runtime', event: { type: 'launch.failed', message: errMsg(e) } });
  /**
   * HTTP の応答をそのまま sync.status の経路に載せる。
   * 付録（送れなかった本文と取り残しの件数）は HTTP も websocket も運ぶので、型は両方とも SyncStatusBody である。
   */
  const syncStatus = (status: SyncStatusBody) => dispatch({ kind: 'server', event: { type: 'sync.status', status } });
  /** アカウントの応答も同じく、accounts.update の経路に載せる。 */
  const accountsUpdated = (accounts: AccountsDto) => dispatch({ kind: 'server', event: { type: 'accounts.update', accounts } });

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

  /**
   * 右ペインのライブの要約を取る。追記のたびに呼ばれるので、1 秒に 1 回までにまとめる。
   * 間に来た呼び出しは捨てず、1 秒後に 1 回だけ取り直す予約にまとめる（最後の追記を取りこぼさない）。
   * 右ペインは補助の表示なので、失敗はトーストにしない。
   */
  const LIVE_GAP_MS = 1000;
  const liveNext = new Map<string, number>();
  const liveWaiting = new Set<string>();
  const clock = () => (deps.now ?? Date.now)();
  function loadLive(sessionId: string): void {
    if (aliveRunOf(store, sessionId) === null || liveWaiting.has(sessionId)) return;
    const go = () => {
      liveWaiting.delete(sessionId);
      liveNext.set(sessionId, clock() + LIVE_GAP_MS);
      deps.api.live(sessionId).then((d) => setStore(applyLiveDigest(store, d))).catch(() => {});
    };
    const wait = (liveNext.get(sessionId) ?? 0) - clock();
    if (wait <= 0) go();
    else { liveWaiting.add(sessionId); deps.setTimeout(go, wait); }
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
      // 履歴を動かすだけで、行き先はハッシュの変化として戻ってくる。
      // ただしアプリの最初の頁より前へは戻らない。デスクトップではその手前がサーバの起動を待つ頁で、戻ると詰む。
      case 'history.go':
        if (e.delta < 0 && deps.location.depth() <= 0) return;
        deps.location.go(e.delta);
        return;
      case 'navigate': {
        const h = formatRoute(e.route);
        if (deps.location.getHash() === h) dispatch({ kind: 'runtime', event: { type: 'hash.changed', route: e.route } });
        else { wrote = h; deps.location.setHash(h); }
        return;
      }
      case 'api.bootstrap':
        deps.api.bootstrap().then((b) => {
          // 取り直しは混ぜるので、そのついでに参照されなくなった run を落とす。
          // 見ているセッションの run は、まだ画面が引くので残す。
          // 本文も同じ基準で落とす。
          const open = state.screen.name === 'session' ? [state.screen.id] : [];
          // サーバの再起動中に終わった run は、run.ended が届かないまま bootstrap から消える。
          // 取り直す前に生きていたのに今は無い run とタブを拾っておき、混ぜた後で終わったことにする。
          const gone = vanishedOnBootstrap(store, b, (deps.now ?? Date.now)());
          setStore(pruneEvents(pruneRuns(applyBootstrap(store, b), open), open));
          // run.ended と tab.upsert を通すのは、届いていれば起きたこと（接続を切る、跳び先を忘れる）を同じ道で起こすためである。
          for (const run of gone.runs) dispatch({ kind: 'server', event: { type: 'run.ended', run } });
          for (const tab of gone.tabs) dispatch({ kind: 'server', event: { type: 'tab.upsert', tab } });
          // 同期の状態と端末の一覧は Mediator が持つので、読み込み直すたびに入れ直す。
          // ここで流さないと、次の sync.status が届くまでヘッダの同期表示が空になる。
          // 古いサーバはこの 2 つを持たないので、そのときは何もしない。
          const older = b as Partial<BootstrapDto>;
          if (older.sync) dispatch({ kind: 'server', event: { type: 'sync.status', status: older.sync } });
          if (older.devices) dispatch({ kind: 'server', event: { type: 'devices.update', devices: older.devices } });
          // 起動時の通知は誰も繋がっていないうちに流れてしまうので、今ある未解決のプロジェクトをここで入力に変える。
          for (const p of b.projects) if (p.path && !p.resolved) dispatch({ kind: 'server', event: { type: 'project.unresolved', projectId: p.id } });
          dispatch({ kind: 'runtime', event: { type: 'hash.changed', route: parseRoute(deps.location.getHash()) } });
          // セッションが 1 つも無ければ、ホームは準備の確認リストを出す。その中身をここで取りに行く。
          if (b.sessions.length === 0) loadReadiness();
        }).catch(fail);
        return;
      case 'api.loadEvents': {
        // 本文が無いと分かっている会話は読みに行かない。行っても 404 のトーストが出るだけである。
        if (store.sessions[e.sessionId]?.hasTranscript === false) return;
        loadSubagents(e.sessionId);
        loadLive(e.sessionId);
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
        let older = false;
        if (e.fromSeq === 0) {
          // 画面を開いた。最新の側から読み、持っていたものは置き換える。
          append = false;
          q = { latest: true, agentId: view.agentId };
          // 検索の結果から開いたときは、跳び先の少し前から前向きに読む。後ろは「新しい行を読み込む」で足す。
          // ターミナルが出るセッションは本文を出さず、右の欄が最新の側を使うので、いつもどおり最新の側から読む。
          if (e.aroundSeq !== undefined && !currentRunOf(store, e.sessionId)) q = { fromSeq: Math.max(e.aroundSeq - AROUND_BEFORE, 0), agentId: view.agentId };
          // 画面に入るたび読み直すので、この時点で開いていないセッションの本文を落とす。
          setStore(pruneEvents(store, [e.sessionId]));
        } else if (e.fromSeq === -1) {
          // 過去へ遡る。読み終えていれば何も求めない。
          if (!have) q = { latest: true, agentId: view.agentId };
          else if (cur!.total > cur!.items.length && !cur!.olderDone) { q = { beforeSeq: lo, agentId: view.agentId }; older = true; }
          else return;
        } else {
          // 追記が届いた（か、真ん中の頁から開いた本文の後ろを読み足す）。持っている中でいちばん新しい seq の次から前向きに読み、末尾に足す。
          q = { fromSeq: have ? hi + 1 : 0, agentId: view.agentId };
        }
        setStore(setEventsLoading(store, key, true));
        deps.api.events(e.sessionId, q).then((p) => setStore(applyEventsPage(store, key, p, append, older))).catch((err) => { setStore(setEventsLoading(store, key, false)); fail(err); });
        return;
      }
      case 'api.search': {
        const seq = ++searchSeq;
        // 期間の日数は、送るこの瞬間の時刻で since に直す。
        const params = toSearchParams(e.params, (deps.now ?? Date.now)());
        // 読んでいる間も持っている行は消さない。届いたら、そのページの行に入れ替える。
        setStore(applySearch(store, params, store.search.result, true));
        // 失敗したら読み込み中を解く。解かないとページ送りが「検索しています」のまま残る。
        deps.api.search(params)
          .then((r) => { if (seq === searchSeq) setStore(applySearch(store, params, r, false)); })
          .catch((err) => { if (seq === searchSeq) setStore(applySearch(store, store.search.params ?? params, store.search.result, false)); fail(err); });
        return;
      }
      case 'api.setProjectStatus': deps.api.setProjectStatus(e.projectId, e.status).catch(fail); return;
      case 'api.resolveProject': deps.api.resolveProject(e.projectId, e.action).catch(fail); return;
      case 'api.updateSettings': {
        const field = e.field;
        deps.api.updateSettings(e.patch).then((s) => {
          setStore({ ...store, settings: s });
          if (field) dispatch({ kind: 'runtime', event: { type: 'settings.saved', field } });
          // パスが変わると欄の下の検証も変わるので、準備の確かめを取り直す。
          loadReadiness();
        }).catch((err: unknown) => {
          // 欄ごとの保存の失敗は、その欄の下に理由を出す。トーストにはしない。
          if (field) dispatch({ kind: 'runtime', event: { type: 'settings.failed', field, message: errMsg(err) } });
          else fail(err);
        });
        return;
      }
      case 'api.readiness': loadReadiness(); return;
      case 'shell.openLog':
        if (!deps.desktop) return;
        deps.desktop.openLog().catch((err: unknown) => failWith('ログを開けませんでした', err));
        return;
      case 'shell.restart':
        if (!deps.desktop) return;
        deps.desktop.restart().catch((err: unknown) => failWith('再起動できませんでした', err));
        return;
      case 'clipboard.copy': {
        const write = deps.clipboard ?? ((text: string) => navigator.clipboard.writeText(text));
        // 写せたら状態に返し、ボタンはそれを見てから「コピーしました」を出す。
        // 書けない（クリップボードの権限が無いなど）ときは知らせるだけで、中身はトーストに出さない。
        // 参加トークンのような秘密も写すからである。中身はボタンの横の欄に出ているので、そこから手で写せる。
        Promise.resolve().then(() => write(e.text)).then(
          () => dispatch({ kind: 'runtime', event: { type: 'clipboard.copied', text: e.text } }),
          () => toast(COPY_FAILED),
        );
        return;
      }
      case 'api.rebuildIndex': deps.api.rebuildIndex().catch(fail); return;
      case 'api.launch': deps.api.launch(e.params).then(launched).catch(launchFailed); return;
      case 'api.createProjectThenLaunch':
        // 作ってから起動する。作れたら store に入れて Mediator に知らせ（起動だけが失敗しても二重に作らないため）、そのプロジェクトで起動する。
        deps.api.createProject(e.place)
          .then((p) => {
            setStore({ ...store, projects: { ...store.projects, [p.id]: p } });
            const params = { ...e.params, projectId: p.id };
            dispatch({ kind: 'runtime', event: { type: 'project.created', projectId: p.id, params } });
            return deps.api.launch(params).then(launched);
          })
          .catch(launchFailed);
        return;
      case 'api.createProject':
        deps.api.createProject(e.place)
          .then((p) => {
            setStore({ ...store, projects: { ...store.projects, [p.id]: p } });
            dispatch({ kind: 'runtime', event: { type: 'project.create.done', projectId: p.id, startSession: e.startSession } });
          })
          .catch((err) => dispatch({ kind: 'runtime', event: { type: 'project.create.failed', message: errMsg(err) } }));
        return;
      // 取れなければ空にする。一覧が出ないだけで、作ることもパスで選ぶこともできる。
      case 'api.workspaceDirs': deps.api.workspaceDirs().then((dirs) => dispatch({ kind: 'runtime', event: { type: 'workspaceDirs.loaded', dirs } })).catch(() => dispatch({ kind: 'runtime', event: { type: 'workspaceDirs.loaded', dirs: [] } })); return;
      case 'desktop.pickFolder':
        if (!deps.desktop) return;
        // 取り消したら何もしない。開く場所はワークスペースのルートにする。
        deps.desktop.pickFolder(store.settings?.workspaceRoot ?? null)
          .then((path) => { if (path) dispatch({ kind: 'runtime', event: { type: 'folder.picked', path } }); })
          .catch((err: unknown) => failWith('フォルダを選べませんでした', err));
        return;
      case 'api.resume': deps.api.resume(e.sessionId).then(launched).catch(launchFailed); return;
      case 'api.fork': deps.api.fork(e.sessionId).then(launched).catch(launchFailed); return;
      case 'api.attach': deps.api.attach(e.sessionId).then(launched).catch(launchFailed); return;
      case 'api.adopt': deps.api.adopt(e.sessionId).then(launched).catch(launchFailed); return;
      case 'api.killRun': deps.api.killRun(e.runId).then((run) => setStore(applyServerEvent(store, { type: 'run.ended', run }))).catch(fail); return;
      case 'api.openTab': {
        const run = aliveRunOf(store, e.sessionId);
        if (!run) { fail(new Error('Claude が動いていないので、シェルタブを開けません')); return; }
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
      case 'api.openEditor': (e.file === undefined ? deps.api.openEditor(e.sessionId) : deps.api.openEditor(e.sessionId, e.file)).catch(fail); return;
      case 'api.jumpToPrompt': {
        const done = (status: TurnJumpStatus) => dispatch({ kind: 'runtime', event: { type: 'turnJump.done', sessionId: e.sessionId, seq: e.seq, status } });
        deps.api.jumpToPrompt(e.runId, { heads: e.heads, index: e.index, from: e.from }).then((r) => done(r.found ? 'found' : r.reason)).catch((err) => { done('failed'); fail(err); });
        return;
      }
      case 'api.leaveTranscript': {
        // 抜けさせるのは今も生きている run だけにする。
        // 終わった run はサーバが 409 で断り、利用者には意味の無いトーストになる。
        // 送った後に終わって断られることもあるので、失敗は静かに捨てる。
        // 抜けられたかどうかは左の端末に出ている。
        const run = store.runs[e.runId];
        if (!run || run.endedAt !== null) return;
        deps.api.leaveTranscript(e.runId).catch(() => {});
        return;
      }
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
      case 'notify.waiting': {
        // 窓が前にあるときは右下のカードで足りる。
        if (!notifier || !state.notify.on || !notifier.background()) return;
        const s = store.sessions[e.sessionId];
        if (!s) return;
        notifier.show({ sessionId: s.id, title: s.name ?? '（名前なし）', body: s.activity?.question ?? NO_QUESTION });
        return;
      }
      case 'notify.return': {
        // 窓が前にあるときは右下の札で足りる（入力待ちと同じ）。
        if (!notifier || !state.notify.on || !notifier.background()) return;
        const s = store.sessions[e.sessionId];
        if (!s) return;
        const time = s.state?.returnTime;
        notifier.show({ sessionId: s.id, title: s.name ?? '（名前なし）', body: `戻る時刻 ${time ?? ''} を過ぎました${s.state?.note ? ` · ${s.state.note}` : ''}` });
        return;
      }
      case 'notify.request':
        if (!notifier) return;
        notifier.request().then(async (granted) => {
          if (granted) {
            deps.storage.set(NOTIFY_KEY, true);
            dispatch({ kind: 'runtime', event: { type: 'notify.changed', available: notifier.available(), on: true } });
            return;
          }
          // 断られたら、OS で切られているのかを読む。切られていれば、許可の仕方を知らせる。
          const blocked = (await notifier.status()) === 'denied' && notifier.available();
          dispatch({ kind: 'runtime', event: { type: 'notify.changed', available: notifier.available(), on: false, blocked } });
          toast(blocked ? NOTIFY_BLOCKED : '通知が許可されませんでした');
        }).catch(fail);
        return;
      case 'badge': notifier?.badge(e.count); return;
      case 'api.addTodo': deps.api.addTodo(e.projectId, e.text).catch(fail); return;
      case 'api.toggleTodo': {
        // 反転の基準はストアの現在値にする。View は done の値を持たない。
        const t = store.todos[e.id];
        if (!t) return;
        // 候補の欄を押したときは確定と同じに扱う。候補は未完なので、素直に反転すると done: false を送って何も起きない。
        if (t.candidate && !t.done) deps.api.confirmTodo(e.id).catch(fail);
        else deps.api.setTodoDone(e.id, !t.done).catch(fail);
        return;
      }
      case 'api.confirmTodo': deps.api.confirmTodo(e.id).catch(fail); return;
      case 'api.rejectTodo': deps.api.rejectTodo(e.id).catch(fail); return;
      // セッションの状態。画面の正は後から届く session.upsert なので、返り値はストアに入れない。失敗の一文はトーストに出す。
      case 'api.setSessionState': deps.api.setSessionState(e.id, e.body).catch(fail); return;
      case 'api.confirmSessionState': deps.api.confirmSessionState(e.id, e.body).catch(fail); return;
      case 'api.rejectSessionState': deps.api.rejectSessionState(e.id).catch(fail); return;
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
        deps.api.shellHook().then((h) => setStore({ ...store, shellHook: h })).catch(fail);
        deps.api.usageAggregate(30).then((a) => setStore({ ...store, usageAggregate: a })).catch(fail);
        deps.api.retention().then((r) => setStore({ ...store, retention: r })).catch(fail);
        // アカウントの認証は、この呼び出しで読まれる（節に出るメールとプラン）。
        // アカウントの口が無い古いサーバでは 404 になる。節に出すものが無いだけなので、失敗は握って黙る。
        deps.api.accounts().then(accountsUpdated).catch(() => {});
        // 一時停止の間はサーバが取りに行かず最後の値を返すので、ここでは状態を見ずに頼んでよい。
        deps.api.syncUsage(true).then((u) => setStore({ ...store, cloudUsage: u })).catch(fail);
        loadReadiness();
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
      case 'waiting.next': dispatch({ kind: 'runtime', event: { type: 'waiting.resolved', sessionId: nextWaitingSession(store, e.from) } }); return;
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
      case 'api.retentionPreview':
        // 前の下見を先に消し、取り直している最中に古い差分で書かないようにする。
        setStore({ ...store, retentionPreview: null });
        deps.api.retentionPreview(e.days).then((p) => setStore({ ...store, retentionPreview: p })).catch((err) => dispatch({ kind: 'runtime', event: { type: 'retention.previewFailed', days: e.days, message: errMsg(err) } }));
        return;
      case 'api.writeRetention': {
        const p = store.retentionPreview;
        if (!p || p.days !== e.days) { dispatch({ kind: 'runtime', event: { type: 'retention.failed', message: '差分を読み込んでいます。少し待ってから押してください' } }); return; }
        deps.api.writeRetention(e.days, p.baseSha256)
          .then((r) => {
            setStore({ ...store, retention: r, retentionPreview: null });
            dispatch({ kind: 'runtime', event: { type: 'retention.written', days: e.days } });
            toast(`保持期間を ${daysLabel(e.days)}にしました`);
          })
          .catch((err: unknown) => dispatch({ kind: 'runtime', event: err instanceof RetentionConflictApiError ? { type: 'retention.conflict', days: e.days } : { type: 'retention.failed', message: errMsg(err) } }));
        return;
      }
      case 'api.joinToken':
        deps.api.joinToken().then((r) => {
          setStore(applyJoinToken(store, r.token, r.token === null ? null : (deps.now ?? Date.now)() + JOIN_TOKEN_TTL_MS));
          // 秘密をストアに残し続けない。同じトークンがまだ出ているときだけ消す。
          if (r.token !== null) deps.setTimeout(() => { if (store.joinToken === r.token) setStore(applyJoinToken(store, null)); }, JOIN_TOKEN_TTL_MS);
        }).catch(fail);
        return;
      case 'api.accounts.load': deps.api.accounts().then(accountsUpdated).catch(fail); return;
      case 'api.accounts.setCurrent': deps.api.setCurrentAccount(e.accountId).then(accountsUpdated).catch(fail); return;
      case 'api.accounts.switchSession': deps.api.switchAccount(e.sessionId, e.accountId).then(launched).catch(launchFailed); return;
      case 'api.accounts.add':
        // 追加の直後にログインを始める。新しいアカウントは応答の末尾の 1 件である。
        deps.api.addAccount(e.name).then((accounts) => {
          accountsUpdated(accounts);
          const added = accounts.accounts.at(-1);
          if (added) deps.api.loginAccount(added.id).catch(fail);
        }).catch(fail);
        return;
      case 'api.accounts.update': deps.api.updateAccount(e.accountId, e.patch).then(accountsUpdated).catch(fail); return;
      case 'api.accounts.remove': deps.api.removeAccount(e.accountId).then(accountsUpdated).catch(fail); return;
      case 'api.accounts.login': deps.api.loginAccount(e.accountId).catch(fail); return;
      case 'api.accounts.cancelLogin': deps.api.cancelAccountLogin(e.accountId).then(accountsUpdated).catch(fail); return;
      case 'api.accounts.refresh': deps.api.refreshAccount(e.accountId).then(accountsUpdated).catch(fail); return;
      default: {
        // 効果を足したときに処理を忘れると、ここで型が合わなくなる。
        const _exhaustive: never = e;
        return _exhaustive;
      }
    }
  }

  /**
   * 窓が前面に戻ったときに、通知の許可を読み直す。
   * 許可は hangar の外（システム設定、ブラウザの設定）で変わるので、起動とスイッチだけでは追い付かない。
   * 利用者が受け取ると選んでいれば（NOTIFY_KEY、選んでいなければ環境の既定）、許されたら受け取るに戻し、切られたら受け取らないにする。
   * 受け取っていたのに切られたときだけ、許可の仕方を知らせる。
   * 利用者の選んだ値は書き換えない。
   * 最後に読んでから NOTIFY_RECHECK_MS の間は読まない。
   * 選んだ値と状態は答えが届いた時点のものを使う。読んでいる間にスイッチが押されても、その結果を古い値で戻さないためである。
   */
  function recheckNotify(): void {
    if (!notifier) return;
    const at = (deps.now ?? Date.now)();
    if (at - notifyCheckedAt < NOTIFY_RECHECK_MS) return;
    notifyCheckedAt = at;
    notifier.status().then((s) => {
      const pref = deps.storage.get(NOTIFY_KEY);
      const wanted = typeof pref === 'boolean' ? pref : notifier.defaultOn;
      const available = notifier.available();
      const blocked = s === 'denied' && available;
      const on = wanted && available && notifier.granted() && !blocked;
      const was = state.notify;
      if (was.available === available && was.on === on && was.blocked === blocked) return;
      dispatch({ kind: 'runtime', event: { type: 'notify.changed', available, on, blocked } });
      if (was.on && blocked) toast(NOTIFY_BLOCKED);
    }, () => {});
  }

  function dispatch(input: Input): void {
    if (input.kind === 'server') {
      setStore(applyServerEvent(store, input.event));
      // 本文が伸びたセッションは、サブエージェントが増えているかもしれない。
      // ここでは取りに行かず、次に本文を読むときに取り直させる。
      // 本文を読むのは画面に出ているセッションだけなので、見ていないセッションの分は無駄に取らない。
      if (input.event.type === 'transcript.appended') subagentsAsked.delete(input.event.sessionId);
      // ホームの実行中の札は意図の 1 行を出す。見ている間に動いたセッションの分を取り直す（loadLive が 1 秒に 1 回までにまとめる）。
      if (state.screen.name === 'home') {
        if (input.event.type === 'transcript.appended') loadLive(input.event.sessionId);
        else if (input.event.type === 'session.upsert') loadLive(input.event.session.id);
        else if (input.event.type === 'run.started') loadLive(input.event.run.sessionId);
      }
    }
    const wasHome = state.screen.name === 'home';
    const r = transition(state, input);
    if (r.state !== state) { const prev = shown; state = r.state; present(commit, prev, state); }
    for (const eff of r.effects) runEffect(eff);
    // ホームへ入ったら、動いているセッションの意図をまとめて取りに行く。
    if (!wasHome && state.screen.name === 'home') for (const run of Object.values(store.runs)) if (run.endedAt === null) loadLive(run.sessionId);
  }

  return {
    dispatch,
    emit: (intent) => dispatch({ kind: 'intent', intent }),
    getState: () => shown,
    getStore: () => store,
    subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    canGoBack: () => deps.location.depth() > 0,
    start() {
      const sv: Record<string, SessionViewState> = {};
      for (const k of deps.storage.keys()) {
        if (!k.startsWith('sv:')) continue;
        const v = deps.storage.get(k);
        if (!v || typeof v !== 'object') continue;
        // follow は残さない決まりだが、古い保存に残っていることがある。読み戻すときに落として既定（真）に戻す。
        // summaryOpen は使われていない欄として消した。古い保存に残っているので、読み戻すときに捨てる（捨てないと次の保存で書き戻る）。
        const { follow: _ignore, summaryOpen: _gone, ...rest } = v as Partial<SessionViewState> & { summaryOpen?: unknown };
        sv[k.slice(3)] = { ...defaultSessionView(), ...rest, livePaneSplit: readSessionLivePaneSplit(rest.livePaneSplit) };
      }
      // 真偽値以外が残っていたら（手で書き換えられたなど）、開いたままにする。
      state = {
        ...state, sessionView: sv, sidebarCollapsed: deps.storage.get(SIDEBAR_KEY) === true, sidebarOrder: cleanSidebarOrder(deps.storage.get(SIDEBAR_ORDER_KEY)), livePaneSplit: clampLivePaneSplit(deps.storage.get(LIVE_PANE_SPLIT_KEY)), retentionBannerDismissed: deps.storage.get(RETENTION_BANNER_KEY) === true,
        pageSize: readPageSize(deps.storage.get(PAGE_SIZE_KEY)),
        // 知らせ終えた戻る時点。開き直しても同じ時点を 2 度知らせない。
        returnSeen: readReturnSeen(deps.storage.get(RETURN_SEEN_KEY)),
        // 新しいセッションの書きかけと前回値。形の違う値（手で書き換えられたなど）は捨てる。
        newSessionDraft: readDraft(deps.storage.get(NEW_SESSION_DRAFT_KEY)), launchPrefs: readLaunchPrefs(deps.storage.get(LAUNCH_PREFS_KEY)),
      };
      shown = state;
      // 通知の受け取り。
      // 選んでいなければ環境の既定に従い、ブラウザでは許可が外れていれば受け取らない。
      if (notifier) {
        const pref = deps.storage.get(NOTIFY_KEY);
        const on = (typeof pref === 'boolean' ? pref : notifier.defaultOn) && notifier.available() && notifier.granted();
        dispatch({ kind: 'runtime', event: { type: 'notify.changed', available: notifier.available(), on } });
        // 受け取るなら、OS の許可をあらかじめ尋ねておき（決まっていれば OS が黙って答える）、尋ね終えたら許可の状態を読む。
        // デスクトップの許可は OS が持つので、システム設定で切られていれば受け取るのままにしない。
        // 利用者の選んだ値（NOTIFY_KEY）は書き換えない。OS で許可し直したら、スイッチを入れ直すだけで戻る。
        if (on) {
          notifier.prepare().then(() => notifier.status()).then((s) => {
            if (s === 'denied' && notifier.available()) dispatch({ kind: 'runtime', event: { type: 'notify.changed', available: true, on: false, blocked: true } });
          }, () => {});
        }
        // 通知を押したら、そのセッションを開いてターミナルにフォーカスする。
        // 窓を前に出すのは notifier の役目である。
        unsubNotify = notifier.onOpen((id) => dispatch({ kind: 'intent', intent: { type: 'session.open', id, focus: 'terminal' } }));
      }
      ws = deps.ws({
        onOpen: () => dispatch({ kind: 'runtime', event: { type: 'ws.open' } }),
        // 切れた時刻を添える。Mediator は純粋な遷移なので、画面がいつから古いかを自分では測れない。
        onClose: () => dispatch({ kind: 'runtime', event: { type: 'ws.close', at: (deps.now ?? Date.now)() } }),
        onEvent: (ev) => dispatch({ kind: 'server', event: ev }),
      });
      lastDepth = deps.location.depth();
      unsubHash = deps.location.onHashChange(() => {
        const h = deps.location.getHash();
        const d = deps.location.depth();
        const moved = d - lastDepth;
        lastDepth = d;
        if (wrote === h) { wrote = null; dispatch({ kind: 'runtime', event: { type: 'hash.changed', route: parseRoute(h) } }); return; }
        wrote = null;
        dispatch({ kind: 'runtime', event: { type: 'hash.changed', route: parseRoute(h), moved } });
      });
      unsubFocus = deps.onWindowFocus?.(() => { dispatch({ kind: 'runtime', event: { type: 'window.focus' } }); recheckNotify(); returnTimerAt = null; syncReturns(); }) ?? null;
      unsubVisible = deps.onWindowVisible?.(recheckNotify) ?? null;
      ws.connect();
    },
    stop() { ws?.close(); unsubHash?.(); unsubFocus?.(); unsubFocus = null; unsubVisible?.(); unsubVisible = null; unsubNotify?.(); unsubNotify = null; deps.terminals.dispose(); },
  };
}
