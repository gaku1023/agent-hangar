import { liveFilterOf, type LiveFilter } from '@agent-hangar/shared';
import type { AccountDto, AccountsDto, ArtifactDto, BootstrapDto, CloudUsageDto, ConfigPreviewDto, RetentionDto, RetentionPreviewDto, DeviceDto, EventsPageDto, IndexProgressDto, LaunchResultDto, LiveDigestDto, LiveSessionDto, LiveStatus, MemoDto, ProjectDto, RunDto, SearchParamsDto, SearchResultDto, ServerEvent, ReadinessDto, SessionDto, SettingsDto, ShellHookDto, StatuslineStatusDto, SummarizerTestDto, SyncDetailDto, SyncStatusBody, TabDto, TodoDto, TranscriptEvent, UsageAggregateDto, UsageDto } from '@agent-hangar/shared';

/**
 * 本文の読み込んだ分。
 * nextSeq は、持っている分より新しい行がまだあるときの、次に前向きに読む seq（最新の側まで持っていれば null）。
 * 検索の結果から真ん中の頁だけを読んで開いたときに、後ろを読み足すのに使う。
 * olderDone は、過去へ遡って空の頁が返った（もう古い行が無い）ことを表す。
 */
export type EventsSlice = { items: TranscriptEvent[]; total: number; nextSeq: number | null; loading: boolean; olderDone?: boolean };
export type Store = {
  bootstrapped: boolean; version: string; device: { id: string; name: string } | null; settings: SettingsDto | null;
  projects: Record<string, ProjectDto>; sessions: Record<string, SessionDto>; live: LiveSessionDto[];
  runs: Record<string, RunDto>; tabs: Record<string, TabDto>;
  events: Record<string, EventsSlice>; subagents: Record<string, string[]>;
  /** 実行中のセッションの右ペインに出すライブの要約。実行中に開いたセッションの分が溜まる（今開いているものだけではない）。 */
  liveDigests: Record<string, LiveDigestDto>;
  search: { params: SearchParamsDto | null; result: SearchResultDto | null; loading: boolean };
  index: IndexProgressDto;
  usage: UsageDto; todos: Record<string, TodoDto>; memos: Record<string, MemoDto>; artifacts: Record<string, ArtifactDto>;
  summaryPending: Record<string, true>;
  // 設定画面に入ったときだけ読む値。
  // 未取得は null で、View は「読み込んでいます」を出す。
  usageAggregate: UsageAggregateDto | null; statusline: StatuslineStatusDto | null; shellHook: ShellHookDto | null; summarizerModels: string[] | null; summarizerTest: SummarizerTestDto | null;
  // クラウド同期（フェーズ 4）。同期を設定していない間は sync が off のまま届く。
  // joinToken と configPreview は押したときだけ取りに行く値なので、未取得は null である。
  // 設定の「使用量と費用」。未取得は null である。
  cloudUsage: CloudUsageDto | null;
  sync: SyncStatusBody | null; devices: DeviceDto[]; joinToken: string | null; configPreview: ConfigPreviewDto | null;
  // Claude Code の会話の保持期間。下見は確認を開いたときだけ取りに行く値なので、未取得は null である。
  retention: RetentionDto | null; retentionPreview: RetentionPreviewDto | null;
  // 準備の確かめ。設定画面と空のホームで取りに行く値なので、未取得は null である。
  readiness: ReadinessDto | null;
  // 参加トークンが消える時刻。画面が残りの秒数を数える。
  joinTokenExpiresAt: number | null;
  // デスクトップの殻の中で動いているか。殻があれば、ログを開くと再起動を殻に頼める。
  desktop: boolean;
  // Claude Code のアカウント（この PC の中だけにある）。未取得、またはサーバが知らせない間は null である。
  accounts: AccountsDto | null;
};

export const emptyUsage = (): UsageDto => ({ fiveHour: null, sevenDay: null, updatedAt: null });

export const eventsKey = (sessionId: string, agentId: string | null): string => `${sessionId}:${agentId ?? ''}`;

export function initialStore(): Store {
  return {
    bootstrapped: false, version: '', device: null, settings: null, projects: {}, sessions: {}, live: [], runs: {}, tabs: {}, events: {}, subagents: {}, liveDigests: {},
    search: { params: null, result: null, loading: false }, index: { phase: 'idle', done: 0, total: 0 },
    usage: emptyUsage(), todos: {}, memos: {}, artifacts: {}, summaryPending: {},
    usageAggregate: null, statusline: null, shellHook: null, summarizerModels: null, summarizerTest: null,
    cloudUsage: null, sync: null, devices: [], joinToken: null, configPreview: null,
    retention: null, retentionPreview: null,
    readiness: null, joinTokenExpiresAt: null, desktop: false, accounts: null,
  };
}

const byId = <T extends { id: string }>(items: T[]): Record<string, T> => Object.fromEntries(items.map((i) => [i.id, i]));

/**
 * 同期の状態を入れ替える。
 * 付録（送れなかった本文と取り残しの件数）は、HTTP の応答も websocket の通知も運ぶ。
 * これより古いサーバの通知にだけ載っていないので、そのときは「分からない」に寄せる。
 * 直前の値は引き継がない。
 * 引き継ぐと、片付いた取り残しと回復した失敗が、画面に出たまま固まってしまう。
 * 件数を出す目的は「進んでいるのか止まっているのか」を読ませることなので、
 * 古い数字を残すのは、何も出さないより悪い。
 */
export function applySyncStatus(next: SyncStatusBody): SyncStatusBody {
  const d = next as Partial<SyncDetailDto>;
  return { ...next, skipped: d.skipped ?? [], sweepPending: d.sweepPending ?? null };
}

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
  return { ...store, bootstrapped: true, version: b.version, device: b.device, settings: b.settings, projects: byId(b.projects), sessions: byId(b.sessions), live: b.live, runs: { ...store.runs, ...byId(b.runs) }, tabs: { ...store.tabs, ...byId(b.tabs) }, index: b.index, usage: old.usage ?? emptyUsage(), todos: byId(old.todos ?? []), artifacts: byId(old.artifacts ?? []), summaryPending: Object.fromEntries((old.summaryPending ?? []).map((id) => [id, true as const])), sync: b.sync ? applySyncStatus(b.sync) : null, devices: b.devices ?? [], retention: old.retention ?? null, cloudUsage: b.cloudUsage ?? null, accounts: b.accounts ?? null };
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
    case 'sync.status': return { ...store, sync: applySyncStatus(ev.status) };
    case 'accounts.update': return { ...store, accounts: ev.accounts };
    case 'sync.usage': return { ...store, cloudUsage: ev.usage };
    case 'devices.update': return { ...store, devices: ev.devices };
    case 'retention.changed': return { ...store, retention: ev.retention };
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

export const accountList = (store: Store): AccountDto[] => store.accounts?.accounts ?? [];

const primaryAccount = (list: AccountDto[]): AccountDto | null => list.find((a) => a.primary) ?? null;

/** いまのアカウント。currentId が一覧に無ければ最初のアカウント。一覧が空なら null。 */
export function currentAccount(store: Store): AccountDto | null {
  const list = accountList(store);
  return list.find((a) => a.id === store.accounts?.currentId) ?? primaryAccount(list);
}

/** そのセッションを最後に動かしたアカウント。対応に無い、または一覧に無い id なら最初のアカウント。一覧が空なら null。 */
export function accountOfSession(store: Store, sessionId: string): AccountDto | null {
  const list = accountList(store);
  const id = store.accounts?.sessions[sessionId];
  return (id ? list.find((a) => a.id === id) : undefined) ?? primaryAccount(list);
}

/** アカウントが 2 件以上あるか。1 件以下のうちは、画面にアカウントの印を出さない。 */
export const hasMultipleAccounts = (store: Store): boolean => accountList(store).length >= 2;

export function setEventsLoading(store: Store, key: string, loading: boolean): Store {
  const cur = store.events[key] ?? { items: [], total: 0, nextSeq: null, loading: false };
  return { ...store, events: { ...store.events, [key]: { ...cur, loading } } };
}

/**
 * 読んだ頁を入れる。append が偽なら置き換える。older は過去へ遡った頁であることを表す。
 * 遡った頁は後ろ向きに読むので続きの印（nextSeq）を持たない。持っている分の後ろの続きの印は残す。
 */
export function applyEventsPage(store: Store, key: string, page: EventsPageDto, append: boolean, older = false): Store {
  const cur = store.events[key];
  const base = append && cur ? cur.items : [];
  const seen = new Set(base.map((e) => e.seq));
  const items = [...base, ...page.events.filter((e) => !seen.has(e.seq))];
  const nextSeq = older && cur ? cur.nextSeq : page.nextSeq;
  const olderDone = older ? page.events.length === 0 || cur?.olderDone === true : append ? cur?.olderDone === true : false;
  return { ...store, events: { ...store.events, [key]: { items, total: page.total, nextSeq, loading: false, olderDone } } };
}

export function applySearch(store: Store, params: SearchParamsDto, result: SearchResultDto | null, loading: boolean): Store {
  return { ...store, search: { params, result, loading } };
}

export function applySubagents(store: Store, sessionId: string, ids: string[]): Store {
  return { ...store, subagents: { ...store.subagents, [sessionId]: ids } };
}

export function applyLiveDigest(store: Store, d: LiveDigestDto): Store {
  return { ...store, liveDigests: { ...store.liveDigests, [d.sessionId]: d } };
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

/**
 * 画面で数えるときのセッションの状態（実行中、入力待ち、終了）。
 * Claude の一覧に載る前の run も実行中に数える。
 * 区切り（Paused・Done・Archived）を付けて休みのまま残っているもの（parked）は、プロセスが残っていても終了に数える。
 * alive を渡せば、何件も数えるときに run の集合を作り直さずに済む。
 */
export function liveFilterOfSession(store: Store, session: SessionDto, alive: Set<string> = runningSessionIds(store)): LiveFilter {
  return liveFilterOf(session.live, alive.has(session.id), session.parked === true);
}

/**
 * 一覧で見せる動き。区切りを付けて休みのまま残っているもの（parked）は、終わったものと同じに見せる。
 * セッション画面は本当の動き（session.live）を出すので、これを使わない。
 */
export function shownLive(session: SessionDto): LiveStatus | null {
  return session.parked ? null : session.live;
}

/** 終わっていない最新の run。 */
export function aliveRunOf(store: Store, sessionId: string): RunDto | null {
  return newest(Object.values(store.runs).filter((r) => r.sessionId === sessionId && r.endedAt === null));
}

/**
 * hangar の run が無いまま動いているセッションを、hangar の端末で開く手。
 * attach は Claude のバックグラウンドのサービスが持つセッションで、つなぐだけで済む。
 * adopt は外のターミナル（VS Code など）で動く claude で、止めて hangar の tmux の中で再開する。作業中は止めると途中で切れるので出さない。
 * ターミナルの CLI でない claude（VS Code の拡張など）も出さない。止めるとその画面の側が壊れる。
 * hangar の run があるなら、その端末を開けばよいので null にする。
 */
export function outsideOpenOf(store: Store, session: SessionDto): 'attach' | 'adopt' | null {
  if (aliveRunOf(store, session.id)) return null;
  const l = store.live.find((x) => x.sessionId === session.providerSessionId);
  if (!l) return null;
  if (l.background) return 'attach';
  return l.status !== 'busy' && l.entrypoint === 'cli' ? 'adopt' : null;
}

/**
 * サイドバーの「動いている」に載るセッションの id（実行中と入力待ち）。
 * 始めた時刻の古い順に並べ、時刻の無いものは後ろ、同じ時刻は id の順にする。
 * 状態や最後の活動では並べない。更新のたびに並びが揺れないようにするためである。
 */
export function liveSessionIds(store: Store): string[] {
  const alive = runningSessionIds(store);
  const at = (s: SessionDto) => s.startedAt ?? Number.POSITIVE_INFINITY;
  return Object.values(store.sessions).filter((s) => liveFilterOfSession(store, s, alive) !== 'ended')
    .sort((a, b) => (at(a) === at(b) ? 0 : at(a) < at(b) ? -1 : 1) || a.id.localeCompare(b.id))
    .map((s) => s.id);
}

/**
 * 入力待ちのセッションの id。
 * 数え方は liveFilterOf に従い、Home の要対応の札と同じ順（最後の活動が古い、つまり長く待っている順）に並べる。
 * 時刻の無いものは後ろに置き、時刻が同じものは id の順にして、並びが揺れないようにする。
 */
export function waitingSessionIds(store: Store): string[] {
  const at = (s: SessionDto) => s.lastActivityAt ?? Number.POSITIVE_INFINITY;
  return Object.values(store.sessions).filter((s) => liveFilterOf(s.live, false) === 'waiting')
    .sort((a, b) => (at(a) === at(b) ? 0 : at(a) < at(b) ? -1 : 1) || a.id.localeCompare(b.id))
    .map((s) => s.id);
}

/**
 * 「次の入力待ちへ」で移る先。
 * 入力待ちのセッションを waitingSessionIds の順に並べ、from の次を返す。
 * from が並びに無ければ先頭を、末尾の次は先頭を返す。
 * 入力待ちが無ければ null。
 */
export function nextWaitingSession(store: Store, from: string | null): string | null {
  const list = waitingSessionIds(store);
  if (list.length === 0) return null;
  const i = from === null ? -1 : list.indexOf(from);
  return list[(i + 1) % list.length]!;
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
/**
 * タブがストアの上でまだ生きているか。
 * Claude のタブは run が終わるまで、シェルのタブは閉じるまで生きている（シェルのタブは Claude が終わっても残る）。
 * 知らないタブは生きていない。
 * 端末の自動のつなぎ直しが、終わったタブを叩き続けないために使う。
 */
export function tabAlive(store: Store, tabId: string): boolean {
  const tab = store.tabs[tabId];
  const run = tab ? store.runs[tab.runId] : undefined;
  if (!tab || !run || tab.closedAt !== null) return false;
  return tab.kind === 'shell' || run.endedAt === null;
}

/**
 * 取り直した bootstrap を混ぜる前に、前は生きていたのに今は生きていない run とシェルのタブを拾う。
 * サーバの再起動中に Claude が終わると、run.ended も tab.upsert も届かないまま、bootstrap の一覧から消える。
 * applyBootstrap は前の値に混ぜるので、拾わないと生きたままの写しが残る。
 * 消えた run は at の時刻に lost で終わったものとし、bootstrap に終わった姿があればそれを使う。
 * 消えたシェルのタブは at の時刻に閉じたものとする。
 */
export function vanishedOnBootstrap(store: Store, b: BootstrapDto, at: number): { runs: RunDto[]; tabs: TabDto[] } {
  const runs = new Map(b.runs.map((r) => [r.id, r]));
  const tabs = new Map(b.tabs.map((t) => [t.id, t]));
  const mine = (runId: string) => store.runs[runId]?.deviceId === b.device.id;
  const goneRuns: RunDto[] = [];
  for (const r of Object.values(store.runs)) {
    if (r.endedAt !== null || r.deviceId !== b.device.id) continue;
    const now = runs.get(r.id);
    if (!now) goneRuns.push({ ...r, endedAt: at, endReason: 'lost' });
    else if (now.endedAt !== null) goneRuns.push(now);
  }
  const goneTabs: TabDto[] = [];
  for (const t of Object.values(store.tabs)) {
    if (t.kind !== 'shell' || t.closedAt !== null || !mine(t.runId)) continue;
    const now = tabs.get(t.id);
    if (!now) goneTabs.push({ ...t, closedAt: at });
    else if (now.closedAt !== null) goneTabs.push(now);
  }
  return { runs: goneRuns, tabs: goneTabs };
}

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
export function applyJoinToken(store: Store, token: string | null, expiresAt: number | null = null): Store { return { ...store, joinToken: token, joinTokenExpiresAt: token === null ? null : expiresAt }; }

/** Claude Code の設定の下見を入れる。閉じるときに null で捨てる。 */
export function applyConfigPreview(store: Store, preview: ConfigPreviewDto | null): Store { return { ...store, configPreview: preview }; }
