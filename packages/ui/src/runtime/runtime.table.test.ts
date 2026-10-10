import { describe, expect, it, vi } from 'vitest';
import type { BootstrapDto } from '@agent-hangar/shared';
import * as mediator from '../mediator/transition.ts';
import { fakeApiExtras } from '../test/fakeApi.ts';
import type { ApiClient } from './api.ts';
import { actionTable } from './actionTable.ts';
import { createRuntime, type RuntimeDeps } from './runtime.ts';

// transition を見張る。中身は本物のままにして、何が渡ったかだけを数える。
vi.mock('../mediator/transition.ts', async (original) => {
  const real = await original<typeof import('../mediator/transition.ts')>();
  return { ...real, transition: vi.fn(real.transition) };
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function harness(over: Partial<ApiClient> = {}) {
  const api = { ...fakeApiExtras(), bootstrap: vi.fn(async () => ({}) as BootstrapDto), setProjectStatus: vi.fn(async () => ({ id: 'p1' })), ...over } as unknown as ApiClient;
  const kept = new Map<string, unknown>();
  const deps: RuntimeDeps = {
    api,
    ws: () => ({ connect: vi.fn(), close: vi.fn() }),
    location: { getHash: () => '#/', setHash: () => {}, onHashChange: () => () => {}, go: () => {}, depth: () => 0 },
    storage: { get: (k) => kept.get(k), set: (k, v) => kept.set(k, v), keys: () => [...kept.keys()] },
    setTimeout: () => 0,
    terminals: { connect: () => {}, disconnect: () => {}, mount: () => {}, status: () => null, fit: () => {}, focus: () => {}, paste: () => {}, zoom: () => {}, fontSize: () => 13, painted: () => true, subscribe: () => () => {}, dispose: () => {}, link: () => ({ retryAt: null, dropped: false, gaveUp: false, detached: false }), reconnect: () => {} },
  };
  return { rt: createRuntime(deps), api };
}
/** transition に渡った UiAction の kind。 */
const mediated = () => vi.mocked(mediator.transition).mock.calls.map((c) => c[2]).filter((i) => i.kind === 'action').map((i) => i.action.type);

describe('表にある UiAction', () => {
  it('transition を通らずに API を呼び、State は変えない', async () => {
    const { rt, api } = harness();
    const before = rt.getState();
    vi.mocked(mediator.transition).mockClear();
    rt.emit({ type: 'project.setStatus', id: 'p1', status: 'paused' });
    await flush();
    expect(api.setProjectStatus).toHaveBeenCalledWith('p1', 'paused');
    expect(mediated()).toEqual([]);
    expect(rt.getState()).toBe(before);
  });
  it('表に無い UiAction は、今までどおり transition へ渡る', () => {
    const { rt } = harness();
    vi.mocked(mediator.transition).mockClear();
    rt.emit({ type: 'sidebar.toggle' });
    expect(mediated()).toEqual(['sidebar.toggle']);
  });
  it('dispatch に直に渡されても、表にあれば transition へ渡さない', async () => {
    const { rt, api } = harness();
    vi.mocked(mediator.transition).mockClear();
    // 型では渡せないので、型を外して渡す。
    rt.dispatch({ kind: 'action', action: { type: 'project.setStatus', id: 'p1', status: 'done' } } as never);
    await flush();
    expect(api.setProjectStatus).toHaveBeenCalledWith('p1', 'done');
    expect(mediated()).toEqual([]);
  });
  it('失敗はトーストになる', async () => {
    const { rt } = harness({ setProjectStatus: vi.fn(async () => { throw new Error('500 /api/projects/p1'); }) });
    rt.emit({ type: 'project.setStatus', id: 'p1', status: 'paused' });
    await flush();
    expect(rt.getState().toasts.map((t) => [t.level, t.message])).toEqual([['error', '500 /api/projects/p1']]);
  });
  it('応答の知らせはトーストになる', async () => {
    const { rt } = harness({ projectOpenTerminal: vi.fn(async () => ({ app: 'terminal' as const, fellBack: true })) });
    rt.emit({ type: 'project.openTerminalApp', id: 'p1' });
    await flush();
    expect(rt.getState().toasts.map((t) => t.level)).toEqual(['info']);
    expect(rt.getState().toasts[0]?.message).toContain('Terminal.app');
  });
  it('同期の応答と bootstrap の同期の状態は Store に直に当て、サーバのイベントに見せかけて transition へ流さない', async () => {
    const sync = { state: 'idle', pending: 4, skipped: [] } as unknown as NonNullable<ReturnType<ReturnType<typeof createRuntime>['getStore']>['sync']>;
    const devices = [{ id: 'd2', name: 'mini', platform: 'darwin', lastSeenAt: 3, self: false, shell: null }];
    const boot = { version: 'v', device: { id: 'd', name: 'mac' }, settings: null, projects: [], sessions: [{ id: 's1' }], live: [], runs: [], tabs: [], index: { phase: 'idle', done: 0, total: 0 }, todos: [], artifacts: [], summaryPending: [], sync, devices, retention: null, cloudUsage: null, accounts: null } as unknown as BootstrapDto;
    const paused = { ...sync, state: 'paused' };
    const { rt } = harness({ bootstrap: vi.fn(async () => boot), syncNow: vi.fn(async () => sync), syncPause: vi.fn(async () => paused) } as Partial<ApiClient>);
    vi.mocked(mediator.transition).mockClear();
    rt.dispatch({ kind: 'runtime', event: { type: 'ws.open' } });
    await flush();
    expect(rt.getStore().sync).toBe(sync);
    expect(rt.getStore().devices).toEqual(devices);
    rt.emit({ type: 'sync.now' });
    await flush();
    rt.emit({ type: 'sync.pause', paused: true });
    await flush();
    expect(rt.getStore().sync).toBe(paused);
    const served = vi.mocked(mediator.transition).mock.calls.map((c) => c[2]).filter((i) => i.kind === 'server').map((i) => i.event.type);
    expect(served.filter((t) => t === 'sync.status' || t === 'devices.update')).toEqual([]);
  });
  it('表の鍵はどれも、transition に渡しても何も起きない（二重に扱っていない）', () => {
    // 型でも止めているが、default で拾って何かをする領域が紛れ込まないことを実行でも確かめる。
    const state = mediator.initialState();
    const { rt } = harness();
    for (const type of Object.keys(actionTable)) {
      const r = mediator.transition(state, rt.getStore(), { kind: 'action', action: { type } } as never);
      expect([type, r.state === state, r.effects]).toEqual([type, true, []]);
    }
  });
});
