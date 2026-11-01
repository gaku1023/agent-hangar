import type { AccountsDto, InvestigateContext, UiAction, SyncStatusBody, TerminalApp } from '@agent-hangar/shared';
import { applyConfigDetail, CUSTOM_PROVIDER_ROW, gitFileKey, type EditorOpenAction, type OpencodeProviderOp, type OpencodeProvidersState, type Store } from '../store/store.ts';
import type { OpencodeProvidersDto } from '@agent-hangar/shared';
import { EditorMissingApiError, type ApiClient } from './api.ts';
import { sameInspect } from '../store/folderInspect.ts';

/** iTerm2 で開けず、Terminal.app に落ちたときの知らせ。文そのものではなく辞書の鍵で、Runtime が現在の言語で引いて出す。 */
export const FELL_BACK = 'runtime.openTerminal.fellBack' as const;
/** Windows Terminal が無く、既定のターミナルに落ちたときの知らせ。 */
export const FELL_BACK_WINDOWS = 'runtime.openTerminal.fellBackWindows' as const;
/** 応答のあとに知らせられる文の鍵（引数の無いもの）。 */
export type CallToast = typeof FELL_BACK | typeof FELL_BACK_WINDOWS;

/**
 * 読み切るのに時間がかかる知らせを出しておく長さ（ミリ秒）。
 * 既定の info は 4 秒で消える（views/ToastStack.tsx の INFO_TOAST_MS）。
 * 長い文を 4 秒では読めないので、その知らせだけ、これを添えて長くする。ほかの知らせの長さは変えない。
 */
export const LONG_TOAST_MS = 8000;

/** 外部ターミナルで開いた応答の知らせ。落ちたときだけ、落ちた先で文を選ぶ。 */
const fellBackToast = (r: { app: TerminalApp; fellBack: boolean }): CallToast | null => (r.fellBack ? (r.app === 'windowsDefault' ? FELL_BACK_WINDOWS : FELL_BACK) : null);

/** 長く出す知らせ。外部ターミナルが開けず別のもので開いたという文は長く、何が起きたかを読む間が要る（Windows Terminal が無いとき、iTerm2 で開けなかったとき）。 */
const holdOf = (toast: CallToast): number | undefined => (toast === FELL_BACK_WINDOWS || toast === FELL_BACK ? LONG_TOAST_MS : undefined);

/** 応答を受けた後にすること。apply は応答が着いた時点の Store に当てる。toast は情報の知らせで、toastHoldMs は出しておく長さ（省くと既定）である。 */
export type CallDone = { apply?: (store: Store) => Store; toast?: CallToast; toastHoldMs?: number };
/**
 * API の呼び出し 1 回と、その前後の扱い。
 * before は呼ぶ前に Store に当てる（実行中だと分かるよう、前の結果を消すなど）。
 * 失敗は、ふつうは Runtime がトーストにする。
 * failed を持つ行だけは、トーストにせず failed で Store に書く（画面が入力の欄のそばに理由を出し、入れたものを残せるように）。
 * failed が null を返した失敗は、ふつうどおりトーストにする。
 * failHoldMs を持つ行の失敗は、その長さで消える error のトーストにする（押した直後に読めば足りる失敗。ほかの error は閉じるまで残る）。
 */
/** failInvestigate は、失敗のトーストに「エージェントで調査…」を付けるときの事情（エラーの文は失敗の時点で足す）。 */
export type ApiCall = { before?: (store: Store) => Store; run: (api: ApiClient) => Promise<CallDone>; failed?: (store: Store, error: unknown) => Store | null; failHoldMs?: number; failInvestigate?: Omit<InvestigateContext, 'message'> };

type After<T> = { before?: (store: Store) => Store; apply?: (store: Store, r: T) => Store; toast?: (r: T) => CallToast | null; failed?: (store: Store, error: unknown) => Store | null; failHoldMs?: number; failInvestigate?: Omit<InvestigateContext, 'message'> };

/** 行の共通の形。API を呼び、応答を Store に当て、知らせがあれば添える。応答の型は、ここで閉じる。 */
function call<T>(run: (api: ApiClient) => Promise<T>, after: After<T> = {}): ApiCall {
  const { before, apply, toast, failed, failHoldMs, failInvestigate } = after;
  return {
    ...(before ? { before } : {}),
    ...(failInvestigate ? { failInvestigate } : {}),
    ...(failed ? { failed } : {}),
    ...(failHoldMs !== undefined ? { failHoldMs } : {}),
    run: (api) => run(api).then((r) => {
      const message = toast?.(r) ?? null;
      const hold = message !== null ? holdOf(message) : undefined;
      return { ...(apply ? { apply: (store: Store) => apply(store, r) } : {}), ...(message !== null ? { toast: message } : {}), ...(hold !== undefined ? { toastHoldMs: hold } : {}) };
    }),
  };
}

const withSync = (store: Store, sync: SyncStatusBody): Store => ({ ...store, sync });

/**
 * エディタで開く行の失敗。エディタが見つからない（409）ときは、トーストにせず「<名前> が見つかりません」の面を出す（試作の 1-3 の B）。
 * ほかの失敗は、ふつうどおりトーストにする（failHoldMs を渡せば、その長さで消える）。開けたら面を閉じる。
 */
const editorOpen = (action: EditorOpenAction, run: (api: ApiClient) => Promise<void>, failHoldMs?: number): ApiCall => call(run, {
  apply: (store) => (store.editorMissing ? { ...store, editorMissing: null } : store),
  failed: (store, e) => (e instanceof EditorMissingApiError ? { ...store, editorMissing: { ...e.body, retry: action, n: (store.editorMissing?.n ?? 0) + 1 } } : null),
  ...(failHoldMs !== undefined ? { failHoldMs } : {}),
});
const withAccounts = (store: Store, accounts: AccountsDto): Store => ({ ...store, accounts });

const EMPTY_PROVIDERS: OpencodeProvidersState = { status: 'loading', data: null, busy: null, error: null, added: null, login: null };
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** 設定のプロバイダーの面を書き換える。まだ読んでいなければ空から。 */
const withProviders = (store: Store, f: (p: OpencodeProvidersState) => Partial<OpencodeProvidersState>): Store => {
  const p = store.opencodeProviders ?? EMPTY_PROVIDERS;
  return { ...store, opencodeProviders: { ...p, ...f(p) } };
};
/**
 * プロバイダーを変える操作（接続、解除、モデル ID の追加、OpenAI 互換のサーバー）。答えは新しい一覧で、そのまま入れる。
 * 送る間はその行を busy にし、失敗はトーストにせず、その行の欄のそばに出す（入れたものを残せるように）。
 * 接続して一覧に新しく入った行を added にする（入るときに目立たせる）。
 */
function providerCall(id: string, op: OpencodeProviderOp, run: (api: ApiClient) => Promise<OpencodeProvidersDto>): ApiCall {
  return call(run, {
    before: (store) => withProviders(store, () => ({ busy: { id, op }, error: null, added: null })),
    apply: (store, data) => withProviders(store, (p) => {
      const had = new Set(p.data?.connected.map((x) => x.id) ?? []);
      const fresh = data.connected.find((x) => !had.has(x.id))?.id ?? null;
      return { status: 'ready', data, busy: null, added: op === 'disconnect' || op === 'model' ? null : fresh };
    }),
    failed: (store, e) => withProviders(store, () => ({ busy: null, error: { id, op, message: errText(e) } })),
  });
}

type Rows = { [K in UiAction['type']]?: (action: Extract<UiAction, { type: K }>, store: Store) => ApiCall | null };

/**
 * API を 1 回呼ぶだけの UiAction の表。
 * ここにある UiAction は、Mediator も Effect も通らない。Runtime が受けて、この表で引いた呼び出しをそのまま実行する。
 * 行は、UiAction の中身と Store（読むだけ）から呼び出しを組む。null を返せば何も呼ばない。
 * State を読むもの、State を変えるもの、応答を Mediator へ戻すもの、API を 2 回以上呼ぶものは、ここへ置かず Mediator に残す。
 */
export const actionTable = {
  // 画面の正は後から届く project.upsert なので、返り値は Store に入れない。
  'project.setStatus': (i) => call((api) => api.setProjectStatus(i.id, i.status)),
  'project.rename': (i) => call((api) => api.renameProject(i.id, i.name)),
  // 外で開けなかった（この PC にパスが無い、プロジェクトが消えた）知らせは、押した直後に読めば足りるので、長く出してから消す。
  'project.openEditor': (i) => editorOpen(i, (api) => api.projectOpenEditor(i.id, i.once), LONG_TOAST_MS),
  'project.openTerminalApp': (i) => call((api) => api.projectOpenTerminal(i.id), { toast: fellBackToast, failHoldMs: LONG_TOAST_MS }),

  'session.openTerminalApp': (i) => call((api) => api.openTerminalApp(i.runId, i.tabId ?? null), { toast: fellBackToast }),
  'session.openEditor': (i) => editorOpen(i, (api) => api.openEditor(i.sessionId, undefined, { once: i.once })),
  // 変更したファイルを押したとき。path は本文に出てきた綴りのまま渡す。line は差分から開くときの行。
  'session.openFile': (i) => editorOpen(i, (api) => api.openEditor(i.sessionId, i.path, { line: i.line, once: i.once })),
  // 画面の正は後から届く session.upsert なので、返り値は Store に入れない。
  'session.state.reject': (i) => call((api) => api.rejectSessionState(i.id)),
  // 別のプロジェクトへ移す。画面の正は後から届く session.upsert なので、返り値は Store に入れない。
  'session.move': (i) => call((api) => api.moveSession(i.id, i.projectId)),
  // 消す。画面の正は後から届く session.removed なので、返り値は Store に入れない。
  'session.delete': (i) => call((api) => api.deleteSession(i.id)),
  // MCP の削除の依頼への答え。画面の正は後から届く deleteApprovals.update なので、返り値は Store に入れない。
  'session.tryNow': (i) => call((api) => api.tryPausedSession(i.id)),
  'schedule.create': (i) => call((api) => api.createSchedule(i.input)),
  'schedule.update': (i) => call((api) => api.updateSchedule(i.id, i.patch)),
  'schedule.delete': (i) => call((api) => api.deleteSchedule(i.id)),
  'schedule.run': (i) => call((api) => api.runSchedule(i.id)),
  'deleteApproval.answer': (i) => call((api) => api.answerDeleteApproval(i.id, i.answer)),
  // 同じファイルの編集の「このファイルでは表示しない」。写しは見張りが書き直し、session.upsert で消える。
  'overlap.dismiss': (i) => call((api) => api.dismissOverlap(i.sessionId, i.with, i.paths)),
  // 起動前の準備をやめる。やめる直前に準備が済んでいた（走っていない）ときの 404 は、利用者に見せることではないので黙る。
  'launchPrep.cancel': (i) => ({ run: (api) => api.cancelPrep(i.key).catch(() => undefined).then(() => ({})) }),
  // 進みと結果は summary.pending と summary.updated で届くので、ここでは待たない。
  'summary.regenerate': (i) => call((api) => api.regenerateSummary(i.sessionId)),

  // TODO の操作は取り消し（⌘Z）のために State を変えるので、表に置かず Mediator（mediator/todos.ts）に置く。
  // 保存した結果はサーバの memo.update より先に入れる。書いた本人の画面が一瞬古い本文に戻らないようにする。
  'memo.save': (i) => call((api) => api.saveMemo(i.projectId, i.markdown), { apply: (store, m) => ({ ...store, memos: { ...store.memos, [m.projectId]: m } }) }),
  // 指示とメモリ。ファイルは外で書き換わるので、表示するたびに読み直す。
  'instructions.load': (i) => call((api) => api.instructions(i.projectId), { apply: (store, d) => ({ ...store, instructions: { ...store.instructions, [d.projectId]: d } }) }),
  'instructions.openEditor': (i) => editorOpen(i, (api) => api.openInstruction(i.projectId, i.kind, i.once)),
  // セットアップのすゝめの中身を見る。写した md を、ほかの「<名前> で開く」と同じ道で開く（見つからなければ同じ面を出す）。
  'setupGuide.openEditor': (i) => editorOpen(i, (api) => api.openSetupGuide(i.once)),
  'artifact.open': (i) => call((api) => api.openArtifact(i.id)),

  // git の表示（0.5.0）。見えている行の git（git.watch）は取り直しの周期を持つので表に置かず、Runtime が受ける。
  // 差分の一覧、差、編集、プロジェクトの git は、開いた面が出すたびに読み直す（ファイルは外で変わる）。
  'git.changes.load': (i) => call((api) => api.sessionChanges(i.sessionId), { apply: (store, d) => ({ ...store, gitChanges: { ...store.gitChanges, [i.sessionId]: d } }) }),
  // 差と編集が読めないときは、ダイアログの右に理由を出す（トーストにしない）。
  'git.diff.load': (i) => call((api) => api.sessionDiff(i.sessionId, i.file), {
    apply: (store, d) => ({ ...store, gitDiffs: { ...store.gitDiffs, [gitFileKey(i.sessionId, i.file)]: d } }),
    failed: (store, e) => ({ ...store, gitDiffs: { ...store.gitDiffs, [gitFileKey(i.sessionId, i.file)]: { error: e instanceof Error ? e.message : String(e) } } }),
  }),
  'git.edits.load': (i) => call((api) => api.sessionEdits(i.sessionId, i.file), {
    apply: (store, d) => ({ ...store, gitEdits: { ...store.gitEdits, [gitFileKey(i.sessionId, i.file)]: d } }),
    failed: (store, e) => ({ ...store, gitEdits: { ...store.gitEdits, [gitFileKey(i.sessionId, i.file)]: { error: e instanceof Error ? e.message : String(e) } } }),
  }),
  'project.git.load': (i) => call((api) => api.projectGit(i.projectId), { apply: (store, d) => ({ ...store, projectGit: { ...store.projectGit, [i.projectId]: d } }) }),
  'artifact.openEditor': (i) => editorOpen(i, (api) => api.openArtifactEditor(i.id, i.once)),
  'artifact.add': (i) => {
    const url = i.url.trim();
    if (!url) return null;
    return call((api) => api.addArtifact(i.projectId, url), {
      // 前の断りは、次の追加を始めたときに消す。
      before: (store) => ({ ...store, artifactAddError: null }),
      apply: (store, a) => ({ ...store, artifacts: { ...store.artifacts, [a.id]: a }, artifactAddError: null }),
      // 断られた理由は欄のそばに出す。トーストにはしない。
      failed: (store, e) => ({ ...store, artifactAddError: { projectId: i.projectId, url, message: e instanceof Error ? e.message : String(e) } }),
    });
  },

  // エディタの欄。候補の一覧はファイルの有無と PATH から読むだけなので、開くたびに取り直す。
  'editors.load': () => call((api) => api.editors(), { apply: (store, editors) => ({ ...store, editors, editorTest: null }) }),
  // テストは、答えが届くまで「起こしています」を出す。答えは開けなかった理由も含めて欄の下に出す（トーストにしない）。
  'editor.test': () => call((api) => api.testEditor(), { before: (store) => ({ ...store, editorTest: 'running' }), apply: (store, editorTest) => ({ ...store, editorTest }), failed: (store) => ({ ...store, editorTest: null }) }),
  // 前回の結果を先に消して、試している最中だと分かるようにする。
  'summarizer.test': () => call((api) => api.testSummarizer(), { before: (store) => ({ ...store, summarizerTest: null }), apply: (store, r) => ({ ...store, summarizerTest: r }) }),

  // 同期。応答の状態は Store に直に当てる（サーバの sync.status と同じ形）。同期の状態は Store だけが持つので、Mediator へは流さない。
  'sync.now': () => call((api) => api.syncNow(), { apply: withSync }),
  'sync.pause': (i) => call((api) => api.syncPause(i.paused), { apply: withSync }),

  // 設定の同期（作り直した実装）。件数と状態は config.update で届くので、応答は中身の一覧だけを Store に入れる。
  'configSync.order.cancel': () => call((api) => api.configDeleteOrder()),
  'configSync.unsent.send': (i) => call((api) => api.configSendUnsent(i.id), { apply: (store, u) => applyConfigDetail(store, 'unsent', u) }),

  // Claude Code のアカウント。一覧を返すものは、応答をそのまま Store に入れる（サーバの accounts.update と同じ形）。
  'accounts.load': () => call((api) => api.accounts(), { apply: withAccounts }),
  // アカウントを足す前の確かめ。打つたびに読み、答えは問いの写しごと Store に置く（画面は今の欄と合う答えだけを使う）。読めない場所（相対パスなど）はトーストにせず答えを消し、理由は登録を押したときにダイアログで言う。
  // 選んだ 1 つのフォルダの事前の問い合わせ（0.6.1）。後から頼んだ問いがあれば、古い問いの答えは捨てる。
  // 読めなくてもトーストにしない。ダイアログは今までどおり、選んだフォルダを登録して始める。
  'folder.inspect': (i) => {
    const name = i.name ?? null;
    return call((api) => api.inspectFolder(i.path, i.name), {
      before: (store) => ({ ...store, folderInspect: { path: i.path, name, status: 'loading' } }),
      apply: (store, data) => (sameInspect(store.folderInspect, i.path, name) ? { ...store, folderInspect: { path: i.path, name, status: 'ready', data } } : store),
      failed: (store) => (sameInspect(store.folderInspect, i.path, name) ? { ...store, folderInspect: { path: i.path, name, status: 'failed' } } : store),
    });
  },
  // 新しいセッションで opencode を選んだときのモードとモデル。後から頼んだ場所があれば、古い場所の答えは捨てる。
  // 同じ場所を読み直す間と失敗したときは、前の答えを残す。読めなくてもトーストにせず、ダイアログが札の下で言う。
  'opencode.options': (i) => call((api) => (i.refresh ? api.opencodeOptions(i.dir, true) : api.opencodeOptions(i.dir)), {
    before: (store) => ({ ...store, opencodeOptions: { dir: i.dir, status: 'loading', data: store.opencodeOptions?.dir === i.dir ? store.opencodeOptions.data : null } }),
    apply: (store, data) => (store.opencodeOptions?.dir === i.dir ? { ...store, opencodeOptions: { dir: i.dir, status: 'ready', data } } : store),
    failed: (store) => (store.opencodeOptions?.dir === i.dir ? { ...store, opencodeOptions: { ...store.opencodeOptions, status: 'failed' } } : store),
  }),
  // 新しいセッションで Codex を選んだときのモデルと推論の段階。読み直しの間と失敗したときは、前の答えを残す。読めなくてもトーストにせず、ダイアログが札の下で言う。
  'codex.options': (i) => call((api) => api.codexOptions(i.refresh), {
    before: (store) => ({ ...store, codexOptions: { status: 'loading', data: store.codexOptions?.data ?? null } }),
    apply: (store, data) => ({ ...store, codexOptions: { status: 'ready', data } }),
    failed: (store) => ({ ...store, codexOptions: { status: 'failed', data: store.codexOptions?.data ?? null } }),
  }),
  // 設定の「連携 › opencode › プロバイダー」。読み直しの間と失敗したときは、前の一覧を残す。
  'opencode.providers.load': () => call((api) => api.opencodeProviders(), {
    before: (store) => withProviders(store, (p) => ({ status: p.data ? 'ready' : 'loading', error: null })),
    // ログインが終わったあとの読み直しなら、ログインの欄を閉じ、その行を接続した行として目立たせる。
    apply: (store, data) => withProviders(store, (p) => (p.login?.status === 'complete' ? { status: 'ready', data, login: null, added: p.login.id } : { status: 'ready', data })),
    failed: (store, e) => withProviders(store, (p) => ({ status: p.data ? 'ready' : 'failed', error: { id: '', op: 'load', message: errText(e) } })),
  }),
  // API キーはこの呼び出しに渡すだけで、Store に置かない。
  'opencode.providers.key': (i) => providerCall(i.id, 'key', (api) => api.opencodeProviderKey(i.id, i.key)),
  'opencode.providers.disconnect': (i) => providerCall(i.id, 'disconnect', (api) => api.opencodeProviderDisconnect(i.id)),
  'opencode.providers.model': (i) => providerCall(i.id, 'model', (api) => api.opencodeProviderModel(i.id, i.model)),
  'opencode.providers.custom': (i) => providerCall(CUSTOM_PROVIDER_ROW, 'custom', (api) => api.opencodeCustomProvider({ name: i.name, url: i.url, ...(i.apiKey ? { apiKey: i.apiKey } : {}) })),
  'opencode.providers.login': (i) => call((api) => api.opencodeLogin(i.id, i.method), {
    before: (store) => withProviders(store, () => ({ busy: { id: i.id, op: 'login' }, error: null, login: null })),
    apply: (store, attempt) => withProviders(store, () => ({ busy: null, login: { id: i.id, attempt, status: 'pending', message: null } })),
    failed: (store, e) => withProviders(store, () => ({ busy: null, error: { id: i.id, op: 'login', message: errText(e) } })),
  }),
  // ログインの進み。画面が数秒おきに頼む。終わったら画面が一覧を読み直す。始め直したあとに届いた古い答えは捨てる。
  'opencode.providers.login.poll': (_i, store) => {
    const login = store.opencodeProviders?.login;
    if (!login || login.status !== 'pending') return null;
    const same = (p: OpencodeProvidersState) => p.login?.attempt.attemptId === login.attempt.attemptId;
    return call((api) => api.opencodeLoginStatus(login.id, login.attempt.attemptId), {
      apply: (s, st) => withProviders(s, (p) => (same(p) && p.login ? { login: { ...p.login, status: st.status, message: st.message } } : {})),
      failed: (s, e) => withProviders(s, (p) => (same(p) && p.login ? { login: { ...p.login, status: 'failed', message: errText(e) } } : {})),
    });
  },
  'opencode.providers.login.code': (i, store) => {
    const login = store.opencodeProviders?.login;
    if (!login) return null;
    return call((api) => api.opencodeLoginComplete(login.id, login.attempt.attemptId, i.code), {
      before: (s) => withProviders(s, () => ({ busy: { id: login.id, op: 'login' }, error: null })),
      apply: (s) => withProviders(s, () => ({ busy: null })),
      failed: (s, e) => withProviders(s, () => ({ busy: null, error: { id: login.id, op: 'login', message: errText(e) } })),
    });
  },
  'opencode.providers.login.cancel': (_i, store) => {
    const login = store.opencodeProviders?.login;
    if (!login) return null;
    return call((api) => api.opencodeLoginCancel(login.id, login.attempt.attemptId), {
      before: (s) => withProviders(s, () => ({ login: null })),
      // 取り消せなくても（serve が止まって試みが消えたなど）、画面からは消えたままでよい。
      failed: (s) => s,
    });
  },
  'share.preview': (i) => call((api) => api.sharePreview(i.agent), { apply: (store, d) => ({ ...store, sharePreview: { ...store.sharePreview, [i.agent]: d } }) }),
  'account.add.preview':(i) => call((api) => (i.agent === 'codex' ? api.previewCodexAccountDir(i.name, i.dir) : api.previewAccountDir(i.name, i.dir)), { apply: (store, accountPreview) => ({ ...store, accountPreview }), failed: (store) => ({ ...store, accountPreview: null }) }),
  'account.choose': (i) => call((api) => (i.agent === 'codex' ? api.setCurrentCodexAccount(i.accountId) : api.setCurrentAccount(i.accountId)), { apply: withAccounts, failInvestigate: { op: 'accountSwitch', agent: i.agent ?? 'claude-code', accountId: i.accountId } }),
  'account.update': (i) => {
    // 名前は前後の空白を落とす。空になった名前は送らず、送るものが無ければ何も呼ばない。
    const name = i.name?.trim();
    const patch = { ...(name ? { name } : {}), ...(i.color !== undefined ? { color: i.color } : {}) };
    return Object.keys(patch).length === 0 ? null : call((api) => (i.agent === 'codex' ? api.updateCodexAccount(i.accountId, patch) : api.updateAccount(i.accountId, patch)), { apply: withAccounts });
  },
  // ログインの進みは accounts.update で届くので、応答は使わない。
  'account.login': (i) => call((api) => (i.agent === 'codex' ? api.loginCodexAccount(i.accountId, i.method) : api.loginAccount(i.accountId))),
  'account.login.cancel': (i) => call((api) => (i.agent === 'codex' ? api.cancelCodexAccountLogin(i.accountId) : api.cancelAccountLogin(i.accountId)), { apply: withAccounts }),
  'account.refresh': (i) => call((api) => (i.agent === 'codex' ? api.refreshCodexAccount(i.accountId) : api.refreshAccount(i.accountId)), { apply: withAccounts }),
} satisfies Rows;

/** 表にある UiAction。Mediator の入力の型からは、これを外す（mediator/types.ts の MediatedAction）。 */
export type TableAction = Extract<UiAction, { type: keyof typeof actionTable }>;

export function isTableAction(action: UiAction): action is TableAction {
  return Object.hasOwn(actionTable, action.type);
}

/** 表を引く。行と UiAction の型は鍵で対になっているので、ここで 1 度だけ型を合わせる。 */
export function actionCall(action: TableAction, store: Store): ApiCall | null {
  const row = actionTable[action.type] as (action: TableAction, store: Store) => ApiCall | null;
  return row(action, store);
}
