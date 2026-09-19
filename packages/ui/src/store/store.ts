import type { ArtifactDto, BootstrapDto, ConfigPreviewDto, DeviceDto, EventsPageDto, IndexProgressDto, LaunchResultDto, LiveSessionDto, MemoDto, ProjectDto, RunDto, SearchParamsDto, SearchResultDto, ServerEvent, SessionDto, SettingsDto, StatuslineStatusDto, SummarizerTestDto, SyncStatusDto, TabDto, TodoDto, TranscriptEvent, UsageAggregateDto, UsageDto } from '@agent-hangar/shared';

export type EventsSlice = { items: TranscriptEvent[]; total: number; nextSeq: number | null; loading: boolean };
export type Store = {
  bootstrapped: boolean; version: string; device: { id: string; name: string } | null; settings: SettingsDto | null;
  projects: Record<string, ProjectDto>; sessions: Record<string, SessionDto>; live: LiveSessionDto[];
  runs: Record<string, RunDto>; tabs: Record<string, TabDto>;
  events: Record<string, EventsSlice>; subagents: Record<string, string[]>;
  search: { params: SearchParamsDto | null; result: SearchResultDto | null; loading: boolean };
  index: IndexProgressDto;
  usage: UsageDto; todos: Record<string, TodoDto>; memos: Record<string, MemoDto>; artifacts: Record<string, ArtifactDto>;
  summaryPending: Record<string, true>;
  // 設定画面に入ったときだけ読む値。
  // 未取得は null で、View は「読み込んでいます」を出す。
  usageAggregate: UsageAggregateDto | null; statusline: StatuslineStatusDto | null; summarizerModels: string[] | null; summarizerTest: SummarizerTestDto | null;
  // クラウド同期（フェーズ 4）。同期を設定していない間は sync が off のまま届く。
  // joinToken と configPreview は押したときだけ取りに行く値なので、未取得は null である。
  sync: SyncStatusDto | null; devices: DeviceDto[]; joinToken: string | null; configPreview: ConfigPreviewDto | null;
};

export const emptyUsage = (): UsageDto => ({ fiveHour: null, sevenDay: null, updatedAt: null });

export const eventsKey = (sessionId: string, agentId: string | null): string => `${sessionId}:${agentId ?? ''}`;

export function initialStore(): Store {
  return {
    bootstrapped: false, version: '', device: null, settings: null, projects: {}, sessions: {}, live: [], runs: {}, tabs: {}, events: {}, subagents: {},
    search: { params: null, result: null, loading: false }, index: { phase: 'idle', done: 0, total: 0 },
    usage: emptyUsage(), todos: {}, memos: {}, artifacts: {}, summaryPending: {},
    usageAggregate: null, statusline: null, summarizerModels: null, summarizerTest: null,
    sync: null, devices: [], joinToken: null, configPreview: null,
  };
}

const byId = <T extends { id: string }>(items: T[]): Record<string, T> => Object.fromEntries(items.map((i) => [i.id, i]));

/** bootstrap を入れる。
 * runs と tabs だけは差し替えずに混ぜる。
 * サーバが返すのは生きた run と開いたシェルタブが残る run だけなので、
 * 差し替えると、終了した run のスクロールバックを見ている最中に画面が変わってしまう。
 */
export function applyBootstrap(store: Store, b: BootstrapDto): Store {
  // フェーズ 3 で増えた項目は、それより古いサーバには無い。
  // 型の上では必ずあるので、欠けていたときだけ既定値で埋める。
  // 版が古いことは画面には出さない。
  const old = b as Partial<BootstrapDto>;
  return { ...store, bootstrapped: true, version: b.version, device: b.device, settings: b.settings, projects: byId(b.projects), sessions: byId(b.sessions), live: b.live, runs: { ...store.runs, ...byId(b.runs) }, tabs: { ...store.tabs, ...byId(b.tabs) }, index: b.index, usage: old.usage ?? emptyUsage(), todos: byId(old.todos ?? []), artifacts: byId(old.artifacts ?? []), summaryPending: Object.fromEntries((old.summaryPending ?? []).map((id) => [id, true as const])), sync: b.sync ?? null, devices: b.devices ?? [] };
}

function relive(sessions: Record<string, SessionDto>, live: LiveSessionDto[]): Record<string, SessionDto> {
  const map = new Map(live.map((l) => [l.sessionId, l]));
  const out: Record<string, SessionDto> = {};
  for (const [id, s] of Object.entries(sessions)) {
    const l = map.get(s.providerSessionId);
    const status = l?.status ?? null;
    const name = l?.nameSource === 'user' && l.name ? l.name : s.name;
    out[id] = status === s.live && name === s.name ? s : { ...s, live: status, name };
  }
  return out;
}

export function applyServerEvent(store: Store, ev: ServerEvent): Store {
  switch (ev.type) {
    case 'ready': return { ...store, version: ev.version };
    case 'project.upsert': return { ...store, projects: { ...store.projects, [ev.project.id]: ev.project } };
    case 'session.upsert': return { ...store, sessions: { ...store.sessions, [ev.session.id]: ev.session } };
    case 'live.update': return { ...store, live: ev.live, sessions: relive(store.sessions, ev.live) };
    case 'index.progress': return { ...store, index: ev.progress };
    case 'run.started': return applyLaunch(store, { run: ev.run, sessionId: ev.run.sessionId, tabs: ev.tabs });
    case 'run.upsert': case 'run.ended': return { ...store, runs: { ...store.runs, [ev.run.id]: ev.run } };
    case 'tab.upsert': return { ...store, tabs: { ...store.tabs, [ev.tab.id]: ev.tab } };
    case 'transcript.appended': {
      const out = { ...store.events };
      let touched = false;
      for (const [k, v] of Object.entries(store.events)) if (k.startsWith(ev.sessionId + ':')) { out[k] = { ...v, total: v.total + ev.count }; touched = true; }
      return touched ? { ...store, events: out } : store;
    }
    case 'usage.update': return { ...store, usage: ev.usage };
    case 'todos.update': {
      // そのプロジェクトの TODO を一覧で置き換える。
      // 消えた項目は落ちる。
      const todos: Record<string, TodoDto> = {};
      for (const [id, t] of Object.entries(store.todos)) if (t.projectId !== ev.projectId) todos[id] = t;
      for (const t of ev.todos) todos[t.id] = t;
      return { ...store, todos };
    }
    case 'memo.update': return { ...store, memos: { ...store.memos, [ev.memo.projectId]: ev.memo } };
    case 'artifact.upsert': return { ...store, artifacts: { ...store.artifacts, [ev.artifact.id]: ev.artifact } };
    case 'sync.status': return { ...store, sync: ev.status };
    case 'devices.update': return { ...store, devices: ev.devices };
    case 'summary.pending': return { ...store, summaryPending: { ...store.summaryPending, [ev.sessionId]: true } };
    case 'summary.updated': case 'summary.failed': {
      // 本文の差し替えは session.upsert が行う。
      // ここは待ちの印を消すだけである。
      if (!store.summaryPending[ev.sessionId]) return store;
      const { [ev.sessionId]: _drop, ...rest } = store.summaryPending;
      return { ...store, summaryPending: rest };
    }
    default: return store;
  }
}

export function setEventsLoading(store: Store, key: string, loading: boolean): Store {
  const cur = store.events[key] ?? { items: [], total: 0, nextSeq: null, loading: false };
  return { ...store, events: { ...store.events, [key]: { ...cur, loading } } };
}

export function applyEventsPage(store: Store, key: string, page: EventsPageDto, append: boolean): Store {
  const cur = store.events[key];
  const base = append && cur ? cur.items : [];
  const seen = new Set(base.map((e) => e.seq));
  const items = [...base, ...page.events.filter((e) => !seen.has(e.seq))];
  return { ...store, events: { ...store.events, [key]: { items, total: page.total, nextSeq: page.nextSeq, loading: false } } };
}

export function applySearch(store: Store, params: SearchParamsDto, result: SearchResultDto | null, loading: boolean): Store {
  return { ...store, search: { params, result, loading } };
}

export function applySubagents(store: Store, sessionId: string, ids: string[]): Store {
  return { ...store, subagents: { ...store.subagents, [sessionId]: ids } };
}

/** 起動の結果を入れる。
 * run.started と同じ扱いにする。
 */
export function applyLaunch(store: Store, r: LaunchResultDto): Store {
  return { ...store, runs: { ...store.runs, [r.run.id]: r.run }, tabs: { ...store.tabs, ...byId(r.tabs) } };
}

const newest = (runs: RunDto[]): RunDto | null => runs.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;

/** そのセッションの run を 1 つでも知っているか。
 * WebSocket の session.upsert より先に HTTP の起動の応答が返るので、これで「読み込んでいます」を出し分ける。
 */
export function hasRunOf(store: Store, sessionId: string): boolean {
  return Object.values(store.runs).some((r) => r.sessionId === sessionId);
}

/** 終わっていない run があるセッションの id。 */
export function runningSessionIds(store: Store): Set<string> {
  return new Set(Object.values(store.runs).filter((r) => r.endedAt === null).map((r) => r.sessionId));
}

/** 終わっていない最新の run。 */
export function aliveRunOf(store: Store, sessionId: string): RunDto | null {
  return newest(Object.values(store.runs).filter((r) => r.sessionId === sessionId && r.endedAt === null));
}

/** 生きた run があればそれ。
 * 無ければ、開いたシェルタブが残っている最新の run。
 */
export function currentRunOf(store: Store, sessionId: string): RunDto | null {
  const alive = aliveRunOf(store, sessionId);
  if (alive) return alive;
  const withTabs = Object.values(store.runs).filter((r) => r.sessionId === sessionId && tabsOf(store, r.id).some((t) => t.kind === 'shell'));
  return newest(withTabs);
}

/** 閉じていないタブ。
 * agent を先頭に、あとは createdAt の順。
 */
export function tabsOf(store: Store, runId: string): TabDto[] {
  return Object.values(store.tabs).filter((t) => t.runId === runId && t.closedAt === null).sort((a, b) => (a.kind === b.kind ? a.createdAt - b.createdAt : a.kind === 'agent' ? -1 : 1));
}

/** 参照されなくなった run とそのタブを落とす。
 * applyBootstrap が runs と tabs を混ぜるので、放っておくと終わった run と閉じたタブが溜まり続ける。
 * 残すのは、終わっていない run、開いたシェルタブが残る run（currentRunOf が拾う）、
 * それと keepSessionIds のセッションの run である。
 * 残す条件は currentRunOf と同じ述語にする。
 * agent タブはサーバが run から合成していて closedAt が常に null なので、
 * 「開いたタブがあるか」で見ると、どの run も落ちなくなる。
 * 落とす run の agent タブは、run が終わったときに接続を切ってあるので、一緒に落としてよい。
 */
export function pruneRuns(store: Store, keepSessionIds: Iterable<string>): Store {
  const keep = new Set(keepSessionIds);
  const drop = new Set<string>();
  for (const r of Object.values(store.runs)) {
    if (r.endedAt === null || keep.has(r.sessionId) || tabsOf(store, r.id).some((t) => t.kind === 'shell')) continue;
    drop.add(r.id);
  }
  if (drop.size === 0) return store;
  return {
    ...store,
    runs: Object.fromEntries(Object.entries(store.runs).filter(([id]) => !drop.has(id))),
    tabs: Object.fromEntries(Object.entries(store.tabs).filter(([, t]) => !drop.has(t.runId))),
  };
}

/** 開いていないセッションのトランスクリプトを落とす。
 * events はセッションと（サブエージェントごとの）ページを溜めるだけで、放っておくと際限なく伸びる。
 * 落とすのは古い側ではなく、開いていないセッションのぶんである。
 * セッション画面に入るたびに fromSeq 0 から読み直す（applyEventsPage の append が false）ので、
 * 開いていないセッションの分は、戻れば必ず取り直される。
 * 「もっと読む」で遡ったページは、そのセッションを開いている限り残る。
 */
export function pruneEvents(store: Store, keepSessionIds: Iterable<string>): Store {
  const keep = new Set(keepSessionIds);
  const entries = Object.entries(store.events).filter(([k]) => [...keep].some((id) => k.startsWith(id + ':')));
  if (entries.length === Object.keys(store.events).length) return store;
  return { ...store, events: Object.fromEntries(entries) };
}

/** プロジェクトの TODO を position の昇順で返す。
 * 完了した項目も同じ並びに残す。
 */
export function todosOf(store: Store, projectId: string): TodoDto[] {
  return Object.values(store.todos).filter((t) => t.projectId === projectId).sort((a, b) => a.position - b.position);
}

/** アーティファクトを最終公開の新しい順で返す。
 * projectId と sessionId は与えられたものだけで絞る。
 * 最終公開が同じものは id の昇順にして、届いた順で並びが変わらないようにする。
 */
export function artifactsOf(store: Store, opts: { projectId?: string; sessionId?: string }): ArtifactDto[] {
  return Object.values(store.artifacts)
    .filter((a) => (opts.projectId === undefined || a.projectId === opts.projectId) && (opts.sessionId === undefined || a.sessionIds.includes(opts.sessionId)))
    .sort((a, b) => b.lastPublishedAt - a.lastPublishedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 参加トークンを入れる。押して見せたあとに null で伏せ直せる。 */
export function applyJoinToken(store: Store, token: string | null): Store { return { ...store, joinToken: token }; }

/** Claude Code の設定の下見を入れる。閉じるときに null で捨てる。 */
export function applyConfigPreview(store: Store, preview: ConfigPreviewDto | null): Store { return { ...store, configPreview: preview }; }
