import { codexEnabledOf, formatRoute, opencodeEnabledOf, parseRoute, permissionNoticeText, stopReasonOf, type ReadinessDto, type AccountsDto, type ConfigApplyOrderEntryIn, type UiAction, type LaunchResultDto, type ProjectDto, type ProjectPlace, type ServerEvent } from '@agent-hangar/shared';
import { initialState, transition, type Effect, type Input, type State } from '../mediator/transition.ts';
import { defaultSessionView } from '../mediator/sessionView.ts';
import { LAUNCH_PREFS_KEY, NEW_SESSION_DRAFT_KEY, readDraft, readLaunchPrefs } from '../mediator/launch.ts';
import { PAGE_SIZE_KEY, readPageSize } from '../mediator/paging.ts';
import { NOTICES_READ_KEY, readNoticesRead } from '../mediator/notices.ts';
import { CODEX_VERSION_SEEN_KEY, readCodexVersionSeen } from '../mediator/codexVersion.ts';
import { OPENCODE_VERSION_SEEN_KEY, readOpencodeVersionSeen } from '../mediator/opencodeVersion.ts';
import { toSearchParams } from '../mediator/screen.ts';
import { cleanPaneLayout, paneSessions, paneShows, PANES_KEY } from '../mediator/panes.ts';
import { cleanSidebarFolded, cleanSidebarOrder, cleanSidebarWidth, SIDEBAR_FOLDED_KEY, SIDEBAR_KEY, SIDEBAR_ORDER_KEY, SIDEBAR_WIDTH_KEY } from '../mediator/sidebar.ts';
import { PROJECT_RAIL_KEY, readProjectRailFolded } from '../mediator/projectRail.ts';
import { NOTIFY_KEY, notifyKeep } from '../mediator/notify.ts';
import { dueReturnKeys, nextReturnAt, readReturnSeen, RETURN_SEEN_KEY } from '../mediator/returnDue.ts';
import { readWaitingNotified, WAITING_NOTIFIED_KEY } from '../mediator/live.ts';
import { noQuestionText } from '../presenters/home.ts';
import { daysLabel } from '../presenters/retention.ts';
import { setupNotice } from '../presenters/setup.ts';
import { readinessCompat } from '../presenters/compat.ts';
import { translatorOf } from '../presenters/i18n.ts';
import { clientPlatform, notifyBlockedKey, readinessComplete, readinessPending } from '../presenters/readiness.ts';
import { unresolvedKind } from '../presenters/unresolved.ts';
import type { FocusTarget, SessionViewState, TodoCall, TurnJumpStatus } from '../mediator/types.ts';
import { applyGit, shownLive, aliveRunOf, appendSearchResult, configPartsToLoad, applyBootstrap, applyConfigDetail, applyEventsPage, applyLaunch, applyLiveDigest, applyNotify, applyPickedFolder, applySearch, applySessionFiles, applyServerEvent, applySubagents, applyWorkspaceDirs, currentRunOf, eventsKey, indexFinishedBy, initialStore, pruneEvents, pruneRuns, setEventsLoading, tabsOf, vanishedOnBootstrap, withoutProject, type ConfigDetailPart, type Store } from '../store/store.ts';
import { ApiConflictError, ApiNotFoundError, LaunchPrepAskApiError, LaunchPrepCancelledApiError, ProjectNestedApiError, ProjectSameFolderApiError, RetentionConflictApiError, StrayProcessApiError, type ApiClient, type EventsQuery } from './api.ts';
import { nestedInspect } from '../store/folderInspect.ts';
import type { DesktopBridge } from './desktop.ts';
import { actionCall, isTableAction, type ApiCall } from './actionTable.ts';
import { createGitWatch } from './gitWatch.ts';
import type { Notifier } from './notifier.ts';
import { createUpdateRunner } from './updater.ts';
import type { ReleaseNote } from '../lib/releaseNotes.ts';
import { createCloudMemberRunner } from './cloudMember.ts';
import type { TerminalHost } from './terminals.ts';
import type { WsClient } from './ws.ts';
import { keyLabel } from '../keys.ts';

export type RuntimeDeps = {
  api: ApiClient;
  ws: (handlers: { onOpen(): void; onClose(): void; onEvent(ev: ServerEvent): void }) => WsClient;
  location: { getHash(): string; setHash(h: string): void; replaceHash?(h: string): void; onHashChange(cb: () => void): () => void; go(delta: number): void; depth(): number };
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
   * 頁を閉じる間際（pagehide と beforeunload。再読み込みも含む）を知らせる。返り値で購読を外す。
   * スマホの解除の「元に戻す」を待っている間に閉じたら、その解除をすぐ送る（runtime/cloudMember.ts の flushPending）。
   */
  onPageHide?: (cb: () => void) => () => void;
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
  /** アプリに同梱したリリースノート（lib/releaseNotesBundle.ts）。設定の履歴と更新後の知らせに使う。無ければ出さない。 */
  releaseNotes?: ReleaseNote[];
  /** 窓が前にあるか。git の表示の周期が見る。無ければ document.visibilityState を読む。テストが差し替える口である。 */
  visible?: () => boolean;
  /** クリップボードに書く。無ければ navigator.clipboard を使う。テストが差し替える口である。 */
  clipboard?: (text: string) => Promise<void>;
};

export type Runtime = {
  dispatch(input: Input): void; emit(action: UiAction): void;
  getState(): State; getStore(): Store;
  subscribe(cb: () => void): () => void;
  /** アプリの中に戻る先があるか。画面端の矢印を出すかどうかの判断に使う。 */
  canGoBack(): boolean;
  start(): void; stop(): void;
};

/** 通知の許可を読み直す間隔の下限。窓に戻ると focus と visibilitychange が続けて来るので、まとめて 1 度にする。 */
export const NOTIFY_RECHECK_MS = 2000;
/** 検索の結果から開くとき、跳び先より前にどれだけ（seq の幅）読むか。跳び先の前の文脈が見える程度にする。 */
const AROUND_BEFORE = 100;

/** Mediator の効果を実行し、サーバとブラウザの出来事を入力に変える。 */
/**
 * 同期で他の PC から降りてきたプロジェクトか（設計書 2.11.5）。
 * 起動の読み込みが済んでいて、この Store がまだ知らない id で、この PC に場所を持ったことが無いもの（elsewhere）である。
 * 同じ id の更新（他の PC での改名など）は、届いたことにしない。
 */
/** TODO の呼び出しを API に引く。返り値は使わない（画面の正は後から届く todos.update）。 */
function todoCall(api: ApiClient, c: TodoCall): Promise<unknown> {
  switch (c.op) {
    case 'setDone': return api.setTodoDone(c.id, c.done);
    case 'edit': return api.editTodo(c.id, c.text);
    case 'remove': return api.removeTodo(c.id);
    case 'confirm': return api.confirmTodo(c.id);
    case 'reject': return api.rejectTodo(c.id);
    case 'accept': return api.acceptTodo(c.id);
    case 'reorder': return api.reorderTodos(c.projectId, c.ids);
    case 'restore': return api.restoreTodos(c.rows);
  }
}

function arrivedFromSync(store: Store, p: ProjectDto): boolean {
  return store.bootstrapped && store.projects[p.id] === undefined && p.status !== 'archived' && unresolvedKind(p) === 'elsewhere';
}

/** 先の戻る時点を見直す間隔の上限。 */
const RETURN_RECHECK_MAX_MS = 12 * 60 * 60_000;
/** 変わると要約エンジンのモデルの一覧（つながるか）が変わる設定の鍵。 */
const SUMMARIZER_KEYS = ['summaryEngine', 'lmStudioUrl', 'summaryApiKey'] as const;

export function createRuntime(deps: RuntimeDeps): Runtime {
  let state = initialState();
  // React が読む状態。present が commit を呼ぶまで、前に描いた state のままでいる。
  // 遷移の計算は常に最新の state で行い、描く側だけを遅らせる。
  let shown = state;
  // 殻の有無は起動の時に決まり、あとで変わらない。
  let store: Store = { ...initialStore(), desktop: deps.desktop != null };
  const listeners = new Set<() => void>();
  const notify = () => { heldStore = false; for (const l of listeners) l(); };
  const commit = () => { if (shown !== state) { shown = state; notify(); } };
  /** 窓が前にあるか（document.visibilityState）。git の表示の周期と、配信を画面へ出すかが見る。 */
  const visible = deps.visible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  /**
   * 隠れている間に Store が変わったのに、画面へまだ知らせていないか（2026-10-14、0.6.1）。
   * 隠れている間の配信は Store に当てる（Mediator の入力待ちの知らせは今までどおり動く）が、React へは知らせない。
   * 見えたときに 1 回だけ知らせて、まとめて描かせる。最小化した窓や裏のタブで、配信のたびに画面全体を描き直さないためである。
   * 画面の移り変わり（commit）は隠れていても知らせる。通知を押して開いた画面などを、見えた瞬間に出すためである。
   * 溜めたものは、見えたとき（onWindowVisible）と前面に来たとき（onWindowFocus）に出す。
   */
  let heldStore = false;
  // 前面にある窓は、visibilityState が hidden と言っても溜めない（当てにならない WebView があっても、見ている画面を止めない）。
  const focused = (): boolean => typeof document !== 'undefined' && document.hasFocus();
  const notifyStore = () => { if (visible() || focused()) notify(); else heldStore = true; };
  const releaseStore = () => { if (heldStore) notify(); };
  const present = deps.present ?? ((c: () => void) => c());
  // ストアが変わったら、そのことだけを Mediator へ知らせる。
  // ストアから決まる状態（入力待ちの知らせ、サイドバーの「動いている」の並び）は、Mediator がストアを読んで合わせる。
  // 戻る時刻だけは時計が要るので、ここで見て届ける（syncReturns）。
  const setStore = (next: Store) => { if (next !== store) { store = next; notifyStore(); dispatch({ kind: 'store' }); syncReturns(); syncPrune(); syncFeed(); } };
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
    deps.setTimeout(() => { if (gen !== returnTimerGen) return; returnTimerAt = null; syncReturns(); syncPrune(); }, Math.min(next - now, RETURN_RECHECK_MAX_MS));
  }
  /**
   * 通知センターに残してよい知らせの顔ぶれ（mediator/notify.ts の notifyKeep）を、変わったときだけ notifier へ渡す。
   * 残っていない顔ぶれの知らせは、殻（notify_prune）が通知センターから外す。
   * bootstrap の前はセッションが空で、何も待っていないように見える。そこで渡すと、まだ待っている知らせまで外してしまう。
   * bootstrap の後の最初の 1 回は必ず渡す。前の起動の間に出して、もう待っていない知らせを外すためである。
   * 通知を受け取らない設定でも渡す。外すだけなので、受け取らないにする前に出た知らせが残らない。
   * 新しい知らせを出す効果（notify.waiting、notify.return）は、この前に走るので、出したものは顔ぶれに入っている。
   */
  let pruneKey: string | null = null;
  function syncPrune(): void {
    if (!notifier || !store.bootstrapped) return;
    const keep = notifyKeep(store, clock());
    const key = JSON.stringify(keep);
    if (key === pruneKey) return;
    pruneKey = key;
    notifier.prune(keep);
  }
  /**
   * 通知を受け取るか（store.notify.on）を、変わったときだけ殻へ伝える（notifier.feed）。
   * デスクトップでは入力待ちと使用制限の通知をサーバが決めて殻が出すので、殻はこの値で出すかを決める（runtime/notifier.ts の serverFed）。
   * 頁が伝えるまで殻は出さない。受け取ると決まった時点で伝わる。
   */
  let feedOn: boolean | null = null;
  function syncFeed(): void {
    if (!notifier?.feed) return;
    const on = store.notify.on;
    if (on === feedOn) return;
    feedOn = on;
    notifier.feed(on);
  }
  const notifier = deps.notifier;
  /**
   * アプリの自動更新（runtime/updater.ts）。殻の中でだけ作る。
   * 段階は Store の update に置き、変わったら画面へ出す。
   */
  /**
   * クラウド同期への参加と、PC の一覧と解除と、この PC の参加の解除（runtime/cloudMember.ts）。
   * 一覧はブラウザでも取る。参加と解除は殻の中でだけ働く（ブラウザでは画面がコマンドを案内する）。
   */
  const cloudMember = createCloudMemberRunner({
    bridge: deps.desktop?.cloud ?? null,
    load: () => deps.api.cloudDevices(),
    pair: () => deps.api.mobilePairing(),
    paired: (pairId) => deps.api.mobilePaired(pairId),
    joinCodes: { current: () => deps.api.joinCodeCurrent(), issue: () => deps.api.joinCodeIssue(), approve: () => deps.api.joinCodeApprove(), reject: () => deps.api.joinCodeReject(), close: () => deps.api.joinCodeClose() },
    recovery: { reissue: () => deps.api.recoveryKeyReissue(), confirm: (draftId, tail) => deps.api.recoveryKeyConfirm(draftId, tail) },
    now: () => clock(),
    restart: () => { void deps.desktop?.restart().catch(fail); },
    setTimeout: deps.setTimeout,
    get: () => store.cloudMember,
    set: (c) => { if (c !== store.cloudMember) setStore({ ...store, cloudMember: c }); },
  });
  const updater = deps.desktop ? createUpdateRunner({
    bridge: deps.desktop.update, storage: deps.storage, setTimeout: deps.setTimeout, now: () => clock(), bundled: deps.releaseNotes ?? [],
    get: () => store.update, set: (u) => { if (u !== store.update) setStore({ ...store, update: u }); },
  }) : null;
  let unsubNotify: (() => void) | null = null;
  let unsubJoin: (() => void) | null = null;
  let ws: WsClient | null = null;
  let searchSeq = 0;
  let readinessSeq = 0;
  let unsubHash: (() => void) | null = null;
  // ハッシュの変化が、アプリが自分で書いたもの（navigate）か、ブラウザの戻る・進むかを見分けるための控え。
  // 自分で書いた先は wrote に控え、届いたら消す。それ以外の変化には、履歴の段がいくつ動いたか（moved）を添える。
  let wrote: string | null = null;
  let lastDepth = 0;
  let unsubFocus: (() => void) | null = null;
  let unsubVisible: (() => void) | null = null;
  let unsubHide: (() => void) | null = null;
  /** 通知の許可を最後に読み直した時刻。 */
  let notifyCheckedAt = -Infinity;

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const fail = (e: unknown) => dispatch({ kind: 'runtime', event: { type: 'api.failed', message: errMsg(e) } });
  /** いまの言語の辞書。言語は設定で変わるので、文を出すたびに store から引く。 */
  const tr = () => translatorOf(store);
  const failWith = (what: string, e: unknown) => dispatch({ kind: 'runtime', event: { type: 'api.failed', message: `${what}: ${errMsg(e)}` } });
  /**
   * 準備の確かめを取りに行く。設定画面の検証と、ホームの帯の始める前の確認が同じ値を読む。
   * Claude Code との互換にずれがあれば、続けてずれの中身（GET /api/compat）も取る。止めた機能の一覧は常に出すので（A4）、開くのを待たない。
   * ずれが無ければ、前に取った中身を捨てる。compat の無い古いサーバの答えでは取りに行かない。
   * 要求には番号を振り、最新の要求の答えだけを取る（検索の searchSeq と同じ作り）。
   * 答えが順番を違えて着いても、古い答えが新しい答えを上書きせず、古い答えに続けて取ったずれの中身も入れない。
   * 前の答えで帯に直すものがあり、この答えでは無くなっていたら、そろったことをトーストで 1 回知らせる（設計書 2.11.4）。
   * 前の答えが無い（起動して最初に取った）ときは、そろったのではなく、はじめから問題が無いので知らせない。
   */
  const loadReadiness = () => {
    const seq = ++readinessSeq;
    deps.api.readiness().then((r) => takeReadiness(seq, r)).catch(fail);
  };
  /**
   * セットアップのすゝめの写しの場所と版を取りに行く（設定の連携の札と、ホームの始める前の確認の最後の行が読む）。
   * サーバは起動のたびに写し直すので、bootstrap を取り直すたびに取る（アプリを入れ替えた後の版とハッシュに合わせる）。
   * 取れないのは同梱物が壊れているときだけで、そのときは札も行も出さない。知らせは出さない（直す手が利用者に無いため）。
   */
  /**
   * opencode（ベータ）の検出を取りに行く。有効にしている間だけ、起動のたびと、有効にしたときに取る。
   * 未検証の版なら、右下の札が設定の画面を開く前に出せる（C7）。取れなくても知らせない（設定の版の行が「読み込み中…」のままになるだけ）。
   */
  const loadOpencodeStatus = () => {
    if (!opencodeEnabledOf(store.settings ?? {})) return;
    deps.api.opencodeStatus().then((o) => setStore({ ...store, opencodeStatus: o })).catch(() => undefined);
  };
  /** Codex（ベータ）の検出。opencode と同じ決まりで、有効にしている間だけ、起動のたびと、有効にしたときに取る。 */
  const loadCodexStatus = () => {
    if (!codexEnabledOf(store.settings ?? {})) return;
    deps.api.codexStatus().then((o) => setStore({ ...store, codexStatus: o })).catch(() => undefined);
  };
  const loadSetupGuide = () => {
    deps.api.setupGuide().then((g) => setStore({ ...store, setupGuide: g })).catch(() => setStore({ ...store, setupGuide: null }));
  };
  /**
   * 要約エンジンのモデルの一覧を取りに行く。OpenAI 互換を選んでいなければ、サーバは問い合わせずに空を返す。
   * 宛先が起動していないのは普通の状態なので、失敗は空の一覧にして黙る。
   */
  const loadSummarizerModels = () => {
    deps.api.summarizerModels().then((m) => setStore({ ...store, summarizerModels: m.models })).catch(() => setStore({ ...store, summarizerModels: [] }));
  };
  /** 準備の確かめの答えを Store に入れる。取り直し（loadReadiness）と再確認（api.recheckMux）が使う。 */
  const takeReadiness = (seq: number, r: ReadinessDto) => {
    if (seq !== readinessSeq) return;
    const before = store.readiness;
    if (before && readinessPending(before) && !readinessPending(r)) toast(tr()(readinessComplete(r) ? 'home.ready.toast.done' : 'home.ready.toast.required'));
    const drifts = readinessCompat(r)?.driftCount ?? 0;
    if (drifts > 0) {
      setStore({ ...store, readiness: r });
      deps.api.compat().then((c) => { if (seq === readinessSeq) setStore({ ...store, compat: c }); }).catch(fail);
    } else setStore({ ...store, readiness: r, compat: null });
  };
  const toast = (message: string, holdMs?: number) => dispatch({ kind: 'server', event: { type: 'toast', level: 'info', message, ...(holdMs !== undefined ? { holdMs } : {}) } });
  const launched = (r: LaunchResultDto) => { setStore(applyLaunch(store, r)); dispatch({ kind: 'runtime', event: { type: 'launch.done', sessionId: r.sessionId, runId: r.run.id } }); };
  // 準備が問いで止まったことと、利用者がやめたことは失敗ではない（launch.halted）。進みと問いは launch.prep で届いている。
  const launchFailed = (e: unknown) => {
    if (e instanceof LaunchPrepAskApiError) dispatch({ kind: 'runtime', event: { type: 'launch.halted', why: 'ask', message: e.message } });
    else if (e instanceof LaunchPrepCancelledApiError) dispatch({ kind: 'runtime', event: { type: 'launch.halted', why: 'cancel', message: e.message } });
    else dispatch({ kind: 'runtime', event: { type: 'launch.failed', message: errMsg(e) } });
  };
  const strayConflict = (sessionId: string, err: StrayProcessApiError, queued: boolean) =>
    dispatch({ kind: 'runtime', event: { type: 'api.conflict', kind: 'strayProcess', sessionId, pid: err.body.pid, message: err.body.error, queued } });
  // 登録が 409（入れ子）で断られたら、事前の問い合わせの答えの代わりに包むプロジェクトを持つ（0.6.1）。
  // 問い合わせより先に送られたときでも、ダイアログがその場の 1 行と「別のプロジェクトにする」を出せるようにする。
  const keepNested = (place: ProjectPlace, err: unknown) => {
    if (place.kind === 'dir' && err instanceof ProjectNestedApiError) setStore({ ...store, folderInspect: nestedInspect(place.path, err.body) });
  };
  /**
   * 通知を出せるか、受け取るかを Store に入れる。Runtime しか知らない事実なので、Mediator を通さない。
   * blocked は OS（デスクトップならシステム設定）で通知が切られていること。省けば切られていない。
   */
  const setNotify = (available: boolean, on: boolean, blocked = false, ask = false) => setStore(applyNotify(store, { available, on, blocked, ...(ask ? { ask: true as const } : {}) }));
  /** アカウントの応答は、accounts.update の経路に載せる。 */
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

  /**
   * 変更したファイルの一覧を取る。終わったセッションの冒頭の 1 枚が使う補助の表示なので、失敗は知らせない。
   * 画面を開いたときに 1 回、見ているセッションの run が終わったときにもう 1 回取る（実行中に増えた分を拾う）。
   */
  function loadFiles(sessionId: string): void {
    deps.api.sessionFiles(sessionId).then((d) => setStore(applySessionFiles(store, sessionId, d.files))).catch(() => {});
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

  /**
   * 設定の同期の中身を取る。件数と状態は config.update と bootstrap で届く値が正なので、ここは項目の一覧だけを入れる。
   * 同期を組んでいない端末では 404 になるので、取りに来る前に configSync があることを見る（呼ぶ側の Mediator が見る）。
   * 失敗は 1 つの部分ごとに知らせる。
   */
  function loadConfigDetail(parts: ConfigDetailPart[]): void {
    for (const part of parts) {
      switch (part) {
        case 'outgoing': deps.api.configOutgoing().then((v) => setStore(applyConfigDetail(store, 'outgoing', v))).catch(fail); break;
        case 'inbox': deps.api.configInbox().then((v) => setStore(applyConfigDetail(store, 'inbox', v))).catch(fail); break;
        case 'conflicts': deps.api.configConflicts().then((v) => setStore(applyConfigDetail(store, 'conflicts', v))).catch(fail); break;
        case 'unsent': deps.api.configUnsent().then((v) => setStore(applyConfigDetail(store, 'unsent', v))).catch(fail); break;
        case 'backups': deps.api.configBackups().then((v) => setStore(applyConfigDetail(store, 'backups', v))).catch(fail); break;
      }
    }
  }
  /** 状態を取り直し、そこから決まる件数のある中身を取り直す。適用と戻しは殻が行い、サーバは次の周期まで知らないので、済んだらすぐ呼ぶ。 */
  function refreshConfigSync(): void {
    deps.api.configSyncState().then((c) => { setStore({ ...store, configSync: c }); loadConfigDetail(configPartsToLoad(c)); }).catch(fail);
  }
  /**
   * 殻の結果（適用または戻し）を知らせにする。
   * applied と restored は済んだので状態を取り直す。cancelled、none、busy、failed は書いていないので、そのまま文を知らせる（失敗だけ赤）。
   */
  function shellOutcome(r: { status: string; message: string | null }, fromDialog: boolean): void {
    dispatch({ kind: 'server', event: { type: 'toast', level: r.status === 'failed' ? 'error' : 'info', message: r.message ?? tr()('runtime.shell.unreadable') } });
    const wrote = r.status === 'applied' || r.status === 'restored';
    if (wrote) refreshConfigSync();
    if (fromDialog) dispatch({ kind: 'runtime', event: { type: 'configSync.done', close: wrote } });
  }
  /**
   * 選んだ項目を指示書にして、殻のネイティブの確認へ進む。entries が null なら、いまある指示書をそのまま使う。
   * ブラウザには殻が無いので、指示書を書いたところで止め、画面の「適用の待ち」の行が hangar config apply を案内する。
   */
  function applyConfigSync(entries: ConfigApplyOrderEntryIn[] | null): void {
    const t = translatorOf(store);
    void (async () => {
      try {
        if (entries) await deps.api.configPutOrder(entries);
        const shell = deps.desktop;
        if (!shell) {
          toast(t('configSyncUi.toast.orderWritten'));
          dispatch({ kind: 'runtime', event: { type: 'configSync.done', close: true } });
          return;
        }
        shellOutcome(await shell.applyConfigSync(), true);
      } catch (err) {
        fail(err);
        dispatch({ kind: 'runtime', event: { type: 'configSync.done', close: false } });
      }
    })();
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
        if (e.replace && deps.location.replaceHash && deps.location.getHash() !== h) { deps.location.replaceHash(h); dispatch({ kind: 'runtime', event: { type: 'hash.changed', route: e.route } }); return; }
        if (deps.location.getHash() === h) dispatch({ kind: 'runtime', event: { type: 'hash.changed', route: e.route } });
        else { wrote = h; deps.location.setHash(h); }
        return;
      }
      case 'api.bootstrap':
        deps.api.bootstrap().then((b) => {
          // 取り直しは混ぜるので、そのついでに参照されなくなった run を落とす。
          // 見ているセッションの run は、まだ画面が引くので残す。
          // 本文も同じ基準で落とす。
          // 並べたペインのセッションも、見えているので残す。
          const open = paneSessions(state);
          // サーバの再起動中に終わった run は、run.ended が届かないまま bootstrap から消える。
          // 取り直す前に生きていたのに今は無い run とタブを拾っておき、混ぜた後で終わったことにする。
          const gone = vanishedOnBootstrap(store, b, (deps.now ?? Date.now)());
          setStore(pruneEvents(pruneRuns(applyBootstrap(store, b), open), open));
          // run.ended と tab.upsert を通すのは、届いていれば起きたこと（接続を切る、跳び先を忘れる）を同じ道で起こすためである。
          for (const run of gone.runs) dispatch({ kind: 'server', event: { type: 'run.ended', run } });
          for (const tab of gone.tabs) dispatch({ kind: 'server', event: { type: 'tab.upsert', tab } });
          // 同期の状態と端末の一覧は applyBootstrap が Store に入れてある。画面は Store から読むので、イベントにして流し直さない。
          dispatch({ kind: 'runtime', event: { type: 'hash.changed', route: parseRoute(deps.location.getHash()) } });
          // ホームの帯は、直すものがあれば始める前の確認を出す。誰にでも出すので、起動のたびにその中身を取りに行く（遅れは 1 回の which の数回分）。
          loadReadiness();
          loadSetupGuide();
          loadOpencodeStatus();
          loadCodexStatus();
        }).catch(fail);
        return;
      case 'api.loadEvents': {
        // 本文が無いと分かっている会話は読みに行かない。行っても 404 のトーストが出るだけである。
        if (store.sessions[e.sessionId]?.hasTranscript === false) return;
        loadSubagents(e.sessionId);
        loadLive(e.sessionId);
        if (e.fromSeq === 0) loadFiles(e.sessionId);
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
        // 古い側の印は、利用者が押した遡り（-1）のときだけ立てる。追記の読み込みで目次のボタンを動かさない。
        setStore(setEventsLoading(store, key, true, e.fromSeq === -1));
        deps.api.events(e.sessionId, q).then((p) => setStore(applyEventsPage(store, key, p, append, older))).catch((err) => { setStore(setEventsLoading(store, key, false)); fail(err); });
        return;
      }
      case 'api.search': {
        const seq = ++searchSeq;
        // 期間の日数は、送るこの瞬間の時刻で since に直す。
        const params = toSearchParams(e.params, (deps.now ?? Date.now)());
        // 読んでいる間も持っている行は消さない。届いたら、置き換える（append なら後ろに足す）。
        setStore(applySearch(store, params, store.search.result, true));
        // 失敗したら読み込み中を解く。解かないと「さらに読み込む」が「読み込んでいます」のまま残る。
        deps.api.search(params)
          .then((r) => { if (seq === searchSeq) setStore(applySearch(store, params, e.append ? appendSearchResult(store.search.result, r) : r, false)); })
          .catch((err) => { if (seq === searchSeq) setStore(applySearch(store, store.search.params ?? params, store.search.result, false)); fail(err); });
        return;
      }
      // 選んだフォルダが別のプロジェクトの場所だった 409 は、まとめる確認にする。ほかの失敗はトーストである。
      // まとめ終えたら、まとめた方を外し、残した方（答えのプロジェクト）を入れ直す。サーバは消したプロジェクトを配らないので、画面の側で外す。
      case 'api.resolveProject': deps.api.resolveProject(e.projectId, e.action).then((r) => {
        if (e.action.kind !== 'repoint' || e.action.merge !== true) return;
        const into = r as ProjectDto | null;
        if (!into || typeof into.id !== 'string' || into.id === e.projectId) return;
        const rest = withoutProject(store, e.projectId);
        setStore({ ...rest, projects: { ...rest.projects, [into.id]: into } });
        toast(tr()('runtime.project.merged', { name: into.name }));
        dispatch({ kind: 'runtime', event: { type: 'project.merged', fromId: e.projectId, intoId: into.id } });
      }).catch((err: unknown) => {
        if (err instanceof ProjectSameFolderApiError) dispatch({ kind: 'runtime', event: { type: 'api.conflict', kind: 'sameFolder', conflict: err.body } });
        else fail(err);
      }); return;
      case 'api.updateSettings': {
        const field = e.field;
        deps.api.updateSettings(e.patch).then((s) => {
          setStore({ ...store, settings: s });
          if (field) dispatch({ kind: 'runtime', event: { type: 'settings.saved', field } });
          // パスが変わると欄の下の検証も変わるので、準備の確かめを取り直す。
          loadReadiness();
          // 要約エンジンか宛先が変わると、つながるかも変わる。目次と欄の「接続済み／接続できません」を古いまま残さない。
          if (SUMMARIZER_KEYS.some((k) => k in e.patch)) loadSummarizerModels();
        }).catch((err: unknown) => {
          // 欄ごとの保存の失敗は、その欄の下に理由を出す。トーストにはしない。
          if (field) dispatch({ kind: 'runtime', event: { type: 'settings.failed', field, message: errMsg(err) } });
          else fail(err);
        });
        return;
      }
      case 'api.readiness': loadReadiness(); return;
      case 'api.recheckMux': {
        // 再確認の答えも準備の確かめなので、取り直しと同じ番号の列に並べる（古い答えで上書きしない）。
        const seq = ++readinessSeq;
        deps.api.recheckMux().then(({ readiness: r, settings }) => {
          // 見つかればサーバが tmuxPath を埋めているので、設定の欄にも映す。
          setStore({ ...store, settings });
          takeReadiness(seq, r);
          dispatch({ kind: 'runtime', event: { type: 'mux.checked', found: r.tools.tmux.ok } });
        }).catch((err: unknown) => {
          dispatch({ kind: 'runtime', event: { type: 'mux.checked', found: false } });
          fail(err);
        });
        return;
      }
      case 'shell.openLog':
        if (!deps.desktop) return;
        deps.desktop.openLog().catch((err: unknown) => failWith(tr()('runtime.shell.openLogFailed'), err));
        return;
      case 'shell.restart':
        if (!deps.desktop) return;
        deps.desktop.restart().catch((err: unknown) => failWith(tr()('runtime.shell.restartFailed'), err));
        return;
      case 'clipboard.copy': {
        const write = deps.clipboard ?? ((text: string) => navigator.clipboard.writeText(text));
        // 写せたら状態に返し、ボタンはそれを見てから「コピーしました」を出す。
        // 書けない（クリップボードの権限が無いなど）ときは知らせるだけで、中身はトーストに出さない。
        // 参加コードのような秘密も写すからである。中身はボタンの横の欄に出ているので、そこから手で写せる。
        Promise.resolve().then(() => write(e.text)).then(
          () => { dispatch({ kind: 'runtime', event: { type: 'clipboard.copied', text: e.text } }); if (e.done !== undefined) toast(e.done); },
          () => toast(tr()('runtime.copy.failed', { keys: keyLabel('⌘C') })),
        );
        return;
      }
      case 'api.rebuildIndex': deps.api.rebuildIndex().catch(fail); return;
      case 'api.launch': deps.api.launch(e.params).then(launched).catch(launchFailed); return;
      // 起動後にコンテキストが足りなかった会話のローカルのモデルの整え直し。進みは prepKey の鍵の launch.prep で届く。
      case 'api.fixContextShort':
        deps.api.prepareModels(e.sessionId, e.prepKey)
          .then(() => dispatch({ kind: 'runtime', event: { type: 'contextShort.done', sessionId: e.sessionId } }))
          .catch((err: unknown) => dispatch({ kind: 'runtime', event: { type: 'contextShort.failed', sessionId: e.sessionId, message: errMsg(err) } }));
        return;
      case 'api.createProjectThenLaunch':
        // 作ってから起動する。作れたら store に入れて Mediator に知らせ（起動だけが失敗しても二重に作らないため）、そのプロジェクトで起動する。
        deps.api.createProject(e.place)
          .then((p) => {
            setStore({ ...store, projects: { ...store.projects, [p.id]: p } });
            const params = { ...e.params, projectId: p.id };
            dispatch({ kind: 'runtime', event: { type: 'project.created', projectId: p.id, params } });
            return deps.api.launch(params).then(launched);
          })
          .catch((err: unknown) => { keepNested(e.place, err); launchFailed(err); });
        return;
      case 'api.createProject':
        deps.api.createProject(e.place)
          .then((p) => {
            setStore({ ...store, projects: { ...store.projects, [p.id]: p } });
            dispatch({ kind: 'runtime', event: { type: 'project.create.done', projectId: p.id, startSession: e.startSession } });
          })
          .catch((err: unknown) => { keepNested(e.place, err); dispatch({ kind: 'runtime', event: { type: 'project.create.failed', message: errMsg(err) } }); });
        return;
      // 候補のダイアログ（初日のプロジェクト）。取っている間と取れなかったことは、面が Store の folderCandidates から読む。
      // ダイアログを開くたびに来るので、前に開いたときの「フォルダの中から」の一覧もここで捨てる。
      case 'api.folderCandidates':
        setStore({ ...store, folderCandidates: { status: 'loading' }, workspaceChildren: null });
        deps.api.folderCandidates()
          .then((data) => setStore({ ...store, folderCandidates: { status: 'ready', data } }))
          .catch(() => setStore({ ...store, folderCandidates: { status: 'failed' } }));
        return;
      // 「フォルダの中から」の親の直下。後から頼んだ親の答えだけを採る（打ち直しや Finder で親を変えたとき、前の答えが遅れて届いても入れ替えない）。
      case 'api.workspaceChildren': {
        const parent = e.parent;
        const latest = () => store.workspaceChildren?.status === 'loading' && store.workspaceChildren.parent === parent;
        setStore({ ...store, workspaceChildren: { status: 'loading', parent } });
        deps.api.workspaceChildren(parent)
          .then((data) => { if (latest()) setStore({ ...store, workspaceChildren: { status: 'ready', parent, data } }); })
          .catch((err: unknown) => { if (latest()) setStore({ ...store, workspaceChildren: { status: 'failed', parent, message: errMsg(err) } }); });
        return;
      }
      // 作成場所を決めてから登録する。先に決めると、その直下は保存のときにサーバが登録するので、登録の側は既にあるものとして返す。
      // 作成場所の保存に失敗したら、登録はせずに面へ理由を返す。
      case 'api.registerFolders': {
        const save = e.workspaceRoot !== null
          ? deps.api.updateSettings({ workspaceRoot: e.workspaceRoot }).then((s) => setStore({ ...store, settings: s }))
          : Promise.resolve();
        save
          .then(() => (e.items.length ? deps.api.registerFolders(e.items) : { projects: [], failed: [] }))
          .then((r) => {
            const projects = { ...store.projects };
            for (const p of r.projects) projects[p.id] = p;
            setStore({ ...store, projects });
            dispatch({ kind: 'runtime', event: { type: 'project.candidates.done', registered: r.projects.length, linked: r.linked?.length ?? 0, failed: r.failed.map((f) => f.error) } });
          })
          .catch((err: unknown) => dispatch({ kind: 'runtime', event: { type: 'project.candidates.failed', message: errMsg(err) } }));
        return;
      }
      // 取れなければ空にする。一覧が出ないだけで、作ることもパスで選ぶこともできる。
      case 'api.workspaceDirs': deps.api.workspaceDirs().then((dirs) => setStore(applyWorkspaceDirs(store, dirs))).catch(() => setStore(applyWorkspaceDirs(store, []))); return;
      case 'desktop.setup': {
        // ブラウザには殻が無い。画面はその場合ボタンの代わりにコマンドを出すので、ここへは来ないが、来ても何もしない。
        const shell = deps.desktop;
        const done = () => dispatch({ kind: 'runtime', event: { type: 'setup.done', target: e.target } });
        if (!shell) { done(); return; }
        shell.setupIntegration(e.target).then((r) => {
          const notice = setupNotice(tr(), r);
          if (notice) dispatch({ kind: 'server', event: { type: 'toast', level: notice.level, message: notice.message } });
          // 書いたかどうかはサーバの読み取り（ステータスライン、シェル連携、準備の確かめ）で決まる。済んでいたときも取り直して札を合わせる。
          if (r.status === 'written' || r.status === 'none') {
            deps.api.statusline().then((st) => setStore({ ...store, statusline: st })).catch(fail);
            deps.api.shellHook().then((h) => setStore({ ...store, shellHook: h })).catch(fail);
            loadReadiness();
          }
          done();
        }).catch((err: unknown) => { failWith(tr()('runtime.setup.failed'), err); done(); });
        return;
      }
      case 'desktop.pickFolder':
        if (!deps.desktop) return;
        // 取り消したら何もしない。開く場所は渡されたもの（アカウントの場所）か、ワークスペースのルートにする。
        // 作成場所は任意で、空なら OS の既定の場所から開く。
        deps.desktop.pickFolder(e.defaultPath !== undefined ? e.defaultPath : store.settings?.workspaceRoot || null)
          .then((path) => { if (path) setStore(applyPickedFolder(store, path)); })
          .catch((err: unknown) => failWith(tr()('runtime.shell.pickFolderFailed'), err));
        return;
      // 終わった扱いの run の claude が動き続けていて断られたら、止めて再開するかを聞く確認にする（issue #258）。
      case 'api.resume':
        (e.stray || e.prepKey ? deps.api.resume(e.sessionId, e.stray, e.prepKey) : deps.api.resume(e.sessionId)).then(launched).catch((err: unknown) => {
          if (err instanceof StrayProcessApiError) strayConflict(e.sessionId, err, false);
          else launchFailed(err);
        });
        return;
      case 'api.fork': deps.api.fork(e.sessionId).then(launched).catch(launchFailed); return;
      // まとめて再開の 1 本。画面は移さない。起きた run は Store に入れ、順番待ちを進めるのは Mediator である。
      case 'api.resumeQueued': {
        const id = e.sessionId;
        // 断られた理由は行に残し、残った claude で断られたときは、続けて確認を出す。
        (e.stray ? deps.api.resume(id, e.stray) : deps.api.resume(id))
          .then((r) => { setStore(applyLaunch(store, r)); dispatch({ kind: 'runtime', event: { type: 'resumeQueue.done', sessionId: id } }); })
          .catch((err: unknown) => {
            dispatch({ kind: 'runtime', event: { type: 'resumeQueue.failed', sessionId: id, message: errMsg(err) } });
            if (err instanceof StrayProcessApiError) strayConflict(id, err, true);
          });
        return;
      }
      case 'api.dismissInterrupted':
        deps.api.dismissInterrupted(e.runIds, e.dismissed).then((r) => setStore(applyServerEvent(store, { type: 'interrupted.update', interrupted: r.interrupted }))).catch(fail);
        return;
      case 'api.attach': deps.api.attach(e.sessionId).then(launched).catch(launchFailed); return;
      case 'api.adopt': deps.api.adopt(e.sessionId).then(launched).catch(launchFailed); return;
      case 'api.killRun': deps.api.killRun(e.runId).then((run) => setStore(applyServerEvent(store, { type: 'run.ended', run }))).catch(fail); return;
      case 'api.openTab': {
        const run = aliveRunOf(store, e.sessionId);
        if (!run) { fail(new Error(tr()('runtime.tab.noClaude'))); return; }
        deps.api.openTab(run.id).then((tab) => setStore(applyServerEvent(store, { type: 'tab.upsert', tab }))).catch(fail);
        return;
      }
      case 'api.closeTab': {
        const tab = store.tabs[e.tabId];
        if (!tab) return;
        deps.api.closeTab(tab.runId, tab.id).then((t) => setStore(applyServerEvent(store, { type: 'tab.upsert', tab: t }))).catch(fail);
        return;
      }
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
        // デスクトップでは、入力待ちの通知はサーバが決めて殻が出す。頁が呼ぶと 2 回出る（runtime/notifier.ts の serverFed）。
        // 窓が前にあるときは右下のカードで足りる。
        if (!notifier || notifier.serverFed || !store.notify.on || !notifier.background()) return;
        const s = store.sessions[e.sessionId];
        if (!s) return;
        // 許可待ちは、何の許可かを本文にする。問いの文を待たない。
        if (stopReasonOf(s) === 'permission') {
          notifier.show({ sessionId: s.id, title: s.name ?? tr()('common.label.noName'), body: permissionNoticeText(tr(), s.permission ?? null), kind: 'waiting' });
          return;
        }
        // 問いの文が無ければ印（bare）を付ける。殻が問いの文を少し待ち、届けば 1 回にまとめて出す。
        const question = s.activity?.question;
        notifier.show({ sessionId: s.id, title: s.name ?? tr()('common.label.noName'), body: question ?? noQuestionText(tr()), kind: 'waiting', ...(question ? {} : { bare: true }) });
        return;
      }
      case 'notify.return': {
        // 窓が前にあるときは OS の通知は出さない（ホームの帯の要対応に行がある）。
        if (!notifier || !store.notify.on || !notifier.background()) return;
        const s = store.sessions[e.sessionId];
        if (!s) return;
        const time = s.state?.returnTime;
        notifier.show({ sessionId: s.id, title: s.name ?? tr()('common.label.noName'), body: s.state?.note ? tr()('runtime.notify.returnBodyNote', { time: time ?? '', note: s.state.note }) : tr()('runtime.notify.returnBody', { time: time ?? '' }), kind: 'return' });
        return;
      }
      case 'notify.request':
        if (!notifier) return;
        notifier.request().then(async (granted) => {
          if (granted) {
            deps.storage.set(NOTIFY_KEY, true);
            setNotify(notifier.available(), true);
            return;
          }
          // 断られたら、OS で切られているのかを読む。切られていれば、許可の仕方を知らせる。
          // 答えずに閉じられて、まだ決まっていなければ、始める前の確認の「通知」の行は残す。
          const s = await notifier.status();
          const blocked = s === 'denied' && notifier.available();
          setNotify(notifier.available(), false, blocked, s === 'undetermined' && notifier.available());
          toast(tr()(blocked ? notifyBlockedKey(clientPlatform(), 'toast') : 'runtime.notify.denied'));
        }).catch(fail);
        return;
      case 'notify.off':
        // その場で切り替えて覚える。許可は求めない。受け取らないと決めたので、尋ねる印（ask）も下ろす（始める前の確認の「要らない」）。
        deps.storage.set(NOTIFY_KEY, false);
        setStore(applyNotify(store, { available: store.notify.available, on: false, blocked: store.notify.blocked }));
        return;
      case 'badge': notifier?.badge(e.count); return;
      case 'update': updater?.run(e.command); return;
      case 'cloudMember': cloudMember.run(e.command); return;
      case 'api.addTodo': deps.api.addTodo(e.projectId, e.text).catch(fail); return;
      case 'api.todo': todoCall(deps.api, e.call).catch(fail); return;
      // セッションの状態。画面の正は後から届く session.upsert なので、返り値はストアに入れない。失敗の一文はトーストに出す。
      case 'api.setSessionState': deps.api.setSessionState(e.id, e.body).catch(fail); return;
      case 'api.confirmSessionState': deps.api.confirmSessionState(e.id, e.body).catch(fail); return;
      case 'api.rejectSessionState': deps.api.rejectSessionState(e.id).catch(fail); return;
      case 'api.loadMemo': deps.api.memo(e.projectId).then((m) => setStore({ ...store, memos: { ...store.memos, [m.projectId]: m } })).catch(fail); return;
      case 'api.loadInstructions': deps.api.instructions(e.projectId).then((d) => setStore({ ...store, instructions: { ...store.instructions, [d.projectId]: d } })).catch(fail); return;
      case 'api.promote':
        deps.api.promote(e.sessionId, { name: e.name, gitInit: e.gitInit, moveFiles: e.moveFiles, ...(e.parent ? { parent: e.parent } : {}) })
          .then((r) => {
            setStore({ ...store, projects: { ...store.projects, [r.project.id]: r.project }, sessions: { ...store.sessions, [r.session.id]: r.session } });
            dispatch({ kind: 'runtime', event: { type: 'promote.done', projectId: r.project.id, moved: r.moved, reason: r.reason } });
          })
          .catch((err) => dispatch({ kind: 'runtime', event: { type: 'promote.failed', message: errMsg(err) } }));
        return;
      case 'api.loadSettingsExtras':
        deps.api.statusline().then((s) => setStore({ ...store, statusline: s })).catch(fail);
        deps.api.shellHook().then((h) => setStore({ ...store, shellHook: h })).catch(fail);
        // opencode の検出（ベータ）。取れなくても設定の面の版の行が「読み込み中…」のままになるだけなので、知らせは出さない。
        deps.api.opencodeStatus().then((o) => setStore({ ...store, opencodeStatus: o })).catch(() => undefined);
        deps.api.codexStatus().then((o) => setStore({ ...store, codexStatus: o })).catch(() => undefined);
        deps.api.usageAggregate(30).then((a) => setStore({ ...store, usageAggregate: a })).catch(fail);
        deps.api.retention().then((r) => setStore({ ...store, retention: r })).catch(fail);
        // アカウントの認証は、この呼び出しで読まれる（節に出るメールとプラン）。
        deps.api.accounts().then(accountsUpdated).catch(fail);
        // 一時停止の間はサーバが取りに行かず最後の値を返すので、ここでは状態を見ずに頼んでよい。
        deps.api.syncUsage(true).then((u) => setStore({ ...store, cloudUsage: u })).catch(fail);
        // Worker の PC の一覧。同期していなければサーバが off を返す。
        cloudMember.run({ op: 'load' });
        loadReadiness();
        loadSummarizerModels();
        return;
      case 'storage.save': deps.storage.set(e.key, e.value); return;
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
      case 'api.resumeHerePlan':
        // 取れなければトーストにする。送信中にはしていないので、解くものは無い。
        deps.api.resumeHerePlan(e.sessionId).then((plan) => dispatch({ kind: 'runtime', event: { type: 'resumeHere.plan', plan } })).catch(fail);
        return;
      // 引き継ぎ。応答の段は、サーバが websocket で配る takeover.update と同じ道（server の入力）で流す。どちらが先に着いても mediator は同じに読む。
      case 'api.takeoverStart':
        deps.api.takeoverStart(e.sessionId, e.force).then((dto) => dispatch({ kind: 'server', event: { type: 'takeover.update', takeover: dto } })).catch((err: unknown) => {
          // 頼みが通らなかったら、待たせずに 1 枚を閉じ、理由をトーストで知らせる（取り下げの知らせと同じ形で閉じる）。
          const now = Date.now();
          dispatch({ kind: 'server', event: { type: 'takeover.update', takeover: { sessionId: e.sessionId, deviceName: '', stage: 'cancelled', startedAt: now, deadline: now } } });
          fail(err);
        });
        return;
      case 'api.takeoverExtend':
        deps.api.takeoverExtend(e.sessionId).then((dto) => dispatch({ kind: 'server', event: { type: 'takeover.update', takeover: dto } })).catch(fail);
        return;
      case 'api.takeoverCancel': deps.api.takeoverCancel(e.sessionId).catch(fail); return;
      case 'api.configSyncLoad': loadConfigDetail(e.parts); return;
      case 'api.configSyncApply': applyConfigSync(e.entries); return;
      case 'api.configSyncRestore': {
        // ブラウザでは殻が無い。画面は、その場合は戻すボタンの代わりにコマンドを出すので、ここへは来ない。
        const shell = deps.desktop;
        if (!shell) return;
        shell.restoreConfigSync(e.name).then((r) => shellOutcome(r, false)).catch((err: unknown) => failWith(tr()('runtime.shell.restoreFailed'), err));
        return;
      }
      case 'api.retentionPreview':
        // 前の下見を先に消し、取り直している最中に古い差分で書かないようにする。
        setStore({ ...store, retentionPreview: null });
        deps.api.retentionPreview(e.days).then((p) => setStore({ ...store, retentionPreview: p })).catch((err) => dispatch({ kind: 'runtime', event: { type: 'retention.previewFailed', days: e.days, message: errMsg(err) } }));
        return;
      case 'api.writeRetention': {
        const p = store.retentionPreview;
        if (!p || p.days !== e.days) { dispatch({ kind: 'runtime', event: { type: 'retention.failed', message: tr()('runtime.retention.previewLoading') } }); return; }
        deps.api.writeRetention(e.days, p.baseSha256)
          .then((r) => {
            setStore({ ...store, retention: r, retentionPreview: null });
            dispatch({ kind: 'runtime', event: { type: 'retention.written', days: e.days } });
            toast(tr()('runtime.retention.set', { days: daysLabel(tr(), e.days) }));
          })
          .catch((err: unknown) => dispatch({ kind: 'runtime', event: err instanceof RetentionConflictApiError ? { type: 'retention.conflict', days: e.days } : { type: 'retention.failed', message: errMsg(err) } }));
        return;
      }
      case 'api.accounts.switchSession': deps.api.switchAccount(e.sessionId, e.accountId).then(launched).catch(launchFailed); return;
      case 'api.accounts.add':
        // 追加の直後にログインを始める。新しいアカウントは応答の末尾の 1 件である。
        // 断られた理由はダイアログに残す（account.add.failed）。トーストにはしない。
        deps.api.addAccount(e.name, e.dir).then((accounts) => {
          accountsUpdated(accounts);
          dispatch({ kind: 'runtime', event: { type: 'account.add.done' } });
          const added = accounts.accounts.at(-1);
          if (added) deps.api.loginAccount(added.id).catch(fail);
        }).catch((err: unknown) => dispatch({ kind: 'runtime', event: { type: 'account.add.failed', message: errMsg(err) } }));
        return;
      case 'api.accounts.remove': deps.api.removeAccount(e.accountId).then(accountsUpdated).catch(fail); return;
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
      const was = store.notify;
      setNotify(available, on, blocked, wanted && available && s === 'undetermined');
      if (was.on && blocked) toast(tr()(notifyBlockedKey(clientPlatform(), 'toast')));
    }, () => {});
  }

  /**
   * git の表示の取り方（runtime/gitWatch.ts）。見えている行と実行中のセッションを、まとめて取り、窓が前にある間は周期で取り直す。
   */
  const gitWatch = createGitWatch({
    fetch: (ids) => deps.api.gitSessions(ids),
    apply: (g) => setStore(applyGit(store, g)),
    live: () => Object.values(store.sessions).filter((s) => shownLive(s) !== null).map((s) => s.id),
    visible,
    setTimeout: (fn, ms) => deps.setTimeout(fn, ms),
    now: deps.now ?? Date.now,
    also: reloadProjectGit,
  });

  /**
   * 開いているプロジェクト画面のブランチと worktree を読み直す（git の表示の周期と、窓が前に戻ったとき）。
   * 画面が開いたときに読むのは ProjectScreen で、ここは開いたままの画面が古くならないようにする役である。
   * この PC にパスの無いプロジェクトとクイックセッションは読まない（ProjectScreen と同じ）。
   * 裏の読み直しなので、失敗は札にしない（30 秒ごとに同じ札が積もる）。開いたときの読み込みの失敗は、今までどおり札にする。
   * プロジェクトが無い（404）と分かったら、画面の外（別の窓、CLI、同期）で一覧から削除されたので、Store から外す。
   * 外すと一覧から消え、開いている画面は「プロジェクトが見つかりません」の面になり、それ以後は読まない。
   */
  function reloadProjectGit(): void {
    if (state.screen.name !== 'project') return;
    const p = store.projects[state.screen.id];
    if (!p || p.isScratch || p.path === null) return;
    const c = actionCall({ type: 'project.git.load', projectId: p.id }, store);
    if (c) runCall({ ...c, failed: (s, e) => (e instanceof ApiNotFoundError ? withoutProject(s, p.id) : s) });
  }

  /**
   * 表で引いた呼び出しを実行する（runtime/actionTable.ts）。
   * 応答は着いた時点の Store に当て、知らせはトーストにする。失敗は、failed を持つ行だけ Store に書き、ほかの行はトーストにする。
   */
  function runCall(c: ApiCall): void {
    if (c.before) setStore(c.before(store));
    c.run(deps.api).then((done) => {
      if (done.apply) setStore(done.apply(store));
      if (done.toast !== undefined) toast(tr()(done.toast), done.toastHoldMs);
    }).catch((e: unknown) => {
      const next = c.failed?.(store, e) ?? null;
      if (next) setStore(next);
      else if (c.failHoldMs !== undefined) dispatch({ kind: 'runtime', event: { type: 'api.failed', message: errMsg(e), holdMs: c.failHoldMs } });
      else fail(e);
    });
  }

  /**
   * View の UiAction を受ける。
   * 表にあれば、Mediator を通さずに API を呼ぶ。無ければ、今までどおり Mediator へ渡す。
   */
  function emit(action: UiAction): void {
    // 見えている行の git（0.5.0）。場所ごとに覚え、まとめて取る。
    if (action.type === 'git.watch') { gitWatch.watch(action.key, action.sessionIds); return; }
    // プロジェクト画面のブランチと worktree は、git の表示の周期で読み直すので、周期を始めておく（セッションの行が無い画面でも回す）。
    if (action.type === 'project.git.load') gitWatch.start();
    if (!isTableAction(action)) { dispatch({ kind: 'action', action }); return; }
    const c = actionCall(action, store);
    if (c) runCall(c);
  }

  function dispatch(input: Input): void {
    // 型では表の UiAction を渡せないが、型を外して渡されても Mediator へは入れない。
    if (input.kind === 'action' && (isTableAction(input.action) || (input.action as UiAction).type === 'git.watch')) { emit(input.action); return; }
    // 索引の走査がこの知らせで終わるかは、当てる前の Store でしか分からない。
    const indexDone = input.kind === 'server' && indexFinishedBy(store, input.event);
    // 同期で降りた、この PC に場所を持ったことが無いプロジェクトか。これも、当てる前の Store でしか分からない（初めて見る id かどうか）。
    // 起動の読み込み（bootstrap）で入るものは project.upsert では届かないので、ここには来ない。読み込みが済む前に届いたものも数えない。
    const arrivedId = input.kind === 'server' && input.event.type === 'project.upsert' && arrivedFromSync(store, input.event.project) ? input.event.project.id : null;
    if (input.kind === 'server') {
      setStore(applyServerEvent(store, input.event));
      // 本文が伸びたセッションは、サブエージェントが増えているかもしれない。
      // ここでは取りに行かず、次に本文を読むときに取り直させる。
      // 本文を読むのは画面に出ているセッションだけなので、見ていないセッションの分は無駄に取らない。
      if (input.event.type === 'transcript.appended') subagentsAsked.delete(input.event.sessionId);
      // opencode を有効にしたら、その場で版を読む（未検証なら右下の札を出す）。
      if (input.event.type === 'settings.changed' && input.event.keys.includes('opencodeEnabled')) loadOpencodeStatus();
      if (input.event.type === 'settings.changed' && input.event.keys.includes('codexEnabled')) loadCodexStatus();
      if (input.event.type === 'run.ended' && paneShows(state, input.event.run.sessionId)) loadFiles(input.event.run.sessionId);
      // ホームの実行中の札は意図の 1 行を出す。見ている間に動いたセッションの分を取り直す（loadLive が 1 秒に 1 回までにまとめる）。
      if (state.screen.name === 'home') {
        if (input.event.type === 'transcript.appended') loadLive(input.event.sessionId);
        else if (input.event.type === 'session.upsert') loadLive(input.event.session.id);
        else if (input.event.type === 'run.started') loadLive(input.event.run.sessionId);
      }
    }
    const wasHome = state.screen.name === 'home';
    const r = transition(state, store, input);
    if (r.state !== state) { const prev = shown; state = r.state; present(commit, prev, state); }
    for (const eff of r.effects) runEffect(eff);
    // 走査中に開いた UI の bootstrap には、プロジェクトも紐づけも載っていない。走査が終わった瞬間に取り直す。
    if (indexDone) runEffect({ kind: 'api.bootstrap' });
    // ホームへ入ったら、動いているセッションの意図をまとめて取りに行く。
    if (!wasHome && state.screen.name === 'home') for (const run of Object.values(store.runs)) if (run.endedAt === null) loadLive(run.sessionId);
    // 他の PC から降りたプロジェクトは、ダイアログではなく、右下の札 1 枚にまとめる（mediator/arrived.ts）。
    if (arrivedId !== null) dispatch({ kind: 'runtime', event: { type: 'projects.arrived', ids: [arrivedId] } });
  }

  return {
    dispatch,
    emit,
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
        // livePaneSplit（右パネルの境目の比率）も、境目を無くしたので同じく捨てる。
        const { follow: _ignore, summaryOpen: _gone, livePaneSplit: _split, ...rest } = v as Partial<SessionViewState> & { summaryOpen?: unknown; livePaneSplit?: unknown };
        sv[k.slice(3)] = { ...defaultSessionView(), ...rest };
      }
      // 真偽値以外が残っていたら（手で書き換えられたなど）、開いたままにする。
      state = {
        ...state, sessionView: sv, sidebarCollapsed: deps.storage.get(SIDEBAR_KEY) === true, sidebarOrder: cleanSidebarOrder(deps.storage.get(SIDEBAR_ORDER_KEY)),
        panes: { ...cleanPaneLayout(deps.storage.get(PANES_KEY)), zoom: null, flash: null },
        sidebarFolded: cleanSidebarFolded(deps.storage.get(SIDEBAR_FOLDED_KEY)), sidebarWidth: cleanSidebarWidth(deps.storage.get(SIDEBAR_WIDTH_KEY)),
        pageSize: readPageSize(deps.storage.get(PAGE_SIZE_KEY)),
        // プロジェクト画面の右パネルで折りたたんだ節。形の違う値は捨てる。
        projectRailFolded: readProjectRailFolded(deps.storage.get(PROJECT_RAIL_KEY)),
        // 知らせ終えた戻る時点。開き直しても同じ時点を 2 度知らせない。
        returnSeen: readReturnSeen(deps.storage.get(RETURN_SEEN_KEY)),
        // 開き直す前に残した入力待ちの鍵。同じ入力待ちを、開き直しで知らせ直さない（mediator/live.ts）。
        waitingCarried: readWaitingNotified(deps.storage.get(WAITING_NOTIFIED_KEY)),
        // ベルの既読の鍵。事実が変われば鍵も変わるので、残っていても古い版の鍵が行を隠すことはない。
        noticesRead: readNoticesRead(deps.storage.get(NOTICES_READ_KEY)),
        // 未検証の opencode の版の札を閉じた版。同じ版では開き直しても出さない。
        opencodeVersionSeen: readOpencodeVersionSeen(deps.storage.get(OPENCODE_VERSION_SEEN_KEY)),
        codexVersionSeen: readCodexVersionSeen(deps.storage.get(CODEX_VERSION_SEEN_KEY)),
        // 新しいセッションの書きかけと前回値。形の違う値（手で書き換えられたなど）は捨てる。
        newSessionDraft: readDraft(deps.storage.get(NEW_SESSION_DRAFT_KEY)), launchPrefs: readLaunchPrefs(deps.storage.get(LAUNCH_PREFS_KEY)),
      };
      shown = state;
      // 通知の受け取り。
      // 選んでいなければ環境の既定に従い、ブラウザでは許可が外れていれば受け取らない。
      if (notifier) {
        const pref = deps.storage.get(NOTIFY_KEY);
        const wanted = (typeof pref === 'boolean' ? pref : notifier.defaultOn) && notifier.available();
        const on = wanted && notifier.granted();
        setNotify(notifier.available(), on);
        // 受け取ると選んでいれば、許可の状態だけを読む。起動しただけでは OS に尋ねない（2026-10-13 の決定、9c）。
        // まだ尋ねていなければ ask を立て、始める前の確認に任意の行「通知」と［許可する］を出す。尋ねるのは、その行か設定のスイッチを押したときだけである（notify.request）。
        // デスクトップの許可は OS が持つので、システム設定で切られていれば受け取るのままにしない。
        // 利用者の選んだ値（NOTIFY_KEY）は書き換えない。OS で許可し直したら、スイッチを入れ直すだけで戻る。
        if (wanted) {
          notifier.status().then((s) => {
            if (s === 'denied' && notifier.available()) setNotify(true, false, true);
            else if (s === 'undetermined') setNotify(notifier.available(), store.notify.on, false, true);
          }, () => {});
        }
        // 通知を押したら、そのセッションを開いてターミナルにフォーカスする。
        // 窓を前に出すのは notifier の役目である。
        unsubNotify = notifier.onOpen((id) => dispatch({ kind: 'action', action: { type: 'session.open', id, focus: 'terminal' } }));
        // 参加リクエストの通知を押したら、設定のクラウド同期を開き、承認の欄の今の状態を取り直す（殻の window.__hangarOpenJoin）。
        unsubJoin = notifier.onOpenJoin?.(() => {
          dispatch({ kind: 'action', action: { type: 'nav.go', to: { name: 'settings', at: 'cloud' } } });
          cloudMember.run({ op: 'load' });
        }) ?? null;
      }
      // 更新の確認（起動したときに 1 度、その後は数時間おき）。殻が updater を持たなければ何もしない。
      updater?.start();
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
      // 前面に来たときも、隠れている間に溜めた Store の変化を出す。visibilitychange を出し損ねる WebView があっても、画面が古いまま残らないようにする。
      unsubFocus = deps.onWindowFocus?.(() => { releaseStore(); dispatch({ kind: 'runtime', event: { type: 'window.focus' } }); recheckNotify(); returnTimerAt = null; syncReturns(); }) ?? null;
      unsubVisible = deps.onWindowVisible?.(() => { releaseStore(); recheckNotify(); gitWatch.wake(); }) ?? null;
      unsubHide = deps.onPageHide?.(() => cloudMember.flushPending()) ?? null;
      ws.connect();
    },
    stop() { ws?.close(); unsubHash?.(); unsubFocus?.(); unsubFocus = null; unsubVisible?.(); unsubVisible = null; unsubHide?.(); unsubHide = null; unsubNotify?.(); unsubNotify = null; unsubJoin?.(); unsubJoin = null; deps.terminals.dispose(); },
  };
}
