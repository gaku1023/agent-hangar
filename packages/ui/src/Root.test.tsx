import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BootstrapDto, RunDto, ServerEvent, SessionDto, TabDto } from '@agent-hangar/shared';
import { Root } from './Root.tsx';
import type { ApiClient } from './runtime/api.ts';
import { createRuntime, type RuntimeDeps } from './runtime/runtime.ts';
import type { TerminalHost } from './runtime/terminals.ts';
import { fakeApiExtras } from './test/fakeApi.ts';

const boot: BootstrapDto = { device: { id: 'd', name: 'mac' }, settings: { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20 }, projects: [{ id: 'p1', name: 'alpha', status: 'active', isScratch: false, path: '/w/alpha', resolved: true, lastActivityAt: Date.now(), runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 }], sessions: [], live: [], runs: [], tabs: [], usage: { fiveHour: null, sevenDay: null, updatedAt: null }, todos: [], artifacts: [], summaryPending: [], index: { phase: 'idle', done: 0, total: 0 }, version: '1' };

// ターミナルの接続はこのテストの対象ではないので、何もしない偽物を渡す。
const terminals: TerminalHost = { connect: vi.fn(), disconnect: vi.fn(), mount: vi.fn(), status: () => null, fit: vi.fn(), focus: vi.fn(), subscribe: () => () => {}, dispose: vi.fn() };

const session: SessionDto = { id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: 'p1', name: 'せっしょん', cwd: '/w/alpha', firstPrompt: null, aiTitle: null, startedAt: Date.now(), lastActivityAt: Date.now(), memo: null, hasTranscript: true, live: null, summary: null, fromScratch: false, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null } };

function make(over: { boot?: BootstrapDto; api?: Partial<ApiClient>; terminals?: TerminalHost } = {}) {
  const b = over.boot ?? boot;
  let hash = '#/';
  const hashListeners = new Set<() => void>();
  const handlers: { onOpen(): void; onClose(): void; onEvent(ev: ServerEvent): void }[] = [];
  const deps: RuntimeDeps = {
    api: { bootstrap: async () => b, events: async () => ({ sessionId: '', events: [], total: 0, nextSeq: null }), subagents: async () => [], search: async () => ({ hits: [], total: 0 }), setProjectStatus: async () => b.projects[0]!, resolveProject: async () => ({}), candidates: async () => ['/w/alpha2'], updateSettings: async (p) => ({ ...b.settings, ...p }), rebuildIndex: async () => {}, ...fakeApiExtras(), ...over.api },
    ws: (h) => { handlers.push(h); return { connect: () => {}, close: () => {} }; },
    location: { getHash: () => hash, setHash: (h) => { hash = h; for (const l of hashListeners) l(); }, onHashChange: (cb) => { hashListeners.add(cb); return () => hashListeners.delete(cb); } },
    storage: { get: () => undefined, set: () => {}, keys: () => [] },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    terminals: over.terminals ?? terminals,
  };
  const rt = createRuntime(deps);
  return { rt, deps, handlers, setHash: deps.location.setHash, terminals: deps.terminals };
}
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

const rootRun = (id: string, sessionId: string): RunDto => ({ id, sessionId, deviceId: 'd', kind: 'start', tmuxName: `hangar-${id}`, pid: 1, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 });
const rootTab = (id: string, runId: string, kind: 'agent' | 'shell'): TabDto => ({ id, runId, sessionId: 's1', kind, title: id, tmuxName: `hangar-${runId}-${id}`, createdAt: Number(id.replace(/\D/g, '')), closedAt: null });

/** 起動が終わったところまで進めた Root。ショートカットのテストの出発点である。 */
async function mounted(over: { boot?: BootstrapDto; api?: Partial<ApiClient>; terminals?: TerminalHost } = {}) {
  const m = make({ boot: { ...boot, sessions: [session] }, ...over });
  m.rt.start();
  render(<Root runtime={m.rt} api={m.deps.api} terminals={m.terminals} />);
  act(() => m.handlers[0]!.onOpen());
  await flush();
  return { ...m, wsHandlers: m.handlers };
}

describe('Root', () => {
  it('起動から Home、Projects へ遷移、未解決ダイアログ', async () => {
    const { rt, deps, handlers, setHash } = make();
    rt.start();
    render(<Root runtime={rt} api={deps.api} terminals={terminals} />);
    expect(screen.getByText('読み込んでいます')).toBeInTheDocument();
    act(() => handlers[0]!.onOpen());
    await flush();
    expect(screen.getByText('プロジェクト')).toBeInTheDocument();
    act(() => setHash('#/projects'));
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    expect(screen.getByText('alpha')).toBeInTheDocument();
    act(() => rt.dispatch({ kind: 'server', event: { type: 'project.unresolved', projectId: 'p1' } }));
    await flush();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('/w/alpha2')).toBeInTheDocument();
  });
  it('トーストは出て、5 秒で消える', async () => {
    vi.useFakeTimers();
    const { rt, deps } = make();
    rt.start();
    render(<Root runtime={rt} api={deps.api} terminals={terminals} />);
    act(() => rt.dispatch({ kind: 'server', event: { type: 'toast', level: 'info', message: 'hello' } }));
    expect(screen.getByText('hello')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(5100); });
    expect(screen.queryByText('hello')).toBeNull();
    vi.useRealTimers();
  });
  it('キーボード。/ で検索欄にフォーカスし、⌘K でパレットが開き、Esc で閉じる', async () => {
    const { rt, deps, handlers } = make();
    rt.start();
    render(<Root runtime={rt} api={deps.api} terminals={terminals} />);
    act(() => handlers[0]!.onOpen());
    await flush();
    fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement?.id).toBe('global-search');
    // 入力中の / は横取りしない。
    fireEvent.keyDown(document.getElementById('global-search')!, { key: '/' });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    // 仮の板を本物のパレットに差し替えたので、見出しの文字ではなく入力欄のラベルで探す。
    expect(screen.getByLabelText('コマンドパレット')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByLabelText('コマンドパレット')).toBeNull();
    // Esc は未解決ダイアログを閉じない。
    act(() => rt.dispatch({ kind: 'server', event: { type: 'project.unresolved', projectId: 'p1' } }));
    await flush();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
  it('⌘N と新規ボタンで起動ダイアログが開き、閉じられる', async () => {
    const { rt, deps, handlers } = make();
    rt.start();
    render(<Root runtime={rt} api={deps.api} terminals={terminals} />);
    act(() => handlers[0]!.onOpen());
    await flush();
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true })); });
    expect(screen.getByRole('dialog', { name: '新しいセッション' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /alpha/ })).toBeInTheDocument();
    fireEvent.click(screen.getByText('やめる'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('セッションを開くとサブエージェントの一覧が届き、選択欄が出る', async () => {
    const { rt, deps, handlers, setHash } = make({ boot: { ...boot, sessions: [session] }, api: { subagents: async () => ['agent-1'] } });
    rt.start();
    render(<Root runtime={rt} api={deps.api} terminals={terminals} />);
    act(() => handlers[0]!.onOpen());
    await flush();
    act(() => setHash('#/session/s1'));
    await flush();
    const select = screen.getByLabelText('サブエージェント') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'agent-1']);
  });
  it('ターミナルの状態は SessionScreen まで届く', async () => {
    const run: RunDto = { id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: Date.now(), endedAt: null, endReason: null, heartbeatAt: 1 };
    const tab: TabDto = { id: 'r1', runId: 'r1', sessionId: 's1', kind: 'agent', title: 'Claude', tmuxName: 'hangar-r1', createdAt: 1, closedAt: null };
    const host: TerminalHost = { ...terminals, status: () => 'error' };
    const { rt, deps, handlers, setHash } = make({ boot: { ...boot, sessions: [session], runs: [run], tabs: [tab] }, terminals: host });
    rt.start();
    render(<Root runtime={rt} api={deps.api} terminals={host} />);
    act(() => handlers[0]!.onOpen());
    await flush();
    act(() => setHash('#/session/s1'));
    await flush();
    expect(screen.getByText('ターミナルに接続できませんでした')).toBeInTheDocument();
  });
});

describe('フェーズ 3 のショートカットとオーバーレイ', () => {
  const key = (init: KeyboardEventInit) => fireEvent.keyDown(window, init);

  it('グローバルのキーが Intent になる', async () => {
    const { rt } = await mounted();
    const emit = vi.spyOn(rt, 'emit');
    key({ key: 'k', metaKey: true });
    expect(emit).toHaveBeenCalledWith({ type: 'palette.open' });
    key({ key: 'n', metaKey: true });
    expect(emit).toHaveBeenCalledWith({ type: 'session.new.open', scratch: false });
    key({ key: 'N', metaKey: true, shiftKey: true });
    expect(emit).toHaveBeenCalledWith({ type: 'session.new.open', scratch: true });
    key({ key: ',', metaKey: true });
    expect(emit).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'settings' } });
  });

  it('セッション画面でタブと分割とトランスクリプトのキーが効く', async () => {
    const { rt, wsHandlers, setHash } = await mounted();
    act(() => setHash('#/session/s1'));
    await flush();
    act(() => wsHandlers[0]!.onEvent({ type: 'run.started', run: rootRun('r1', 's1'), tabs: [rootTab('t1', 'r1', 'agent'), rootTab('t2', 'r1', 'shell')] }));
    await flush();
    const emit = vi.spyOn(rt, 'emit');
    key({ key: '2', metaKey: true });
    expect(emit).toHaveBeenCalledWith({ type: 'tab.select', tabId: 't2' });
    key({ key: '2', ctrlKey: true, altKey: true });
    expect(emit).toHaveBeenLastCalledWith({ type: 'tab.select', tabId: 't2' });
    key({ key: '\\', metaKey: true });
    expect(emit).toHaveBeenCalledWith({ type: 'split.toggle' });
    key({ key: 'j', metaKey: true });
    expect(emit).toHaveBeenCalledWith({ type: 'transcript.toggle' });
  });

  it('タブが 1 つだけなら ⌘\\ は何も出さない', async () => {
    const { rt, wsHandlers, setHash } = await mounted();
    act(() => setHash('#/session/s1'));
    await flush();
    act(() => wsHandlers[0]!.onEvent({ type: 'run.started', run: rootRun('r1', 's1'), tabs: [rootTab('t1', 'r1', 'agent')] }));
    await flush();
    const emit = vi.spyOn(rt, 'emit');
    key({ key: '\\', metaKey: true });
    expect(emit).not.toHaveBeenCalledWith({ type: 'split.toggle' });
  });

  it('⌘W は閉じられるタブのときだけ tab.close を出す', async () => {
    const { rt, wsHandlers, setHash } = await mounted();
    act(() => setHash('#/session/s1'));
    await flush();
    act(() => wsHandlers[0]!.onEvent({ type: 'run.started', run: rootRun('r1', 's1'), tabs: [rootTab('t1', 'r1', 'agent'), rootTab('t2', 'r1', 'shell')] }));
    await flush();
    const emit = vi.spyOn(rt, 'emit');
    key({ key: 'w', metaKey: true });
    expect(emit).not.toHaveBeenCalledWith({ type: 'tab.close', tabId: 't1' });
    act(() => rt.emit({ type: 'tab.select', tabId: 't2' }));
    await flush();
    key({ key: 'w', metaKey: true });
    expect(emit).toHaveBeenCalledWith({ type: 'tab.close', tabId: 't2' });
  });

  it('ターミナルにフォーカスがあるときは ⌘ を含むものだけを受ける', async () => {
    const { rt } = await mounted();
    const host = document.createElement('div');
    host.className = 'term-host';
    const inner = document.createElement('div');
    host.appendChild(inner);
    document.body.appendChild(host);
    const emit = vi.spyOn(rt, 'emit');
    fireEvent.keyDown(inner, { key: '/', bubbles: true });
    expect(emit).not.toHaveBeenCalled();
    fireEvent.keyDown(inner, { key: 'k', metaKey: true, bubbles: true });
    expect(emit).toHaveBeenCalledWith({ type: 'palette.open' });
    host.remove();
  });

  it('パレットの入力は Root が持ち、閉じると空に戻る', async () => {
    const { rt } = await mounted();
    act(() => rt.emit({ type: 'palette.open' }));
    await flush();
    const input = screen.getByLabelText('コマンドを検索') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'alp' } });
    expect((screen.getByLabelText('コマンドを検索') as HTMLInputElement).value).toBe('alp');
    act(() => rt.emit({ type: 'palette.close' }));
    await flush();
    act(() => rt.emit({ type: 'palette.open' }));
    await flush();
    expect((screen.getByLabelText('コマンドを検索') as HTMLInputElement).value).toBe('');
  });

  it('昇格のダイアログと完了のダイアログが出る', async () => {
    const { rt } = await mounted();
    act(() => rt.emit({ type: 'session.promote.open', id: 's1' }));
    await flush();
    expect(screen.getByLabelText('プロジェクト名')).toBeTruthy();
    act(() => rt.dispatch({ kind: 'runtime', event: { type: 'promote.done', projectId: 'p1', moved: true, reason: null } }));
    await flush();
    expect(screen.getByText('この場所で新しいセッションを開始')).toBeTruthy();
  });

  it('Esc は未解決のダイアログだけは閉じず、ほかのオーバーレイは閉じる', async () => {
    const { rt } = await mounted();
    act(() => rt.emit({ type: 'session.promote.open', id: 's1' }));
    await flush();
    key({ key: 'Escape' });
    await flush();
    expect(screen.queryByLabelText('プロジェクト名')).toBeNull();
  });
});
