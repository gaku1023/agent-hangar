import type { NotifyPermission } from './notifier.ts';
import { describe, expect, it, vi } from 'vitest';
import type { BootstrapDto, CloudUsageDto, EventsPageDto, LaunchResultDto, MemoDto, ProjectDto, RunDto, ServerEvent, SessionDto, SyncStatusBody, TabDto, TodoDto } from '@agent-hangar/shared';
import { ApiConflictError, RetentionConflictApiError, type ApiClient } from './api.ts';
import { createRuntime, type RuntimeDeps } from './runtime.ts';
import type { TerminalHost } from './terminals.ts';
import { accountsFixture } from '../test/accounts.ts';
import { fakeApiExtras } from '../test/fakeApi.ts';
import type { State } from '../mediator/types.ts';
import { presentNewProject } from '../presenters/newProject.ts';
import { presentShell } from '../presenters/shell.ts';

const boot: BootstrapDto = { device: { id: 'd', name: 'mac' }, settings: { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, nodePath: null, claudePath: null }, projects: [], sessions: [], live: [], runs: [], tabs: [], todos: [], artifacts: [], summaryPending: [], index: { phase: 'idle', done: 0, total: 0 }, version: '1', sync: { state: 'off', url: null, lastPushAt: null, lastPullAt: null, pending: 0, error: null, deviceCount: 0, limitedUntil: null, paused: false, skipped: [], sweepPending: null, oncePass: false }, devices: [], retention: null, cloudUsage: null, accounts: { currentId: 'primary', accounts: [], sessions: {} } };
const syncStatus: SyncStatusBody = { state: 'idle', url: 'https://h', lastPushAt: 1, lastPullAt: 2, pending: 0, error: null, deviceCount: 2, limitedUntil: null, paused: false, skipped: [], sweepPending: null, oncePass: false };
const launchResult: LaunchResultDto = { run: { id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'resume', tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 }, sessionId: 's1', tabs: [] };
const page = (seqs: number[], total: number): EventsPageDto => ({ sessionId: 's1', events: seqs.map((seq) => ({ kind: 'user', seq, text: 'x' })), total, nextSeq: null });

/** ターミナルの偽物。React の外で持つ接続の代わりに、呼ばれた tabId を並べる。 */
function fakeTerminals(): TerminalHost & { connected: string[]; disconnected: string[] } {
  const h = { connected: [] as string[], disconnected: [] as string[], connect: (id: string) => { h.connected.push(id); }, disconnect: (id: string) => { h.disconnected.push(id); }, mount: () => {}, status: () => null, fit: () => {}, focus: vi.fn(), paste: () => {}, zoom: () => {}, fontSize: () => 13, painted: () => true, subscribe: () => () => {}, dispose: () => {}, link: () => ({ retryAt: null, dropped: false, gaveUp: false, detached: false }), reconnect: () => {} };
  return h;
}

function harness(overrides: Partial<ApiClient> = {}, extra: Partial<RuntimeDeps> = {}) {
  const api: ApiClient = {
    bootstrap: vi.fn(async () => boot),
    // 3 件のうち、開くと最新の 1 件、遡ると 1 つ古い 1 件、追記の取り込みでは前向きに 1 件。
    events: vi.fn(async (_s, q) => (q.latest ? page([2], 3) : q.beforeSeq !== undefined ? page([q.beforeSeq - 1], 3) : page([q.fromSeq!], 4))),
    subagents: vi.fn(async () => []),
    search: vi.fn(async () => ({ hits: [], total: 0 })),
    setProjectStatus: vi.fn(async () => { throw new Error('500 /api/projects/p1'); }),
    resolveProject: vi.fn(async () => ({})),
    candidates: vi.fn(async () => []),
    updateSettings: vi.fn(async (p) => ({ workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal' as const, codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, ...p })),
    rebuildIndex: vi.fn(async () => {}),
    ...fakeApiExtras(),
    syncNow: vi.fn(async () => syncStatus),
    syncPause: vi.fn(async () => ({ ...syncStatus, state: 'paused' as const })),
    syncFocus: vi.fn(async () => {}),
    resumeHere: vi.fn(async () => launchResult),
    joinToken: vi.fn(async () => ({ token: 'tok' })),
    ...overrides,
  };
  const focusListeners = new Set<() => void>();
  let hash = '#/';
  const hashListeners = new Set<() => void>();
  const wsHandlers: { onOpen(): void; onClose(): void; onEvent(ev: ServerEvent): void }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const go = vi.fn();
  let depth = 0;
  const store = new Map<string, unknown>();
  const deps: RuntimeDeps = {
    api,
    ws: (h) => { wsHandlers.push(h); return { connect: vi.fn(), close: vi.fn() }; },
    location: { getHash: () => hash, setHash: (h) => { hash = h; depth += 1; for (const l of hashListeners) l(); }, onHashChange: (cb) => { hashListeners.add(cb); return () => hashListeners.delete(cb); }, go, depth: () => depth },
    storage: { get: (k) => store.get(k), set: (k, v) => store.set(k, v), keys: () => [...store.keys()] },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    terminals: fakeTerminals(),
    focus: vi.fn(),
    onWindowFocus: (cb) => { focusListeners.add(cb); return () => focusListeners.delete(cb); },
    ...extra,
  };
  const rt = createRuntime(deps);
  return { rt, go, api, wsHandlers, timers, store, terminals: deps.terminals as ReturnType<typeof fakeTerminals>, setHash: deps.location.setHash,
    // ブラウザの戻る・進む。ハッシュと段を入れ替えて、積まずに変化だけを知らせる。
    browse: (h: string, d: number) => { hash = h; depth = d; for (const l of hashListeners) l(); },
    focus: deps.focus as ReturnType<typeof vi.fn>, fireFocus: () => { for (const l of focusListeners) l(); } };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createRuntime', () => {
  const aliveRun = { id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'start' as const, tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 };
  it('実行中のセッションは本文を読むときに右ペインの要約も取り、1 秒に 1 回までにまとめる', async () => {
    let clock = 10_000;
    const { rt, api, setHash, timers } = harness({}, { now: () => clock });
    rt.start();
    rt.dispatch({ kind: 'server', event: { type: 'run.started', run: aliveRun, tabs: [] } });
    setHash('#/session/s1');
    await flush();
    expect(api.live).toHaveBeenCalledTimes(1);
    expect(rt.getStore().liveDigests.s1).toMatchObject({ sessionId: 's1' });
    const before = timers.length;
    rt.dispatch({ kind: 'server', event: { type: 'transcript.appended', sessionId: 's1', count: 1 } });
    rt.dispatch({ kind: 'server', event: { type: 'transcript.appended', sessionId: 's1', count: 1 } });
    await flush();
    // 1 秒たつまでは取りに行かず、予約は 1 つだけにする。
    expect(api.live).toHaveBeenCalledTimes(1);
    const mine = timers.slice(before).filter((t) => t.ms === 1000);
    expect(mine).toHaveLength(1);
    clock += 1000;
    mine[0]!.fn();
    await flush();
    expect(api.live).toHaveBeenCalledTimes(2);
  });
  it('ホームへ入ったら、動いているセッションの意図を取りに行き、見ている間に動いた分を取り直す', async () => {
    let clock = 10_000;
    const { rt, api, setHash, timers } = harness({}, { now: () => clock });
    rt.start();
    rt.dispatch({ kind: 'server', event: { type: 'run.started', run: aliveRun, tabs: [] } });
    setHash('#/projects');
    await flush();
    // ホーム以外では取りに行かない。
    expect(api.live).not.toHaveBeenCalled();
    setHash('#/');
    await flush();
    expect(api.live).toHaveBeenCalledTimes(1);
    expect(api.live).toHaveBeenCalledWith('s1');
    const before = timers.length;
    rt.dispatch({ kind: 'server', event: { type: 'transcript.appended', sessionId: 's1', count: 1 } });
    await flush();
    // 1 秒に 1 回までにまとめる。
    expect(api.live).toHaveBeenCalledTimes(1);
    clock += 1000;
    timers.slice(before).filter((t) => t.ms === 1000)[0]!.fn();
    await flush();
    expect(api.live).toHaveBeenCalledTimes(2);
  });
  it('セッションを開くとき、変更したファイルの一覧も取り、run が終わったら取り直す', async () => {
    const files = [{ path: '/w/a.ts', edits: 2, agentId: null }];
    const sessionFiles = vi.fn(async () => ({ files }));
    const { rt, api, setHash } = harness({ sessionFiles });
    rt.start();
    setHash('#/session/s1');
    await flush();
    expect(api.sessionFiles).toHaveBeenCalledTimes(1);
    expect(api.sessionFiles).toHaveBeenCalledWith('s1');
    expect(rt.getStore().sessionFiles.s1).toEqual(files);
    // 実行中に増えた分は、終わったときに取り直す。
    rt.dispatch({ kind: 'server', event: { type: 'run.ended', run: { ...aliveRun, endedAt: 5, endReason: 'exited' } } });
    await flush();
    expect(api.sessionFiles).toHaveBeenCalledTimes(2);
  });
  it('変更したファイルの一覧を取れなくても、知らせは出さない（補助の表示）', async () => {
    const sessionFiles = vi.fn(async () => { throw new Error('500'); });
    const { rt, setHash } = harness({ sessionFiles });
    rt.start();
    setHash('#/session/s1');
    await flush();
    expect(rt.getStore().sessionFiles.s1).toBeUndefined();
    expect(rt.getState().toasts).toEqual([]);
  });
  it('生きた run の無いセッションでは要約を取らない', async () => {
    const { rt, api, setHash } = harness();
    rt.start();
    setHash('#/session/s1');
    await flush();
    expect(api.live).not.toHaveBeenCalled();
  });
  it('ws が開くと bootstrap を取り、現在のハッシュで画面を決める', async () => {
    const { rt, api, wsHandlers, setHash } = harness();
    rt.start();
    setHash('#/projects');
    wsHandlers[0]!.onOpen();
    await flush();
    expect(api.bootstrap).toHaveBeenCalledTimes(1);
    expect(rt.getStore().bootstrapped).toBe(true);
    expect(rt.getState().screen).toEqual({ name: 'projects' });
  });
  it('session 画面は最新の側から読み、loadMore は過去へ遡る', async () => {
    const { rt, api, setHash } = harness();
    rt.start();
    setHash('#/session/s1');
    await flush();
    expect(api.events).toHaveBeenCalledWith('s1', { latest: true, agentId: null });
    expect(rt.getStore().events['s1:']?.items.map((e) => e.seq)).toEqual([2]);
    rt.emit({ type: 'transcript.loadMore', sessionId: 's1' });
    await flush();
    // 持っている中でいちばん古い seq より前を求める。
    expect(api.events).toHaveBeenLastCalledWith('s1', { beforeSeq: 2, agentId: null });
    expect([...rt.getStore().events['s1:']!.items.map((e) => e.seq)].sort()).toEqual([1, 2]);
  });
  it('検索の結果から開いたら、跳び先の少し前から前向きに読む。ターミナルが出るセッションでは最新の側から読む', async () => {
    const { rt, api, wsHandlers } = harness();
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    rt.emit({ type: 'session.open', id: 's1', seq: 900, q: 'パスワード' });
    await flush();
    expect(api.events).toHaveBeenLastCalledWith('s1', { fromSeq: 800, agentId: null });
    expect(rt.getState().sessionView.s1).toMatchObject({ jump: { seq: 900, query: 'パスワード', n: 1 }, follow: false });
    // 跳び先が頭に近ければ 0 から読む。
    rt.emit({ type: 'nav.go', to: { name: 'home' } });
    await flush();
    rt.emit({ type: 'session.open', id: 's1', seq: 30, q: 'x' });
    await flush();
    expect(api.events).toHaveBeenLastCalledWith('s1', { fromSeq: 0, agentId: null });
    // run のあるセッションは右の欄が最新の側を使うので、真ん中は読まない。
    wsHandlers[0]!.onEvent({ type: 'run.started', run: { id: 'r2', sessionId: 's2', deviceId: 'd', kind: 'start', tmuxName: 'hangar-r2', pid: 1, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 }, tabs: [] });
    await flush();
    rt.emit({ type: 'session.open', id: 's2', seq: 900, q: 'x' });
    await flush();
    expect(api.events).toHaveBeenLastCalledWith('s2', { latest: true, agentId: null });
  });
  it('真ん中の頁から開いた本文は、新しい行を読み足せる', async () => {
    const events = vi.fn(async (_s: string, q: { fromSeq?: number; latest?: boolean; beforeSeq?: number }) => (q.fromSeq === 800 ? { ...page([800, 801], 2000), nextSeq: 802 } : page([q.fromSeq ?? 0], 2000)));
    const { rt, wsHandlers } = harness({ events });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    rt.emit({ type: 'session.open', id: 's1', seq: 900, q: 'x' });
    await flush();
    expect(rt.getStore().events['s1:']?.nextSeq).toBe(802);
    rt.emit({ type: 'transcript.loadNewer', sessionId: 's1' });
    await flush();
    expect(events).toHaveBeenLastCalledWith('s1', { fromSeq: 802, agentId: null });
  });
  it('追記が届いたら、持っている中でいちばん新しい seq の次から前向きに読む', async () => {
    const { rt, api, setHash } = harness();
    rt.start();
    setHash('#/session/s1');
    await flush();
    rt.dispatch({ kind: 'server', event: { type: 'transcript.appended', sessionId: 's1', count: 1 } });
    await flush();
    expect(api.events).toHaveBeenLastCalledWith('s1', { fromSeq: 3, agentId: null });
    expect([...rt.getStore().events['s1:']!.items.map((e) => e.seq)].sort()).toEqual([2, 3]);
  });
  it('検索の「さらに読み込む」は、届いた行を持っている行の後ろに足す', async () => {
    const hit = (id: string) => ({ sessionId: id, matchCount: 1, snippets: [] });
    const search = vi.fn(async (p: { offset?: number }) => (p.offset ? { hits: [hit('s2'), hit('s3')], total: 3 } : { hits: [hit('s1'), hit('s2')], total: 3 }));
    const { rt, setHash } = harness({ search });
    rt.start();
    setHash('#/?q=x');
    await flush();
    expect(search).toHaveBeenLastCalledWith({ q: 'x', hideArchived: true, limit: 50 });
    expect(rt.getStore().search.result?.hits.map((h) => h.sessionId)).toEqual(['s1', 's2']);
    rt.emit({ type: 'search.more' });
    // 読んでいる間も、持っている行は消さない。
    expect(rt.getStore().search).toMatchObject({ loading: true, result: { total: 3 } });
    expect(rt.getStore().search.result?.hits).toHaveLength(2);
    await flush();
    expect(search).toHaveBeenLastCalledWith({ q: 'x', hideArchived: true, limit: 50, offset: 2 });
    expect(rt.getStore().search).toMatchObject({ loading: false, result: { total: 3 } });
    // 重なった行（s2）は 1 度だけ。
    expect(rt.getStore().search.result?.hits.map((h) => h.sessionId)).toEqual(['s1', 's2', 's3']);
  });
  it('「さらに読み込む」の最中に条件を変えたら、古い続きは捨てる', async () => {
    const hit = (id: string) => ({ sessionId: id, matchCount: 1, snippets: [] });
    let release: (r: { hits: ReturnType<typeof hit>[]; total: number }) => void = () => {};
    const search = vi.fn((p: { offset?: number; status?: string }) => (p.offset ? new Promise<{ hits: ReturnType<typeof hit>[]; total: number }>((res) => { release = res; }) : Promise.resolve(p.status ? { hits: [hit('d1')], total: 1 } : { hits: [hit('s1'), hit('s2')], total: 5 })));
    const { rt, setHash } = harness({ search });
    rt.start();
    setHash('#/?q=x');
    await flush();
    rt.emit({ type: 'search.more' });
    rt.emit({ type: 'search.filter', patch: { status: 'done' } });
    await flush();
    release({ hits: [hit('s3'), hit('s4')], total: 5 });
    await flush();
    expect(rt.getStore().search.result?.hits.map((h) => h.sessionId)).toEqual(['d1']);
  });
  it('期間の日数は、問い合わせる時刻で since に直してから送る', async () => {
    const search = vi.fn(async () => ({ hits: [], total: 0 }));
    const now = new Date(2026, 9, 1, 15, 30).getTime();
    const { rt, setHash } = harness({ search }, { now: () => now });
    rt.start();
    setHash('#/?q=x');
    await flush();
    rt.emit({ type: 'search.filter', patch: { days: 1 } });
    await flush();
    expect(search).toHaveBeenLastCalledWith({ q: 'x', hideArchived: true, since: new Date(2026, 9, 1).getTime(), limit: 50 });
  });
  it('同じ語でトークンだけ変えた Enter は、新しい絞り込みでちょうど 1 回だけ問い合わせる', async () => {
    const search = vi.fn(async () => ({ hits: [], total: 0 }));
    const { rt, setHash } = harness({ search });
    rt.start();
    setHash('#/?q=x');
    await flush();
    expect(search).toHaveBeenCalledTimes(1);
    rt.emit({ type: 'search.query', text: 'x', filter: { status: 'done' } });
    await flush();
    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenLastCalledWith({ q: 'x', status: 'done', limit: 50 });
  });
  it('語の無い一覧で触ったファイルだけを変えた Enter も、ちょうど 1 回だけ問い合わせる', async () => {
    const search = vi.fn(async () => ({ hits: [], total: 0 }));
    const { rt, setHash } = harness({ search });
    rt.start();
    setHash('#/');
    await flush();
    expect(search).not.toHaveBeenCalled();
    rt.emit({ type: 'search.query', text: '', filter: { file: 'a.md' } });
    await flush();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenLastCalledWith({ q: '', file: 'a.md', hideArchived: true, limit: 50 });
  });
  it('「さらに読み込む」に失敗しても、読み込み中のまま残さず、持っている結果も消さない', async () => {
    const hit = (id: string) => ({ sessionId: id, matchCount: 1, snippets: [] });
    const search = vi.fn(async (p: { offset?: number }) => { if (p.offset) throw new Error('500 /api/search'); return { hits: [hit('s1')], total: 3 }; });
    const { rt, setHash } = harness({ search });
    rt.start();
    setHash('#/?q=x');
    await flush();
    rt.emit({ type: 'search.more' });
    await flush();
    expect(rt.getStore().search).toMatchObject({ loading: false, result: { total: 3 } });
    expect(rt.getStore().search.result?.hits.map((h) => h.sessionId)).toEqual(['s1']);
  });
  it('すべて読み終えていれば loadMore はサーバを呼ばない', async () => {
    const { rt, api, setHash } = harness({ events: vi.fn(async () => page([0, 1, 2], 3)) });
    rt.start();
    setHash('#/session/s1');
    await flush();
    expect(api.events).toHaveBeenCalledTimes(1);
    rt.emit({ type: 'transcript.loadMore', sessionId: 's1' });
    await flush();
    expect(api.events).toHaveBeenCalledTimes(1);
  });
  it('本文を読むときにサブエージェントの一覧も取り、同じセッションでは取り直さない', async () => {
    const { rt, api, setHash } = harness({ subagents: vi.fn(async () => ['agent-1']) });
    rt.start();
    setHash('#/session/s1');
    await flush();
    expect(api.subagents).toHaveBeenCalledWith('s1');
    expect(rt.getStore().subagents.s1).toEqual(['agent-1']);
    // 続きを読んでも、画面を離れて戻っても取り直さない。
    rt.emit({ type: 'transcript.loadMore', sessionId: 's1' });
    setHash('#/');
    setHash('#/session/s1');
    await flush();
    expect(api.subagents).toHaveBeenCalledTimes(1);
    // 別のセッションでは取る。
    setHash('#/session/s2');
    await flush();
    expect(api.subagents).toHaveBeenLastCalledWith('s2');
  });
  it('本文が伸びたセッションはサブエージェントを取り直す', async () => {
    let ids = ['agent-1'];
    const { rt, api, setHash } = harness({ subagents: vi.fn(async () => ids) });
    rt.start();
    setHash('#/session/s1');
    await flush();
    expect(rt.getStore().subagents.s1).toEqual(['agent-1']);
    ids = ['agent-1', 'agent-2'];
    rt.dispatch({ kind: 'server', event: { type: 'transcript.appended', sessionId: 's1', count: 1 } });
    await flush();
    expect(api.subagents).toHaveBeenCalledTimes(2);
    expect(rt.getStore().subagents.s1).toEqual(['agent-1', 'agent-2']);
    // 伸びていないセッションは取り直さない。
    rt.dispatch({ kind: 'server', event: { type: 'transcript.appended', sessionId: 's2', count: 1 } });
    await flush();
    expect(api.subagents).toHaveBeenCalledTimes(2);
  });
  describe('未解決のプロジェクト（2.11.5）', () => {
    const project = (id: string, over: Partial<ProjectDto> = {}): ProjectDto => ({ id, name: id, status: 'active', isScratch: false, path: `/w/${id}`, resolved: true, lastActivityAt: null, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 0, unresolved: null, ...over });
    const lost = (id: string) => project(id, { resolved: false, unresolved: { kind: 'missing', previousPath: `/w/${id}`, deviceName: null } });
    const arrived = (id: string) => project(id, { path: null, resolved: false, unresolved: { kind: 'elsewhere', previousPath: `/o/${id}`, deviceName: 'Mac mini' } });
    const upsert = (p: ProjectDto): ServerEvent => ({ type: 'project.upsert', project: p });

    it('起動の読み込みに未解決のプロジェクトがあっても、ダイアログは開かない（帯の件数になるだけ）', async () => {
      const { rt, wsHandlers } = harness({ bootstrap: vi.fn(async () => ({ ...boot, projects: [lost('p1'), arrived('p2'), project('p3')] })) });
      rt.start();
      wsHandlers[0]!.onOpen();
      await flush();
      expect(rt.getState().overlay).toEqual({ kind: 'none' });
      expect(Object.keys(rt.getStore().projects).sort()).toEqual(['p1', 'p2', 'p3']);
      // 起動の読み込みで入ったものは、届いた知らせにしない。
      expect(rt.getState().arrivedProjects).toEqual([]);
    });

    it('サーバが project.unresolved を流しても、ダイアログは開かない', async () => {
      const { rt, wsHandlers } = harness({ bootstrap: vi.fn(async () => ({ ...boot, projects: [lost('p1')] })) });
      rt.start();
      wsHandlers[0]!.onOpen();
      await flush();
      wsHandlers[0]!.onEvent({ type: 'project.unresolved', projectId: 'p1' });
      expect(rt.getState().overlay).toEqual({ kind: 'none' });
    });

    it('「場所を再指定」を押したときだけ、ダイアログが開く', async () => {
      const { rt, wsHandlers } = harness({ bootstrap: vi.fn(async () => ({ ...boot, projects: [lost('p1')] })) });
      rt.start();
      wsHandlers[0]!.onOpen();
      await flush();
      rt.emit({ type: 'project.resolve.open', id: 'p1' });
      expect(rt.getState().overlay).toEqual({ kind: 'resolveProject', projectId: 'p1' });
    });

    it('同期で他の PC のプロジェクトが降りたら、降りた分を覚える。3 件が別々の知らせで届いても、1 つの札にまとまる', async () => {
      const { rt, wsHandlers } = harness();
      rt.start();
      wsHandlers[0]!.onOpen();
      await flush();
      for (const id of ['a', 'b', 'c']) wsHandlers[0]!.onEvent(upsert(arrived(id)));
      expect(rt.getState().arrivedProjects).toEqual(['a', 'b', 'c']);
      expect(rt.getState().toasts).toEqual([]);
    });

    it('すでに知っているプロジェクトの更新、この PC に場所のあるもの、この PC で消えたものは、届いた知らせにしない', async () => {
      const { rt, wsHandlers } = harness({ bootstrap: vi.fn(async () => ({ ...boot, projects: [arrived('known')] })) });
      rt.start();
      wsHandlers[0]!.onOpen();
      await flush();
      wsHandlers[0]!.onEvent(upsert({ ...arrived('known'), name: 'renamed' }));
      wsHandlers[0]!.onEvent(upsert(project('mine')));
      wsHandlers[0]!.onEvent(upsert(lost('lost')));
      wsHandlers[0]!.onEvent(upsert(arrived('scratch-like')));
      expect(rt.getState().arrivedProjects).toEqual(['scratch-like']);
    });

    it('起動の読み込みが済む前に届いたものは、知らせにしない', () => {
      const { rt, wsHandlers } = harness();
      rt.start();
      wsHandlers[0]!.onEvent(upsert(arrived('early')));
      expect(rt.getState().arrivedProjects).toEqual([]);
    });
  });
  it('API の失敗はトーストになる', async () => {
    const { rt } = harness();
    rt.start();
    rt.emit({ type: 'project.setStatus', id: 'p1', status: 'paused' });
    await flush();
    expect(rt.getState().toasts[0]).toMatchObject({ level: 'error', message: '500 /api/projects/p1' });
  });
  it('切断後は指定の時間で再接続する', () => {
    const { rt, wsHandlers, timers } = harness();
    rt.start();
    wsHandlers[0]!.onClose();
    expect(timers[0]?.ms).toBe(2000);
  });
  it('切断は時刻を添えて伝える。Mediator は自分で測れないからである', () => {
    const { rt, wsHandlers } = harness();
    rt.start();
    const before = Date.now();
    wsHandlers[0]!.onClose();
    const { staleSince, nextRetryAt } = rt.getState();
    expect(staleSince).toBeGreaterThanOrEqual(before);
    expect(nextRetryAt).toBe(staleSince! + 2000);
  });
  it('セッション表示の一時状態を保存し、起動時に読み戻す', () => {
    const a = harness();
    a.rt.start();
    a.rt.emit({ type: 'transcript.showThinking', sessionId: 's1', show: true });
    expect(a.store.get('sv:s1')).toMatchObject({ showThinking: true });
    const b = harness();
    b.store.set('sv:s1', { showThinking: true, showRaw: true });
    b.rt.start();
    expect(b.rt.getState().sessionView.s1).toMatchObject({ showThinking: true, showRaw: true, follow: true });
  });
  it('古い保存に残る summaryOpen は、読み戻すときに捨て、書き戻さない', () => {
    const b = harness();
    b.store.set('sv:s1', { showThinking: true, summaryOpen: true });
    b.rt.start();
    expect(b.rt.getState().sessionView.s1).toMatchObject({ showThinking: true });
    expect(b.rt.getState().sessionView.s1).not.toHaveProperty('summaryOpen');
    b.rt.emit({ type: 'transcript.showRaw', sessionId: 's1', show: true });
    expect(b.store.get('sv:s1')).not.toHaveProperty('summaryOpen');
  });
  it('古い保存に残る右ペインの境目の比率は、読み戻すときに捨て、書き戻さない', () => {
    const a = harness();
    a.store.set('livePane.split', 0.35);
    a.store.set('sv:s1', { showThinking: true, livePaneSplit: 0.25 });
    a.rt.start();
    expect(a.rt.getState()).not.toHaveProperty('livePaneSplit');
    expect(a.rt.getState().sessionView.s1).toMatchObject({ showThinking: true });
    expect(a.rt.getState().sessionView.s1).not.toHaveProperty('livePaneSplit');
    a.rt.emit({ type: 'transcript.showRaw', sessionId: 's1', show: true });
    expect(a.store.get('sv:s1')).not.toHaveProperty('livePaneSplit');
  });
  it('サイドバーの折りたたみを保存し、起動時に読み戻す。真でない値は開いたまま', () => {
    const a = harness();
    a.rt.start();
    a.rt.emit({ type: 'sidebar.toggle' });
    expect(a.store.get('sidebar.collapsed')).toBe(true);
    const b = harness();
    b.store.set('sidebar.collapsed', true);
    b.rt.start();
    expect(b.rt.getState().sidebarCollapsed).toBe(true);
    const c = harness();
    c.store.set('sidebar.collapsed', 'yes');
    c.rt.start();
    expect(c.rt.getState().sidebarCollapsed).toBe(false);
  });
  it('新しいセッションの下書きと前回値を起動時に読み戻す。形の違う値は捨てる', () => {
    const a = harness();
    a.store.set('newSession.draft', { name: 'n', prompt: 'やって', attachments: [] });
    a.store.set('newSession.prefs', { p1: { model: 'opus', addDirs: ['/a'] }, p2: { model: 3 }, p3: 'x', p4: { addDirs: [1] } });
    a.rt.start();
    expect(a.rt.getState().newSessionDraft).toEqual({ name: 'n', prompt: 'やって', attachments: [] });
    expect(a.rt.getState().launchPrefs).toEqual({ p1: { model: 'opus', addDirs: ['/a'] } });
    const b = harness();
    b.store.set('newSession.draft', { name: 1 });
    b.store.set('newSession.prefs', []);
    b.rt.start();
    expect(b.rt.getState().newSessionDraft).toBeNull();
    expect(b.rt.getState().launchPrefs).toEqual({});
  });
  it('保存済みの follow: false を無視し、開いた直後は必ず追う', () => {
    // 遡るために一度上へスクロールしただけで follow: false が焼き付くと、次から最古の側で開いてしまう。
    const b = harness();
    b.store.set('sv:s1', { showThinking: true, follow: false });
    b.rt.start();
    expect(b.rt.getState().sessionView.s1).toMatchObject({ showThinking: true, follow: true });
  });
  it('follow は localStorage に残さない', () => {
    const a = harness();
    a.rt.start();
    a.rt.emit({ type: 'transcript.follow', sessionId: 's1', follow: false });
    expect(a.rt.getState().sessionView.s1).toMatchObject({ follow: false });
    expect(Object.keys(a.store.get('sv:s1') as object)).not.toContain('follow');
  });
  it('subscribe は状態かストアが変わるたびに呼ばれる', () => {
    const { rt } = harness();
    const cb = vi.fn();
    rt.subscribe(cb);
    rt.dispatch({ kind: 'server', event: { type: 'toast', level: 'info', message: 'x' } });
    expect(cb).toHaveBeenCalled();
  });
  it('present があれば、commit を呼ぶまで getState は前に描いた状態を返す', async () => {
    const calls: { commit: () => void; prev: State; next: State }[] = [];
    const { rt, wsHandlers, setHash } = harness({}, { present: (commit, prev, next) => { calls.push({ commit, prev, next }); } });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    // 起動からここまでの変化も present を通る。先に出しておく。
    for (const c of calls.splice(0)) c.commit();
    expect(rt.getState().screen).toEqual({ name: 'home' });
    setHash('#/projects');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prev.screen).toEqual({ name: 'home' });
    expect(calls[0]!.next.screen).toEqual({ name: 'projects' });
    expect(rt.getState().screen).toEqual({ name: 'home' });
    const seen = vi.fn();
    rt.subscribe(seen);
    calls[0]!.commit();
    expect(rt.getState().screen).toEqual({ name: 'projects' });
    expect(seen).toHaveBeenCalledTimes(1);
    // 同じ変化を 2 度出しても、描き直しは増えない。
    calls[0]!.commit();
    expect(seen).toHaveBeenCalledTimes(1);
  });
  it('commit の前に次の変化が来ても、commit で最後の状態に追いつく', async () => {
    const commits: (() => void)[] = [];
    const { rt, wsHandlers, setHash } = harness({}, { present: (commit) => { commits.push(commit); } });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    setHash('#/projects');
    setHash('#/settings');
    commits[0]!();
    expect(rt.getState().screen).toEqual({ name: 'settings' });
  });
});

const launched: LaunchResultDto = { run: { id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 }, sessionId: 's1', tabs: [{ id: 'r1', runId: 'r1', sessionId: 's1', kind: 'agent', title: 'Claude', tmuxName: 'hangar-r1', createdAt: 1, closedAt: null }] };

describe('起動とターミナル', () => {
  const created = { id: 'p9', name: 'fresh', status: 'active' as const, isScratch: false, path: '/w/fresh', resolved: true, lastActivityAt: null, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 };
  it('place 付きの起動は、作ってから、作ったプロジェクトで起動する', async () => {
    const createProject = vi.fn(async () => created);
    const launch = vi.fn(async () => launched);
    const { rt } = harness({ createProject, launch });
    rt.start();
    rt.emit({ type: 'session.new.open' });
    rt.emit({ type: 'session.new.submit', params: { name: 'n' }, place: { kind: 'newDir', name: 'fresh', gitInit: true } });
    await flush();
    expect(createProject).toHaveBeenCalledWith({ kind: 'newDir', name: 'fresh', gitInit: true });
    expect(launch).toHaveBeenCalledWith({ name: 'n', projectId: 'p9' });
    expect(rt.getStore().projects.p9).toEqual(created);
    expect(rt.getState()).toMatchObject({ launch: { kind: 'idle' }, screen: { name: 'session', id: 's1' } });
  });
  it('作れた後に起動だけ失敗したら、作ったプロジェクトを失敗の状態に持つ', async () => {
    const { rt } = harness({ createProject: vi.fn(async () => created), launch: vi.fn(async () => { throw new Error('tmux が見つかりません'); }) });
    rt.start();
    rt.emit({ type: 'session.new.open' });
    rt.emit({ type: 'session.new.submit', params: {}, place: { kind: 'dir', path: '/w/fresh' } });
    await flush();
    expect(rt.getState().launch).toEqual({ kind: 'failed', message: 'tmux が見つかりません', createdProjectId: 'p9' });
  });
  it('作れなければ起動せず、失敗の文言を出す', async () => {
    const launch = vi.fn(async () => launched);
    const { rt } = harness({ createProject: vi.fn(async () => { throw new Error('/w/fresh は既にあります'); }), launch });
    rt.start();
    rt.emit({ type: 'session.new.open' });
    rt.emit({ type: 'session.new.submit', params: {}, place: { kind: 'newDir', name: 'fresh', gitInit: false } });
    await flush();
    expect(launch).not.toHaveBeenCalled();
    expect(rt.getState().launch).toEqual({ kind: 'failed', message: '/w/fresh は既にあります' });
  });
  it('ダイアログを開くと未登録の一覧を取り、Finder の結果を持つ', async () => {
    const pickFolder = vi.fn(async () => '/Users/me/thesis');
    const { rt } = harness({ workspaceDirs: vi.fn(async () => [{ name: 'a', path: '/w/a' }]) }, { desktop: { openLog: vi.fn(), restart: vi.fn(), pickFolder, applyConfigSync: vi.fn(), restoreConfigSync: vi.fn() } });
    rt.start();
    rt.emit({ type: 'project.new.open' });
    rt.emit({ type: 'folder.pick' });
    await flush();
    expect(rt.getStore().workspaceDirs).toEqual([{ name: 'a', path: '/w/a' }]);
    expect(rt.getStore().pickedFolder).toEqual({ path: '/Users/me/thesis', n: 1 });
    // 画面は Store から読む。
    expect(presentNewProject(rt.getState(), rt.getStore())).toMatchObject({ dirs: [{ name: 'a', path: '/w/a' }], picked: { path: '/Users/me/thesis', n: 1 } });
  });
  it('未登録の一覧が取れなければ、空の一覧にする', async () => {
    const { rt } = harness({ workspaceDirs: vi.fn(async () => { throw new Error('500'); }) });
    rt.start();
    rt.emit({ type: 'project.new.open' });
    await flush();
    expect(rt.getStore().workspaceDirs).toEqual([]);
    expect(rt.getState().toasts).toEqual([]);
  });
  it('作成のダイアログの送信は、作ってから done を返す', async () => {
    const { rt } = harness({ createProject: vi.fn(async () => created) });
    rt.start();
    rt.emit({ type: 'project.new.open' });
    rt.emit({ type: 'project.new.submit', place: { kind: 'newDir', name: 'fresh', gitInit: true }, startSession: false });
    await flush();
    expect(rt.getStore().projects.p9).toEqual(created);
    expect(rt.getState()).toMatchObject({ overlay: { kind: 'none' }, projectCreate: { kind: 'idle' } });
  });
  it('起動に成功するとストアに run が入り、セッション画面へ移ってターミナルに繋ぐ', async () => {
    const { rt, api, terminals, setHash } = harness({ launch: vi.fn(async () => launched) });
    rt.start();
    setHash('#/');
    rt.emit({ type: 'session.new.open', projectId: 'p1' });
    rt.emit({ type: 'session.new.submit', params: { projectId: 'p1' } });
    await flush();
    expect(api.launch).toHaveBeenCalledWith({ projectId: 'p1' });
    expect(rt.getStore().runs.r1).toBeDefined();
    expect(rt.getState()).toMatchObject({ launch: { kind: 'idle' }, overlay: { kind: 'none' }, screen: { name: 'session', id: 's1' } });
    expect(terminals.connected).toEqual(['r1']);
  });
  it('起動の失敗は failed だけで、トーストは重ねない', async () => {
    const { rt } = harness({ launch: vi.fn(async () => { throw new Error('tmux が見つかりません'); }) });
    rt.start();
    rt.emit({ type: 'session.new.open', projectId: 'p1' });
    rt.emit({ type: 'session.new.submit', params: { projectId: 'p1' } });
    await flush();
    expect(rt.getState().launch).toEqual({ kind: 'failed', message: 'tmux が見つかりません' });
    expect(rt.getState().toasts).toEqual([]);
  });
  it('セッション画面に入ると生きた run の Claude タブに繋ぎ、終了した run には繋がない', async () => {
    const { rt, terminals, setHash } = harness();
    rt.start();
    rt.dispatch({ kind: 'server', event: { type: 'run.started', run: launched.run, tabs: launched.tabs } });
    setHash('#/session/s1');
    expect(terminals.connected).toEqual(['r1']);
    rt.dispatch({ kind: 'server', event: { type: 'run.ended', run: { ...launched.run, endedAt: 2, endReason: 'exited' } } });
    expect(terminals.disconnected).toEqual(['r1']);
    setHash('#/session/s1');
    expect(terminals.connected).toEqual(['r1']);
  });
  it('tab.open は run を引いて API を呼び、届いたタブに繋ぐ', async () => {
    const tab = { id: 't1', runId: 'r1', sessionId: 's1', kind: 'shell' as const, title: 'シェル 1', tmuxName: 'hangar-r1-t1', createdAt: 2, closedAt: null };
    const { rt, api, terminals, setHash } = harness({ openTab: vi.fn(async () => tab) });
    rt.start();
    rt.dispatch({ kind: 'server', event: { type: 'run.started', run: launched.run, tabs: launched.tabs } });
    setHash('#/session/s1');
    rt.emit({ type: 'tab.open', sessionId: 's1', kind: 'shell' });
    await flush();
    expect(api.openTab).toHaveBeenCalledWith('r1');
    rt.dispatch({ kind: 'server', event: { type: 'tab.upsert', tab } });
    expect(terminals.connected).toEqual(['r1', 't1']);
    expect(terminals.focus).toHaveBeenCalledWith('t1');
    rt.emit({ type: 'tab.close', tabId: 't1' });
    await flush();
    expect(api.closeTab).toHaveBeenCalledWith('r1', 't1');
  });
  it('生きた run が無ければ API を呼ばず、Claude が動いていないと知らせる', async () => {
    const { rt, api, setHash } = harness();
    rt.start();
    await flush();
    setHash('#/session/s1');
    rt.emit({ type: 'tab.open', sessionId: 's1', kind: 'shell' });
    await flush();
    expect(api.openTab).not.toHaveBeenCalled();
    expect(rt.getState().toasts.at(-1)?.message).toBe('Claude が実行中ではないので、シェルタブを開けません');
  });
  it('セッションを渡り歩いても、離れたセッションの接続は残らない', () => {
    const forSession = (sid: string) => ({ run: { ...launched.run, id: `r-${sid}`, sessionId: sid }, tabs: [{ ...launched.tabs[0]!, id: `r-${sid}`, runId: `r-${sid}`, sessionId: sid }] });
    const { rt, terminals, setHash } = harness();
    rt.start();
    for (const sid of ['s1', 's2', 's3']) { const r = forSession(sid); rt.dispatch({ kind: 'server', event: { type: 'run.started', run: r.run, tabs: r.tabs } }); }
    setHash('#/session/s1');
    setHash('#/session/s2');
    setHash('#/session/s3');
    setHash('#/');
    expect(terminals.connected).toEqual(['r-s1', 'r-s2', 'r-s3']);
    expect(terminals.disconnected).toEqual(['r-s1', 'r-s2', 'r-s3']);
  });
  it('取り直した bootstrap から消えた run は終わったものとし、そのタブの接続を切る', async () => {
    // サーバの再起動中に Claude が終わると、run.ended は届かない。
    const shell = { ...launched.tabs[0]!, id: 't1', kind: 'shell' as const, title: 'zsh', tmuxName: 'hangar-r1-t1', createdAt: 2 };
    const other = { ...launched.run, id: 'r2', sessionId: 's2', tmuxName: 'hangar-r2' };
    const { rt, terminals, wsHandlers, setHash } = harness({ bootstrap: vi.fn(async () => ({ ...boot, runs: [other], tabs: [{ ...launched.tabs[0]!, id: 'r2', runId: 'r2', sessionId: 's2' }] })) });
    rt.start();
    rt.dispatch({ kind: 'server', event: { type: 'run.started', run: launched.run, tabs: [...launched.tabs, shell] } });
    rt.dispatch({ kind: 'server', event: { type: 'run.started', run: other, tabs: [] } });
    setHash('#/session/s1');
    terminals.disconnected.length = 0;
    wsHandlers[0]!.onOpen();
    await flush();
    expect(terminals.disconnected).toEqual(expect.arrayContaining(['r1', 't1']));
    expect(terminals.disconnected).not.toContain('r2');
    expect(rt.getStore().runs.r1?.endedAt).not.toBeNull();
    expect(rt.getStore().tabs.t1?.closedAt).not.toBeNull();
    expect(rt.getStore().runs.r2?.endedAt).toBeNull();
  });
  it('bootstrap を取り直すたびに、参照されなくなった run を落とす', async () => {
    const ended = { ...launched.run, endedAt: 2, endReason: 'exited' as const };
    const closed = { ...launched.tabs[0]!, closedAt: 3 };
    const seed = (rt: ReturnType<typeof harness>['rt']) => {
      rt.dispatch({ kind: 'server', event: { type: 'run.started', run: launched.run, tabs: launched.tabs } });
      rt.dispatch({ kind: 'server', event: { type: 'run.ended', run: ended } });
      rt.dispatch({ kind: 'server', event: { type: 'tab.upsert', tab: closed } });
    };
    const a = harness();
    a.rt.start();
    seed(a.rt);
    a.wsHandlers[0]!.onOpen();
    await flush();
    expect(a.rt.getStore().runs.r1).toBeUndefined();
    expect(a.rt.getStore().tabs.r1).toBeUndefined();
    // 見ているセッションの run は残す。
    const b = harness();
    b.rt.start();
    seed(b.rt);
    b.setHash('#/session/s1');
    b.wsHandlers[0]!.onOpen();
    await flush();
    expect(b.rt.getStore().runs.r1).toBeDefined();
  });
  it('目次から跳ばした結果を、開いたターンの状態に戻す', async () => {
    const jumpToPrompt = vi.fn(async () => ({ found: false as const, reason: 'notFound' as const }));
    const { rt, setHash } = harness({ jumpToPrompt });
    rt.start();
    setHash('#/session/s1');
    rt.emit({ type: 'turn.open', sessionId: 's1', seq: 4, runId: 'r1', jump: { heads: ['a'], index: 0, from: 'bottom' } });
    expect(rt.getState().sessionView.s1?.turnJump).toEqual({ seq: 4, status: 'pending', runId: 'r1' });
    await flush();
    expect(jumpToPrompt).toHaveBeenCalledWith('r1', { heads: ['a'], index: 0, from: 'bottom' });
    expect(rt.getState().sessionView.s1?.turnJump).toEqual({ seq: 4, status: 'notFound', runId: 'r1' });
  });
  it('transcript から抜けさせるのは、今も生きている run にだけで、断られても知らせない', async () => {
    const aliveRun = p3Run('r1', 's1');
    const leaveTranscript = vi.fn(async () => { throw new Error('run is not alive'); });
    const { rt, setHash } = harness({ leaveTranscript });
    rt.start();
    await flush();
    setHash('#/session/s1');
    // 知らない run（終わって消えた run）には送らない。
    rt.emit({ type: 'turn.latest', sessionId: 's1', runId: 'r1' });
    await flush();
    expect(leaveTranscript).not.toHaveBeenCalled();
    // 終わった run にも送らない。
    rt.dispatch({ kind: 'server', event: { type: 'run.started', run: aliveRun, tabs: [] } });
    rt.dispatch({ kind: 'server', event: { type: 'run.ended', run: { ...aliveRun, endedAt: 2 } } });
    rt.emit({ type: 'turn.latest', sessionId: 's1', runId: 'r1' });
    await flush();
    expect(leaveTranscript).not.toHaveBeenCalled();
    // 生きている run には送る。その間に終わって 409 で断られても、トーストは出さない。
    rt.dispatch({ kind: 'server', event: { type: 'run.started', run: { ...aliveRun, id: 'r2' }, tabs: [] } });
    rt.emit({ type: 'turn.latest', sessionId: 's1', runId: 'r2' });
    await flush();
    expect(leaveTranscript).toHaveBeenCalledWith('r2');
    expect(rt.getState().toasts).toEqual([]);
  });
  it('iTerm2 から Terminal.app に落ちたらトーストで知らせる', async () => {
    const { rt } = harness({ openTerminalApp: vi.fn(async () => ({ app: 'terminal' as const, fellBack: true })) });
    rt.start();
    rt.emit({ type: 'session.openTerminalApp', runId: 'r1' });
    await flush();
    expect(rt.getState().toasts[0]?.message).toContain('Terminal.app');
  });
});

const p3Project = (id: string): ProjectDto => ({ id, name: id, status: 'active', isScratch: false, path: '/w/' + id, resolved: true, lastActivityAt: 1, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 });
const p3Session: SessionDto = { id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: 'p9', name: 's1', cwd: '/w/newp', firstPrompt: null, aiTitle: null, startedAt: 1, lastActivityAt: 1, memo: null, hasTranscript: true, live: null, summary: null, fromScratch: false, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null };
const p3Todo = (id: string, done: boolean): TodoDto => ({ id, projectId: 'p1', text: 'x', done, position: 1, sessionId: null, updatedAt: 1, candidate: null });
const p3Run = (id: string, sessionId: string): RunDto => ({ id, sessionId, deviceId: 'd', kind: 'start', tmuxName: `hangar-${id}`, pid: 1, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 });
const p3Tab = (id: string, runId: string, kind: 'agent' | 'shell'): TabDto => ({ id, runId, sessionId: 's1', kind, title: id, tmuxName: `hangar-${runId}-${id}`, createdAt: Number(id.replace(/\D/g, '') || 0), closedAt: null });

describe('フェーズ 3 の効果', () => {
  it('TODO の追加は前後の空白を落として渡し、削除は id をそのまま渡す', async () => {
    const addTodo = vi.fn(async (projectId: string, text: string) => ({ id: 't9', projectId, text, done: false, position: 1, sessionId: null, updatedAt: 1, candidate: null }));
    const removeTodo = vi.fn(async (id: string) => p3Todo(id, false));
    const { rt, wsHandlers } = harness({ addTodo, removeTodo });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    rt.emit({ type: 'todo.add', projectId: 'p1', text: '  牛乳を買う  ' });
    await flush();
    expect(addTodo).toHaveBeenCalledWith('p1', '牛乳を買う');
    // 空白だけの入力は API まで届かない。
    rt.emit({ type: 'todo.add', projectId: 'p1', text: '   ' });
    await flush();
    expect(addTodo).toHaveBeenCalledTimes(1);
    rt.emit({ type: 'todo.remove', id: 't9' });
    await flush();
    expect(removeTodo).toHaveBeenCalledWith('t9');
  });
  it('TODO の反転はストアの現在値から done を決める', async () => {
    const setTodoDone = vi.fn(async (id: string, done: boolean) => p3Todo(id, done));
    const { rt, wsHandlers } = harness({ setTodoDone });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    wsHandlers[0]!.onEvent({ type: 'todos.update', projectId: 'p1', todos: [p3Todo('t1', false)] });
    rt.emit({ type: 'todo.toggle', id: 't1' });
    await flush();
    expect(setTodoDone).toHaveBeenCalledWith('t1', true);
    wsHandlers[0]!.onEvent({ type: 'todos.update', projectId: 'p1', todos: [p3Todo('t1', true)] });
    rt.emit({ type: 'todo.toggle', id: 't1' });
    await flush();
    expect(setTodoDone).toHaveBeenLastCalledWith('t1', false);
    setTodoDone.mockClear();
    rt.emit({ type: 'todo.toggle', id: 'nope' });
    await flush();
    expect(setTodoDone).not.toHaveBeenCalled();
  });

  it('候補の TODO の反転は確定になり、確定と却下はそのまま API へ渡す', async () => {
    const setTodoDone = vi.fn(async (id: string, done: boolean) => p3Todo(id, done));
    const confirmTodo = vi.fn(async (id: string) => p3Todo(id, true));
    const rejectTodo = vi.fn(async (id: string) => p3Todo(id, false));
    const { rt, wsHandlers } = harness({ setTodoDone, confirmTodo, rejectTodo });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    wsHandlers[0]!.onEvent({ type: 'todos.update', projectId: 'p1', todos: [{ ...p3Todo('t1', false), candidate: { sessionId: 's1', note: 'n', at: 1 } }] });
    rt.emit({ type: 'todo.toggle', id: 't1' });
    await flush();
    // 候補の欄を押したのに done: false を送ると、何も起きずに候補だけが消える。確定と同じに扱う。
    expect(confirmTodo).toHaveBeenCalledWith('t1');
    expect(setTodoDone).not.toHaveBeenCalled();
    rt.emit({ type: 'todo.reject', id: 't1' });
    rt.emit({ type: 'todo.confirm', id: 't1' });
    await flush();
    expect(rejectTodo).toHaveBeenCalledWith('t1');
    expect(confirmTodo).toHaveBeenCalledTimes(2);
  });
  it('完了かつ候補という古い値の反転は、確定ではなく完了の取り消しになる', async () => {
    const setTodoDone = vi.fn(async (id: string, done: boolean) => p3Todo(id, done));
    const confirmTodo = vi.fn(async (id: string) => p3Todo(id, true));
    const { rt, wsHandlers } = harness({ setTodoDone, confirmTodo });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    wsHandlers[0]!.onEvent({ type: 'todos.update', projectId: 'p1', todos: [{ ...p3Todo('t1', true), candidate: { sessionId: 's1', note: 'n', at: 1 } }] });
    rt.emit({ type: 'todo.toggle', id: 't1' });
    await flush();
    expect(setTodoDone).toHaveBeenCalledWith('t1', false);
    expect(confirmTodo).not.toHaveBeenCalled();
  });
  it('メモは読み込みと保存の両方でストアに入る', async () => {
    const memo = vi.fn(async (projectId: string): Promise<MemoDto> => ({ projectId, markdown: '# 読んだ', updatedAt: 5 }));
    const saveMemo = vi.fn(async (projectId: string, markdown: string): Promise<MemoDto> => ({ projectId, markdown, updatedAt: 6 }));
    const { rt, wsHandlers, setHash } = harness({ memo, saveMemo });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    setHash('#/project/p1');
    await flush();
    expect(memo).toHaveBeenCalledWith('p1');
    expect(rt.getStore().memos.p1?.markdown).toBe('# 読んだ');
    rt.emit({ type: 'memo.save', projectId: 'p1', markdown: '# 書いた' });
    await flush();
    expect(saveMemo).toHaveBeenCalledWith('p1', '# 書いた');
    expect(rt.getStore().memos.p1).toEqual({ projectId: 'p1', markdown: '# 書いた', updatedAt: 6 });
  });
  it('セッションのメモはストアのセッションを差し替える', async () => {
    const setSessionMemo = vi.fn(async (sessionId: string, text: string): Promise<SessionDto> => ({ ...p3Session, id: sessionId, memo: text }));
    const { rt, wsHandlers } = harness({ setSessionMemo });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    rt.emit({ type: 'session.setMemo', id: 's1', text: '覚え書き' });
    await flush();
    expect(setSessionMemo).toHaveBeenCalledWith('s1', '覚え書き');
    expect(rt.getStore().sessions.s1?.memo).toBe('覚え書き');
  });
  it('昇格は成功でストアを更新して promote.done、失敗で promote.failed になる', async () => {
    const promote = vi.fn(async () => ({ project: p3Project('p9'), session: p3Session, moved: true, reason: null }));
    const { rt, wsHandlers } = harness({ promote });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    rt.emit({ type: 'session.promote.submit', id: 's1', name: 'newp', gitInit: false, moveFiles: true });
    await flush();
    expect(promote).toHaveBeenCalledWith('s1', { name: 'newp', gitInit: false, moveFiles: true });
    expect(rt.getStore().projects.p9?.name).toBe('p9');
    expect(rt.getState().overlay).toEqual({ kind: 'promoted', projectId: 'p9', moved: true, reason: null });
    const bad = harness({ promote: vi.fn(async () => { throw new Error('409 /api/sessions/s1/promote'); }) });
    bad.rt.start();
    bad.wsHandlers[0]!.onOpen();
    await flush();
    bad.rt.emit({ type: 'session.promote.submit', id: 's1', name: 'taken', gitInit: false, moveFiles: false });
    await flush();
    expect(bad.rt.getState().promote).toEqual({ kind: 'failed', message: '409 /api/sessions/s1/promote' });
  });
  it('アーティファクトは開くだけの操作と、追加でストアに入る操作がある', async () => {
    const artifact = { id: 'a1', projectId: 'p1', url: 'https://x/1', title: null, description: null, favicon: null, filePath: null, fileExists: false, firstPublishedAt: 1, lastPublishedAt: 1, versionCount: 1, sessionIds: [] };
    const addArtifact = vi.fn(async () => artifact);
    const openArtifact = vi.fn(async () => {});
    const openArtifactEditor = vi.fn(async () => {});
    const { rt, wsHandlers } = harness({ addArtifact, openArtifact, openArtifactEditor });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    rt.emit({ type: 'artifact.add', projectId: 'p1', url: 'https://x/1' });
    rt.emit({ type: 'artifact.open', id: 'a1' });
    rt.emit({ type: 'artifact.openEditor', id: 'a1' });
    await flush();
    expect(addArtifact).toHaveBeenCalledWith('p1', 'https://x/1');
    expect(openArtifact).toHaveBeenCalledWith('a1');
    expect(openArtifactEditor).toHaveBeenCalledWith('a1');
    expect(rt.getStore().artifacts.a1).toEqual(artifact);
  });
  it('変更したファイルを開くときはそのファイルを送り、VS Code で開くときは作業ディレクトリ（file なし）を頼む', async () => {
    const openEditor = vi.fn(async (_sessionId: string, _file?: string) => {});
    const { rt } = harness({ openEditor });
    rt.start();
    rt.emit({ type: 'session.openFile', sessionId: 's1', path: '/w/alpha/src/a.ts' });
    rt.emit({ type: 'session.openEditor', sessionId: 's1' });
    await flush();
    // file を落とすと、ファイルではなく作業ディレクトリが開く。
    expect(openEditor.mock.calls).toEqual([['s1', '/w/alpha/src/a.ts'], ['s1']]);
  });
  it('設定画面に入ると statusline と集計とモデル一覧を読む', async () => {
    const statusline = vi.fn(async () => ({ command: 'bash ~/.claude/statusline.sh', scriptPath: '/h/.claude/statusline.sh', installed: true }));
    const usageAggregate = vi.fn(async () => ({ days: [{ day: '2026-09-18', inputTokens: 1, outputTokens: 2, sessions: 1 }], projects: [] }));
    const summarizerModels = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const { rt, wsHandlers, setHash } = harness({ statusline, usageAggregate, summarizerModels });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    setHash('#/settings');
    await flush();
    expect(usageAggregate).toHaveBeenCalledWith(30);
    expect(statusline).toHaveBeenCalledTimes(1);
    expect(summarizerModels).toHaveBeenCalledTimes(1);
    expect(rt.getStore().statusline?.installed).toBe(true);
    expect(rt.getStore().usageAggregate?.days).toHaveLength(1);
    expect(rt.getStore().summarizerModels).toEqual([]);
    // LM Studio に繋がらないのは普通の状態なので、トーストにしない。
    expect(rt.getState().toasts).toEqual([]);
  });
  it('設定画面に入ると GET /api/accounts を呼び、結果を Store に入れる', async () => {
    const accounts = vi.fn(async () => accountsFixture);
    const { rt, wsHandlers, setHash } = harness({ accounts });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    expect(accounts).not.toHaveBeenCalled();
    setHash('#/settings');
    await flush();
    expect(accounts).toHaveBeenCalledTimes(1);
    expect(rt.getStore().accounts).toEqual(accountsFixture);
    expect(rt.getState().toasts).toEqual([]);
  });
  it('GET /api/accounts が失敗したらトーストで知らせ、ほかの取得は進む', async () => {
    const accounts = vi.fn(async () => { throw new Error('500 /api/accounts'); });
    const statusline = vi.fn(async () => ({ command: 'bash statusline.sh', scriptPath: '/h/.claude/statusline.sh', installed: true }));
    const { rt, wsHandlers, setHash } = harness({ accounts, statusline });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    setHash('#/settings');
    await flush();
    expect(accounts).toHaveBeenCalledTimes(1);
    expect(rt.getState().toasts.map((t) => t.message)).toContain('500 /api/accounts');
    expect(rt.getStore().statusline?.installed).toBe(true);
  });
  it('設定を開くと使用量を取り直す', async () => {
    const dto: CloudUsageDto = {
      source: 'cloudflare', fetchedAt: 1_000, stale: false, notice: null,
      limits: { d1RowsPerDay: 100_000, workersRequestsPerDay: 100_000 },
      today: { d1RowsWritten: 23_480, workersRequests: 4_120, resetAt: 2_000 },
      plan: { workersPaid: false, r2Paid: true }, month: null,
    };
    const syncUsage = vi.fn(async () => dto);
    const { rt, wsHandlers, setHash } = harness({ syncUsage });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    expect(rt.getStore().cloudUsage).toBeNull();
    setHash('#/settings');
    await flush();
    // 一時停止の間はサーバが取りに行かないので、ここでは常に取り直しを頼む。
    expect(syncUsage).toHaveBeenCalledWith(true);
    expect(rt.getStore().cloudUsage).toEqual(dto);
  });
  it('要約器を試すと結果がストアに入る', async () => {
    const testSummarizer = vi.fn(async () => ({ ok: true as const, id: 'lmstudio' as const, ms: 12, summary: { title: 'T', oneLiner: 'O', body: 'B', state: 'done' as const, nextSteps: [], source: 'post_hoc' as const, sourceId: 'lmstudio', sourceModel: 'gemma', basedOnTurns: 3 } }));
    const { rt, wsHandlers } = harness({ testSummarizer });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    rt.emit({ type: 'summarizer.test' });
    await flush();
    expect(testSummarizer).toHaveBeenCalledTimes(1);
    expect(rt.getStore().summarizerTest).toMatchObject({ ok: true, id: 'lmstudio', ms: 12 });
    // もう一度試すと、結果が届くまでの間は前回の結果が消えている。
    rt.emit({ type: 'summarizer.test' });
    expect(rt.getStore().summarizerTest).toBeNull();
    await flush();
    expect(rt.getStore().summarizerTest).toMatchObject({ ok: true });
  });
  it('事後要約の作り直しは呼ぶだけで、進みはサーバから届く', async () => {
    const regenerateSummary = vi.fn(async () => {});
    const { rt, wsHandlers } = harness({ regenerateSummary });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    rt.emit({ type: 'summary.regenerate', sessionId: 's1' });
    await flush();
    expect(regenerateSummary).toHaveBeenCalledWith('s1');
  });
  it('分割は選択中でない最初のタブを右にし、タブが 1 つなら知らせる', async () => {
    const { rt, wsHandlers, setHash } = harness();
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    setHash('#/session/s1');
    await flush();
    wsHandlers[0]!.onEvent({ type: 'run.started', run: p3Run('r1', 's1'), tabs: [p3Tab('t1', 'r1', 'agent')] });
    rt.emit({ type: 'split.toggle' });
    await flush();
    expect(rt.getState().sessionView.s1?.split).toBeFalsy();
    expect(rt.getState().toasts.at(-1)?.message).toBe('横に並べるにはタブが 2 つ必要です');
    wsHandlers[0]!.onEvent({ type: 'tab.upsert', tab: p3Tab('t2', 'r1', 'shell') });
    rt.emit({ type: 'tab.select', tabId: 't1' });
    rt.emit({ type: 'split.toggle' });
    await flush();
    expect(rt.getState().sessionView.s1).toMatchObject({ split: true, splitTab: 't2' });
  });
  it('focus の新しい対象は deps.focus に渡る', async () => {
    const { rt, wsHandlers, focus } = harness();
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    rt.emit({ type: 'session.promote.open', id: 's1' });
    expect(rt.getState().overlay).toEqual({ kind: 'promote', sessionId: 's1' });
    expect(focus).toHaveBeenCalledWith('promoteName');
    rt.emit({ type: 'todo.add', projectId: 'p1', text: '買う' });
    await flush();
    expect(focus).toHaveBeenLastCalledWith('todoInput');
  });
});

describe('履歴', () => {
  it('nav.back と nav.forward はブラウザの履歴を動かす', () => {
    const { rt, go } = harness();
    rt.emit({ type: 'nav.go', to: { name: 'projects' } });
    rt.emit({ type: 'nav.back' });
    expect(go).toHaveBeenCalledWith(-1);
    rt.emit({ type: 'nav.forward' });
    expect(go).toHaveBeenCalledWith(1);
  });

  it('確認のダイアログの上でブラウザの戻るが来たら、画面を移さず履歴を戻し直す', () => {
    const { rt, go, browse } = harness();
    rt.start();
    rt.emit({ type: 'nav.go', to: { name: 'projects' } });
    expect(rt.getState().screen).toEqual({ name: 'projects' });
    rt.emit({ type: 'session.kill', runId: 'r1', working: true, shellTabs: 0 });
    expect(rt.getState().overlay.kind).toBe('confirm');
    browse('#/', 0);
    expect(rt.getState().screen).toEqual({ name: 'projects' });
    expect(rt.getState().overlay.kind).toBe('confirm');
    expect(go).toHaveBeenCalledWith(1);
    // 戻し直した変化が届いても、同じ画面なので何も変わらない。
    browse('#/projects', 1);
    expect(rt.getState().screen).toEqual({ name: 'projects' });
    expect(rt.getState().overlay.kind).toBe('confirm');
  });

  it('戻れるかどうかを画面に教えられる', () => {
    // 画面端の矢印は、戻れないときには出さない。
    const { rt } = harness();
    expect(rt.canGoBack()).toBe(false);
    rt.emit({ type: 'nav.go', to: { name: 'projects' } });
    expect(rt.canGoBack()).toBe(true);
  });

  it('アプリの最初の頁からは戻らない', () => {
    // デスクトップでは、その手前がサーバの起動を待つ頁である。そこへ戻ると二度と遷移せず詰む。
    const { rt, go } = harness();
    rt.emit({ type: 'nav.back' });
    expect(go).not.toHaveBeenCalled();
    // 進む側は、戻っていなければ行き先そのものが無いので、そのまま渡してよい。
    rt.emit({ type: 'nav.forward' });
    expect(go).toHaveBeenCalledWith(1);
  });
});

describe('繰り越しの掃除', () => {
  it('別のセッションを開くと、前のセッションの本文を落とす', async () => {
    // 画面に入るたび fromSeq 0 から読み直すので、開いていないセッションの本文は持たない。
    const { rt, setHash } = harness();
    rt.start();
    setHash('#/session/s1');
    await flush();
    rt.emit({ type: 'transcript.loadMore', sessionId: 's1' });
    await flush();
    expect(rt.getStore().events['s1:']?.items).toHaveLength(2);
    setHash('#/session/s2');
    await flush();
    expect(Object.keys(rt.getStore().events)).toEqual(['s2:']);
    // 戻れば読み直す。
    setHash('#/session/s1');
    await flush();
    expect(Object.keys(rt.getStore().events)).toEqual(['s1:']);
    expect(rt.getStore().events['s1:']?.items).toHaveLength(1);
  });
});

describe('索引の進み（ランタイム）', () => {
  const progress = (phase: 'idle' | 'scanning' | 'indexing') => ({ type: 'index.progress' as const, progress: { phase, done: 0, total: 0 } });
  it('走査が終わった瞬間に bootstrap を取り直す', async () => {
    const { rt, api, wsHandlers } = harness();
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    expect(api.bootstrap).toHaveBeenCalledTimes(1);
    wsHandlers[0]!.onEvent(progress('scanning'));
    wsHandlers[0]!.onEvent(progress('indexing'));
    expect(api.bootstrap).toHaveBeenCalledTimes(1);
    wsHandlers[0]!.onEvent(progress('idle'));
    expect(api.bootstrap).toHaveBeenCalledTimes(2);
    await flush();
    // 同じ idle が続いても取り直さない。
    wsHandlers[0]!.onEvent(progress('idle'));
    expect(api.bootstrap).toHaveBeenCalledTimes(2);
  });
  it('走査中に開いて、最初の知らせが idle でも取り直す', async () => {
    // 走査中の bootstrap にはプロジェクトも紐づけも載っていない。段階は Store の 1 か所だけにあるので、bootstrap が運んだ段階からも終わりが分かる。
    const bootstrap = vi.fn(async () => ({ ...boot, index: { phase: 'scanning' as const, done: 0, total: 0 } }));
    const { rt, api, wsHandlers } = harness({ bootstrap });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    wsHandlers[0]!.onEvent(progress('idle'));
    expect(api.bootstrap).toHaveBeenCalledTimes(2);
  });
});

describe('同期とこの PC で再開', () => {
  it('今すぐ同期と一時停止はストアの sync を差し替える', async () => {
    const { rt, api } = harness();
    rt.start();
    rt.emit({ type: 'sync.now' });
    await flush();
    expect(api.syncNow).toHaveBeenCalled();
    expect(rt.getStore().sync?.state).toBe('idle');
    // 応答は Store に直に当たる。ヘッダは Store の sync を読む。
    expect(presentShell(rt.getState(), rt.getStore(), 10).sync).toMatchObject({ visible: true, state: 'idle' });
    rt.emit({ type: 'sync.pause', paused: true });
    await flush();
    expect(api.syncPause).toHaveBeenCalledWith(true);
    expect(rt.getStore().sync?.state).toBe('paused');
    expect(presentShell(rt.getState(), rt.getStore(), 10).sync).toMatchObject({ state: 'paused' });
  });
  it('bootstrap の sync と devices は Store に入り、ヘッダに出る', async () => {
    // 読み込み直した直後にヘッダの同期表示が空にならないことを固定する。
    const device = { id: 'd2', name: 'mini', platform: 'darwin', lastSeenAt: 3, self: false, shell: null };
    const { rt, wsHandlers } = harness({ bootstrap: vi.fn(async () => ({ ...boot, sync: { ...syncStatus, pending: 4 }, devices: [device] })) });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    expect(presentShell(rt.getState(), rt.getStore(), 10).sync).toMatchObject({ visible: true, state: 'idle', pending: '未送信の変更 4' });
    expect(rt.getStore().devices).toEqual([device]);
  });
  it('websocket の sync.status で、片付いた取り残しと回復した失敗が画面から消える', async () => {
    // レビュアの再現筋である。焦点が戻ると 202 だけが返り、状態は websocket だけで届く。
    // その通知が付録を運ばないと、画面の件数は一度受け取った値のまま固まる。
    const stuck = { ...syncStatus, sweepPending: 3, skipped: [{ key: 'transcripts/mini/u1.jsonl.gz', attempts: 3, message: '復号できません' }] };
    const { rt, wsHandlers } = harness({ bootstrap: vi.fn(async () => ({ ...boot, sync: stuck })) });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    expect(rt.getStore().sync).toMatchObject({ sweepPending: 3 });
    expect(rt.getStore().sync?.skipped).toHaveLength(1);
    wsHandlers[0]!.onEvent({ type: 'sync.status', status: { ...stuck, sweepPending: 0, skipped: [] } });
    await flush();
    expect(rt.getStore().sync).toMatchObject({ sweepPending: 0, skipped: [] });
  });
  it('窓が前面に来たら syncFocus を呼び、失敗してもトーストを出さない', async () => {
    const { rt, api, fireFocus } = harness({ syncFocus: vi.fn(async () => { throw new Error('500 /api/sync/focus'); }) });
    rt.start();
    fireFocus();
    await flush();
    expect(api.syncFocus).toHaveBeenCalledTimes(1);
    expect(rt.getState().toasts).toEqual([]);
    rt.stop();
    fireFocus();
    await flush();
    expect(api.syncFocus).toHaveBeenCalledTimes(1);
  });
  it('この PC で再開の 409 は確認ダイアログになる', async () => {
    const { rt, api } = harness({ resumeHere: vi.fn(async () => { throw new ApiConflictError({ error: 'local_smaller', localSize: 10, remoteSize: 99 }); }) });
    rt.start();
    rt.emit({ type: 'session.resumeHere', id: 's1' });
    await flush();
    expect(api.resumeHere).toHaveBeenCalledWith('s1', false);
    expect(rt.getState().overlay).toEqual({ kind: 'confirm', confirm: { kind: 'overwriteTranscript', sessionId: 's1', localSize: 10, remoteSize: 99 } });
    expect(rt.getState().toasts).toEqual([]);
  });
  it('この PC で再開が通れば run がストアに入る', async () => {
    const { rt, api } = harness();
    rt.start();
    rt.emit({ type: 'session.resumeHere', id: 's1', overwrite: true });
    await flush();
    expect(api.resumeHere).toHaveBeenCalledWith('s1', true);
    expect(rt.getStore().runs.r1?.sessionId).toBe('s1');
  });
  it('この PC で再開の 409 以外の失敗はトーストになり、もう一度押せる', async () => {
    const { rt, api } = harness({ resumeHere: vi.fn(async () => { throw new Error('500 /api/sessions/s1/resume-here'); }) });
    rt.start();
    rt.emit({ type: 'session.resumeHere', id: 's1' });
    await flush();
    expect(rt.getState().overlay).toEqual({ kind: 'none' });
    expect(rt.getState().toasts[0]?.message).toContain('500 /api/sessions/s1/resume-here');
    // 送信中が解けていないと、二重送信の歯止めに引っかかって二度と押せなくなる。
    expect(rt.getState().launch).toEqual({ kind: 'failed', message: '500 /api/sessions/s1/resume-here' });
    rt.emit({ type: 'session.resumeHere', id: 's1' });
    await flush();
    expect(api.resumeHere).toHaveBeenCalledTimes(2);
  });
  it('参加トークンを取りに行く', async () => {
    const { rt, api } = harness();
    rt.start();
    rt.emit({ type: 'sync.joinToken.show' });
    await flush();
    expect(rt.getStore().joinToken).toBe('tok');
  });
  it('参加トークンはしばらく置くと自分で消える', async () => {
    const { rt, timers } = harness();
    rt.start();
    rt.emit({ type: 'sync.joinToken.show' });
    await flush();
    expect(rt.getStore().joinToken).toBe('tok');
    const timer = timers.find((t) => t.ms >= 10_000);
    expect(timer).toBeDefined();
    timer!.fn();
    expect(rt.getStore().joinToken).toBeNull();
  });
});

describe('保持期間（ランタイム）', () => {
  const R = { days: 30, source: 'default' as const, userValue: null, writable: true, unwritableReason: null, usage: null };
  const preview = { days: 365, path: '/c/settings.json', lines: [], baseSha256: 'abc', backupDir: '/h/backups/claude-config', projectedBytes: null };
  it('本文の無い会話を開いても、本文を読みに行かない', async () => {
    const s1: SessionDto = { id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: null, name: null, cwd: '/w', firstPrompt: null, aiTitle: null, startedAt: null, lastActivityAt: null, memo: null, hasTranscript: false, live: null, summary: null, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null };
    const { rt, api, wsHandlers, setHash } = harness({ bootstrap: vi.fn(async () => ({ ...boot, sessions: [s1] })) });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    setHash('#/session/s1');
    await flush();
    expect(api.events).not.toHaveBeenCalled();
    expect(rt.getState().toasts).toEqual([]);
  });
  it('書き込みは下見の指紋を送り、成功なら store.retention を入れ替えてトーストを出す', async () => {
    const written = { ...R, days: 365, source: 'user' as const, userValue: 365 };
    const retentionPreview = vi.fn(async () => preview);
    const writeRetention = vi.fn(async () => written);
    const { rt } = harness({ retentionPreview, writeRetention });
    rt.start();
    rt.emit({ type: 'retention.edit', days: 365, from: 'banner' });
    await flush();
    expect(rt.getStore().retentionPreview?.baseSha256).toBe('abc');
    rt.emit({ type: 'retention.write' });
    await flush();
    expect(writeRetention).toHaveBeenCalledWith(365, 'abc');
    expect(rt.getStore().retention).toEqual(written);
    expect(rt.getState().overlay).toEqual({ kind: 'none' });
    expect(rt.getState().toasts.map((t) => t.message)).toEqual(['保持期間を 1 年にしました']);
  });
  it('409 なら読み直したことを出し、下見を取り直す', async () => {
    const retentionPreview = vi.fn(async () => preview);
    const writeRetention = vi.fn(async () => { throw new RetentionConflictApiError(); });
    const { rt } = harness({ retentionPreview, writeRetention });
    rt.start();
    rt.emit({ type: 'retention.edit', days: 365, from: 'banner' });
    await flush();
    rt.emit({ type: 'retention.write' });
    await flush();
    expect(rt.getState().overlay).toMatchObject({ kind: 'retention', reloaded: true, writing: false });
    expect(retentionPreview).toHaveBeenCalledTimes(2);
  });
  it('下見に失敗したら、トーストではなくダイアログに理由を出す', async () => {
    const retentionPreview = vi.fn(async () => { throw new Error('設定ファイルの書式を読み取れなかったので書き換えませんでした'); });
    const { rt } = harness({ retentionPreview });
    rt.start();
    rt.emit({ type: 'retention.edit', days: 365, from: 'banner' });
    await flush();
    expect(rt.getState().overlay).toMatchObject({ kind: 'retention', previewError: '設定ファイルの書式を読み取れなかったので書き換えませんでした' });
    expect(rt.getState().toasts).toEqual([]);
  });
  it('設定画面に入ると保持期間を読み直す', async () => {
    const retention = vi.fn(async () => R);
    const { rt, wsHandlers, setHash } = harness({ retention });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    setHash('#/settings');
    await flush();
    expect(retention).toHaveBeenCalledTimes(1);
    expect(rt.getStore().retention).toEqual(R);
  });
});

describe('入力待ちの知らせ', () => {
  const stats = { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null };
  const waitingSession = (over: Partial<SessionDto> = {}): SessionDto => ({ id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: null, name: '請求書の書き出し', cwd: '/w', firstPrompt: null, aiTitle: null, startedAt: 1, lastActivityAt: 1, memo: null, hasTranscript: true, live: null, summary: null, stats, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, ...over });
  const live = (sessionId: string, status: 'busy' | 'waiting') => ({ sessionId, status, name: null, nameSource: null, cwd: '/w', pid: 1 });
  function fakeNotifier(o: { available?: boolean; defaultOn?: boolean; granted?: boolean; background?: boolean; grant?: boolean; status?: NotifyPermission } = {}) {
    let open: ((id: string) => void) | null = null;
    return {
      defaultOn: o.defaultOn ?? true,
      available: () => o.available ?? true,
      granted: () => o.granted ?? true,
      request: vi.fn(async () => o.grant ?? true),
      prepare: vi.fn(async () => {}),
      status: vi.fn(async (): Promise<NotifyPermission> => o.status ?? 'granted'),
      background: () => o.background ?? true,
      show: vi.fn(),
      badge: vi.fn(),
      onOpen: (cb: (id: string) => void) => { open = cb; return () => { open = null; }; },
      fireOpen: (id: string) => open?.(id),
    };
  }
  async function started(notifier: ReturnType<typeof fakeNotifier> | undefined, sessions: SessionDto[] = [waitingSession()], stored?: boolean) {
    const h = harness({ bootstrap: vi.fn(async () => ({ ...boot, sessions })) }, notifier ? { notifier } : {});
    if (stored !== undefined) h.store.set('notify.waiting', stored);
    h.rt.start();
    h.wsHandlers[0]!.onOpen();
    await flush();
    return h;
  }

  it('live.update をセッションに引き当てて、入力待ちのカードとバッジにする', async () => {
    const n = fakeNotifier();
    const { rt, wsHandlers } = await started(n);
    wsHandlers[0]!.onEvent({ type: 'live.update', live: [live('u1', 'waiting')] });
    expect(rt.getState().waitingToasts).toEqual(['s1']);
    expect(n.badge).toHaveBeenLastCalledWith(1);
    wsHandlers[0]!.onEvent({ type: 'live.update', live: [live('u1', 'busy')] });
    expect(rt.getState().waitingToasts).toEqual([]);
    expect(n.badge).toHaveBeenLastCalledWith(0);
  });
  it('起動したときにもう入力待ちのセッションも、カードにする', async () => {
    const n = fakeNotifier();
    const { rt } = await started(n, [waitingSession({ live: 'waiting' })]);
    expect(rt.getState().waitingToasts).toEqual(['s1']);
    expect(n.badge).toHaveBeenLastCalledWith(1);
  });
  it('窓が背面にあり、受け取る設定なら、名前を題に問いを本文にして通知する', async () => {
    const n = fakeNotifier();
    const { wsHandlers } = await started(n, [waitingSession({ activity: { tool: 'AskUserQuestion', summary: 'AskUserQuestion', question: '用紙の向きをどちらにしますか' } })]);
    wsHandlers[0]!.onEvent({ type: 'live.update', live: [live('u1', 'waiting')] });
    expect(n.show).toHaveBeenCalledWith({ sessionId: 's1', title: '請求書の書き出し', body: '用紙の向きをどちらにしますか' });
  });
  it('問いが取れないときは「入力を待っています」、名前が無ければ「（名前なし）」', async () => {
    const n = fakeNotifier();
    const { wsHandlers } = await started(n, [waitingSession({ name: null })]);
    wsHandlers[0]!.onEvent({ type: 'live.update', live: [live('u1', 'waiting')] });
    expect(n.show).toHaveBeenCalledWith({ sessionId: 's1', title: '（名前なし）', body: '入力待ちです' });
  });
  it('窓が前にあるときと、受け取らない設定のときは通知しない', async () => {
    const front = fakeNotifier({ background: false });
    (await started(front)).wsHandlers[0]!.onEvent({ type: 'live.update', live: [live('u1', 'waiting')] });
    expect(front.show).not.toHaveBeenCalled();
    const off = fakeNotifier();
    (await started(off, undefined, false)).wsHandlers[0]!.onEvent({ type: 'live.update', live: [live('u1', 'waiting')] });
    expect(off.show).not.toHaveBeenCalled();
  });
  it('通知を押したら、そのセッションを開いてターミナルにフォーカスする', async () => {
    const n = fakeNotifier();
    const { rt } = await started(n);
    n.fireOpen('s1');
    expect(rt.getState().screen).toEqual({ name: 'session', id: 's1' });
  });
  it('選んでいなければ環境の既定に従い、既定で受け取る環境ではあらかじめ許可を尋ねておく', async () => {
    const desk = fakeNotifier({ defaultOn: true });
    expect((await started(desk)).rt.getStore().notify).toEqual({ available: true, on: true, blocked: false });
    expect(desk.prepare).toHaveBeenCalledTimes(1);
    const web = fakeNotifier({ defaultOn: false, granted: false });
    expect((await started(web)).rt.getStore().notify).toEqual({ available: true, on: false, blocked: false });
    expect(web.prepare).not.toHaveBeenCalled();
    // 受け取ると選んでいても、ブラウザの許可が外れていれば受け取らない。
    const revoked = fakeNotifier({ defaultOn: false, granted: false });
    expect((await started(revoked, undefined, true)).rt.getStore().notify.on).toBe(false);
  });
  it('受け取るにすると許可を求め、許されたら切り替えて覚える', async () => {
    const n = fakeNotifier({ defaultOn: false, granted: false });
    const { rt, store } = await started(n);
    rt.emit({ type: 'notify.set', on: true });
    expect(n.request).toHaveBeenCalledTimes(1);
    await flush();
    expect(rt.getStore().notify.on).toBe(true);
    expect(store.get('notify.waiting')).toBe(true);
  });
  it('受け取らないにすると、その場で切り替えて覚える', async () => {
    const n = fakeNotifier({ defaultOn: true, granted: true });
    const { rt, store } = await started(n);
    expect(rt.getStore().notify.on).toBe(true);
    rt.emit({ type: 'notify.set', on: false });
    expect(rt.getStore().notify).toEqual({ available: true, on: false, blocked: false });
    expect(store.get('notify.waiting')).toBe(false);
  });
  it('許されなかったら受け取らないままにして、そう知らせる', async () => {
    const n = fakeNotifier({ defaultOn: false, granted: false, grant: false });
    const { rt, store } = await started(n);
    rt.emit({ type: 'notify.set', on: true });
    await flush();
    expect(rt.getStore().notify.on).toBe(false);
    expect(store.get('notify.waiting')).toBeUndefined();
    expect(rt.getState().toasts.at(-1)?.message).toBe('通知が許可されませんでした');
  });
  // デスクトップの許可は OS が持つ。システム設定で切られていたら、受け取るのままにせず、設定に許可の仕方を出す。
  it('OS で通知が切られていれば、起動したときに受け取らないにして、切られていることを持つ', async () => {
    const n = fakeNotifier({ defaultOn: true, status: 'denied' });
    const { rt, store } = await started(n);
    await flush();
    expect(rt.getStore().notify).toEqual({ available: true, on: false, blocked: true });
    // 利用者の選んだ値は書き換えない。OS で許可し直せば、スイッチを入れ直すだけで戻る。
    expect(store.get('notify.waiting')).toBeUndefined();
  });
  it('起動したときに尋ねて断られたときも、受け取らないにする', async () => {
    let answer: NotifyPermission = 'undetermined';
    const n = { ...fakeNotifier({ defaultOn: true }), prepare: vi.fn(async () => { answer = 'denied'; }), status: vi.fn(async () => answer) };
    const { rt } = await started(n);
    await flush();
    expect(n.prepare).toHaveBeenCalledTimes(1);
    expect(rt.getStore().notify).toEqual({ available: true, on: false, blocked: true });
  });
  it('許されていれば、受け取るのまま', async () => {
    const { rt } = await started(fakeNotifier({ defaultOn: true, status: 'granted' }));
    await flush();
    expect(rt.getStore().notify).toEqual({ available: true, on: true, blocked: false });
  });
  it('受け取るにして OS で切られていたら、システム設定で許可するよう知らせる。許されたら切られた印を外す', async () => {
    const n = fakeNotifier({ defaultOn: false, granted: false, grant: false, status: 'denied' });
    const { rt } = await started(n);
    rt.emit({ type: 'notify.set', on: true });
    await flush();
    expect(rt.getStore().notify).toEqual({ available: true, on: false, blocked: true });
    expect(rt.getState().toasts.at(-1)?.message).toBe('通知が切られています。システム設定の「通知」で Hangar を許可してください');
    n.request.mockResolvedValue(true);
    rt.emit({ type: 'notify.set', on: true });
    await flush();
    expect(rt.getStore().notify).toEqual({ available: true, on: true, blocked: false });
  });
  describe('戻る時刻を過ぎた知らせ', () => {
    /** 2026-10-05 の手元の時刻。 */
    const at = (h: number, min = 0) => new Date(2026, 9, 5, h, min).getTime();
    const timed = (id: string, returnTime: string | null, note = 'timer の初回を見る'): SessionDto => ({ ...waitingSession(), id, providerSessionId: 'u-' + id, name: '会話 ' + id, live: null, state: { status: 'paused', note, returnOn: '2026-10-05', returnTime, setBy: 'conversation', setAt: 1, candidate: null } });
    async function startedAt(clock: { now: number }, sessions: SessionDto[], n = fakeNotifier(), seen?: string[]) {
      const h = harness({ bootstrap: vi.fn(async () => ({ ...boot, sessions })) }, { notifier: n, now: () => clock.now });
      if (seen) h.store.set('return.notified', seen);
      h.rt.start();
      h.wsHandlers[0]!.onOpen();
      await flush();
      return { ...h, n };
    }
    it('時刻の前は何も出さず、その時刻に見直す予約を入れ、時刻が来たら通知を 1 回出す', async () => {
      const clock = { now: at(13, 0) };
      const h = await startedAt(clock, [timed('s1', '13:30'), timed('s2', null)]);
      expect(h.rt.getState().returnSeen).toEqual([]);
      expect(h.n.show).not.toHaveBeenCalled();
      const timer = h.timers.find((t) => t.ms === 30 * 60_000);
      expect(timer).toBeDefined();
      clock.now = at(13, 30);
      timer!.fn();
      expect(h.rt.getState().returnSeen).toEqual(['s1|2026-10-05 13:30']);
      expect(h.n.show).toHaveBeenCalledTimes(1);
      expect(h.n.show).toHaveBeenCalledWith({ sessionId: 's1', title: '会話 s1', body: 'リマインダーの時刻 13:30 を過ぎました · timer の初回を見る' });
      expect(h.store.get('return.notified')).toEqual(['s1|2026-10-05 13:30']);
      // 同じ予約がもう一度走っても、ストアが変わっても、2 度は出さない。
      timer!.fn();
      h.wsHandlers[0]!.onEvent({ type: 'session.upsert', session: timed('s2', null, '別の理由') });
      expect(h.n.show).toHaveBeenCalledTimes(1);
    });
    it('ストアが変わるたびに予約を積まない（次の時点が同じなら予約は 1 つ）', async () => {
      const clock = { now: at(13, 0) };
      const h = await startedAt(clock, [timed('s1', '13:30')]);
      const count = () => h.timers.filter((t) => t.ms === 30 * 60_000).length;
      expect(count()).toBe(1);
      h.wsHandlers[0]!.onEvent({ type: 'session.upsert', session: timed('s2', null) });
      h.wsHandlers[0]!.onEvent({ type: 'session.upsert', session: timed('s3', null) });
      expect(count()).toBe(1);
    });
    it('閉じている間に過ぎた今日の時点は、開いたときに 1 回知らせる。前に知らせ終えたものは出さない', async () => {
      const clock = { now: at(14, 0) };
      const fresh = await startedAt(clock, [timed('s1', '13:30')]);
      expect(fresh.rt.getState().returnSeen).toEqual(['s1|2026-10-05 13:30']);
      expect(fresh.n.show).toHaveBeenCalledTimes(1);
      const again = await startedAt(clock, [timed('s1', '13:30')], fakeNotifier(), ['s1|2026-10-05 13:30']);
      expect(again.n.show).not.toHaveBeenCalled();
    });
    it('窓が前にあるときと、通知を受け取らないときは、OS の通知を出さない（ベルの一覧には行が出る）', async () => {
      const clock = { now: at(14, 0) };
      const front = await startedAt(clock, [timed('s1', '13:30')], fakeNotifier({ background: false }));
      expect(front.rt.getState().returnSeen).toEqual(['s1|2026-10-05 13:30']);
      expect(front.n.show).not.toHaveBeenCalled();
      const off = fakeNotifier();
      const h = harness({ bootstrap: vi.fn(async () => ({ ...boot, sessions: [timed('s1', '13:30')] })) }, { notifier: off, now: () => clock.now });
      h.store.set('notify.waiting', false);
      h.rt.start();
      h.wsHandlers[0]!.onOpen();
      await flush();
      expect(off.show).not.toHaveBeenCalled();
    });
    it('時刻を付け直すと、新しい時点でもう一度知らせる', async () => {
      const clock = { now: at(14, 0) };
      const h = await startedAt(clock, [timed('s1', '13:30')]);
      h.wsHandlers[0]!.onEvent({ type: 'session.upsert', session: timed('s1', '21:50') });
      expect(h.rt.getState().returnSeen).toEqual([]);
      clock.now = at(21, 50);
      h.timers.at(-1)!.fn();
      expect(h.rt.getState().returnSeen).toEqual(['s1|2026-10-05 21:50']);
      expect(h.n.show).toHaveBeenCalledTimes(2);
      expect(h.n.show).toHaveBeenLastCalledWith({ sessionId: 's1', title: '会話 s1', body: 'リマインダーの時刻 21:50 を過ぎました · timer の初回を見る' });
    });
  });
  // OS やブラウザの許可は、hangar の外（システム設定、ブラウザの設定）で変わる。
  // 窓が前面に戻ったときに読み直し、利用者が受け取ると選んでいれば、許可に合わせて受け取るを戻したり外したりする。
  describe('窓が前面に戻ったときの許可の読み直し', () => {
    /** 許可を外から書き換えられる偽の notifier。desktop は OS が許可を持つ殻、web はブラウザである。 */
    function mutableNotifier(kind: 'desktop' | 'web', initial: NotifyPermission) {
      let perm = initial;
      const base = fakeNotifier({ defaultOn: kind === 'desktop' });
      return {
        ...base,
        available: () => kind === 'desktop' || perm !== 'denied',
        granted: () => kind === 'desktop' || perm === 'granted',
        status: vi.fn(async (): Promise<NotifyPermission> => perm),
        set: (p: NotifyPermission) => { perm = p; },
      };
    }
    async function boot2(n: ReturnType<typeof mutableNotifier>, stored?: boolean) {
      let clock = 100_000;
      const visible = new Set<() => void>();
      const h = harness({ bootstrap: vi.fn(async () => ({ ...boot, sessions: [] })) }, { notifier: n, now: () => clock, onWindowVisible: (cb) => { visible.add(cb); return () => visible.delete(cb); } });
      if (stored !== undefined) h.store.set('notify.waiting', stored);
      h.rt.start();
      h.wsHandlers[0]!.onOpen();
      await flush();
      return { ...h, fireVisible: () => { for (const l of visible) l(); }, advance: (ms: number) => { clock += ms; } };
    }

    it('OS で切られていたのを許可して戻ったら、受け取るに戻す', async () => {
      const n = mutableNotifier('desktop', 'denied');
      const h = await boot2(n, true);
      expect(h.rt.getStore().notify).toEqual({ available: true, on: false, blocked: true });
      n.set('granted');
      h.advance(5000);
      h.fireFocus();
      await flush();
      expect(h.rt.getStore().notify).toEqual({ available: true, on: true, blocked: false });
      expect(h.store.get('notify.waiting')).toBe(true);
    });
    it('受け取っている間に OS で切られたら、受け取らないにして設定の仕方を知らせる', async () => {
      const n = mutableNotifier('desktop', 'granted');
      const h = await boot2(n);
      expect(h.rt.getStore().notify).toEqual({ available: true, on: true, blocked: false });
      n.set('denied');
      h.advance(5000);
      h.fireVisible();
      await flush();
      expect(h.rt.getStore().notify).toEqual({ available: true, on: false, blocked: true });
      expect(h.rt.getState().toasts.at(-1)?.message).toBe('通知が切られています。システム設定の「通知」で Hangar を許可してください');
      // 利用者の選んだ値は書き換えない。許可し直して戻れば、受け取るに戻る。
      expect(h.store.has('notify.waiting')).toBe(false);
      n.set('granted');
      h.advance(5000);
      h.fireFocus();
      await flush();
      expect(h.rt.getStore().notify).toEqual({ available: true, on: true, blocked: false });
    });
    it('受け取らないと選んでいれば、許可されても受け取るにしない', async () => {
      const n = mutableNotifier('desktop', 'denied');
      const h = await boot2(n, false);
      n.set('granted');
      h.advance(5000);
      h.fireFocus();
      await flush();
      expect(h.rt.getStore().notify.on).toBe(false);
    });
    it('ブラウザの許可も同じ契機で読み直す', async () => {
      const n = mutableNotifier('web', 'denied');
      const h = await boot2(n, true);
      expect(h.rt.getStore().notify).toEqual({ available: false, on: false, blocked: false });
      n.set('granted');
      h.advance(5000);
      h.fireVisible();
      await flush();
      expect(h.rt.getStore().notify).toEqual({ available: true, on: true, blocked: false });
      n.set('denied');
      h.advance(5000);
      h.fireFocus();
      await flush();
      expect(h.rt.getStore().notify).toEqual({ available: false, on: false, blocked: false });
    });
    it('読んでいる間にスイッチを切られたら、答えが届いた時点の選んだ値と状態で決める', async () => {
      // 許可されたと届いても、切った後なので受け取るに戻さない。
      const n = mutableNotifier('desktop', 'granted');
      const h = await boot2(n, true);
      let answer!: (p: NotifyPermission) => void;
      n.status.mockImplementationOnce(() => new Promise<NotifyPermission>((r) => { answer = r; }));
      h.advance(5000);
      h.fireFocus();
      h.rt.emit({ type: 'notify.set', on: false });
      answer('granted');
      await flush();
      expect(h.rt.getStore().notify).toEqual({ available: true, on: false, blocked: false });
      // 切られたと届いても、もう受け取っていないので設定の仕方は知らせない。
      const m = mutableNotifier('desktop', 'granted');
      const k = await boot2(m, true);
      m.status.mockImplementationOnce(() => new Promise<NotifyPermission>((r) => { answer = r; }));
      k.advance(5000);
      k.fireFocus();
      k.rt.emit({ type: 'notify.set', on: false });
      answer('denied');
      await flush();
      expect(k.rt.getStore().notify).toEqual({ available: true, on: false, blocked: true });
      expect(k.rt.getState().toasts).toEqual([]);
    });
    it('設定の仕方を知らせるのは、受け取っていたのに OS で切られたときだけ', async () => {
      // 受け取らないと選んでいた。
      const n = mutableNotifier('desktop', 'granted');
      const h = await boot2(n, false);
      n.set('denied');
      h.advance(5000);
      h.fireFocus();
      await flush();
      expect(h.rt.getStore().notify.blocked).toBe(true);
      expect(h.rt.getState().toasts).toEqual([]);
      // ブラウザで拒まれたのは OS の設定ではない。
      const m = mutableNotifier('web', 'granted');
      const k = await boot2(m, true);
      expect(k.rt.getStore().notify.on).toBe(true);
      m.set('denied');
      k.advance(5000);
      k.fireFocus();
      await flush();
      expect(k.rt.getStore().notify.on).toBe(false);
      expect(k.rt.getState().toasts).toEqual([]);
    });
    it('最後に読んでから 2 秒以内は読み直さない', async () => {
      const n = mutableNotifier('desktop', 'granted');
      const h = await boot2(n, false);
      const before = n.status.mock.calls.length;
      h.fireFocus();
      h.fireVisible();
      await flush();
      expect(n.status.mock.calls.length).toBe(before + 1);
      h.advance(1999);
      h.fireFocus();
      await flush();
      expect(n.status.mock.calls.length).toBe(before + 1);
      h.advance(1);
      h.fireFocus();
      await flush();
      expect(n.status.mock.calls.length).toBe(before + 2);
    });
  });
  it('通知の仕組みが無い環境でも、カードは積む', async () => {
    const { rt, wsHandlers } = await started(undefined);
    wsHandlers[0]!.onEvent({ type: 'live.update', live: [live('u1', 'waiting')] });
    expect(rt.getState().waitingToasts).toEqual(['s1']);
    expect(rt.getStore().notify).toEqual({ available: false, on: false, blocked: false });
  });
});

describe('設定の欄ごとの保存と準備の確かめ（ランタイム）', () => {
  const READY = {
    tools: { tmux: { path: '/bin/tmux', ok: true, problem: null, version: '3.4' }, claude: { path: '/bin/claude', ok: true, problem: null, version: '2.3.1' }, code: { path: null, ok: false, problem: 'unset' as const, version: null }, node: { path: '/bin/node', ok: true, problem: null, version: 'v22.9.0', auto: true } },
    workspace: { path: '/w', exists: true, projectCount: 12 }, mcp: { registered: false, file: '/h/.claude.json' }, statusline: { command: null, scriptPath: null, installed: false },
    commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install', shell: 'hangar shell install' },
    compat: { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 },
  };
  it('保存できたら欄に印を付け、準備の確かめを取り直す', async () => {
    const readiness = vi.fn(async () => READY);
    const { rt, api } = harness({ readiness });
    rt.start();
    rt.emit({ type: 'settings.update', patch: { tmuxPath: '/bin/tmux' }, field: 'tmuxPath' });
    await flush();
    expect(api.updateSettings).toHaveBeenCalledWith({ tmuxPath: '/bin/tmux' });
    expect(rt.getStore().settings?.tmuxPath).toBe('/bin/tmux');
    expect(rt.getState().settingsSave.tmuxPath).toEqual({ kind: 'saved', n: 1 });
    await flush();
    expect(readiness).toHaveBeenCalled();
    expect(rt.getStore().readiness).toEqual(READY);
  });
  it('保存を断られたら、理由を欄に返し、トーストにしない', async () => {
    const { rt } = harness({ updateSettings: vi.fn(async () => { throw new Error('「tmux のパス」に /x が見つかりません'); }) });
    rt.start();
    rt.emit({ type: 'settings.update', patch: { tmuxPath: '/x' }, field: 'tmuxPath' });
    await flush();
    expect(rt.getState().settingsSave.tmuxPath).toEqual({ kind: 'error', message: '「tmux のパス」に /x が見つかりません' });
    expect(rt.getState().toasts).toEqual([]);
  });
  it('設定の画面に入ると準備の確かめも取る。もう一度確かめるでも取る', async () => {
    const readiness = vi.fn(async () => READY);
    const { rt, setHash } = harness({ readiness });
    rt.start();
    setHash('#/settings');
    await flush();
    expect(readiness).toHaveBeenCalledTimes(1);
    rt.emit({ type: 'readiness.check' });
    await flush();
    expect(readiness).toHaveBeenCalledTimes(2);
  });
  it('起動のたびに、ホームの帯の確認のために準備の確かめを取る（セッションが 1 つも無いときに限らない）', async () => {
    const s1: SessionDto = { id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: null, name: null, cwd: '/w', firstPrompt: null, aiTitle: null, startedAt: null, lastActivityAt: null, memo: null, hasTranscript: false, live: null, summary: null, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null };
    for (const sessions of [[], [s1]]) {
      const readiness = vi.fn(async () => READY);
      const { rt, wsHandlers } = harness({ readiness, bootstrap: vi.fn(async () => ({ ...boot, sessions })) });
      rt.start();
      wsHandlers[0]!.onOpen();
      await flush();
      await flush();
      expect([sessions.length, readiness.mock.calls.length]).toEqual([sessions.length, 1]);
      expect(rt.getStore().readiness).toEqual(READY);
    }
  });
  describe('そろったときのトースト（2.11.4）', () => {
    const PENDING = { ...READY, workspace: { ...READY.workspace, projectCount: 0 } };
    const OPTIONAL_LEFT = READY;
    const COMPLETE = { ...READY, mcp: { ...READY.mcp, registered: true }, statusline: { ...READY.statusline, installed: true } };
    /** 答えを順に返す。呼ぶたびに 1 つ進む。 */
    const run = async (answers: unknown[]) => {
      const readiness = vi.fn(async () => answers.shift() as never);
      const { rt } = harness({ readiness });
      rt.start();
      for (let i = 0; i < 3; i++) { rt.emit({ type: 'readiness.check' }); await flush(); }
      return rt;
    };
    it('直すものがあった後で全部そろったら、トーストを 1 回だけ出す。取り直しを重ねても繰り返さない', async () => {
      const rt = await run([PENDING, COMPLETE, COMPLETE]);
      expect(rt.getState().toasts.map((t) => t.message)).toEqual(['セットアップは完了しています。設定の「情報」でいつでも確認できます']);
    });
    it('必須が済んで任意の行だけが残ったときは、帯が消えるので、任意が設定の「連携」に残ることをトーストで言う', async () => {
      const rt = await run([PENDING, OPTIONAL_LEFT, OPTIONAL_LEFT]);
      expect(rt.getState().toasts.map((t) => t.message)).toEqual(['必要な準備は完了しました。MCP とステータスラインは設定の「連携」で設定できます']);
    });
    it('最初の取得で、すでにそろっているときは出さない（そろったのではなく、はじめから問題が無い）', async () => {
      const rt = await run([COMPLETE, COMPLETE, COMPLETE]);
      expect(rt.getState().toasts).toEqual([]);
    });
    it('直すものが残っている間は出さない', async () => {
      const rt = await run([PENDING, PENDING, PENDING]);
      expect(rt.getState().toasts).toEqual([]);
    });
  });
  it('互換にずれがあれば、準備の確かめに続けてずれの中身を取る。ずれが無くなれば中身を捨てる', async () => {
    const DETAIL = { verifiedVersion: '2.1.292', localVersion: '2.1.300', drifts: [{ contract: 'registry' as const, value: 'status=compacting', version: '2.1.300', count: 1, firstSeenAt: 1, lastSeenAt: 2 }] };
    let driftCount = 1;
    const readiness = vi.fn(async () => ({ ...READY, compat: { verifiedVersion: '2.1.292', localVersion: '2.1.300', driftCount } }));
    const compat = vi.fn(async () => DETAIL);
    const { rt } = harness({ readiness, compat });
    rt.start();
    rt.emit({ type: 'readiness.check' });
    await flush();
    await flush();
    expect(compat).toHaveBeenCalledTimes(1);
    expect(rt.getStore().compat).toEqual(DETAIL);
    driftCount = 0;
    rt.emit({ type: 'readiness.check' });
    await flush();
    await flush();
    expect(compat).toHaveBeenCalledTimes(1);
    expect(rt.getStore().compat).toBeNull();
  });
  it('ずれが無い答えと、compat の無い古いサーバの答えでは、ずれの中身を取りに行かない', async () => {
    const compat = vi.fn(async () => ({ verifiedVersion: '2.1.292', localVersion: null, drifts: [] }));
    const { compat: _drop, ...older } = READY;
    let answer: unknown = READY;
    const { rt } = harness({ readiness: vi.fn(async () => answer as never), compat });
    rt.start();
    rt.emit({ type: 'readiness.check' });
    await flush();
    answer = older;
    rt.emit({ type: 'readiness.check' });
    await flush();
    await flush();
    expect(compat).not.toHaveBeenCalled();
    expect(rt.getStore().readiness).toEqual(older);
    expect(rt.getStore().compat).toBeNull();
  });
  it('ずれ有りの答えのずれの中身が遅れて着いても、その後に届いた「ずれ無し」の答えの後では store に入れない', async () => {
    const DETAIL = { verifiedVersion: '2.1.292', localVersion: '2.1.300', drifts: [{ contract: 'registry' as const, value: 'status=compacting', version: '2.1.300', count: 1, firstSeenAt: 1, lastSeenAt: 2 }] };
    const withDrifts = { ...READY, compat: { verifiedVersion: '2.1.292', localVersion: '2.1.300', driftCount: 1 } };
    let resolveCompat: (v: typeof DETAIL) => void = () => {};
    const compat = vi.fn(() => new Promise<typeof DETAIL>((r) => { resolveCompat = r; }));
    const answers = [withDrifts, READY];
    const { rt } = harness({ readiness: vi.fn(async () => answers.shift()!), compat });
    rt.start();
    rt.emit({ type: 'readiness.check' });
    await flush();
    expect(compat).toHaveBeenCalledTimes(1);
    rt.emit({ type: 'readiness.check' });
    await flush();
    expect(rt.getStore().readiness).toEqual(READY);
    resolveCompat(DETAIL);
    await flush();
    expect(rt.getStore().readiness).toEqual(READY);
    expect(rt.getStore().compat).toBeNull();
  });
  it('準備の確かめの答えが順番を違えて着いたら、新しい要求の答えだけを取る', async () => {
    const DETAIL = { verifiedVersion: '2.1.292', localVersion: '2.1.300', drifts: [{ contract: 'registry' as const, value: 'status=compacting', version: '2.1.300', count: 1, firstSeenAt: 1, lastSeenAt: 2 }] };
    const withDrifts = { ...READY, compat: { verifiedVersion: '2.1.292', localVersion: '2.1.300', driftCount: 1 } };
    const resolvers: ((v: typeof READY) => void)[] = [];
    const readiness = vi.fn(() => new Promise<typeof READY>((r) => { resolvers.push(r); }));
    const compat = vi.fn(async () => DETAIL);
    const { rt } = harness({ readiness, compat });
    rt.start();
    // 古い要求（ずれ無し）と、新しい要求（ずれ有り）。新しい方が先に着く。
    rt.emit({ type: 'readiness.check' });
    rt.emit({ type: 'readiness.check' });
    expect(readiness).toHaveBeenCalledTimes(2);
    resolvers[1]!(withDrifts);
    await flush();
    await flush();
    expect(rt.getStore().readiness).toEqual(withDrifts);
    expect(rt.getStore().compat).toEqual(DETAIL);
    resolvers[0]!(READY);
    await flush();
    await flush();
    expect(rt.getStore().readiness).toEqual(withDrifts);
    expect(rt.getStore().compat).toEqual(DETAIL);
    expect(compat).toHaveBeenCalledTimes(1);
  });
  it('参加トークンは消える時刻と一緒に置く', async () => {
    const { rt } = harness({}, { now: () => 1_000 });
    rt.start();
    rt.emit({ type: 'sync.joinToken.show' });
    await flush();
    expect(rt.getStore().joinTokenExpiresAt).toBe(121_000);
  });
});

describe('殻の操作（ランタイム）', () => {
  it('殻があれば、ログを開くと再起動を殻に頼む', async () => {
    const desktop = { openLog: vi.fn(async () => {}), restart: vi.fn(async () => {}), pickFolder: vi.fn(async () => null), applyConfigSync: vi.fn(), restoreConfigSync: vi.fn() };
    const { rt } = harness({}, { desktop });
    rt.start();
    expect(rt.getStore().desktop).toBe(true);
    rt.emit({ type: 'shell.openLog' });
    rt.emit({ type: 'shell.restart' });
    await flush();
    expect(desktop.openLog).toHaveBeenCalled();
    expect(desktop.restart).toHaveBeenCalled();
  });
  it('殻が断ったらトーストで知らせる', async () => {
    const desktop = { openLog: vi.fn(async () => { throw new Error('denied'); }), restart: vi.fn(async () => {}), pickFolder: vi.fn(async () => null), applyConfigSync: vi.fn(), restoreConfigSync: vi.fn() };
    const { rt } = harness({}, { desktop });
    rt.start();
    rt.emit({ type: 'shell.openLog' });
    await flush();
    expect(rt.getState().toasts.map((t) => t.message)).toEqual(['ログを開けませんでした: denied']);
  });
  it('殻の無いブラウザでは desktop が偽で、コピーはクリップボードに書く', async () => {
    const clipboard = vi.fn(async () => {});
    const { rt } = harness({}, { clipboard });
    rt.start();
    expect(rt.getStore().desktop).toBe(false);
    rt.emit({ type: 'clipboard.copy', text: '~/.agent-hangar/desktop.log' });
    await flush();
    expect(clipboard).toHaveBeenCalledWith('~/.agent-hangar/desktop.log');
    // 写せたことを状態に返す。ボタンはこれを見てから「コピーしました」を出す。
    expect(rt.getState().copied).toEqual({ text: '~/.agent-hangar/desktop.log', n: 1 });
  });
  // 参加トークンのような秘密も写すので、写せなかったときに中身をトーストへ出さない。
  it('コピーに失敗したら、中身を出さずに知らせ、写せた印は付けない', async () => {
    const clipboard = vi.fn(async () => { throw new Error('denied'); });
    const { rt } = harness({}, { clipboard });
    rt.start();
    rt.emit({ type: 'clipboard.copy', text: 'secret-token-123' });
    await flush();
    const messages = rt.getState().toasts.map((t) => t.message);
    expect(messages).toEqual(['コピーできませんでした。文字を選択して ⌘C でコピーしてください']);
    expect(messages.join('')).not.toContain('secret-token-123');
    expect(rt.getState().copied).toBeNull();
  });
});

describe('セッションの状態', () => {
  const NONE = { status: null, note: null, returnOn: null, returnTime: null, setBy: null, setAt: null, candidate: null };
  it('状態の操作をそのまま API へ渡し、失敗はトーストにする', async () => {
    const setSessionState = vi.fn(async () => { throw new Error('Paused にはリマインダーの日付が要ります'); });
    const confirmSessionState = vi.fn(async () => ({ state: NONE }));
    const rejectSessionState = vi.fn(async () => ({ state: NONE }));
    const { rt, wsHandlers } = harness({ setSessionState, confirmSessionState, rejectSessionState });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    rt.emit({ type: 'session.state.set', id: 's1', status: 'paused' });
    rt.emit({ type: 'session.state.confirm', id: 's1', returnOn: '2026-10-05' });
    rt.emit({ type: 'session.state.reject', id: 's1' });
    await flush();
    expect(setSessionState).toHaveBeenCalledWith('s1', { status: 'paused' });
    expect(confirmSessionState).toHaveBeenCalledWith('s1', { returnOn: '2026-10-05' });
    expect(rejectSessionState).toHaveBeenCalledWith('s1');
    expect(rt.getState().toasts.at(-1)).toMatchObject({ level: 'error', message: 'Paused にはリマインダーの日付が要ります' });
  });
});

describe('サイドバーの「動いている」の並び（ランタイム）', () => {
  const running = (id: string, startedAt: number, live: SessionDto['live'] = 'busy'): SessionDto => ({ ...p3Session, id, providerSessionId: 'u-' + id, projectId: null, live, startedAt });
  const liveRow = (sessionId: string, status: 'busy' | 'waiting') => ({ sessionId, status, name: null, nameSource: null, cwd: '/w', pid: 1 });
  async function started(sessions: SessionDto[], stored?: unknown) {
    const h = harness({ bootstrap: vi.fn(async () => ({ ...boot, sessions })) });
    if (stored !== undefined) h.store.set('sidebar.order', stored);
    h.rt.start();
    h.wsHandlers[0]!.onOpen();
    await flush();
    return h;
  }

  it('保存が空なら、動いているセッションを始めた順で並びに書き足して保存する', async () => {
    const h = await started([running('s2', 20, 'waiting'), running('s1', 10), { ...running('s3', 5), live: null }]);
    expect(h.rt.getState().sidebarOrder).toEqual(['s1', 's2']);
    expect(h.store.get('sidebar.order')).toEqual(['s1', 's2']);
  });
  it('覚えた並びは保ち、初めて現れたものだけを末尾に足す', async () => {
    const h = await started([running('s1', 10), running('s2', 20), running('s3', 30)], ['s3', 'gone', 's1']);
    expect(h.rt.getState().sidebarOrder).toEqual(['s3', 'gone', 's1', 's2']);
  });
  it('入力待ちに変わっても、動いているものが一瞬消えても、並びは変わらない', async () => {
    const h = await started([running('s1', 10), running('s2', 20)]);
    h.wsHandlers[0]!.onEvent({ type: 'live.update', live: [liveRow('u-s2', 'waiting'), liveRow('u-s1', 'busy')] });
    expect(h.rt.getState().sidebarOrder).toEqual(['s1', 's2']);
    h.wsHandlers[0]!.onEvent({ type: 'live.update', live: [] });
    expect(h.rt.getState().sidebarOrder).toEqual(['s1', 's2']);
    h.wsHandlers[0]!.onEvent({ type: 'live.update', live: [liveRow('u-s2', 'busy'), liveRow('u-s1', 'busy')] });
    expect(h.rt.getState().sidebarOrder).toEqual(['s1', 's2']);
    expect(h.store.get('sidebar.order')).toEqual(['s1', 's2']);
  });
});

describe('アカウント', () => {
  const univ = accountsFixture.accounts[1]!;
  async function started(overrides: Partial<ApiClient> = {}) {
    const h = harness(overrides);
    h.rt.start();
    h.wsHandlers[0]!.onOpen();
    await flush();
    return h;
  }
  it('bootstrap の accounts が Store に入る', async () => {
    const h = await started({ bootstrap: vi.fn(async () => ({ ...boot, accounts: accountsFixture })) });
    expect(h.rt.getStore().accounts).toEqual(accountsFixture);
  });
  it('account.choose は setCurrentAccount を呼び、応答の AccountsDto を Store に入れる', async () => {
    const next = { ...accountsFixture, currentId: 'a1' };
    const h = await started({ setCurrentAccount: vi.fn(async () => next) });
    h.rt.emit({ type: 'account.choose', accountId: 'a1' });
    await flush();
    expect(h.api.setCurrentAccount).toHaveBeenCalledWith('a1');
    expect(h.rt.getStore().accounts).toEqual(next);
  });
  it('accounts.load は一覧を取り、Store に入れる', async () => {
    const h = await started();
    h.rt.emit({ type: 'accounts.load' });
    await flush();
    expect(h.api.accounts).toHaveBeenCalledTimes(1);
    expect(h.rt.getStore().accounts).toEqual(accountsFixture);
  });
  it('account.add は addAccount のあと、応答の末尾のアカウントの id で loginAccount を呼ぶ', async () => {
    const added = { ...univ, id: 'a2', name: '研究室', color: '#1f7a5a', auth: null, loginRunning: false };
    const next = { ...accountsFixture, accounts: [...accountsFixture.accounts, added] };
    const h = await started({ addAccount: vi.fn(async () => next) });
    h.rt.emit({ type: 'account.add', name: ' 研究室 ' });
    await flush();
    expect(h.api.addAccount).toHaveBeenCalledWith('研究室');
    expect(h.api.loginAccount).toHaveBeenCalledTimes(1);
    expect(h.api.loginAccount).toHaveBeenCalledWith('a2');
    expect(h.rt.getStore().accounts).toEqual(next);
  });
  it('account.add の追加に失敗したら、ログインは始めず、サーバの文をトーストに出す', async () => {
    const h = await started({ addAccount: vi.fn(async () => { throw new Error('その名前はもう使われています'); }) });
    h.rt.emit({ type: 'account.add', name: '大学' });
    await flush();
    expect(h.api.loginAccount).not.toHaveBeenCalled();
    expect(h.rt.getState().toasts.map((t) => t.message)).toEqual(['その名前はもう使われています']);
  });
  it('account.switchSession（承諾）は switchAccount を呼び、成功で run が入ってそのセッションの画面へ移る', async () => {
    const h = await started({ switchAccount: vi.fn(async () => launched) });
    h.setHash('#/');
    h.rt.emit({ type: 'account.switchSession', sessionId: 's1', accountId: 'a1', working: false });
    expect(h.rt.getState().overlay).toEqual({ kind: 'confirm', confirm: { kind: 'switchAccount', sessionId: 's1', accountId: 'a1', working: false } });
    expect(h.api.switchAccount).not.toHaveBeenCalled();
    h.rt.emit({ type: 'account.switchSession', sessionId: 's1', accountId: 'a1', working: false, confirmed: true });
    await flush();
    expect(h.api.switchAccount).toHaveBeenCalledWith('s1', 'a1');
    expect(h.rt.getStore().runs.r1).toBeDefined();
    expect(h.rt.getState()).toMatchObject({ launch: { kind: 'idle' }, overlay: { kind: 'none' }, screen: { name: 'session', id: 's1' } });
  });
  it('account.switchSession の失敗は、サーバの文をトーストに出し、launch は submitting のまま残らない', async () => {
    const h = await started({ switchAccount: vi.fn(async () => { throw new Error('このセッションはもうそのアカウントで実行中です'); }) });
    h.rt.emit({ type: 'account.switchSession', sessionId: 's1', accountId: 'a1', working: true, confirmed: true });
    await flush();
    expect(h.rt.getState().launch).toEqual({ kind: 'failed', message: 'このセッションはもうそのアカウントで実行中です' });
    expect(h.rt.getState().toasts.map((t) => t.message)).toEqual(['このセッションはもうそのアカウントで実行中です']);
  });
  it('account.login が 409 で失敗したら、その文をトーストに出す', async () => {
    const h = await started({ loginAccount: vi.fn(async () => { throw new Error('ログインはすでに始まっています'); }) });
    h.rt.emit({ type: 'account.login', accountId: 'a1' });
    await flush();
    expect(h.api.loginAccount).toHaveBeenCalledWith('a1');
    expect(h.rt.getState().toasts.map((t) => t.message)).toEqual(['ログインはすでに始まっています']);
  });
  it('update、remove（承諾）、login.cancel、refresh は、応答の AccountsDto を Store に入れる', async () => {
    const next = { ...accountsFixture, accounts: [accountsFixture.accounts[0]!], sessions: {} };
    const h = await started({
      updateAccount: vi.fn(async () => accountsFixture), removeAccount: vi.fn(async () => next),
      cancelAccountLogin: vi.fn(async () => accountsFixture), refreshAccount: vi.fn(async () => accountsFixture),
    });
    h.rt.emit({ type: 'account.update', accountId: 'a1', name: '研究室' });
    await flush();
    expect(h.api.updateAccount).toHaveBeenCalledWith('a1', { name: '研究室' });
    h.rt.emit({ type: 'account.remove', accountId: 'a1', confirmed: true });
    await flush();
    expect(h.api.removeAccount).toHaveBeenCalledWith('a1');
    expect(h.rt.getStore().accounts).toEqual(next);
    h.rt.emit({ type: 'account.login.cancel', accountId: 'a1' });
    h.rt.emit({ type: 'account.refresh', accountId: 'a1' });
    await flush();
    expect(h.api.cancelAccountLogin).toHaveBeenCalledWith('a1');
    expect(h.api.refreshAccount).toHaveBeenCalledWith('a1');
    expect(h.rt.getStore().accounts).toEqual(accountsFixture);
  });
  it('accounts.update のイベントで Store が入れ替わる', async () => {
    const h = await started({ bootstrap: vi.fn(async () => ({ ...boot, accounts: accountsFixture })) });
    const next = { ...accountsFixture, currentId: 'a1', accounts: accountsFixture.accounts.map((a) => (a.id === 'a1' ? { ...a, loginRunning: true } : a)) };
    h.wsHandlers[0]!.onEvent({ type: 'accounts.update', accounts: next });
    expect(h.rt.getStore().accounts).toEqual(next);
  });
});

describe('設定の同期（作り直した実装）', () => {
  const cfg = (over: Partial<NonNullable<BootstrapDto['configSync']>> = {}): NonNullable<BootstrapDto['configSync']> => ({ enabled: true, workerPending: false, approval: 'each', incoming: 0, conflicts: 0, held: 0, unsent: 0, backups: 0, applyOrder: null, lastSentAt: null, ...over });
  const shellOutcome = (status: 'applied' | 'restored' | 'cancelled' | 'none' | 'failed' | 'busy', message = 'm') => ({ status, message, generation: null });
  const desktopOf = (apply: () => Promise<ReturnType<typeof shellOutcome>>, restore: () => Promise<ReturnType<typeof shellOutcome>> = async () => shellOutcome('restored')) => ({ openLog: vi.fn(), restart: vi.fn(), pickFolder: vi.fn(), applyConfigSync: vi.fn(apply), restoreConfigSync: vi.fn(restore) });
  const withConfig = (c: NonNullable<BootstrapDto['configSync']>, over: Partial<ApiClient> = {}, extra: Partial<RuntimeDeps> = {}) =>
    harness({ bootstrap: vi.fn(async () => ({ ...boot, configSync: c })), ...over }, extra);
  const toasts = (rt: ReturnType<typeof harness>['rt']) => rt.getState().toasts.map((t) => [t.level, t.message]);

  it('bootstrap と config.update が状態を入れ、設定の画面に入ると件数のある中身だけを取る', async () => {
    const { rt, api, wsHandlers, setHash } = withConfig(cfg({ incoming: 2, unsent: 1 }));
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    expect(rt.getStore().configSync).toMatchObject({ incoming: 2, unsent: 1 });
    setHash('#/settings?at=cloud');
    await flush();
    expect(api.configInbox).toHaveBeenCalledTimes(1);
    expect(api.configUnsent).toHaveBeenCalledTimes(1);
    expect(api.configConflicts).not.toHaveBeenCalled();
    expect(api.configBackups).not.toHaveBeenCalled();
    expect(rt.getStore().configDetail.inbox).toEqual({ items: [], approval: 'each' });
    // 状態が動いたら、設定の画面にいるので中身を取り直す。
    wsHandlers[0]!.onEvent({ type: 'config.update', configSync: cfg({ incoming: 3, unsent: 1 }) });
    await flush();
    expect(rt.getStore().configSync?.incoming).toBe(3);
    expect(api.configInbox).toHaveBeenCalledTimes(2);
  });

  it('殻があれば、承諾した項目を指示書にしてから殻の確認へ進み、書けたら状態を取り直してダイアログを閉じる', async () => {
    const desktop = desktopOf(async () => shellOutcome('applied', '適用しました。'));
    const { rt, api } = withConfig(cfg(), { configSyncState: vi.fn(async () => cfg({ backups: 1 })) }, { desktop });
    rt.start();
    await flush();
    rt.emit({ type: 'configSync.open', part: 'review' });
    rt.emit({ type: 'configSync.apply', entries: [{ id: 'file:CLAUDE.md' }] });
    expect(rt.getState().overlay).toEqual({ kind: 'configSync', part: 'review', working: true });
    await flush();
    expect(api.configPutOrder).toHaveBeenCalledWith([{ id: 'file:CLAUDE.md' }]);
    expect(desktop.applyConfigSync).toHaveBeenCalledTimes(1);
    expect(toasts(rt)).toEqual([['info', '適用しました。']]);
    expect(rt.getState().overlay).toEqual({ kind: 'none' });
    expect(rt.getStore().configSync?.backups).toBe(1);
  });

  it('殻の確認で取り消されたら、書いていないので閉じず、押せる状態に戻す。失敗は赤で知らせる', async () => {
    let next = shellOutcome('cancelled', '適用しませんでした。');
    const desktop = desktopOf(async () => next);
    const { rt, api } = withConfig(cfg(), {}, { desktop });
    rt.start();
    await flush();
    rt.emit({ type: 'configSync.open', part: 'approve' });
    rt.emit({ type: 'configSync.apply', entries: [{ id: 'a' }] });
    await flush();
    expect(rt.getState().overlay).toEqual({ kind: 'configSync', part: 'approve', working: false });
    expect(toasts(rt)).toEqual([['info', '適用しませんでした。']]);
    expect(api.configSyncState).not.toHaveBeenCalled();
    next = shellOutcome('failed', '書けませんでした。');
    rt.emit({ type: 'configSync.apply', entries: [{ id: 'a' }] });
    await flush();
    expect(toasts(rt).at(-1)).toEqual(['error', '書けませんでした。']);
    expect(rt.getState().overlay).toEqual({ kind: 'configSync', part: 'approve', working: false });
  });

  it('殻が無いブラウザでは、指示書を書いたところで止め、ターミナルで実行するよう知らせて閉じる', async () => {
    const { rt, api } = withConfig(cfg());
    rt.start();
    await flush();
    rt.emit({ type: 'configSync.open', part: 'conflicts' });
    rt.emit({ type: 'configSync.apply', entries: [{ id: 'file:CLAUDE.md', take: 'mine' }] });
    await flush();
    expect(api.configPutOrder).toHaveBeenCalledWith([{ id: 'file:CLAUDE.md', take: 'mine' }]);
    expect(rt.getState().overlay).toEqual({ kind: 'none' });
    expect(toasts(rt)[0]![1]).toContain('適用の指示書を書きました');
  });

  it('指示書を書けなかったら、殻の確認へ進まず、理由を赤で知らせて押せる状態に戻す', async () => {
    const desktop = desktopOf(async () => shellOutcome('applied'));
    const { rt } = withConfig(cfg(), { configPutOrder: vi.fn(async () => { throw new Error('適用する項目が選ばれていません'); }) }, { desktop });
    rt.start();
    await flush();
    rt.emit({ type: 'configSync.open', part: 'review' });
    rt.emit({ type: 'configSync.apply', entries: [{ id: 'x' }] });
    await flush();
    expect(desktop.applyConfigSync).not.toHaveBeenCalled();
    expect(toasts(rt)).toEqual([['error', '適用する項目が選ばれていません']]);
    expect(rt.getState().overlay).toEqual({ kind: 'configSync', part: 'review', working: false });
  });

  it('すでにある指示書のやり直しは指示書を書き直さず、殻の確認だけへ進む。取り消しは指示書を消す', async () => {
    const desktop = desktopOf(async () => shellOutcome('applied'));
    const { rt, api } = withConfig(cfg({ applyOrder: { count: 2, createdAt: 1 } }), {}, { desktop });
    rt.start();
    await flush();
    rt.emit({ type: 'configSync.order.apply' });
    await flush();
    expect(api.configPutOrder).not.toHaveBeenCalled();
    expect(desktop.applyConfigSync).toHaveBeenCalledTimes(1);
    rt.emit({ type: 'configSync.order.cancel' });
    await flush();
    expect(api.configDeleteOrder).toHaveBeenCalledTimes(1);
  });

  it('世代へ戻すのは殻の命令へ名前だけを渡し、戻せたら状態を取り直す', async () => {
    const desktop = desktopOf(async () => shellOutcome('applied'), async () => shellOutcome('restored', '戻しました。'));
    const { rt, api } = withConfig(cfg({ backups: 2 }), {}, { desktop });
    rt.start();
    await flush();
    rt.emit({ type: 'configSync.restore', name: '20261010-120000' });
    await flush();
    expect(desktop.restoreConfigSync).toHaveBeenCalledWith('20261010-120000');
    expect(toasts(rt)).toEqual([['info', '戻しました。']]);
    expect(api.configSyncState).toHaveBeenCalledTimes(1);
  });

  it('送る一覧の承諾は、スイッチを入れる', async () => {
    const { rt, api } = withConfig(cfg({ enabled: false }));
    rt.start();
    await flush();
    rt.emit({ type: 'configSync.open', part: 'send' });
    await flush();
    expect(api.configOutgoing).toHaveBeenCalledTimes(1);
    rt.emit({ type: 'configSync.send.confirm' });
    await flush();
    expect(api.updateSettings).toHaveBeenCalledWith({ configBundleSync: true });
    expect(rt.getState().overlay).toEqual({ kind: 'none' });
  });

  it('それでも送るは、応答の一覧を Store に入れる', async () => {
    const { rt, api } = withConfig(cfg({ unsent: 1 }), { configSendUnsent: vi.fn(async () => ({ items: [{ id: 'u', kind: 'secret' as const, itemId: 'i', label: 'x', reason: 'secret:ghp_', allowed: true }] })) });
    rt.start();
    await flush();
    rt.emit({ type: 'configSync.unsent.send', id: 'u' });
    await flush();
    expect(api.configSendUnsent).toHaveBeenCalledWith('u');
    expect(rt.getStore().configDetail.unsent?.items[0]?.allowed).toBe(true);
  });
});

describe('ランタイムの文（英語）', () => {
  const JAPANESE = /[぀-ヿ㐀-鿿]/;
  const english = { ...boot, settings: { ...boot.settings, language: 'en' as const } };
  const stats = { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null };
  const nameless: SessionDto = { id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: null, name: null, cwd: '/w', firstPrompt: null, aiTitle: null, startedAt: 1, lastActivityAt: 1, memo: null, hasTranscript: true, live: null, summary: null, stats, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null };
  async function startedEnglish(overrides: Partial<ApiClient> = {}, extra: Partial<RuntimeDeps> = {}, sessions: SessionDto[] = []) {
    const h = harness({ bootstrap: vi.fn(async () => ({ ...english, sessions })), ...overrides }, extra);
    h.rt.start();
    h.wsHandlers[0]!.onOpen();
    await flush();
    return h;
  }
  const toasts = (rt: ReturnType<typeof harness>['rt']) => rt.getState().toasts.map((t) => t.message);

  it('コピーに失敗したときの知らせ', async () => {
    const { rt } = await startedEnglish({}, { clipboard: vi.fn(async () => { throw new Error('denied'); }) });
    rt.emit({ type: 'clipboard.copy', text: 'x' });
    await flush();
    expect(toasts(rt)).toEqual(['Could not copy. Select the text and press ⌘C']);
  });
  it('iTerm2 から Terminal.app に落ちたときの知らせ', async () => {
    const { rt } = await startedEnglish({ openTerminalApp: vi.fn(async () => ({ app: 'terminal' as const, fellBack: true })) });
    rt.emit({ type: 'session.openTerminalApp', runId: 'r1' });
    await flush();
    expect(toasts(rt)).toEqual(['Could not open in iTerm2, so opened in Terminal.app instead']);
  });
  it('殻の操作の失敗は、英語の頭に原因を添える', async () => {
    const desktop = { openLog: vi.fn(async () => { throw new Error('denied'); }), restart: vi.fn(async () => { throw new Error('busy'); }), pickFolder: vi.fn(async () => { throw new Error('gone'); }), applyConfigSync: vi.fn(), restoreConfigSync: vi.fn() };
    const { rt } = await startedEnglish({}, { desktop });
    rt.emit({ type: 'shell.openLog' });
    rt.emit({ type: 'shell.restart' });
    rt.emit({ type: 'folder.pick' });
    await flush();
    expect(toasts(rt)).toEqual(['Could not open the log: denied', 'Could not restart: busy', 'Could not select the folder: gone']);
  });
  it('殻の返事が読めなかったときは、英語の文を知らせる', async () => {
    const desktop = { openLog: vi.fn(), restart: vi.fn(), pickFolder: vi.fn(), applyConfigSync: vi.fn(), restoreConfigSync: vi.fn(async () => ({ status: 'failed' as const, message: null, generation: null })) };
    const { rt } = await startedEnglish({}, { desktop });
    rt.emit({ type: 'configSync.restore', name: '20261010-120000' });
    await flush();
    expect(toasts(rt)).toEqual(['Could not read the response from the desktop app.']);
  });
  it('デスクトップ通知：名前の無いセッションの題と、問いの取れない本文が英語になる', async () => {
    let shown: unknown = null;
    const notifier = { defaultOn: true, available: () => true, granted: () => true, request: vi.fn(async () => true), prepare: vi.fn(async () => {}), status: vi.fn(async (): Promise<NotifyPermission> => 'granted'), background: () => true, show: vi.fn((n: unknown) => { shown = n; }), badge: vi.fn(), onOpen: () => () => {} };
    const { wsHandlers } = await startedEnglish({}, { notifier }, [nameless]);
    wsHandlers[0]!.onEvent({ type: 'live.update', live: [{ sessionId: 'u1', status: 'waiting', name: null, nameSource: null, cwd: '/w', pid: 1 }] });
    expect(shown).toEqual({ sessionId: 's1', title: '(No name)', body: 'Waiting for input' });
    expect(JSON.stringify(shown)).not.toMatch(JAPANESE);
  });
});

// 段 6 の psmux（tmux）の再確認。答えの準備の確かめと設定を Store に入れ、見つかったかを mediator に知らせる。
describe('psmux と tmux の再確認（ランタイム）', () => {
  const tools = { claude: { path: '/bin/claude', ok: true, problem: null, version: '2.3.1' }, code: { path: null, ok: false, problem: 'unset' as const, version: null }, node: { path: '/bin/node', ok: true, problem: null, version: 'v22.9.0', auto: true } };
  const base = {
    workspace: { path: '/w', exists: true, projectCount: 12 }, mcp: { registered: true, file: '/h/.claude.json' }, statusline: { command: null, scriptPath: null, installed: true },
    commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install', shell: 'hangar shell install' },
    compat: { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 },
  };
  const MISSING = { ...base, tools: { ...tools, tmux: { path: null, ok: false, problem: 'unset' as const, version: null } } };
  const FOUND = { ...base, tools: { ...tools, tmux: { path: 'C:\\x\\psmux.exe', ok: true, problem: null, version: '3.3.1' } } };
  const settings = (tmuxPath: string | null) => ({ workspaceRoot: '/w', claudeDir: '/c', tmuxPath, terminalApp: 'terminal' as const, codePath: null, lmStudioUrl: '', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, nodePath: null, claudePath: null });
  it('見つかれば、準備の確かめと埋めた設定を Store に入れ、印を外す', async () => {
    const recheckMux = vi.fn(async () => ({ readiness: FOUND, settings: settings('C:\\x\\psmux.exe') }));
    const { rt } = harness({ readiness: vi.fn(async () => MISSING), recheckMux });
    rt.start();
    rt.emit({ type: 'readiness.check' });
    await flush();
    rt.emit({ type: 'mux.recheck' });
    expect(rt.getState().muxCheck).toBe('checking');
    await flush();
    expect(recheckMux).toHaveBeenCalledTimes(1);
    expect(rt.getStore().readiness?.tools.tmux.ok).toBe(true);
    expect(rt.getStore().settings?.tmuxPath).toBe('C:\\x\\psmux.exe');
    expect(rt.getState().muxCheck).toBe('idle');
  });
  it('見つからなければ「まだ見つかりません」の印を持つ。要求が失敗しても同じにして、トーストで知らせる', async () => {
    const recheckMux = vi.fn(async () => ({ readiness: MISSING, settings: settings(null) }));
    const { rt } = harness({ readiness: vi.fn(async () => MISSING), recheckMux });
    rt.start();
    rt.emit({ type: 'mux.recheck' });
    await flush();
    expect(rt.getState().muxCheck).toBe('missing');
    recheckMux.mockRejectedValueOnce(new Error('接続できません'));
    rt.emit({ type: 'mux.recheck' });
    await flush();
    expect(rt.getState().muxCheck).toBe('missing');
    expect(rt.getState().toasts.map((t) => t.message)).toContain('接続できません');
  });
});
