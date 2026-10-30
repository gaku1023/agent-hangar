import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapDto, RunDto, ServerEvent, SessionDto } from '@agent-hangar/shared';
import { Root } from '../Root.tsx';
import { createRuntime, type RuntimeDeps } from '../runtime/runtime.ts';
import type { TerminalHost } from '../runtime/terminals.ts';
import { fakeApiExtras } from '../test/fakeApi.ts';
import { fakeMotionTokens } from '../test/motion.ts';
import { dropZone } from './paneDrag.ts';

const boot: BootstrapDto = { device: { id: 'd', name: 'mac' }, settings: { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', editor: { id: 'vscode' as const, path: null, fileCmd: '', dirCmd: '', terminal: 'none' as const }, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, nodePath: null, claudePath: null }, projects: [{ id: 'p1', name: 'alpha', status: 'active', isScratch: false, path: '/w/alpha', resolved: true, lastActivityAt: Date.now(), runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 }], sessions: [], live: [], runs: [], tabs: [], todos: [], artifacts: [], summaryPending: [], index: { phase: 'idle', done: 0, total: 0 }, version: '1', sync: { state: 'off', url: null, lastPushAt: null, lastPullAt: null, pending: 0, error: null, deviceCount: 0, limitedUntil: null, paused: false, skipped: [], sweepPending: null, oncePass: false, diskShort: null }, devices: [], retention: null, cloudUsage: null, accounts: { currentId: 'primary', accounts: [], sessions: {} }, home: '/h', interrupted: null };

const terminals: TerminalHost = { connect: vi.fn(), disconnect: vi.fn(), mount: vi.fn(), status: () => null, fit: vi.fn(), focus: vi.fn(), paste: vi.fn(), zoom: vi.fn(), fontSize: () => 13, painted: () => true, subscribe: () => () => {}, dispose: vi.fn(), link: () => ({ retryAt: null, dropped: false, gaveUp: false, detached: false }), reconnect: vi.fn() };

const mk = (id: string, name: string): SessionDto => ({ id, provider: 'claude-code', providerSessionId: `u-${id}`, projectId: 'p1', name, cwd: '/w/alpha', firstPrompt: null, aiTitle: null, startedAt: Date.now(), lastActivityAt: Date.now(), lastTurnAt: null, hasTranscript: true, live: 'idle', summary: null, fromScratch: false, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, woke: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, newerElsewhere: false, takenOver: null, fromPhone: null, unread: null, spawnedBy: null });
const run = (id: string, sessionId: string): RunDto => ({ id, sessionId, deviceId: 'd', kind: 'start', tmuxName: `hangar-${id}`, pid: 1, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 });

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

let restoreTokens = () => {};
beforeEach(() => { restoreTokens = fakeMotionTokens(); });
afterEach(() => { vi.unstubAllGlobals(); restoreTokens(); });

async function mounted(ids = ['s1', 's2', 's3']) {
  const sessions = ids.map((id) => mk(id, `name-${id}`));
  const b: BootstrapDto = { ...boot, sessions, runs: ids.map((id, i) => run(`r${i}`, id)) };
  let hash = '#/';
  const hashListeners = new Set<() => void>();
  const handlers: { onOpen(): void; onClose(): void; onEvent(ev: ServerEvent): void }[] = [];
  let depth = 0;
  const deps: RuntimeDeps = {
    api: { detachSpawn: async () => ({}), bootstrap: async () => b, events: async () => ({ sessionId: '', events: [], total: 0, nextSeq: null }), subagents: async () => [], search: async () => ({ hits: [], total: 0 }), setProjectStatus: async () => b.projects[0]!, resolveProject: async () => ({}), candidates: async () => [], updateSettings: async (p) => ({ ...b.settings, ...p }), rebuildIndex: async () => {}, ...fakeApiExtras() },
    ws: (h) => { handlers.push(h); return { connect: () => {}, close: () => {} }; },
    location: { getHash: () => hash, setHash: (h) => { hash = h; depth += 1; for (const l of hashListeners) l(); }, onHashChange: (cb) => { hashListeners.add(cb); return () => hashListeners.delete(cb); }, go: vi.fn(), depth: () => depth },
    storage: { get: () => undefined, set: () => {}, keys: () => [] },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    terminals,
    focus: () => {},
  };
  const rt = createRuntime(deps);
  const emit = vi.spyOn(rt, 'emit');
  rt.start();
  render(<Root runtime={rt} api={deps.api} terminals={terminals} />);
  act(() => handlers[0]!.onOpen());
  await flush();
  act(() => deps.location.setHash('#/session/s1'));
  await flush();
  const open = async (sessionId: string, side: 'right' | 'down' = 'right') => { act(() => rt.emit({ type: 'pane.open', sessionId, target: null, side })); await flush(); };
  return { rt, emit, open };
}

const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
const place = (el: Element, r: DOMRect) => { (el as HTMLElement).getBoundingClientRect = () => r; };
/** サイドバーの右端を 200 に置き、本体の側にセッション画面かペインの矩形を置く。 */
function layout() {
  const nav = document.querySelector('nav#sidebar');
  if (nav) place(nav, box(0, 0, 200, 600));
  const ws = document.querySelector('[data-pane-workspace]');
  if (ws) {
    Array.from(ws.querySelectorAll('[data-pane]')).forEach((c, i) => place(c, box(300 + i * 400, 50, 400, 500)));
  } else {
    const sc = document.querySelector('.session-screen:not([data-variant])');
    if (sc) place(sc, box(300, 50, 800, 500));
  }
}
const ptr = (target: Element | Window, type: string, x: number, y: number) => {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  for (const [k, v] of Object.entries({ clientX: x, clientY: y, pointerId: 1, button: 0, ctrlKey: false, isPrimary: true })) Object.defineProperty(ev, k, { value: v });
  act(() => { target.dispatchEvent(ev); });
};
const esc = () => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
const rowOf = (name: string) => screen.getByRole('link', { name: new RegExp(name) });
const preview = () => document.querySelector<HTMLElement>('[data-pane-drop-preview]');
const typesOf = (m: { emit: { mock: { calls: unknown[][] } } }, prefix: string) => m.emit.mock.calls.map((c) => (c[0] as { type: string }).type).filter((t) => t.startsWith(prefix));

describe('dropZone', () => {
  const r = { left: 100, top: 50, width: 400, height: 200 };
  const table: Array<[string, number, number, string]> = [
    ['左の辺の近く', 110, 150, 'left'],
    ['右の辺の近く', 490, 150, 'right'],
    ['上の辺の近く', 300, 55, 'up'],
    ['下の辺の近く', 300, 245, 'down'],
    ['真ん中', 300, 150, 'center'],
    ['左上の角は近いほう（幅の 10% と高さの 5%）で上', 140, 60, 'up'],
    ['左下の角は近いほう（幅の 3% と高さの 2%）で下', 112, 246, 'down'],
    ['左の境の内側（28% 未満）は左', 100 + 400 * 0.27, 150, 'left'],
    ['左の境の外側（28% 以上）は中央', 100 + 400 * 0.29, 150, 'center'],
    ['上の境の内側（28% 未満）は上', 300, 50 + 200 * 0.27, 'up'],
    ['上の境の外側（28% 以上）は中央', 300, 50 + 200 * 0.29, 'center'],
  ];
  it.each(table)('%s', (_n, x, y, side) => { expect(dropZone(r, { x, y })).toBe(side); });
  it('大きさの無い矩形は中央', () => { expect(dropZone({ left: 0, top: 0, width: 0, height: 0 }, { x: 0, y: 0 })).toBe('center'); });
});

describe('サイドバーの行を本体へ引く', () => {
  it('ペイン 1 つのとき、本体の右の辺で離すと pane.open（right、target は操作中のペイン）を出し、並べ替えは出さない', async () => {
    const m = await mounted();
    layout();
    m.emit.mockClear();
    const row = rowOf('name-s2');
    ptr(row, 'pointerdown', 100, 100);
    ptr(row, 'pointermove', 700, 300);
    expect(preview()!.textContent).toBe('ここで開く');
    ptr(row, 'pointermove', 1050, 300);
    expect(preview()!.textContent).toBe('右に分割');
    expect(preview()!.getAttribute('data-side')).toBe('right');
    expect(preview()!.style.left).toBe('700px');
    expect(preview()!.style.width).toBe('400px');
    ptr(row, 'pointerup', 1050, 300);
    await flush();
    expect(m.emit).toHaveBeenCalledWith({ type: 'pane.open', sessionId: 's2', target: null, side: 'right' });
    expect(typesOf(m, 'sidebar.order')).toEqual([]);
    expect(preview()).toBeNull();
    expect(document.querySelectorAll('[data-pane-header]')).toHaveLength(2);
  });

  it('中央で離すと center を出す', async () => {
    const m = await mounted();
    layout();
    const row = rowOf('name-s2');
    m.emit.mockClear();
    ptr(row, 'pointerdown', 100, 100);
    ptr(row, 'pointermove', 700, 300);
    ptr(row, 'pointerup', 700, 300);
    expect(m.emit).toHaveBeenCalledWith({ type: 'pane.open', sessionId: 's2', target: null, side: 'center' });
  });

  it('Esc でやめると、予告が消え、離しても何も出ない', async () => {
    const m = await mounted();
    layout();
    const row = rowOf('name-s3');
    m.emit.mockClear();
    ptr(row, 'pointerdown', 100, 100);
    ptr(row, 'pointermove', 1050, 300);
    expect(preview()).not.toBeNull();
    esc();
    expect(preview()).toBeNull();
    ptr(row, 'pointerup', 1050, 300);
    expect(typesOf(m, 'pane.')).toEqual([]);
    expect(typesOf(m, 'sidebar.')).toEqual([]);
  });

  it('分割中は、指したペインを target にして出す', async () => {
    const m = await mounted();
    await m.open('s2');
    layout();
    const second = Array.from(document.querySelectorAll<HTMLElement>('[data-pane]'))[1]!.dataset.pane;
    const row = rowOf('name-s3');
    m.emit.mockClear();
    ptr(row, 'pointerdown', 100, 100);
    ptr(row, 'pointermove', 750, 540);
    expect(preview()!.getAttribute('data-side')).toBe('down');
    ptr(row, 'pointerup', 750, 540);
    expect(m.emit).toHaveBeenCalledWith({ type: 'pane.open', sessionId: 's3', target: second, side: 'down' });
  });

  it('サイドバーの上へ戻すと予告が消え、離しても pane.open は出ない（今までの並べ替え）', async () => {
    const m = await mounted();
    layout();
    const row = rowOf('name-s2');
    m.emit.mockClear();
    ptr(row, 'pointerdown', 100, 100);
    ptr(row, 'pointermove', 700, 300);
    expect(preview()).not.toBeNull();
    ptr(row, 'pointermove', 100, 40);
    expect(preview()).toBeNull();
    expect(row).not.toHaveAttribute('data-pane-drag');
    ptr(row, 'pointerup', 100, 40);
    expect(typesOf(m, 'pane.')).toEqual([]);
  });

  it('本体でない所（ペインの外）では予告を出さず、離しても何も出さない', async () => {
    const m = await mounted();
    layout();
    const row = rowOf('name-s2');
    m.emit.mockClear();
    ptr(row, 'pointerdown', 100, 100);
    ptr(row, 'pointermove', 1500, 900);
    expect(preview()?.getAttribute('data-on') ?? null).toBeNull();
    ptr(row, 'pointerup', 1500, 900);
    expect(typesOf(m, 'pane.')).toEqual([]);
  });
});

describe('ペインの見出しをつかんで動かす', () => {
  const header = (i: number) => document.querySelectorAll<HTMLElement>('[data-pane-header]')[i]!;
  it('別のペインの辺で離すと pane.move、中央の予告は「位置を入れ替える」', async () => {
    const m = await mounted();
    await m.open('s2');
    layout();
    const [a, b] = Array.from(document.querySelectorAll<HTMLElement>('[data-pane]')).map((p) => p.dataset.pane!);
    m.emit.mockClear();
    ptr(header(0), 'pointerdown', 400, 60);
    ptr(window, 'pointermove', 900, 300);
    expect(preview()!.textContent).toBe('位置を入れ替える');
    ptr(window, 'pointermove', 1090, 300);
    expect(preview()!.textContent).toBe('右に分割');
    ptr(window, 'pointerup', 1090, 300);
    expect(m.emit).toHaveBeenCalledWith({ type: 'pane.move', pane: a, target: b, side: 'right' });
    expect(preview()).toBeNull();
  });

  it('自分のペインの上では「同じ位置には配置できません」と出して、pane.move を出さない', async () => {
    const m = await mounted();
    await m.open('s2');
    layout();
    m.emit.mockClear();
    ptr(header(0), 'pointerdown', 400, 60);
    ptr(window, 'pointermove', 320, 300);
    expect(preview()!.textContent).toBe('同じ位置には配置できません');
    expect(preview()!.getAttribute('data-blocked')).toBe('true');
    ptr(window, 'pointerup', 320, 300);
    expect(typesOf(m, 'pane.move')).toEqual([]);
  });

  it('Esc でやめる。見出しの中のボタンは掴み先にならない', async () => {
    const m = await mounted();
    await m.open('s2');
    layout();
    m.emit.mockClear();
    ptr(header(0), 'pointerdown', 400, 60);
    ptr(window, 'pointermove', 900, 300);
    esc();
    expect(preview()).toBeNull();
    ptr(window, 'pointerup', 900, 300);
    ptr(header(0).querySelector('[data-pane-toc]')!, 'pointerdown', 400, 60);
    ptr(window, 'pointermove', 900, 300);
    expect(preview()).toBeNull();
    ptr(window, 'pointerup', 900, 300);
    expect(typesOf(m, 'pane.move')).toEqual([]);
  });
});
