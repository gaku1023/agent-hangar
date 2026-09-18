import { describe, expect, it, vi } from 'vitest';
import type { BootstrapDto, EventsPageDto, ServerEvent } from '@agent-hangar/shared';
import type { ApiClient } from './api.ts';
import { createRuntime, type RuntimeDeps } from './runtime.ts';
import { fakeApiExtras } from '../test/fakeApi.ts';

const boot: BootstrapDto = { device: { id: 'd', name: 'mac' }, settings: { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null }, projects: [], sessions: [], live: [], runs: [], tabs: [], index: { phase: 'idle', done: 0, total: 0 }, version: '1' };
const page = (from: number, next: number | null): EventsPageDto => ({ sessionId: 's1', events: [{ kind: 'user', seq: from, text: 'x' }], total: 3, nextSeq: next });

function harness(overrides: Partial<ApiClient> = {}) {
  const api: ApiClient = {
    bootstrap: vi.fn(async () => boot),
    events: vi.fn(async (_s, from) => page(from, from === 0 ? 1 : null)),
    subagents: vi.fn(async () => []),
    search: vi.fn(async () => ({ hits: [], total: 0 })),
    setProjectStatus: vi.fn(async () => { throw new Error('500 /api/projects/p1'); }),
    resolveProject: vi.fn(async () => ({})),
    candidates: vi.fn(async () => []),
    updateSettings: vi.fn(async (p) => ({ workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal' as const, codePath: null, ...p })),
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
  };
  const rt = createRuntime(deps);
  return { rt, api, wsHandlers, timers, store, setHash: deps.location.setHash };
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
