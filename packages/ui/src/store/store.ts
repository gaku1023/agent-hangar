import type { BootstrapDto, EventsPageDto, IndexProgressDto, LaunchResultDto, LiveSessionDto, ProjectDto, RunDto, SearchParamsDto, SearchResultDto, ServerEvent, SessionDto, SettingsDto, TabDto, TranscriptEvent } from '@agent-hangar/shared';

export type EventsSlice = { items: TranscriptEvent[]; total: number; nextSeq: number | null; loading: boolean };
export type Store = {
  bootstrapped: boolean; version: string; device: { id: string; name: string } | null; settings: SettingsDto | null;
  projects: Record<string, ProjectDto>; sessions: Record<string, SessionDto>; live: LiveSessionDto[];
  runs: Record<string, RunDto>; tabs: Record<string, TabDto>;
  events: Record<string, EventsSlice>; subagents: Record<string, string[]>;
  search: { params: SearchParamsDto | null; result: SearchResultDto | null; loading: boolean };
  index: IndexProgressDto;
};

export const eventsKey = (sessionId: string, agentId: string | null): string => `${sessionId}:${agentId ?? ''}`;

export function initialStore(): Store {
  return { bootstrapped: false, version: '', device: null, settings: null, projects: {}, sessions: {}, live: [], runs: {}, tabs: {}, events: {}, subagents: {}, search: { params: null, result: null, loading: false }, index: { phase: 'idle', done: 0, total: 0 } };
}

const byId = <T extends { id: string }>(items: T[]): Record<string, T> => Object.fromEntries(items.map((i) => [i.id, i]));

/** bootstrap を入れる。
 * runs と tabs だけは差し替えずに混ぜる。
 * サーバが返すのは生きた run と開いたシェルタブが残る run だけなので、
 * 差し替えると、終了した run のスクロールバックを見ている最中に画面が変わってしまう。
 */
export function applyBootstrap(store: Store, b: BootstrapDto): Store {
  return { ...store, bootstrapped: true, version: b.version, device: b.device, settings: b.settings, projects: byId(b.projects), sessions: byId(b.sessions), live: b.live, runs: { ...store.runs, ...byId(b.runs) }, tabs: { ...store.tabs, ...byId(b.tabs) }, index: b.index };
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
