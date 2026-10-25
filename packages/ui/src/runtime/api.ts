import type { EditorMissingDto, EditorsDto, EditorTestDto, JoinApproverState, KnownEditorId, RecoveryKeyDraftDto, SetupGuideDto } from '@agent-hangar/shared';
import type { GitDiffDto, GitDto, ProjectGitDto, SessionChangesDto, SessionEditsDto } from '@agent-hangar/shared';
import type { AccountDirPreviewDto, AccountsDto, ArtifactDto, BootstrapDto, CloudDevicesDto, CloudUsageDto, CompatDto, ConfigApplyOrderDto, ConfigApplyOrderEntryIn, ConfigBackupsDto, ConfigConflictDto, ConfigInboxDto, ConfigOutgoingDto, InstructionFileKind, InstructionsDto, InterruptedDto, ConfigSyncDto, ConfigUnsentDto, DropDto, EventsPageDto, FolderCandidatesDto, FolderInspectDto, FolderRegisterItem, FolderRegisterResultDto, LaunchParams, LaunchResultDto, LiveDigestDto, MemoDto, MobilePairedDto, MobilePairingDto, MuxRecheckDto, OpencodeStatusDto, ProjectDto, ProjectNestedDto, ProjectPlace, ProjectStatus, PromoteResultDto, PromptCommandDto, ReadinessDto, ResolveAction, ResumeHereConflictDto, ResumeHerePlanDto, ResumeStray, StrayProcessDto, TakeoverDto, RetentionDto, RetentionPreviewDto, RunDto, SearchParamsDto, SearchResultDto, SessionDto, SessionFilesDto, SessionStateDto, SessionStatus, SettingsDto, ShellHookDto, StatuslineStatusDto, SummarizerTestDto, SyncStatusBody, TabDto, TerminalApp, TodoDto, UsageAggregateDto, WorkspaceChildrenDto, WorkspaceDirDto, ProjectSameFolderDto } from '@agent-hangar/shared';

/** 「この PC で再開」で手元の本文の方が小さいときの 409。UI は確認ダイアログにする。 */
export class ApiConflictError extends Error {
  constructor(public readonly body: ResumeHereConflictDto) { super('local_smaller'); this.name = 'ApiConflictError'; }
}

/** 再開を、終わった扱いの run の claude（pid）が動き続けていることで断った（409）。UI は止めて再開するかを聞く確認にする。 */
export class StrayProcessApiError extends Error {
  constructor(public readonly body: StrayProcessDto) { super(body.error); this.name = 'StrayProcessApiError'; }
}

/** エディタが見つからなかった（409）。UI は「<名前> が見つかりません」の面を出す。 */
export class EditorMissingApiError extends Error {
  constructor(public readonly body: EditorMissingDto) { super(body.error); this.name = 'EditorMissingApiError'; }
}

/** 「場所を再指定」で選んだフォルダが、この PC で別のプロジェクトの場所だった（409）。UI はまとめる確認を出す。 */
export class ProjectSameFolderApiError extends Error {
  constructor(public readonly body: ProjectSameFolderDto) { super(body.error); this.name = 'ProjectSameFolderApiError'; }
}

/** 登録しようとしたフォルダが、登録済みのプロジェクトの下だった（409、0.6.1）。UI はその場の 1 行と「別のプロジェクトにする」を出す。 */
export class ProjectNestedApiError extends Error {
  constructor(public readonly body: ProjectNestedDto) { super(body.error); this.name = 'ProjectNestedApiError'; }
}

/** 保持期間の下見の後に、設定ファイルがほかで変わった。UI は下見を取り直す。 */
export class RetentionConflictApiError extends Error {
  constructor() { super('retention_conflict'); this.name = 'RetentionConflictApiError'; }
}

/**
 * 相手が無い（404）。文はサーバの理由のままで、ふつうの失敗と同じく札にできる。
 * 裏の読み直し（開いたままのプロジェクト画面の git）は、これで「画面の外で消えた」と見分ける。
 */
export class ApiNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'ApiNotFoundError'; }
}

/**
 * それ以外の失敗の答え。文はサーバの理由のままで、状態番号を status に持つ。
 * リカバリーキーの確認は、400（末尾の違い）、409（下書きが無い）、502（Worker の失敗）で次の手順が違うので、番号で見分ける。
 */
export class ApiStatusError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/**
 * 本文の読み出しの向き。
 * latest は末尾から（画面を開いたとき）、beforeSeq はその手前へ（過去へ遡るとき）、
 * fromSeq はそこから前向きへ（追記を取り込むとき）。
 */
export type EventsQuery = { agentId: string | null; latest?: boolean; beforeSeq?: number; fromSeq?: number };

/** エディタで開くときの添え。line はファイルの行、once は「今回は <名前> で開く」のエディタ。 */
export type EditorOpenOpts = { line?: number; once?: KnownEditorId };

export type ApiClient = {
  bootstrap(): Promise<BootstrapDto>;
  events(sessionId: string, q: EventsQuery): Promise<EventsPageDto>;
  subagents(sessionId: string): Promise<string[]>;
  /** 実行中のセッションの右ペインに出すライブの要約。 */
  live(sessionId: string): Promise<LiveDigestDto>;
  /** そのセッションが編集系のツールで変えたファイル（索引から。読み込んだ本文の窓には依らない）。冒頭の 1 枚の「変更したファイル」が使う。 */
  sessionFiles(sessionId: string): Promise<SessionFilesDto>;
  /** git の表示（0.5.0）。見えている行のセッションの git（POST /api/git/sessions）。 */
  gitSessions(ids: string[]): Promise<GitDto>;
  /** 「変更したファイル」の差分の一覧（git の状態つき）。 */
  sessionChanges(sessionId: string): Promise<SessionChangesDto>;
  /** 1 つのファイルの作業ツリーとの差。 */
  sessionDiff(sessionId: string, file: string): Promise<GitDiffDto>;
  /** そのファイルへのセッションの編集（トランスクリプトから）。 */
  sessionEdits(sessionId: string, file: string): Promise<SessionEditsDto>;
  /** プロジェクトのブランチと worktree。 */
  projectGit(projectId: string): Promise<ProjectGitDto>;
  search(params: SearchParamsDto): Promise<SearchResultDto>;
  setProjectStatus(id: string, status: ProjectStatus): Promise<ProjectDto>;
  renameProject(id: string, name: string): Promise<ProjectDto>;
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
  /** stray は、残った claude の確認で選んだもの。付けなければ、残っていれば StrayProcessApiError で投げる。 */
  resume(sessionId: string, stray?: ResumeStray): Promise<LaunchResultDto>;
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
  openEditor(sessionId: string, file?: string, opts?: EditorOpenOpts): Promise<void>;
  projectOpenEditor(projectId: string, once?: KnownEditorId): Promise<void>;
  /** この PC で見つけたエディタと、選んでいるエディタの状態（設定のエディタの欄）。 */
  editors(): Promise<EditorsDto>;
  /** 見本のファイルを書いて 3 行目を開く（設定の「テスト」）。 */
  testEditor(): Promise<EditorTestDto>;
  projectOpenTerminal(projectId: string): Promise<{ app: TerminalApp; fellBack: boolean }>;
  createProject(place: ProjectPlace): Promise<ProjectDto>;
  /** 選んだ 1 つのフォルダの事前の問い合わせ（0.6.1）。name を渡すと、弱い一致をその名前で見る。 */
  inspectFolder(path: string, name?: string): Promise<FolderInspectDto>;
  workspaceDirs(): Promise<WorkspaceDirDto[]>;
  /** Claude Code と会話したフォルダの候補（初日のプロジェクト）。 */
  folderCandidates(): Promise<FolderCandidatesDto>;
  /** 「フォルダの中から」の親フォルダの直下（GET /api/workspace/children）。parent の ~ はサーバがホームに直す。 */
  workspaceChildren(parent: string): Promise<WorkspaceChildrenDto>;
  /** まとめて登録する。行ごとに結び付け先（linkTo）と入れ子の明示（allowNested）を持つ。登録できなかったものは failed に理由が入る。 */
  registerFolders(items: FolderRegisterItem[]): Promise<FolderRegisterResultDto>;
  usageAggregate(days: number): Promise<UsageAggregateDto>;
  statusline(): Promise<StatuslineStatusDto>;
  shellHook(): Promise<ShellHookDto>;
  /** 準備の確かめ。設定画面の検証と、ホームの帯の始める前の確認が読む。 */
  readiness(): Promise<ReadinessDto>;
  /** psmux（tmux）を探し直させ、取り直した準備の確かめを受け取る。 */
  recheckMux(): Promise<MuxRecheckDto>;
  /** Claude Code との互換のずれの中身。準備の確かめでずれが 1 件以上あるときに、続けて取る（止めた機能の一覧を常に出すため）。 */
  compat(): Promise<CompatDto>;
  /** opencode の検出（ベータ）。設定の「連携 › opencode」の版の行が読む。設定が切でも答える。 */
  opencodeStatus(): Promise<OpencodeStatusDto>;
  addTodo(projectId: string, text: string): Promise<TodoDto>;
  setTodoDone(id: string, done: boolean): Promise<TodoDto>;
  removeTodo(id: string): Promise<TodoDto>;
  confirmTodo(id: string): Promise<TodoDto>;
  rejectTodo(id: string): Promise<TodoDto>;
  editTodo(id: string, text: string): Promise<TodoDto>;
  acceptTodo(id: string): Promise<TodoDto>;
  reorderTodos(projectId: string, ids: string[]): Promise<TodoDto[]>;
  restoreTodos(rows: TodoDto[]): Promise<TodoDto[]>;
  /** セッションの状態を手で変える。status の null は Active に戻す。返り値は使わない（画面の正は session.upsert）。 */
  setSessionState(id: string, body: { status: SessionStatus | null; note?: string; returnOn?: string; returnTime?: string }): Promise<{ state: SessionStateDto }>;
  /** 提案を確定する。日を変えたときだけ returnOn を渡す。提案が無ければ 409 の一文で投げる。 */
  confirmSessionState(id: string, body: { returnOn?: string; returnTime?: string }): Promise<{ state: SessionStateDto }>;
  rejectSessionState(id: string): Promise<{ state: SessionStateDto }>;
  /** セッションを別のプロジェクトへ移す。移した後のセッションを返す。返り値は使わない（画面の正は session.upsert）。 */
  moveSession(id: string, projectId: string): Promise<SessionDto>;
  /** セッションを消す（本文を OS のゴミ箱へ移す）。実行中なら 409、ゴミ箱へ移せなければ 500 の一文で投げる。 */
  deleteSession(id: string): Promise<{ ok: true }>;
  /** 中断の群の「再開しない」（dismissed が真）と、その取り消し。新しい群を返す。 */
  dismissInterrupted(runIds: string[], dismissed: boolean): Promise<{ interrupted: InterruptedDto | null }>;
  /** 同じファイルの編集の「このファイルでは表示しない」。 */
  dismissOverlap(sessionId: string, other: string, paths: string[]): Promise<void>;
  memo(projectId: string): Promise<MemoDto>;
  saveMemo(projectId: string, markdown: string): Promise<MemoDto>;
  /** プロジェクトの指示とメモリ。あるファイルだけが来る。 */
  instructions(projectId: string): Promise<InstructionsDto>;
  /** 指示とメモリのファイルをエディタで開く。無いファイルは作らず、404 の一文で投げる。 */
  openInstruction(projectId: string, kind: InstructionFileKind, once?: KnownEditorId): Promise<void>;
  /** セットアップのすゝめの写しの場所、版、ハッシュ、貼る一言。 */
  setupGuide(): Promise<SetupGuideDto>;
  /** 写したセットアップのすゝめをエディタで開く。エディタが見つからなければ EditorMissingApiError で投げる。 */
  openSetupGuide(once?: KnownEditorId): Promise<void>;
  addArtifact(projectId: string, url: string): Promise<ArtifactDto>;
  openArtifact(id: string): Promise<void>;
  openArtifactEditor(id: string, once?: KnownEditorId): Promise<void>;
  promote(sessionId: string, body: { name: string; gitInit: boolean; moveFiles: boolean; parent?: string }): Promise<PromoteResultDto>;
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
  /** 「この PC で再開」の確認に出すもの。 */
  resumeHerePlan(sessionId: string): Promise<ResumeHerePlanDto>;
  /** ほかの PC で動く会話の引き継ぎ。start は停止を頼む（force は応答のない相手を頼まずに引き継ぐ）、extend は打ち切りを延ばす、cancel は取り下げる。応答の段は takeover.update と同じ形。 */
  takeoverStart(sessionId: string, force: boolean): Promise<TakeoverDto>;
  takeoverExtend(sessionId: string): Promise<TakeoverDto>;
  takeoverCancel(sessionId: string): Promise<void>;
  /**
   * 参加済みの PC で「PC を追加」（/api/sync/join-codes）。どれも承認の状態（JoinApproverState）を返す。
   * 参加コードの平文を返すのはこの PC の画面のためだけで、同期を設定していなければ 404 で断られる。
   */
  joinCodeCurrent(): Promise<JoinApproverState>;
  joinCodeIssue(): Promise<JoinApproverState>;
  joinCodeApprove(): Promise<JoinApproverState>;
  joinCodeReject(): Promise<JoinApproverState>;
  joinCodeClose(): Promise<JoinApproverState>;
  /**
   * 設定の「リカバリーキーを再発行」（/api/sync/recovery-key）。
   * reissue は新しいリカバリーキーの 4 行と下書きの ID を返し、まだ何も差し替えない。
   * confirm に末尾 4 文字を渡し、合えば名簿と keybox を差し替える。違えば 400、下書きが無ければ 409 で、サーバーの文で投げる。
   */
  recoveryKeyReissue(): Promise<RecoveryKeyDraftDto>;
  recoveryKeyConfirm(draftId: string, tail: string): Promise<void>;
  /** Worker の PC の一覧（参加日、解除日、最後に同期した IP と場所）。解除と参加の口は HTTP に無い（殻の命令だけ）。 */
  cloudDevices(): Promise<CloudDevicesDto>;
  /** スマホを接続する QR。押すたびに新しい券を取る。中身にスマホ用の暗号鍵が入るので、QR と「文字列をコピー」にだけ使う。 */
  mobilePairing(): Promise<MobilePairingDto>;
  /** QR を出している間の見回り。その券で接続し、PC が keybox を置き終えたスマホ。サーバーは Worker に問い合わせない。 */
  mobilePaired(pairId: string): Promise<MobilePairedDto>;
  // 設定の同期（作り直した実装）。同期を組んでいない端末のサーバは 404 を返す。読む経路はどれも ~/.claude に触れず、書くのは hangar の置き場の指示書だけである。
  configSyncState(): Promise<ConfigSyncDto>;
  configOutgoing(): Promise<ConfigOutgoingDto>;
  configInbox(): Promise<ConfigInboxDto>;
  configConflicts(): Promise<ConfigConflictDto[]>;
  configUnsent(): Promise<ConfigUnsentDto>;
  configBackups(): Promise<ConfigBackupsDto>;
  /** 送らなかった項目を、それでも送る。更新後の一覧を返す。 */
  configSendUnsent(id: string): Promise<ConfigUnsentDto>;
  /** 承諾した項目を適用の指示書にする。前の指示書は置き換わる。 */
  configPutOrder(entries: ConfigApplyOrderEntryIn[]): Promise<ConfigApplyOrderDto>;
  configDeleteOrder(): Promise<void>;
  // 会話の保持期間。書き込みは下見の指紋を添え、ほかで変わっていたら 409 で断られる。
  retention(): Promise<RetentionDto>;
  retentionPreview(days: number): Promise<RetentionPreviewDto>;
  writeRetention(days: number, baseSha256: string): Promise<RetentionDto>;
  // Claude Code のアカウント。AccountsDto を返すものは、画面へは accounts.update と同じ道で入れる。
  accounts(): Promise<AccountsDto>;
  setCurrentAccount(id: string): Promise<AccountsDto>;
  /** セッションを別のアカウントで再開する。サーバがいまのアカウントも変える。断る理由は 409 と 400 の一文で投げる。 */
  switchAccount(sessionId: string, accountId: string): Promise<LaunchResultDto>;
  /** dir は画面で打ったままの場所（~/ も可）。null ならサーバが名前から決める。 */
  addAccount(name: string, dir: string | null): Promise<AccountsDto>;
  /** アカウントを足す前の確かめ。何も作らない。 */
  previewAccountDir(name: string, dir: string): Promise<AccountDirPreviewDto>;
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
      if (r.status === 409 && (body as { code?: unknown } | null)?.code === 'editor_missing') throw new EditorMissingApiError(body as unknown as EditorMissingDto);
      if (r.status === 409 && (body as { code?: unknown } | null)?.code === 'project_same_folder') throw new ProjectSameFolderApiError(body as unknown as ProjectSameFolderDto);
      if (r.status === 409 && (body as { code?: unknown } | null)?.code === 'stray_process') throw new StrayProcessApiError(body as unknown as StrayProcessDto);
      if (r.status === 409 && (body as { code?: unknown } | null)?.code === 'project_nested') throw new ProjectNestedApiError(body as unknown as ProjectNestedDto);
      const message = body?.error ?? `${r.status} ${path}`;
      if (r.status === 404) throw new ApiNotFoundError(message);
      throw new ApiStatusError(message, r.status);
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
    gitSessions: (ids) => post('/api/git/sessions', { ids }),
    sessionChanges: (sessionId) => call(`/api/sessions/${sessionId}/changes`),
    sessionDiff: (sessionId, file) => call(`/api/sessions/${sessionId}/diff${qs({ file })}`),
    sessionEdits: (sessionId, file) => call(`/api/sessions/${sessionId}/edits${qs({ file })}`),
    projectGit: (projectId) => call(`/api/projects/${projectId}/git`),
    search: (params) => call(`/api/search${qs(params)}`),
    setProjectStatus: (id, status) => call(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    renameProject: (id, name) => call(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
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
    resume: (sessionId, stray) => post(`/api/sessions/${sessionId}/resume`, stray ? { stray } : undefined),
    fork: (sessionId) => post(`/api/sessions/${sessionId}/fork`),
    attach: (sessionId) => post(`/api/sessions/${sessionId}/attach`),
    adopt: (sessionId) => post(`/api/sessions/${sessionId}/adopt`),
    killRun: (runId) => call(`/api/runs/${runId}`, { method: 'DELETE' }),
    openTab: (runId) => post(`/api/runs/${runId}/tabs`),
    closeTab: (runId, tabId) => call(`/api/runs/${runId}/tabs/${tabId}`, { method: 'DELETE' }),
    openTerminalApp: (runId, tabId) => post(`/api/runs/${runId}/open-terminal`, tabId ? { tabId } : {}),
    jumpToPrompt: (runId, body) => post(`/api/runs/${runId}/jump`, body),
    leaveTranscript: (runId) => post(`/api/runs/${runId}/leave-transcript`),
    openEditor: (sessionId, file, opts) => post(`/api/sessions/${sessionId}/open-editor`, file === undefined && !opts?.once ? undefined : { ...(file !== undefined ? { file } : {}), ...(opts?.line !== undefined ? { line: opts.line } : {}), ...(opts?.once ? { once: opts.once } : {}) }),
    projectOpenEditor: (projectId, once) => post(`/api/projects/${projectId}/open-editor`, once ? { once } : undefined),
    editors: () => call('/api/editors'),
    testEditor: () => post('/api/editor/test'),
    projectOpenTerminal: (projectId) => post(`/api/projects/${projectId}/open-terminal`),
    createProject: (place) => post('/api/projects', place),
    inspectFolder: (path, name) => call(`/api/workspace/inspect${qs({ path, name })}`),
    workspaceDirs: () => call('/api/workspace/dirs'),
    folderCandidates: () => call('/api/workspace/candidates'),
    workspaceChildren: (parent) => call(`/api/workspace/children${qs({ parent })}`),
    registerFolders: (items) => post('/api/workspace/register', { items }),
    usageAggregate: (days) => call(`/api/usage/aggregate${qs({ days })}`),
    statusline: () => call('/api/statusline'),
    shellHook: () => call('/api/shell-hook'),
    readiness: () => call('/api/readiness'),
    recheckMux: () => post('/api/readiness/mux'),
    compat: () => call('/api/compat'),
    opencodeStatus: () => call('/api/opencode/status'),
    addTodo: (projectId, text) => post(`/api/projects/${projectId}/todos`, { text }),
    setTodoDone: (id, done) => call(`/api/todos/${id}`, { method: 'PATCH', body: JSON.stringify({ done }) }),
    removeTodo: (id) => call(`/api/todos/${id}`, { method: 'DELETE' }),
    confirmTodo: (id) => post(`/api/todos/${id}/confirm`),
    rejectTodo: (id) => post(`/api/todos/${id}/reject`),
    editTodo: (id, text) => call(`/api/todos/${id}`, { method: 'PATCH', body: JSON.stringify({ text }) }),
    acceptTodo: (id) => post(`/api/todos/${id}/accept`),
    reorderTodos: (projectId, ids) => post(`/api/projects/${projectId}/todos/order`, { ids }),
    restoreTodos: (rows) => post('/api/todos/restore', { todos: rows }),
    setSessionState: (id, body) => call(`/api/sessions/${id}/state`, { method: 'PUT', body: JSON.stringify(body) }),
    confirmSessionState: (id, body) => post(`/api/sessions/${id}/state/confirm`, body),
    rejectSessionState: (id) => post(`/api/sessions/${id}/state/reject`),
    moveSession: (id, projectId) => call(`/api/sessions/${id}/project`, { method: 'PUT', body: JSON.stringify({ projectId }) }),
    deleteSession: (id) => call(`/api/sessions/${id}`, { method: 'DELETE' }),
    dismissInterrupted: (runIds, dismissed) => post('/api/interrupted/dismiss', { runIds, dismissed }),
    dismissOverlap: (sessionId, other, paths) => post(`/api/sessions/${sessionId}/overlap/dismiss`, { with: other, paths }),
    memo: (projectId) => call(`/api/projects/${projectId}/memo`),
    saveMemo: (projectId, markdown) => call(`/api/projects/${projectId}/memo`, { method: 'PUT', body: JSON.stringify({ markdown }) }),
    instructions: (projectId) => call(`/api/projects/${projectId}/instructions`),
    openInstruction: (projectId, kind, once) => post(`/api/projects/${projectId}/instructions/open`, { kind, ...(once ? { once } : {}) }),
    setupGuide: () => call('/api/setup-guide'),
    openSetupGuide: (once) => post('/api/setup-guide/open', once ? { once } : undefined),
    addArtifact: (projectId, url) => post(`/api/projects/${projectId}/artifacts`, { url }),
    openArtifact: (id) => post(`/api/artifacts/${id}/open`),
    openArtifactEditor: (id, once) => post(`/api/artifacts/${id}/open-editor`, once ? { once } : undefined),
    promote: (sessionId, body) => post(`/api/sessions/${sessionId}/promote`, body),
    regenerateSummary: (sessionId) => post(`/api/sessions/${sessionId}/summarize`),
    summarizerModels: () => call('/api/summarizer/models'),
    testSummarizer: () => post('/api/summarizer/test'),
    syncUsage: (refresh) => call(refresh ? '/api/sync/usage?refresh=1' : '/api/sync/usage'),
    syncNow: () => post('/api/sync/now'),
    syncPause: (paused) => post('/api/sync/pause', { paused }),
    syncFocus: () => post('/api/sync/focus'),
    resumeHere: (sessionId, overwrite) => post(`/api/sessions/${sessionId}/resume-here`, { overwrite }),
    resumeHerePlan: (sessionId) => call(`/api/sessions/${sessionId}/resume-here`),
    takeoverStart: (sessionId, force) => post(`/api/sessions/${sessionId}/takeover`, { force }),
    takeoverExtend: (sessionId) => post(`/api/sessions/${sessionId}/takeover/extend`),
    takeoverCancel: (sessionId) => call(`/api/sessions/${sessionId}/takeover`, { method: 'DELETE' }),
    joinCodeCurrent: () => call('/api/sync/join-codes/current'),
    joinCodeIssue: () => post('/api/sync/join-codes'),
    joinCodeApprove: () => post('/api/sync/join-codes/current/approve'),
    joinCodeReject: () => post('/api/sync/join-codes/current/reject'),
    joinCodeClose: () => call('/api/sync/join-codes/current', { method: 'DELETE' }),
    recoveryKeyReissue: () => post('/api/sync/recovery-key/reissue'),
    recoveryKeyConfirm: async (draftId, tail) => { await post('/api/sync/recovery-key/confirm', { draftId, tail }); },
    cloudDevices: () => call('/api/sync/cloud-devices'),
    mobilePairing: () => post('/api/sync/mobile-pairing'),
    mobilePaired: (pairId) => call(`/api/sync/mobile-pairing/${encodeURIComponent(pairId)}`),
    configSyncState: () => call('/api/config-sync'),
    configOutgoing: () => call('/api/config-sync/outgoing'),
    configInbox: () => call('/api/config-sync/inbox'),
    configConflicts: () => call('/api/config-sync/conflicts'),
    configUnsent: () => call('/api/config-sync/unsent'),
    configBackups: () => call('/api/config-sync/backups'),
    configSendUnsent: (id) => post(`/api/config-sync/unsent/${encodeURIComponent(id)}/send`),
    configPutOrder: (items) => call('/api/config-sync/apply-order', { method: 'PUT', body: JSON.stringify({ items }) }),
    configDeleteOrder: () => call('/api/config-sync/apply-order', { method: 'DELETE' }),
    retention: () => call('/api/retention'),
    retentionPreview: (days) => post('/api/retention/preview', { days }),
    writeRetention: (days, baseSha256) => call('/api/retention', { method: 'PUT', body: JSON.stringify({ days, baseSha256 }) }),
    accounts: () => call('/api/accounts'),
    setCurrentAccount: (id) => call('/api/accounts/current', { method: 'PUT', body: JSON.stringify({ id }) }),
    switchAccount: (sessionId, accountId) => post(`/api/sessions/${sessionId}/switch-account`, { account: accountId }),
    addAccount: (name, dir) => post('/api/accounts', dir === null ? { name } : { name, dir }),
    previewAccountDir: (name, dir) => call(`/api/accounts/preview?${new URLSearchParams({ name, dir }).toString()}`),
    updateAccount: (id, patch) => call(`/api/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    removeAccount: (id) => call(`/api/accounts/${id}`, { method: 'DELETE' }),
    loginAccount: (id) => post(`/api/accounts/${id}/login`),
    cancelAccountLogin: (id) => post(`/api/accounts/${id}/login/cancel`),
    refreshAccount: (id) => post(`/api/accounts/${id}/refresh`),
  };
}
