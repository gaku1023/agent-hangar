import type { ArtifactDto, BootstrapDto, EventsPageDto, LaunchParams, LaunchResultDto, MemoDto, ProjectDto, ProjectStatus, PromoteResultDto, ResolveAction, RunDto, SearchParamsDto, SearchResultDto, SessionDto, SettingsDto, StatuslineStatusDto, SummarizerTestDto, TabDto, TerminalApp, TodoDto, UsageAggregateDto, UsageDto } from '@agent-hangar/shared';

export type ApiClient = {
  bootstrap(): Promise<BootstrapDto>;
  events(sessionId: string, fromSeq: number, agentId: string | null): Promise<EventsPageDto>;
  subagents(sessionId: string): Promise<string[]>;
  search(params: SearchParamsDto): Promise<SearchResultDto>;
  setProjectStatus(id: string, status: ProjectStatus): Promise<ProjectDto>;
  resolveProject(id: string, action: ResolveAction): Promise<unknown>;
  candidates(id: string, name: string): Promise<string[]>;
  updateSettings(patch: Partial<SettingsDto>): Promise<SettingsDto>;
  rebuildIndex(): Promise<void>;
  launch(params: LaunchParams): Promise<LaunchResultDto>;
  resume(sessionId: string): Promise<LaunchResultDto>;
  fork(sessionId: string): Promise<LaunchResultDto>;
  killRun(runId: string): Promise<RunDto>;
  openTab(runId: string): Promise<TabDto>;
  closeTab(runId: string, tabId: string): Promise<TabDto>;
  openTerminalApp(runId: string, tabId: string | null): Promise<{ app: TerminalApp; fellBack: boolean }>;
  openEditor(sessionId: string): Promise<void>;
  projectOpenEditor(projectId: string): Promise<void>;
  projectOpenTerminal(projectId: string): Promise<{ app: TerminalApp; fellBack: boolean }>;
  createProject(name: string, path: string): Promise<ProjectDto>;
  usage(): Promise<UsageDto>;
  usageAggregate(days: number): Promise<UsageAggregateDto>;
  statusline(): Promise<StatuslineStatusDto>;
  addTodo(projectId: string, text: string): Promise<TodoDto>;
  setTodoDone(id: string, done: boolean): Promise<TodoDto>;
  removeTodo(id: string): Promise<TodoDto>;
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
};

/** 相対 URL の `/api/...` を叩く薄いクライアント。
 * 失敗はサーバの `{ error }` を、無ければ `${status} ${path}` を Error にする。
 */
export function createApi(fetchFn: typeof fetch = (...a) => fetch(...a)): ApiClient {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const r = await fetchFn(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
    if (!r.ok) {
      // サーバが { error } を返せばその理由を、無ければ状態番号と経路を投げる。
      const body = (await r.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `${r.status} ${path}`);
    }
    if (r.status === 202 || r.status === 204) return undefined as T;
    return (await r.json()) as T;
  }
  const qs = (o: Record<string, unknown>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v)); const s = p.toString(); return s ? `?${s}` : ''; };
  const post = <T>(path: string, body?: unknown) => call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
  return {
    bootstrap: () => call('/api/bootstrap'),
    events: (sessionId, fromSeq, agentId) => call(`/api/sessions/${sessionId}/events${qs({ fromSeq, agentId })}`),
    subagents: (sessionId) => call(`/api/sessions/${sessionId}/subagents`),
    search: (params) => call(`/api/search${qs(params)}`),
    setProjectStatus: (id, status) => call(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    resolveProject: (id, action) => call(`/api/projects/${id}/resolve`, { method: 'POST', body: JSON.stringify(action) }),
    candidates: (id, name) => call(`/api/projects/${id}/candidates${qs({ name })}`),
    updateSettings: (patch) => call('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
    rebuildIndex: () => post('/api/index/rebuild'),
    launch: (params) => post('/api/runs', params),
    resume: (sessionId) => post(`/api/sessions/${sessionId}/resume`),
    fork: (sessionId) => post(`/api/sessions/${sessionId}/fork`),
    killRun: (runId) => call(`/api/runs/${runId}`, { method: 'DELETE' }),
    openTab: (runId) => post(`/api/runs/${runId}/tabs`),
    closeTab: (runId, tabId) => call(`/api/runs/${runId}/tabs/${tabId}`, { method: 'DELETE' }),
    openTerminalApp: (runId, tabId) => post(`/api/runs/${runId}/open-terminal`, tabId ? { tabId } : {}),
    openEditor: (sessionId) => post(`/api/sessions/${sessionId}/open-editor`),
    projectOpenEditor: (projectId) => post(`/api/projects/${projectId}/open-editor`),
    projectOpenTerminal: (projectId) => post(`/api/projects/${projectId}/open-terminal`),
    createProject: (name, path) => post('/api/projects', { name, path }),
    usage: () => call('/api/usage'),
    usageAggregate: (days) => call(`/api/usage/aggregate${qs({ days })}`),
    statusline: () => call('/api/statusline'),
    addTodo: (projectId, text) => post(`/api/projects/${projectId}/todos`, { text }),
    setTodoDone: (id, done) => call(`/api/todos/${id}`, { method: 'PATCH', body: JSON.stringify({ done }) }),
    removeTodo: (id) => call(`/api/todos/${id}`, { method: 'DELETE' }),
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
  };
}
