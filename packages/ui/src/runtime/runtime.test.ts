import { describe, expect, it, vi } from 'vitest';
import type { BootstrapDto, EventsPageDto, LaunchResultDto, ServerEvent } from '@agent-hangar/shared';
import type { ApiClient } from './api.ts';
import { createRuntime, type RuntimeDeps } from './runtime.ts';
import type { TerminalHost } from './terminals.ts';
import { fakeApiExtras } from '../test/fakeApi.ts';

const boot: BootstrapDto = { device: { id: 'd', name: 'mac' }, settings: { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20 }, projects: [], sessions: [], live: [], runs: [], tabs: [], usage: { fiveHour: null, sevenDay: null, updatedAt: null }, todos: [], artifacts: [], summaryPending: [], index: { phase: 'idle', done: 0, total: 0 }, version: '1' };
const page = (from: number, next: number | null): EventsPageDto => ({ sessionId: 's1', events: [{ kind: 'user', seq: from, text: 'x' }], total: 3, nextSeq: next });

/** ターミナルの偽物。React の外で持つ接続の代わりに、呼ばれた tabId を並べる。 */
function fakeTerminals(): TerminalHost & { connected: string[]; disconnected: string[] } {
  const h = { connected: [] as string[], disconnected: [] as string[], connect: (id: string) => { h.connected.push(id); }, disconnect: (id: string) => { h.disconnected.push(id); }, mount: () => {}, status: () => null, fit: () => {}, focus: vi.fn(), subscribe: () => () => {}, dispose: () => {} };
  return h;
}

function harness(overrides: Partial<ApiClient> = {}) {
  const api: ApiClient = {
    bootstrap: vi.fn(async () => boot),
    events: vi.fn(async (_s, from) => page(from, from === 0 ? 1 : null)),
    subagents: vi.fn(async () => []),
    search: vi.fn(async () => ({ hits: [], total: 0 })),
    setProjectStatus: vi.fn(async () => { throw new Error('500 /api/projects/p1'); }),
    resolveProject: vi.fn(async () => ({})),
    candidates: vi.fn(async () => []),
    updateSettings: vi.fn(async (p) => ({ workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal' as const, codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, ...p })),
    rebuildIndex: vi.fn(async () => {}),
    ...fakeApiExtras(),
    ...overrides,
  };
  let hash = '#/';
  const hashListeners = new Set<() => void>();
  const wsHandlers: { onOpen(): void; onClose(): void; onEvent(ev: ServerEvent): void }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const store = new Map<string, unknown>();
  const deps: RuntimeDeps = {
    api,
    ws: (h) => { wsHandlers.push(h); return { connect: vi.fn(), close: vi.fn() }; },
    location: { getHash: () => hash, setHash: (h) => { hash = h; for (const l of hashListeners) l(); }, onHashChange: (cb) => { hashListeners.add(cb); return () => hashListeners.delete(cb); } },
    storage: { get: (k) => store.get(k), set: (k, v) => store.set(k, v), keys: () => [...store.keys()] },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    terminals: fakeTerminals(),
  };
  const rt = createRuntime(deps);
  return { rt, api, wsHandlers, timers, store, terminals: deps.terminals as ReturnType<typeof fakeTerminals>, setHash: deps.location.setHash };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createRuntime', () => {
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
  it('session 画面で先頭ページを読み、loadMore で次のページを追記する', async () => {
    const { rt, api, setHash } = harness();
    rt.start();
    setHash('#/session/s1');
    await flush();
    expect(api.events).toHaveBeenCalledWith('s1', 0, null);
    expect(rt.getStore().events['s1:']?.items).toHaveLength(1);
    rt.emit({ type: 'transcript.loadMore', sessionId: 's1' });
    await flush();
    expect(api.events).toHaveBeenLastCalledWith('s1', 1, null);
    expect(rt.getStore().events['s1:']?.items.map((e) => e.seq)).toEqual([0, 1]);
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
  it('bootstrap に未解決のプロジェクトがあればダイアログを開く', async () => {
    const project = { id: 'p1', name: 'alpha', status: 'active' as const, isScratch: false, path: '/w/alpha', resolved: false, lastActivityAt: null, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 0 };
    const { rt, wsHandlers } = harness({ bootstrap: vi.fn(async () => ({ ...boot, projects: [project, { ...project, id: 'p2', path: null, resolved: false }, { ...project, id: 'p3', resolved: true }] })) });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    // パスを持たないプロジェクトは指し直しようがないので出さない。
    expect(rt.getState().overlay).toEqual({ kind: 'resolveProject', projectId: 'p1' });
    expect(rt.getState().unresolvedQueue).toEqual([]);
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
  it('subscribe は状態かストアが変わるたびに呼ばれる', () => {
    const { rt } = harness();
    const cb = vi.fn();
    rt.subscribe(cb);
    rt.dispatch({ kind: 'server', event: { type: 'toast', level: 'info', message: 'x' } });
    expect(cb).toHaveBeenCalled();
  });
});

const launched: LaunchResultDto = { run: { id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 }, sessionId: 's1', tabs: [{ id: 'r1', runId: 'r1', sessionId: 's1', kind: 'agent', title: 'Claude', tmuxName: 'hangar-r1', createdAt: 1, closedAt: null }] };

describe('起動とターミナル', () => {
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
  it('iTerm2 から Terminal.app に落ちたらトーストで知らせる', async () => {
    const { rt } = harness({ openTerminalApp: vi.fn(async () => ({ app: 'terminal' as const, fellBack: true })) });
    rt.start();
    rt.emit({ type: 'session.openTerminalApp', runId: 'r1' });
    await flush();
    expect(rt.getState().toasts[0]?.message).toContain('Terminal.app');
  });
});
