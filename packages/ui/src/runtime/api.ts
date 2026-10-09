import type { AccountsDto, ArtifactDto, BootstrapDto, CloudUsageDto, CompatDto, ConfigPreviewDto, DropDto, EventsPageDto, LaunchParams, LaunchResultDto, LiveDigestDto, MemoDto, ProjectDto, ProjectPlace, ProjectStatus, PromoteResultDto, PromptCommandDto, ReadinessDto, ResolveAction, ResumeHereConflictDto, RetentionDto, RetentionPreviewDto, RunDto, SearchParamsDto, SearchResultDto, SessionDto, SessionFilesDto, SessionStateDto, SessionStatus, SettingsDto, ShellHookDto, StatuslineStatusDto, SummarizerTestDto, SyncStatusBody, TabDto, TerminalApp, TodoDto, UsageAggregateDto, WorkspaceDirDto } from '@agent-hangar/shared';

/** 「この PC で再開」で手元の本文の方が小さいときの 409。UI は確認ダイアログにする。 */
export class ApiConflictError extends Error {
  constructor(public readonly body: ResumeHereConflictDto) { super('local_smaller'); this.name = 'ApiConflictError'; }
}

/** 保持期間の下見の後に、設定ファイルがほかで変わった。UI は下見を取り直す。 */
export class RetentionConflictApiError extends Error {
  constructor() { super('retention_conflict'); this.name = 'RetentionConflictApiError'; }
}

/**
 * 本文の読み出しの向き。
 * latest は末尾から（画面を開いたとき）、beforeSeq はその手前へ（過去へ遡るとき）、
 * fromSeq はそこから前向きへ（追記を取り込むとき）。
 */
export type EventsQuery = { agentId: string | null; latest?: boolean; beforeSeq?: number; fromSeq?: number };

export type ApiClient = {
  bootstrap(): Promise<BootstrapDto>;
  events(sessionId: string, q: EventsQuery): Promise<EventsPageDto>;
  subagents(sessionId: string): Promise<string[]>;
  /** 実行中のセッションの右ペインに出すライブの要約。 */
  live(sessionId: string): Promise<LiveDigestDto>;
  /** そのセッションが編集系のツールで変えたファイル（索引から。読み込んだ本文の窓には依らない）。冒頭の 1 枚の「変更したファイル」が使う。 */
  sessionFiles(sessionId: string): Promise<SessionFilesDto>;
  search(params: SearchParamsDto): Promise<SearchResultDto>;
  setProjectStatus(id: string, status: ProjectStatus): Promise<ProjectDto>;
  resolveProject(id: string, action: ResolveAction): Promise<unknown>;
  candidates(id: string, name: string): Promise<string[]>;
  // 初期プロンプト欄の候補と添付。
  promptCommands(projectId: string | null): Promise<PromptCommandDto[]>;
  /** プロジェクトのファイルを問いで探す（相対パス、最大 50 件）。問いが空なら最近変えたもの。 */
  promptFiles(projectId: string, query: string): Promise<string[]>;
  uploadDrop(file: Blob, name: string): Promise<DropDto>;
  existingDrops(paths: string[]): Promise<string[]>;
  updateSettings(patch: Partial<SettingsDto>): Promise<SettingsDto>;
  rebuildIndex(): Promise<void>;
  launch(params: LaunchParams): Promise<LaunchResultDto>;
  resume(sessionId: string): Promise<LaunchResultDto>;
  fork(sessionId: string): Promise<LaunchResultDto>;
  attach(sessionId: string): Promise<LaunchResultDto>;
  adopt(sessionId: string): Promise<LaunchResultDto>;
  killRun(runId: string): Promise<RunDto>;
  openTab(runId: string): Promise<TabDto>;
  closeTab(runId: string, tabId: string): Promise<TabDto>;
  openTerminalApp(runId: string, tabId: string | null): Promise<{ app: TerminalApp; fellBack: boolean }>;
  /** Claude のタブを transcript の中の指示へ跳ばす。 */
  jumpToPrompt(runId: string, body: { heads: string[]; index: number; from: 'top' | 'bottom' }): Promise<{ found: true } | { found: false; reason: 'mode' | 'notFound' }>;
  leaveTranscript(runId: string): Promise<{ left: boolean }>;
  /**
   * file を渡すと、作業ディレクトリではなくそのファイルを開く。
   * サーバはそのセッションが変えたファイルかを確かめる。
   */
  openEditor(sessionId: string, file?: string): Promise<void>;
  projectOpenEditor(projectId: string): Promise<void>;
  projectOpenTerminal(projectId: string): Promise<{ app: TerminalApp; fellBack: boolean }>;
  createProject(place: ProjectPlace): Promise<ProjectDto>;
  workspaceDirs(): Promise<WorkspaceDirDto[]>;
  usageAggregate(days: number): Promise<UsageAggregateDto>;
  statusline(): Promise<StatuslineStatusDto>;
  shellHook(): Promise<ShellHookDto>;
  /** 準備の確かめ。設定画面の検証と、空のホームの確認リストが読む。 */
  readiness(): Promise<ReadinessDto>;
  /** Claude Code との互換のずれの中身。準備の確かめでずれが 1 件以上あるときに、続けて取る（止めた機能の一覧を常に出すため）。 */
  compat(): Promise<CompatDto>;
  addTodo(projectId: string, text: string): Promise<TodoDto>;
  setTodoDone(id: string, done: boolean): Promise<TodoDto>;
  removeTodo(id: string): Promise<TodoDto>;
  confirmTodo(id: string): Promise<TodoDto>;
  rejectTodo(id: string): Promise<TodoDto>;
  /** セッションの状態を手で変える。status の null は Active に戻す。返り値は使わない（画面の正は session.upsert）。 */
  setSessionState(id: string, body: { status: SessionStatus | null; note?: string; returnOn?: string; returnTime?: string }): Promise<{ state: SessionStateDto }>;
  /** 提案を確定する。日を変えたときだけ returnOn を渡す。提案が無ければ 409 の一文で投げる。 */
  confirmSessionState(id: string, body: { returnOn?: string; returnTime?: string }): Promise<{ state: SessionStateDto }>;
  rejectSessionState(id: string): Promise<{ state: SessionStateDto }>;
  memo(projectId: string): Promise<MemoDto>;
  saveMemo(projectId: string, markdown: string): Promise<MemoDto>;
  setSessionMemo(sessionId: string, memo: string): Promise<SessionDto>;
  addArtifact(projectId: string, url: string): Promise<ArtifactDto>;
  openArtifact(id: string): Promise<void>;
  openArtifactEditor(id: string): Promise<void>;
  promote(sessionId: string, body: { name: string; gitInit: boolean; moveFiles: boolean }): Promise<PromoteResultDto>;
  /** 202 と { accepted } が返るが、本文は使わない。結果は summary.pending と summary.updated で届く。 */
  regenerateSummary(sessionId: string): Promise<void>;
  summarizerModels(): Promise<{ models: string[] }>;
  testSummarizer(): Promise<SummarizerTestDto>;
  // ここから下はクラウド同期（フェーズ 4）である。
  /** 設定の「使用量と費用」。refresh なら取り直す（サーバは一時停止の間は取りに行かず最後の値を返す）。 */
  syncUsage(refresh: boolean): Promise<CloudUsageDto | null>;
  syncNow(): Promise<SyncStatusBody>;
  syncPause(paused: boolean): Promise<SyncStatusBody>;
  /** 窓が前面に来たことをサーバに伝えて pull を促す。サーバ側で間引く。 */
  syncFocus(): Promise<void>;
  resumeHere(sessionId: string, overwrite: boolean): Promise<LaunchResultDto>;
  /** 全セッションの読み書き権を持つ秘密なので、押したときだけ取りに行く。 */
  joinToken(): Promise<{ token: string | null }>;
  configPreview(): Promise<ConfigPreviewDto>;
  configPull(): Promise<{ applied: number; conflicts: number }>;
  // 会話の保持期間。書き込みは下見の指紋を添え、ほかで変わっていたら 409 で断られる。
  retention(): Promise<RetentionDto>;
  retentionPreview(days: number): Promise<RetentionPreviewDto>;
  writeRetention(days: number, baseSha256: string): Promise<RetentionDto>;
  // Claude Code のアカウント。AccountsDto を返すものは、画面へは accounts.update と同じ道で入れる。
  accounts(): Promise<AccountsDto>;
  setCurrentAccount(id: string): Promise<AccountsDto>;
  /** セッションを別のアカウントで再開する。サーバがいまのアカウントも変える。断る理由は 409 と 400 の一文で投げる。 */
  switchAccount(sessionId: string, accountId: string): Promise<LaunchResultDto>;
  addAccount(name: string): Promise<AccountsDto>;
  updateAccount(id: string, patch: { name?: string; color?: string }): Promise<AccountsDto>;
  removeAccount(id: string): Promise<AccountsDto>;
  /** 202 が返るが、本文は使わない。ログインの進みは accounts.update で届く。 */
  loginAccount(id: string): Promise<void>;
  cancelAccountLogin(id: string): Promise<AccountsDto>;
  refreshAccount(id: string): Promise<AccountsDto>;
};

/** 相対 URL の `/api/...` を叩く薄いクライアント。
 * 失敗はサーバの `{ error }` を、無ければ `${status} ${path}` を Error にする。
 */
export function createApi(fetchFn: typeof fetch = (...a) => fetch(...a)): ApiClient {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const r = await fetchFn(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
    if (!r.ok) {
      // サーバが { error } を返せばその理由を、無ければ状態番号と経路を投げる。
      // 応答の本文は 1 度しか読めないので、読み取りはこの 1 回だけにする。
      const body = (await r.json().catch(() => null)) as { error?: string; localSize?: number; remoteSize?: number } | null;
      // 「この PC で再開」の 409 だけは、確認ダイアログを出すために型の付いた失敗にする。
      if (r.status === 409 && body?.error === 'local_smaller') throw new ApiConflictError(body as ResumeHereConflictDto);
      if (r.status === 409 && body?.error === 'retention_conflict') throw new RetentionConflictApiError();
      throw new Error(body?.error ?? `${r.status} ${path}`);
    }
    if (r.status === 202 || r.status === 204) return undefined as T;
    return (await r.json()) as T;
  }
  const qs = (o: Record<string, unknown>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v)); const s = p.toString(); return s ? `?${s}` : ''; };
  const post = <T>(path: string, body?: unknown) => call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
  return {
    bootstrap: () => call('/api/bootstrap'),
    events: (sessionId, q) => call(`/api/sessions/${sessionId}/events${qs({ latest: q.latest ? 1 : undefined, before: q.beforeSeq, fromSeq: q.fromSeq, agentId: q.agentId })}`),
    subagents: (sessionId) => call(`/api/sessions/${sessionId}/subagents`),
    live: (sessionId) => call(`/api/sessions/${sessionId}/live`),
    sessionFiles: (sessionId) => call(`/api/sessions/${sessionId}/files`),
    search: (params) => call(`/api/search${qs(params)}`),
    setProjectStatus: (id, status) => call(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    resolveProject: (id, action) => call(`/api/projects/${id}/resolve`, { method: 'POST', body: JSON.stringify(action) }),
    candidates: (id, name) => call(`/api/projects/${id}/candidates${qs({ name })}`),
    promptCommands: (projectId) => call<{ commands: PromptCommandDto[] }>(`/api/prompt/commands${qs({ projectId })}`).then((r) => r.commands),
    promptFiles: (projectId, query) => call<{ files: string[] }>(`/api/prompt/files${qs({ projectId, q: query })}`).then((r) => r.files),
    // 本文はそのまま送る。サーバが通すのは application/octet-stream だけなので、call の既定の種類を上書きする。
    // 送りきれないまま止まると「送っています」の札が残り、起動もできなくなる。60 秒で打ち切って、ふつうの失敗として知らせる。
    uploadDrop: (file, name) => call(`/api/drops${qs({ name })}`, { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' }, signal: AbortSignal.timeout(60_000) }),
    existingDrops: (paths) => post<{ paths: string[] }>('/api/drops/existing', { paths }).then((r) => r.paths),
    updateSettings: (patch) => call('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
    rebuildIndex: () => post('/api/index/rebuild'),
    launch: (params) => post('/api/runs', params),
    resume: (sessionId) => post(`/api/sessions/${sessionId}/resume`),
    fork: (sessionId) => post(`/api/sessions/${sessionId}/fork`),
    attach: (sessionId) => post(`/api/sessions/${sessionId}/attach`),
    adopt: (sessionId) => post(`/api/sessions/${sessionId}/adopt`),
    killRun: (runId) => call(`/api/runs/${runId}`, { method: 'DELETE' }),
    openTab: (runId) => post(`/api/runs/${runId}/tabs`),
    closeTab: (runId, tabId) => call(`/api/runs/${runId}/tabs/${tabId}`, { method: 'DELETE' }),
    openTerminalApp: (runId, tabId) => post(`/api/runs/${runId}/open-terminal`, tabId ? { tabId } : {}),
    jumpToPrompt: (runId, body) => post(`/api/runs/${runId}/jump`, body),
    leaveTranscript: (runId) => post(`/api/runs/${runId}/leave-transcript`),
    openEditor: (sessionId, file) => post(`/api/sessions/${sessionId}/open-editor`, file === undefined ? undefined : { file }),
    projectOpenEditor: (projectId) => post(`/api/projects/${projectId}/open-editor`),
    projectOpenTerminal: (projectId) => post(`/api/projects/${projectId}/open-terminal`),
    createProject: (place) => post('/api/projects', place),
    workspaceDirs: () => call('/api/workspace/dirs'),
    usageAggregate: (days) => call(`/api/usage/aggregate${qs({ days })}`),
    statusline: () => call('/api/statusline'),
    shellHook: () => call('/api/shell-hook'),
    readiness: () => call('/api/readiness'),
    compat: () => call('/api/compat'),
    addTodo: (projectId, text) => post(`/api/projects/${projectId}/todos`, { text }),
    setTodoDone: (id, done) => call(`/api/todos/${id}`, { method: 'PATCH', body: JSON.stringify({ done }) }),
    removeTodo: (id) => call(`/api/todos/${id}`, { method: 'DELETE' }),
    confirmTodo: (id) => post(`/api/todos/${id}/confirm`),
    rejectTodo: (id) => post(`/api/todos/${id}/reject`),
    setSessionState: (id, body) => call(`/api/sessions/${id}/state`, { method: 'PUT', body: JSON.stringify(body) }),
    confirmSessionState: (id, body) => post(`/api/sessions/${id}/state/confirm`, body),
    rejectSessionState: (id) => post(`/api/sessions/${id}/state/reject`),
    memo: (projectId) => call(`/api/projects/${projectId}/memo`),
    saveMemo: (projectId, markdown) => call(`/api/projects/${projectId}/memo`, { method: 'PUT', body: JSON.stringify({ markdown }) }),
    setSessionMemo: (sessionId, memo) => call(`/api/sessions/${sessionId}`, { method: 'PATCH', body: JSON.stringify({ memo }) }),
    addArtifact: (projectId, url) => post(`/api/projects/${projectId}/artifacts`, { url }),
    openArtifact: (id) => post(`/api/artifacts/${id}/open`),
    openArtifactEditor: (id) => post(`/api/artifacts/${id}/open-editor`),
    promote: (sessionId, body) => post(`/api/sessions/${sessionId}/promote`, body),
    regenerateSummary: (sessionId) => post(`/api/sessions/${sessionId}/summarize`),
    summarizerModels: () => call('/api/summarizer/models'),
    testSummarizer: () => post('/api/summarizer/test'),
    syncUsage: (refresh) => call(refresh ? '/api/sync/usage?refresh=1' : '/api/sync/usage'),
    syncNow: () => post('/api/sync/now'),
    syncPause: (paused) => post('/api/sync/pause', { paused }),
    syncFocus: () => post('/api/sync/focus'),
    resumeHere: (sessionId, overwrite) => post(`/api/sessions/${sessionId}/resume-here`, { overwrite }),
    joinToken: () => call('/api/sync/joinToken'),
    configPreview: () => call('/api/sync/config/preview'),
    configPull: () => post('/api/sync/config/pull'),
    retention: () => call('/api/retention'),
    retentionPreview: (days) => post('/api/retention/preview', { days }),
    writeRetention: (days, baseSha256) => call('/api/retention', { method: 'PUT', body: JSON.stringify({ days, baseSha256 }) }),
    accounts: () => call('/api/accounts'),
    setCurrentAccount: (id) => call('/api/accounts/current', { method: 'PUT', body: JSON.stringify({ id }) }),
    switchAccount: (sessionId, accountId) => post(`/api/sessions/${sessionId}/switch-account`, { account: accountId }),
    addAccount: (name) => post('/api/accounts', { name }),
    updateAccount: (id, patch) => call(`/api/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    removeAccount: (id) => call(`/api/accounts/${id}`, { method: 'DELETE' }),
    loginAccount: (id) => post(`/api/accounts/${id}/login`),
    cancelAccountLogin: (id) => post(`/api/accounts/${id}/login/cancel`),
    refreshAccount: (id) => post(`/api/accounts/${id}/refresh`),
  };
}
