import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapDto, RunDto, ServerEvent, SessionDto } from '@agent-hangar/shared';
import { Root } from '../Root.tsx';
import { createRuntime, type RuntimeDeps } from '../runtime/runtime.ts';
import type { TerminalHost } from '../runtime/terminals.ts';
import { fakeApiExtras } from '../test/fakeApi.ts';
import { fakeMotionTokens } from '../test/motion.ts';
import { clampPaneRatio } from './PaneDivider.tsx';

const boot: BootstrapDto = { device: { id: 'd', name: 'mac' }, settings: { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', editor: { id: 'vscode' as const, path: null, fileCmd: '', dirCmd: '', terminal: 'none' as const }, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, nodePath: null, claudePath: null }, projects: [{ id: 'p1', name: 'alpha', status: 'active', isScratch: false, path: '/w/alpha', resolved: true, lastActivityAt: Date.now(), runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 }], sessions: [], live: [], runs: [], tabs: [], todos: [], artifacts: [], summaryPending: [], index: { phase: 'idle', done: 0, total: 0 }, version: '1', sync: { state: 'off', url: null, lastPushAt: null, lastPullAt: null, pending: 0, error: null, deviceCount: 0, limitedUntil: null, paused: false, skipped: [], sweepPending: null, oncePass: false, diskShort: null }, devices: [], retention: null, cloudUsage: null, accounts: { currentId: 'primary', accounts: [], sessions: {} }, home: '/h', interrupted: null };

const terminals: TerminalHost = { connect: vi.fn(), disconnect: vi.fn(), mount: vi.fn(), status: () => null, fit: vi.fn(), focus: vi.fn(), paste: vi.fn(), zoom: vi.fn(), fontSize: () => 13, painted: () => true, subscribe: () => () => {}, dispose: vi.fn(), link: () => ({ retryAt: null, dropped: false, gaveUp: false, detached: false }), reconnect: vi.fn() };

const mk = (id: string, name: string): SessionDto => ({ id, provider: 'claude-code', providerSessionId: `u-${id}`, projectId: 'p1', name, cwd: '/w/alpha', firstPrompt: null, aiTitle: null, startedAt: Date.now(), lastActivityAt: Date.now(), lastTurnAt: null, hasTranscript: true, live: 'idle', summary: null, fromScratch: false, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, woke: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, newerElsewhere: false, takenOver: null, fromPhone: null, unread: null, spawnedBy: null });
const run = (id: string, sessionId: string): RunDto => ({ id, sessionId, deviceId: 'd', kind: 'start', tmuxName: `hangar-${id}`, pid: 1, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 });

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

type Observed = { cb: ResizeObserverCallback; el: Element };
let observed: Observed[] = [];
let restoreTokens = () => {};
beforeEach(() => {
  restoreTokens = fakeMotionTokens();
  observed = [];
  vi.stubGlobal('ResizeObserver', class {
    cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.cb = cb; }
    observe(el: Element) { observed.push({ cb: this.cb, el }); }
    unobserve() {}
    disconnect() { observed = observed.filter((o) => o.cb !== this.cb); }
  });
});
afterEach(() => { vi.unstubAllGlobals(); restoreTokens(); });

/** そのペインの幅が変わったことにする。 */
function resizePane(el: Element, width: number) {
  act(() => {
    for (const o of observed.filter((x) => x.el === el)) o.cb([{ target: el, contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
  });
}

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

const headers = () => Array.from(document.querySelectorAll<HTMLElement>('[data-pane-header]'));

describe('PaneWorkspace', () => {
  it('ペインが 1 つのときは今までどおり大きな見出しを出し、ペインの見出しは出さない', async () => {
    await mounted();
    expect(document.querySelector('.page-head')).not.toBeNull();
    expect(headers()).toHaveLength(0);
    expect(document.querySelector('[data-pane-workspace]')).toBeNull();
  });

  it('ペインが 2 つ以上のとき、大きな見出しは無く、ペインの数だけ見出しがある', async () => {
    const m = await mounted();
    await m.open('s2');
    expect(document.querySelector('.page-head')).toBeNull();
    expect(headers()).toHaveLength(2);
    await m.open('s3', 'down');
    expect(headers()).toHaveLength(3);
  });

  it('ペインの見出しにステータスの札、主の操作、⋯、ⓘ、☰、✕ がある', async () => {
    const m = await mounted();
    await m.open('s2');
    const h = headers()[0]!;
    expect(h.querySelector('.status-pill')).not.toBeNull();
    expect(h.querySelector('.btn-primary')).not.toBeNull();
    expect(within(h).getByRole('button', { name: '他の操作' })).toBeInTheDocument();
    expect(within(h).getByRole('button', { name: '詳細' })).toBeInTheDocument();
    expect(within(h).getByRole('button', { name: '右パネルを開く' })).toBeInTheDocument();
    expect(within(h).getByRole('button', { name: '分割から外す' })).toBeInTheDocument();
    expect(h.textContent).toContain('name-s1');
    expect(h.textContent).toContain('alpha');
  });

  it('☰ は pane.toc、✕ は pane.remove を出し、ペインを押すと pane.focus を出す', async () => {
    const m = await mounted();
    await m.open('s2');
    const leaves = Array.from(document.querySelectorAll<HTMLElement>('[data-pane]'));
    const first = leaves[0]!.dataset.pane!;
    // 操作中でないペインを押す。
    const other = leaves.find((l) => l.dataset.focused !== 'true')!;
    m.emit.mockClear();
    fireEvent.pointerDown(other);
    expect(m.emit).toHaveBeenCalledWith({ type: 'pane.focus', pane: other.dataset.pane });
    m.emit.mockClear();
    fireEvent.click(within(headers()[0]!).getByRole('button', { name: '右パネルを開く' }));
    expect(m.emit).toHaveBeenCalledWith({ type: 'pane.toc', pane: first });
    fireEvent.click(within(headers()[0]!).getByRole('button', { name: '分割から外す' }));
    expect(m.emit).toHaveBeenCalledWith({ type: 'pane.remove', pane: first });
  });

  it('右パネルは既定で閉じ、☰ で開く', async () => {
    const m = await mounted();
    await m.open('s2');
    const pane = document.querySelector<HTMLElement>('[data-pane]')!;
    expect(pane.querySelector('.toc-slot')?.getAttribute('data-collapsed')).toBe('true');
    fireEvent.click(within(headers()[0]!).getByRole('button', { name: '右パネルを開く' }));
    await flush();
    expect(document.querySelector<HTMLElement>('[data-pane]')!.querySelector('.toc-slot')?.getAttribute('data-collapsed')).toBeNull();
    expect(within(headers()[0]!).getByRole('button', { name: '右パネルを閉じる' })).toBeInTheDocument();
  });

  it('幅で tight と tiny が付く', async () => {
    const m = await mounted();
    await m.open('s2');
    const pane = document.querySelector<HTMLElement>('[data-pane]')!;
    resizePane(pane, 800);
    expect(pane.classList.contains('tight')).toBe(false);
    expect(pane.classList.contains('tiny')).toBe(false);
    resizePane(pane, 600);
    expect(pane.classList.contains('tight')).toBe(true);
    expect(pane.classList.contains('tiny')).toBe(false);
    resizePane(pane, 400);
    expect(pane.classList.contains('tight')).toBe(true);
    expect(pane.classList.contains('tiny')).toBe(true);
    // tiny では主の操作と ⓘ が見出しから消え、⋯ の中へ入る。
    const h = headers()[0]!;
    expect(h.querySelector('.btn-primary')).toBeNull();
    expect(within(h).queryByRole('button', { name: '詳細' })).toBeNull();
    fireEvent.click(within(h).getByRole('button', { name: '他の操作' }));
    expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(0);
  });

  it('分割しても、サイドバーの行にペインの番号の札を付けない。操作中のペインの行だけに印を付ける', async () => {
    const m = await mounted();
    await m.open('s2');
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.side-live-row'));
    expect(rows.length).toBeGreaterThan(1);
    expect(document.querySelector('.side-pane-badge, [data-pane-badge]')).toBeNull();
    expect(rows.filter((r) => r.getAttribute('aria-current') === 'page').map((r) => r.dataset.id)).toEqual(['s2']);
  });

  it('空のペインは動いているセッションの一覧を出し、押すと pane.fill を出す', async () => {
    const m = await mounted();
    act(() => m.rt.emit({ type: 'pane.openEmpty', side: 'right' }));
    await flush();
    const empty = document.querySelector<HTMLElement>('[data-pane-empty]')!;
    expect(empty).not.toBeNull();
    expect(within(empty.closest<HTMLElement>('[data-pane]')!).getByText('空のペイン')).toBeInTheDocument();
    // 木にある s1 は一覧に出さない。
    expect(within(empty).queryByText('name-s1')).toBeNull();
    const pane = empty.closest<HTMLElement>('[data-pane]')!.dataset.pane;
    m.emit.mockClear();
    fireEvent.click(within(empty).getByText('name-s2'));
    expect(m.emit).toHaveBeenCalledWith({ type: 'pane.fill', pane, sessionId: 's2' });
  });

  it('境目をドラッグすると pane.resize、ダブルクリックで pane.equalize、矢印キーで pane.resize を出す', async () => {
    const m = await mounted();
    await m.open('s2');
    const sep = screen.getByRole('separator', { name: 'ペインの境目' });
    const host = sep.parentElement as HTMLElement;
    host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const node = host.dataset.node;
    m.emit.mockClear();
    fireEvent.pointerDown(sep, { clientX: 500 });
    expect(host.hasAttribute('data-layout-moving')).toBe(true);
    // 掴んでいる間は、比の動き（transition）を切る印が立つ。
    expect(host.dataset.dragging).toBe('true');
    fireEvent.pointerMove(window, { clientX: 300 });
    expect(m.emit).toHaveBeenLastCalledWith({ type: 'pane.resize', node, ratio: 0.3 });
    // 最小の幅 280px を守る。
    fireEvent.pointerMove(window, { clientX: 100 });
    expect(m.emit).toHaveBeenLastCalledWith({ type: 'pane.resize', node, ratio: 0.28 });
    fireEvent.pointerUp(window);
    expect(host.hasAttribute('data-layout-moving')).toBe(false);
    expect(host.hasAttribute('data-dragging')).toBe(false);
    m.emit.mockClear();
    fireEvent.pointerMove(window, { clientX: 700 });
    expect(m.emit).not.toHaveBeenCalled();
    fireEvent.doubleClick(sep);
    expect(m.emit).toHaveBeenCalledWith({ type: 'pane.equalize' });
    m.emit.mockClear();
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(m.emit).toHaveBeenCalledWith({ type: 'pane.resize', node, ratio: expect.closeTo(0.5 + 0.02, 5) });
  });

  it('掴まずに比が変わったとき（ダブルクリックやキー）は、動きの間だけ端末の寸法合わせを止め、動きの終わりに戻す', async () => {
    const m = await mounted();
    await m.open('s2');
    const host = screen.getByRole('separator', { name: 'ペインの境目' }).parentElement as HTMLElement;
    const node = host.dataset.node!;
    document.documentElement.style.setProperty('--dur', '200ms');
    try {
      act(() => m.rt.emit({ type: 'pane.resize', node, ratio: 0.3 }));
      await flush();
      expect(host.hasAttribute('data-layout-moving')).toBe(true);
      fireEvent.transitionEnd(host.querySelector('.pane-slot')!, { propertyName: 'flex-grow' });
      expect(host.hasAttribute('data-layout-moving')).toBe(false);
    } finally { document.documentElement.style.removeProperty('--dur'); }
  });

  describe('角（T 字）', () => {
    const rectOf = (l: number, t: number, w: number, h: number) => () => ({ left: l, top: t, width: w, height: h, right: l + w, bottom: t + h, x: l, y: t, toJSON: () => ({}) }) as DOMRect;
    /** 左に s1、右に s2 と s3 を上下に置き、節の矩形を決める（親は 1000×800、右の子は x が 500 から）。 */
    async function tee() {
      const m = await mounted();
      await m.open('s2');
      const target = document.querySelector<HTMLElement>('[data-session="s2"]')!.dataset.pane!;
      act(() => m.rt.emit({ type: 'pane.open', sessionId: 's3', target, side: 'down' }));
      await flush();
      const corner = document.querySelector<HTMLElement>('[data-corner]')!;
      const child = corner.closest<HTMLElement>('[data-node]')!;
      const parent = child.parentElement!.closest<HTMLElement>('[data-node]')!;
      parent.getBoundingClientRect = rectOf(0, 0, 1000, 800);
      child.getBoundingClientRect = rectOf(500, 0, 500, 800);
      m.emit.mockClear();
      return { m, corner, parent: parent.dataset.node!, child: child.dataset.node! };
    }
    const resizes = (m: { emit: { mock: { calls: unknown[][] } } }) => m.emit.mock.calls.map((c) => c[0] as { type: string; node: string; ratio: number }).filter((a) => a.type === 'pane.resize');

    it('T 字の角に取っ手が 1 つ出る', async () => {
      const t = await tee();
      expect(document.querySelectorAll('[data-corner]')).toHaveLength(1);
      expect(t.corner.getAttribute('aria-hidden')).toBe('true');
    });

    it('角をドラッグすると、親の節と子の節の 2 つに pane.resize を出し、離すと端末の寸法合わせが戻る', async () => {
      const { m, corner, parent, child } = await tee();
      fireEvent.pointerDown(corner, { clientX: 504, clientY: 400 });
      expect(document.querySelector(`[data-node="${parent}"]`)!.hasAttribute('data-layout-moving')).toBe(true);
      expect(corner.dataset.grab).toBe('true');
      // 交わる節のすべてで、比の動きを切る。
      for (const id of [parent, child]) expect(document.querySelector(`[data-node="${id}"]`)!.getAttribute('data-dragging')).toBe('true');
      fireEvent.pointerMove(window, { clientX: 300, clientY: 300 });
      expect(resizes(m)).toEqual([{ type: 'pane.resize', node: parent, ratio: 0.3 }, { type: 'pane.resize', node: child, ratio: 0.375 }]);
      // 最小の幅 280px を守る。
      m.emit.mockClear();
      fireEvent.pointerMove(window, { clientX: 50, clientY: 300 });
      expect(resizes(m)[0]).toEqual({ type: 'pane.resize', node: parent, ratio: 0.28 });
      const settled = vi.fn();
      window.addEventListener('hangar:layout-settled', settled);
      fireEvent.pointerUp(window);
      window.removeEventListener('hangar:layout-settled', settled);
      expect(settled).toHaveBeenCalledTimes(1);
      expect(document.querySelector(`[data-node="${parent}"]`)!.hasAttribute('data-layout-moving')).toBe(false);
      for (const id of [parent, child]) expect(document.querySelector(`[data-node="${id}"]`)!.hasAttribute('data-dragging')).toBe(false);
      m.emit.mockClear();
      fireEvent.pointerMove(window, { clientX: 700, clientY: 400 });
      expect(m.emit).not.toHaveBeenCalled();
    });

    it('⇧ を押している間は、動きの大きい軸の節だけが動く', async () => {
      const { m, corner, parent, child } = await tee();
      fireEvent.pointerDown(corner, { clientX: 504, clientY: 400 });
      fireEvent.pointerMove(window, { clientX: 300, clientY: 380, shiftKey: true });
      expect(resizes(m)).toEqual([{ type: 'pane.resize', node: parent, ratio: 0.3 }, { type: 'pane.resize', node: child, ratio: 0.5 }]);
      m.emit.mockClear();
      fireEvent.pointerMove(window, { clientX: 500, clientY: 200, shiftKey: true });
      expect(resizes(m)).toEqual([{ type: 'pane.resize', node: parent, ratio: 0.5 }, { type: 'pane.resize', node: child, ratio: 0.35 }]);
      fireEvent.pointerUp(window);
    });

    it('ダブルクリックは関わる 2 つの節だけを 0.5 にし、pane.equalize は出さない', async () => {
      const { m, corner, parent, child } = await tee();
      fireEvent.doubleClick(corner);
      expect(resizes(m)).toEqual([{ type: 'pane.resize', node: parent, ratio: 0.5 }, { type: 'pane.resize', node: child, ratio: 0.5 }]);
      expect(m.emit.mock.calls.some((c) => (c[0] as { type: string }).type === 'pane.equalize')).toBe(false);
    });
  });

  it('左に 1 つ、右に 2 つのとき左を閉じても、残る 2 つは消えず、閉じたペインの要素は残るペインに使い回されない', async () => {
    // 閉じるペインの退場の動きは、閉じる前に測った要素を body へ移して薄れさせ、外す。
    // その要素が残るペインの描画に使い回されると、生きているペインまで消える（⌘W で片側が空く不具合）。
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: vi.fn() }));
    try {
      const m = await mounted();
      await m.open('s2');
      const right = document.querySelector<HTMLElement>('[data-session="s2"]')!.dataset.pane!;
      act(() => m.rt.emit({ type: 'pane.open', sessionId: 's3', target: right, side: 'down' }));
      await flush();
      const left = document.querySelector<HTMLElement>('[data-session="s1"]')!;
      act(() => m.rt.emit({ type: 'pane.remove', pane: left.dataset.pane! }));
      await flush();
      await flush();
      const shown = Array.from(document.querySelectorAll<HTMLElement>('[data-pane-workspace] [data-pane]')).map((e) => e.dataset.session);
      expect(shown).toEqual(['s2', 's3']);
      expect(left.closest('[data-pane-workspace]')).toBeNull();
    } finally {
      delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
    }
  });

  it('最大化中はそのペインだけを出し、見出しの解除のボタンで pane.zoom を出す', async () => {
    const m = await mounted();
    await m.open('s2');
    const pane = document.querySelector<HTMLElement>('[data-pane]')!.dataset.pane!;
    act(() => m.rt.emit({ type: 'pane.zoom', pane }));
    await flush();
    expect(headers()).toHaveLength(1);
    expect(screen.queryByRole('separator', { name: 'ペインの境目' })).toBeNull();
    m.emit.mockClear();
    fireEvent.click(within(headers()[0]!).getByRole('button', { name: '最大化を解除' }));
    expect(m.emit).toHaveBeenCalledWith({ type: 'pane.zoom', pane });
  });
});

describe('clampPaneRatio', () => {
  it('最小の幅 280px を守る', () => {
    expect(clampPaneRatio(0.1, 1000)).toBeCloseTo(0.28);
    expect(clampPaneRatio(0.95, 1000)).toBeCloseTo(0.72);
    expect(clampPaneRatio(0.5, 1000)).toBe(0.5);
  });
  it('2 つ分の幅に満たないときは mediator の範囲（0.1〜0.9）だけで収める', () => {
    expect(clampPaneRatio(0.2, 500)).toBe(0.2);
  });
});

describe('ペインの見出しの右クリックとキー', () => {
  const itemTexts = () => screen.getAllByRole('menuitem').map((i) => i.querySelector('.menu-item-text > span')?.textContent);
  const pick = (label: string) => fireEvent.click(screen.getAllByRole('menuitem').find((i) => i.querySelector('.menu-item-text > span')?.textContent === label)!);

  it('見出しを右クリックすると、ステータス、ID をコピー、最大化、右と下に空のペイン、均等、分割から外す、ほかを外すの順に出す', async () => {
    const m = await mounted();
    await m.open('s2');
    const h = headers()[0]!;
    fireEvent.contextMenu(h);
    expect(itemTexts()).toEqual(['ステータス', 'セッション ID をコピー', 'ペインを最大化', '右に空のペインを開く', '下に空のペインを開く', 'ペインのサイズを均等にする', '分割から外す', 'ほかのペインを外す']);
  });

  it('各項目が、押したペインの id で入力を出す', async () => {
    const m = await mounted();
    await m.open('s2');
    const first = document.querySelector<HTMLElement>('[data-pane]')!.dataset.pane!;
    const h = headers()[0]!;
    const cases: [string, unknown][] = [
      ['セッション ID をコピー', { type: 'session.copyId', id: 's1' }],
      ['右に空のペインを開く', { type: 'pane.openEmpty', side: 'right' }],
      ['下に空のペインを開く', { type: 'pane.openEmpty', side: 'down' }],
      ['ペインのサイズを均等にする', { type: 'pane.equalize' }],
      ['ペインを最大化', { type: 'pane.zoom', pane: first }],
    ];
    for (const [label, action] of cases) {
      fireEvent.contextMenu(h);
      m.emit.mockClear();
      pick(label);
      expect(m.emit).toHaveBeenCalledWith(action);
      if (label === 'ペインを最大化') act(() => m.rt.emit({ type: 'pane.zoom', pane: first }));
    }
  });

  it('分割から外すとほかを外すは、押したペインの id で入力を出す', async () => {
    const m = await mounted();
    await m.open('s2');
    const first = document.querySelector<HTMLElement>('[data-pane]')!.dataset.pane!;
    fireEvent.contextMenu(headers()[0]!);
    m.emit.mockClear();
    pick('ほかのペインを外す');
    expect(m.emit).toHaveBeenCalledWith({ type: 'pane.removeOthers', pane: first });
  });

  it('分割から外すは pane.remove を出す', async () => {
    const m = await mounted();
    await m.open('s2');
    const first = document.querySelector<HTMLElement>('[data-pane]')!.dataset.pane!;
    fireEvent.contextMenu(headers()[0]!);
    m.emit.mockClear();
    pick('分割から外す');
    expect(m.emit).toHaveBeenCalledWith({ type: 'pane.remove', pane: first });
  });

  it('ステータスを押すと、同じ場所に状態の 4 つ（いまの状態に ✓）が出て、選ぶと session.state.set を出す', async () => {
    const m = await mounted();
    await m.open('s2');
    fireEvent.contextMenu(headers()[0]!);
    pick('ステータス');
    expect(screen.getAllByRole('menuitemradio').map((i) => [i.textContent, i.getAttribute('aria-checked')])).toEqual([['Activeu', 'true'], ['Pausedp', 'false'], ['Doned', 'false'], ['Archiveda', 'false']]);
    m.emit.mockClear();
    fireEvent.click(screen.getAllByRole('menuitemradio')[2]!);
    expect(m.emit).toHaveBeenCalledWith({ type: 'session.state.set', id: 's1', status: 'done' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('空のペインの見出しはステータスと ID のコピーを出さない', async () => {
    const m = await mounted();
    await m.open('s2');
    act(() => m.rt.emit({ type: 'pane.openEmpty', side: 'right' }));
    await flush();
    const empty = document.querySelector<HTMLElement>('[data-pane-header][data-empty="true"]')!;
    fireEvent.contextMenu(empty);
    expect(itemTexts()).toEqual(['ペインを最大化', '右に空のペインを開く', '下に空のペインを開く', 'ペインのサイズを均等にする', '分割から外す', 'ほかのペインを外す']);
  });

  it('最大化中は「最大化を解除」になる', async () => {
    const m = await mounted();
    await m.open('s2');
    act(() => m.rt.emit({ type: 'pane.zoom', pane: document.querySelector<HTMLElement>('[data-pane]')!.dataset.pane! }));
    await flush();
    fireEvent.contextMenu(headers()[0]!);
    expect(itemTexts()).toContain('最大化を解除');
  });

  it('狭いペイン（tiny）の ⋯ に「詳しく」があり、押すとそのペインの ⓘ と同じ中身の面が開く', async () => {
    const m = await mounted();
    await m.open('s2');
    const pane = document.querySelector<HTMLElement>('[data-pane]')!;
    resizePane(pane, 400);
    const h = headers()[0]!;
    fireEvent.click(within(h).getByRole('button', { name: '他の操作' }));
    expect(itemTexts()).toContain('詳細（ID、モデル、ブランチ）');
    pick('詳細（ID、モデル、ブランチ）');
    const viaMenu = (await screen.findByRole('dialog', { name: '詳細' })).textContent;
    expect(viaMenu).toContain('詳細');
    fireEvent.keyDown(screen.getByRole('dialog', { name: '詳細' }), { key: 'Escape' });
    // 広いときの ⓘ と同じ中身である。
    resizePane(pane, 800);
    fireEvent.click(within(headers()[0]!).getByRole('button', { name: '詳細' }));
    expect(screen.getByRole('dialog', { name: '詳細' }).textContent).toBe(viaMenu);
  });

  it('⌘J は、ペインが 2 つ以上のときは操作中のペインの右パネル（pane.toc）へ向く。1 つのときは今までの transcript.toggle', async () => {
    const m = await mounted();
    m.emit.mockClear();
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    expect(m.emit).toHaveBeenCalledWith({ type: 'transcript.toggle' });
    await m.open('s2');
    const focus = document.querySelector<HTMLElement>('[data-pane][data-focused="true"]')!.dataset.pane!;
    m.emit.mockClear();
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    expect(m.emit).toHaveBeenCalledWith({ type: 'pane.toc', pane: focus });
  });

  it('分割のキー（⌘D、⌘⇧D、⌘⇧W、⌘⇧↵）が操作中のペインに向く', async () => {
    const m = await mounted();
    await m.open('s2');
    // 空のペインを開くたびに、新しいペインが操作中になる。そのつど、いまの操作中を読む。
    const focus = () => document.querySelector<HTMLElement>('[data-pane][data-focused="true"]')!.dataset.pane!;
    const cases: [KeyboardEventInit, () => unknown][] = [
      [{ key: 'd', metaKey: true }, () => ({ type: 'pane.openEmpty', side: 'right' })],
      [{ key: 'D', metaKey: true, shiftKey: true }, () => ({ type: 'pane.openEmpty', side: 'down' })],
      [{ key: 'Enter', metaKey: true, shiftKey: true }, () => ({ type: 'pane.zoom', pane: focus() })],
      [{ key: 'W', metaKey: true, shiftKey: true }, () => ({ type: 'pane.remove', pane: focus() })],
    ];
    for (const [init, action] of cases) {
      m.emit.mockClear();
      const expected = action();
      fireEvent.keyDown(window, init);
      expect(m.emit).toHaveBeenCalledWith(expected);
      await flush();
    }
  });

  it('隣へ移る（⌘⌥矢印）は、ペインの矩形から求めた隣へ pane.focus を出す', async () => {
    const m = await mounted();
    await m.open('s2');
    const [left, right] = Array.from(document.querySelectorAll<HTMLElement>('[data-pane]'));
    const rect = (l: number, r: number) => () => ({ left: l, right: r, top: 0, bottom: 600, width: r - l, height: 600, x: l, y: 0, toJSON: () => ({}) }) as DOMRect;
    left!.getBoundingClientRect = rect(0, 400);
    right!.getBoundingClientRect = rect(404, 800);
    // 新しく開いたペインが操作中なので、右にいる。左へ移る。
    expect(right!.dataset.focused).toBe('true');
    m.emit.mockClear();
    fireEvent.keyDown(window, { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, altKey: true });
    expect(m.emit).toHaveBeenCalledWith({ type: 'pane.focus', pane: left!.dataset.pane });
    // 左端から左へは隣が無く、何も出さない。
    m.emit.mockClear();
    fireEvent.keyDown(window, { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, altKey: true });
    expect(m.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'pane.focus' }));
  });
});
