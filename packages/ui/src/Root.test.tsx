import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapDto, RunDto, ServerEvent, SessionDto, TabDto } from '@agent-hangar/shared';
import { Root } from './Root.tsx';
import type { ApiClient } from './runtime/api.ts';
import { createRuntime, type RuntimeDeps } from './runtime/runtime.ts';
import type { TerminalHost } from './runtime/terminals.ts';
import { fakeApiExtras } from './test/fakeApi.ts';
import { SWIPE_STALE_HIDE_MS } from './swipe.ts';
import { fakeMotionTokens } from './test/motion.ts';

const boot: BootstrapDto = { device: { id: 'd', name: 'mac' }, settings: { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, syncClaudeConfig: false, nodePath: null, claudePath: null }, projects: [{ id: 'p1', name: 'alpha', status: 'active', isScratch: false, path: '/w/alpha', resolved: true, lastActivityAt: Date.now(), runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 }], sessions: [], live: [], runs: [], tabs: [], usage: { fiveHour: null, sevenDay: null, updatedAt: null }, todos: [], artifacts: [], summaryPending: [], index: { phase: 'idle', done: 0, total: 0 }, version: '1', sync: { state: 'off', url: null, lastPushAt: null, lastPullAt: null, pending: 0, error: null, deviceCount: 0, claudeConfig: { enabled: false, confirmed: false }, skipped: [], sweepPending: null }, devices: [] };

// ターミナルの接続はこのテストの対象ではないので、何もしない偽物を渡す。
const terminals: TerminalHost = { connect: vi.fn(), disconnect: vi.fn(), mount: vi.fn(), status: () => null, fit: vi.fn(), focus: vi.fn(), paste: vi.fn(), zoom: vi.fn(), fontSize: () => 13, subscribe: () => () => {}, dispose: vi.fn() };

const session: SessionDto = { id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: 'p1', name: 'せっしょん', cwd: '/w/alpha', firstPrompt: null, aiTitle: null, startedAt: Date.now(), lastActivityAt: Date.now(), memo: null, hasTranscript: true, live: null, summary: null, fromScratch: false, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, lock: null, remoteOnly: false };

function make(over: { boot?: BootstrapDto; api?: Partial<ApiClient>; terminals?: TerminalHost } = {}) {
  const b = over.boot ?? boot;
  let hash = '#/';
  const hashListeners = new Set<() => void>();
  const handlers: { onOpen(): void; onClose(): void; onEvent(ev: ServerEvent): void }[] = [];
  const go = vi.fn();
  let depth = 0;
  const deps: RuntimeDeps = {
    api: { bootstrap: async () => b, events: async () => ({ sessionId: '', events: [], total: 0, nextSeq: null }), subagents: async () => [], search: async () => ({ hits: [], total: 0 }), setProjectStatus: async () => b.projects[0]!, resolveProject: async () => ({}), candidates: async () => ['/w/alpha2'], updateSettings: async (p) => ({ ...b.settings, ...p }), rebuildIndex: async () => {}, ...fakeApiExtras(), ...over.api },
    ws: (h) => { handlers.push(h); return { connect: () => {}, close: () => {} }; },
    location: { getHash: () => hash, setHash: (h) => { hash = h; depth += 1; for (const l of hashListeners) l(); }, onHashChange: (cb) => { hashListeners.add(cb); return () => hashListeners.delete(cb); }, go, depth: () => depth },
    storage: { get: () => undefined, set: () => {}, keys: () => [] },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    terminals: over.terminals ?? terminals,
  };
  const rt = createRuntime(deps);
  return { rt, deps, handlers, go, setHash: deps.location.setHash, terminals: deps.terminals };
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
  it('起動からホーム、プロジェクトへ遷移、未解決ダイアログ', async () => {
    const { rt, deps, handlers, setHash } = make();
    rt.start();
    render(<Root runtime={rt} api={deps.api} terminals={terminals} />);
    expect(screen.getByText('読み込んでいます')).toBeInTheDocument();
    act(() => handlers[0]!.onOpen());
    await flush();
    // Home の区画の見出し。ナビの項目も同じ名前なので、見出しとして探す。
    expect(screen.getByRole('heading', { level: 2, name: 'プロジェクト' })).toBeInTheDocument();
    act(() => setHash('#/projects'));
    expect(screen.getByRole('heading', { level: 1, name: 'プロジェクト' })).toBeInTheDocument();
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
  it('切断の帯は秒を刻む', () => {
    vi.useFakeTimers();
    const { rt, deps, handlers } = make();
    rt.start();
    render(<Root runtime={rt} api={deps.api} terminals={terminals} />);
    act(() => handlers[0]!.onClose());
    expect(screen.getByRole('status')).toHaveTextContent('2 秒後に再接続します');
    // 相対時刻の時計は既定では 30 秒ごとなので、切れているあいだだけ速く刻まないと数字が嘘になる。
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByRole('status')).toHaveTextContent('1 秒後に再接続します');
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
    // 幅が狭くて検索欄を畳んでいるときは、/ でパレットを開く。隠れた欄にフォーカスしても何も起きないからである。
    const box = document.getElementById('global-search')!;
    box.blur();
    box.style.display = 'none';
    fireEvent.keyDown(window, { key: '/' });
    expect(screen.getByLabelText('コマンドパレット')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    box.style.display = '';
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
    fireEvent.click(screen.getByRole('button', { name: 'プロジェクト' }));
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
    const group = screen.getByRole('radiogroup', { name: 'サブエージェント' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['主線', 'agent-1']);
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

  // 今いるプロジェクト、今見ているセッションのプロジェクトを、ダイアログで最初から選んでおく。
  it('⌘N は今の画面のプロジェクトを選んだ状態で開く', async () => {
    const { rt, setHash } = await mounted();
    const emit = vi.spyOn(rt, 'emit');
    act(() => setHash('#/project/p1'));
    await flush();
    key({ key: 'n', metaKey: true });
    expect(emit).toHaveBeenLastCalledWith({ type: 'session.new.open', scratch: false, projectId: 'p1' });
    act(() => rt.emit({ type: 'overlay.close' }));
    act(() => setHash('#/session/s1'));
    await flush();
    key({ key: 'n', metaKey: true });
    expect(emit).toHaveBeenLastCalledWith({ type: 'session.new.open', scratch: false, projectId: 'p1' });
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

  it('セッション画面の ⌘+ ⌘− ⌘0 は全部の端末の文字の大きさを変え、ブラウザの拡大には渡さない', async () => {
    // fireEvent は既定の動きを止めたときに false を返す。
    const zoom = vi.fn();
    const { wsHandlers, setHash } = await mounted({ terminals: { ...terminals, zoom } });
    act(() => setHash('#/session/s1'));
    await flush();
    act(() => wsHandlers[0]!.onEvent({ type: 'run.started', run: rootRun('r1', 's1'), tabs: [rootTab('t1', 'r1', 'agent')] }));
    await flush();
    expect(key({ key: '=', metaKey: true })).toBe(false);
    expect(key({ key: '-', metaKey: true })).toBe(false);
    expect(key({ key: '0', metaKey: true })).toBe(false);
    expect(zoom.mock.calls).toEqual([['in'], ['out'], ['reset']]);
    // ターミナルにフォーカスがあっても ⌘ の組み合わせなので受ける。
    const host = document.createElement('div');
    host.className = 'term-host';
    document.body.appendChild(host);
    expect(fireEvent.keyDown(host, { key: '+', metaKey: true, shiftKey: true, bubbles: true })).toBe(false);
    expect(zoom).toHaveBeenLastCalledWith('in');
    host.remove();
  });

  it('端末の無い画面の ⌘+ ⌘− ⌘0 はブラウザに渡す', async () => {
    const zoom = vi.fn();
    await mounted({ terminals: { ...terminals, zoom } });
    expect(key({ key: '=', metaKey: true })).toBe(true);
    expect(key({ key: '0', metaKey: true })).toBe(true);
    expect(zoom).not.toHaveBeenCalled();
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
    // promote.done は送信中のときだけ効くので、先に送信まで進める。
    act(() => rt.emit({ type: 'session.promote.submit', id: 's1', name: 'newp', gitInit: false, moveFiles: false }));
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

describe('フェーズ 4 のオーバーレイ', () => {
  const key = (init: KeyboardEventInit) => fireEvent.keyDown(window, init);

  it('本文の 409 で確認のダイアログが出て、Esc で閉じる', async () => {
    const { rt } = await mounted();
    act(() => rt.dispatch({ kind: 'runtime', event: { type: 'api.conflict', kind: 'resumeHere', sessionId: 's1', localSize: 1024, remoteSize: 4096 } }));
    await flush();
    expect(screen.getByRole('dialog', { name: '上書きの確認' })).toBeInTheDocument();
    expect(screen.getByText('他の端末の本文 4.0 KB')).toBeInTheDocument();
    // Esc の扱いはフェーズ 3 のままで、新しいオーバーレイも overlayKind !== 'none' の枝で閉じる。
    key({ key: 'Escape' });
    await flush();
    expect(screen.queryByRole('dialog', { name: '上書きの確認' })).toBeNull();
  });

  it('一覧から削除は確認を挟み、件数を出し、Esc で未解決のダイアログへ戻る', async () => {
    const resolveProject = vi.fn(async () => ({}));
    const { rt } = await mounted({ api: { resolveProject } });
    act(() => rt.dispatch({ kind: 'server', event: { type: 'project.unresolved', projectId: 'p1' } }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '一覧から削除' }));
    await flush();
    const dialog = screen.getByRole('dialog', { name: '一覧から削除の確認' });
    expect(dialog).toHaveTextContent('プロジェクト alpha を一覧から削除し、1 件のセッションを未分類に戻します。');
    expect(resolveProject).not.toHaveBeenCalled();
    key({ key: 'Escape' });
    await flush();
    expect(screen.queryByRole('dialog', { name: '一覧から削除の確認' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'プロジェクトの場所を確認' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '一覧から削除' }));
    await flush();
    fireEvent.click(within(screen.getByRole('dialog', { name: '一覧から削除の確認' })).getByRole('button', { name: '一覧から削除' }));
    await flush();
    expect(resolveProject).toHaveBeenCalledWith('p1', { kind: 'unlink' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('取り込みの下見は store の一覧をそのまま出す', async () => {
    const { rt } = await mounted({ api: { configPreview: async () => ({ confirmed: false, entries: [{ path: 'CLAUDE.md', action: 'create' as const, localMtime: null, remoteMtime: 2, remoteDevice: 'mini', size: 10 }] }) } });
    act(() => rt.emit({ type: 'sync.config.preview' }));
    await flush();
    expect(screen.getByRole('dialog', { name: '取り込み内容の確認' })).toBeInTheDocument();
    expect(screen.getByText('CLAUDE.md')).toBeInTheDocument();
    key({ key: 'Escape' });
    await flush();
    expect(screen.queryByRole('dialog', { name: '取り込み内容の確認' })).toBeNull();
  });
});

describe('キーの見直し', () => {
  // 既定の動作を止めたかどうかを見たいので、イベントは自分で作って投げる。
  const key = (init: KeyboardEventInit, target: EventTarget = window) => {
    const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    act(() => { target.dispatchEvent(ev); });
    return ev;
  };
  const wheel = (deltaX: number, deltaY = 0, target: EventTarget = window) =>
    act(() => { target.dispatchEvent(new WheelEvent('wheel', { deltaX, deltaY, bubbles: true })); });
  // スワイプはデスクトップの殻の中だけの機能で、指の位相が届くことが前提になる。
  const shell = () => window as unknown as { __hangarPhaseAware?: boolean; __hangarSwipeBegin?: () => void; __hangarSwipeEnd?: () => void };
  const phaseOn = () => { shell().__hangarPhaseAware = true; };
  const beginGesture = () => act(() => { shell().__hangarSwipeBegin!(); });
  const endGesture = () => act(() => { shell().__hangarSwipeEnd!(); });
  afterEach(() => { delete shell().__hangarPhaseAware; });

  it('受け取らない ⌘1 と ⌘W は、ブラウザと OS に渡す', async () => {
    const { rt } = await mounted();
    const emit = vi.spyOn(rt, 'emit');
    // ホーム画面にはタブが無い。
    expect(key({ key: '1', metaKey: true }).defaultPrevented).toBe(false);
    expect(key({ key: 'w', metaKey: true }).defaultPrevented).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('受け取る ⌘1 と ⌘W は、ブラウザに渡さない', async () => {
    const { wsHandlers, setHash, rt } = await mounted();
    act(() => setHash('#/session/s1'));
    await flush();
    act(() => wsHandlers[0]!.onEvent({ type: 'run.started', run: rootRun('r1', 's1'), tabs: [rootTab('t1', 'r1', 'agent'), rootTab('t2', 'r1', 'shell')] }));
    await flush();
    expect(key({ key: '2', metaKey: true }).defaultPrevented).toBe(true);
    act(() => rt.emit({ type: 'tab.select', tabId: 't2' }));
    await flush();
    expect(key({ key: 'w', metaKey: true }).defaultPrevented).toBe(true);
  });

  // セッション画面の ⌘W は窓（アプリ）を閉じない。閉じてよいのはフォーカスのある枠のシェルタブだけである。
  const sessionWithShell = async () => {
    const m = await mounted();
    act(() => m.setHash('#/session/s1'));
    await flush();
    act(() => m.wsHandlers[0]!.onEvent({ type: 'run.started', run: rootRun('r1', 's1'), tabs: [rootTab('r1', 'r1', 'agent'), rootTab('t2', 'r1', 'shell')] }));
    await flush();
    return m;
  };
  const paneHost = (tabId: string) => document.querySelector<HTMLElement>(`.term-host[data-tab="${tabId}"]`)!;

  it('セッション画面の ⌘W は、Claude のタブでも窓に渡さず、何も閉じない', async () => {
    const { rt } = await sessionWithShell();
    const emit = vi.spyOn(rt, 'emit');
    expect(key({ key: 'w', metaKey: true }).defaultPrevented).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it('run の無いセッション画面でも ⌘W は窓に渡さない', async () => {
    const { rt, setHash } = await mounted();
    act(() => setHash('#/session/s1'));
    await flush();
    const emit = vi.spyOn(rt, 'emit');
    expect(key({ key: 'w', metaKey: true }).defaultPrevented).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it('分割中の ⌘W は、フォーカスのある枠のタブがシェルのときだけそれを閉じる', async () => {
    const { rt } = await sessionWithShell();
    act(() => rt.emit({ type: 'split.toggle' }));
    await flush();
    expect(paneHost('r1')).not.toBeNull();
    expect(paneHost('t2')).not.toBeNull();
    const emit = vi.spyOn(rt, 'emit');
    // 左の Claude の枠にフォーカスがあれば、何も閉じない。
    fireEvent.focusIn(paneHost('r1'));
    expect(key({ key: 'w', metaKey: true }).defaultPrevented).toBe(true);
    expect(emit).not.toHaveBeenCalled();
    // 右のシェルの枠を押すと、そこが ⌘W の対象になる。
    fireEvent.pointerDown(paneHost('t2'));
    expect(key({ key: 'w', metaKey: true }).defaultPrevented).toBe(true);
    expect(emit).toHaveBeenCalledWith({ type: 'tab.close', tabId: 't2' });
  });

  it('枠の外へフォーカスが移っても、最後にフォーカスのあった枠を覚えている', async () => {
    const { rt } = await sessionWithShell();
    act(() => rt.emit({ type: 'split.toggle' }));
    await flush();
    const emit = vi.spyOn(rt, 'emit');
    fireEvent.focusIn(paneHost('t2'));
    const outside = screen.getByRole('button', { name: '停止' });
    fireEvent.focusIn(outside);
    key({ key: 'w', metaKey: true }, outside);
    expect(emit).toHaveBeenCalledWith({ type: 'tab.close', tabId: 't2' });
  });

  it('枠の中で打った ⌘W は、その枠のタブを閉じる', async () => {
    const { rt } = await sessionWithShell();
    act(() => rt.emit({ type: 'split.toggle' }));
    await flush();
    const emit = vi.spyOn(rt, 'emit');
    key({ key: 'w', metaKey: true }, paneHost('t2'));
    expect(emit).toHaveBeenCalledWith({ type: 'tab.close', tabId: 't2' });
  });

  it('Ctrl でも ⌘ と同じ操作になる', async () => {
    const { rt, wsHandlers, setHash } = await mounted();
    act(() => setHash('#/session/s1'));
    await flush();
    act(() => wsHandlers[0]!.onEvent({ type: 'run.started', run: rootRun('r1', 's1'), tabs: [rootTab('t1', 'r1', 'agent'), rootTab('t2', 'r1', 'shell')] }));
    await flush();
    const emit = vi.spyOn(rt, 'emit');
    key({ key: '\\', ctrlKey: true });
    expect(emit).toHaveBeenCalledWith({ type: 'split.toggle' });
    key({ key: 'j', ctrlKey: true });
    expect(emit).toHaveBeenCalledWith({ type: 'transcript.toggle' });
  });

  it('ターミナルの中の Ctrl の打鍵は端末のものなので横取りしない', async () => {
    const { rt } = await mounted();
    const host = document.createElement('div');
    host.className = 'term-host';
    document.body.appendChild(host);
    const emit = vi.spyOn(rt, 'emit');
    expect(key({ key: 'k', ctrlKey: true }, host).defaultPrevented).toBe(false);
    expect(key({ key: 'w', ctrlKey: true }, host).defaultPrevented).toBe(false);
    expect(emit).not.toHaveBeenCalled();
    host.remove();
  });

  it('? でキーの一覧が開き、Esc で閉じる', async () => {
    await mounted();
    key({ key: '?', shiftKey: true });
    await flush();
    expect(screen.getByRole('dialog', { name: 'キーボード' })).toBeInTheDocument();
    expect(screen.getByText('コマンドパレット')).toBeInTheDocument();
    key({ key: 'Escape' });
    await flush();
    expect(screen.queryByRole('dialog', { name: 'キーボード' })).toBeNull();
  });

  it('入力中の ? は文字なので、一覧を開かない', async () => {
    await mounted();
    fireEvent.keyDown(document.getElementById('global-search')!, { key: '?', shiftKey: true });
    await flush();
    expect(screen.queryByRole('dialog', { name: 'キーボード' })).toBeNull();
  });

  it('⌘[ と ⌘] で履歴が動く', async () => {
    const { go, setHash } = await mounted();
    act(() => setHash('#/projects'));
    key({ key: '[', metaKey: true });
    expect(go).toHaveBeenCalledWith(-1);
    key({ key: ']', metaKey: true });
    expect(go).toHaveBeenCalledWith(1);
  });

  it('入力欄の外の Backspace では戻らない', async () => {
    // WKWebView は、入力欄の外の Backspace で履歴を 1 つ戻す。いまの Chrome と Safari には無い動きなので止める。
    const { go, setHash, rt } = await mounted();
    act(() => setHash('#/projects'));
    const emit = vi.spyOn(rt, 'emit');
    expect(key({ key: 'Backspace' }).defaultPrevented).toBe(true);
    expect(key({ key: 'Backspace' }, document.body).defaultPrevented).toBe(true);
    expect(go).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('入力欄とターミナルの Backspace は文字を消すので止めない', async () => {
    await mounted();
    expect(key({ key: 'Backspace' }, document.getElementById('global-search')!).defaultPrevented).toBe(false);
    const host = document.createElement('div');
    host.className = 'term-host';
    const ta = document.createElement('textarea');
    host.appendChild(ta);
    document.body.appendChild(host);
    expect(key({ key: 'Backspace' }, ta).defaultPrevented).toBe(false);
    host.remove();
  });

  it('ブラウザでは自前のスワイプを使わない', async () => {
    // ブラウザには元から手勢がある。二重に持たず、標準の戻る進むに任せる。
    const { go, setHash } = await mounted();
    act(() => setHash('#/projects'));
    for (let i = 0; i < 8; i++) wheel(-30);
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(go).not.toHaveBeenCalled();
    expect(screen.getByTestId('swipe-hint').dataset.dir).toBeUndefined();
  });

  it('引いている間は矢印が出るだけで、離すまで画面は動かない', async () => {
    const { setHash, go } = await mounted();
    act(() => setHash('#/projects'));
    phaseOn();
    const hint = screen.getByTestId('swipe-hint');
    beginGesture();
    // しきい値の半分まで引く。
    for (let i = 0; i < 3; i++) wheel(-20);
    expect(hint.dataset.dir).toBe('back');
    expect(hint.dataset.armed).toBeUndefined();
    expect(Number(hint.style.getPropertyValue('--swipe-ratio'))).toBeCloseTo(0.5);
    // 引き切ると身構えるが、指が付いている間はまだ動かない。
    for (let i = 0; i < 3; i++) wheel(-20);
    expect(hint.dataset.armed).toBe('true');
    expect(go).not.toHaveBeenCalled();
    endGesture();
    expect(go).toHaveBeenCalledWith(-1);
    expect(hint.dataset.done).toBe('true');
  });

  it('動いた後の矢印は、--dur-exit の消える動きが終わってから片付ける', async () => {
    // 片付けは display: none にするので、消える動きより先に片付けると最後の数コマが飛ぶ。
    const restore = fakeMotionTokens({ '--dur-exit': '120ms' });
    try {
      const { setHash } = await mounted();
      act(() => setHash('#/projects'));
      phaseOn();
      const hint = screen.getByTestId('swipe-hint');
      beginGesture();
      for (let i = 0; i < 6; i++) wheel(-20);
      endGesture();
      expect(hint.dataset.done).toBe('true');
      await act(() => new Promise((r) => setTimeout(r, 80)));
      expect(hint.dataset.dir).toBe('back');
      await act(() => new Promise((r) => setTimeout(r, 80)));
      expect(hint.dataset.dir).toBeUndefined();
    } finally { restore(); }
  });

  it('位相が届く環境でも、時間では確定しない', async () => {
    // 時間で打ち切る経路を残すと、合図が遅れた回に、指を置いたまま画面が動く。
    const { setHash, go } = await mounted();
    act(() => setHash('#/projects'));
    phaseOn();
    beginGesture();
    for (let i = 0; i < 6; i++) wheel(-20);
    await act(() => new Promise((r) => setTimeout(r, 800)));
    expect(go).not.toHaveBeenCalled();
    endGesture();
    expect(go).toHaveBeenCalledWith(-1);
  });

  it('引いて止めたまま持ち続けても、離すまで動かない', async () => {
    const { setHash, go } = await mounted();
    act(() => setHash('#/projects'));
    phaseOn();
    beginGesture();
    for (let i = 0; i < 6; i++) wheel(-20);
    await act(() => new Promise((r) => setTimeout(r, 700)));
    expect(go).not.toHaveBeenCalled();
    expect(screen.getByTestId('swipe-hint').dataset.armed).toBe('true');
    endGesture();
    expect(go).toHaveBeenCalledWith(-1);
  });

  it('離した後の惰性で矢印が戻ってこない', async () => {
    // 指が離れた後もホイールは流れ続ける。それを拾って描き直すと、矢印が消えないまま残る。
    const { setHash } = await mounted();
    act(() => setHash('#/projects'));
    phaseOn();
    const hint = screen.getByTestId('swipe-hint');
    beginGesture();
    // 引き切らずに離す。画面は動かないが、矢印は片付く。
    for (let i = 0; i < 3; i++) wheel(-20);
    expect(hint.dataset.dir).toBe('back');
    endGesture();
    expect(hint.dataset.dir).toBeUndefined();
    for (let i = 0; i < 6; i++) wheel(-14);
    expect(hint.dataset.dir).toBeUndefined();
  });

  it('引き切ってから引き戻せば、離しても動かない', async () => {
    const { setHash, go } = await mounted();
    act(() => setHash('#/projects'));
    phaseOn();
    beginGesture();
    for (let i = 0; i < 6; i++) wheel(-20);
    // 揺れの 1 つでは取り消さない。引いた分の半分を戻して初めて取り消す。
    for (let i = 0; i < 4; i++) wheel(20);
    endGesture();
    expect(go).not.toHaveBeenCalled();
  });

  it('戻れないときは矢印を出さない', async () => {
    await mounted();
    phaseOn();
    beginGesture();
    for (let i = 0; i < 3; i++) wheel(-20);
    expect(screen.getByTestId('swipe-hint').dataset.dir).toBeUndefined();
  });

  it('宙に浮いた手勢の矢印は、しばらくして消える', async () => {
    // 合図を取りこぼしても矢印が居残らないようにする。消すだけで、画面は動かさない。
    const { setHash, go } = await mounted();
    act(() => setHash('#/projects'));
    phaseOn();
    beginGesture();
    for (let i = 0; i < 3; i++) wheel(-20);
    expect(screen.getByTestId('swipe-hint').dataset.dir).toBe('back');
    await act(() => new Promise((r) => setTimeout(r, SWIPE_STALE_HIDE_MS + 200)));
    expect(screen.getByTestId('swipe-hint').dataset.dir).toBeUndefined();
    expect(go).not.toHaveBeenCalled();
  });

  it('アプリの最初の頁からはスワイプでも戻らない', async () => {
    // デスクトップでは、その手前がサーバの起動を待つ頁である。そこへ戻ると二度と遷移せず詰む。
    const { go } = await mounted();
    phaseOn();
    beginGesture();
    for (let i = 0; i < 6; i++) wheel(-30);
    endGesture();
    expect(go).not.toHaveBeenCalled();
  });

  it('縦に流しているだけでは履歴が動かない', async () => {
    const { setHash, go } = await mounted();
    act(() => setHash('#/projects'));
    phaseOn();
    beginGesture();
    for (let i = 0; i < 20; i++) wheel(-5, -30);
    endGesture();
    expect(go).not.toHaveBeenCalled();
  });

  it('横に流せる箱は、端に着くまで手勢を取る', async () => {
    const { go, setHash } = await mounted();
    act(() => setHash('#/projects'));
    phaseOn();
    // 一覧のように横へはみ出した箱。左へまだ流せるので、この手勢は箱のものである。
    const box = document.createElement('div');
    box.style.overflowX = 'auto';
    Object.defineProperty(box, 'scrollWidth', { value: 900, configurable: true });
    Object.defineProperty(box, 'clientWidth', { value: 300, configurable: true });
    Object.defineProperty(box, 'scrollLeft', { value: 150, writable: true, configurable: true });
    document.body.appendChild(box);
    const pull = () => { for (let i = 0; i < 6; i++) wheel(-30, 0, box); };
    beginGesture();
    pull();
    // 左端に着いた。同じ手勢の続きは箱のものなので、ここで離しても画面は動かない。
    box.scrollLeft = 0;
    pull();
    endGesture();
    expect(go).not.toHaveBeenCalled();
    // 引き直せば、左端なので箱は取らない。引き切って離せば動く。
    beginGesture();
    pull();
    endGesture();
    expect(go).toHaveBeenCalledWith(-1);
    box.remove();
  });

  it('箱の端から始めた手勢は、途中で箱に余地ができても画面のもの', async () => {
    // 箱は引かれている間に実際にスクロールし、持ち主の判定が打鍵ごとに裏返る。
    // そのたびに積みを捨てていたので、箱の上では矢印が戻ったり荒ぶっていた。
    const { setHash, go } = await mounted();
    act(() => setHash('#/projects'));
    phaseOn();
    const box = document.createElement('div');
    box.style.overflowX = 'auto';
    Object.defineProperty(box, 'scrollWidth', { value: 900, configurable: true });
    Object.defineProperty(box, 'clientWidth', { value: 300, configurable: true });
    Object.defineProperty(box, 'scrollLeft', { value: 0, writable: true, configurable: true });
    document.body.appendChild(box);
    beginGesture();
    for (let i = 0; i < 3; i++) wheel(-30, 0, box);
    // 同じ手勢の途中で箱に余地ができても、持ち主は変わらない。
    box.scrollLeft = 150;
    for (let i = 0; i < 3; i++) wheel(-30, 0, box);
    endGesture();
    expect(go).toHaveBeenCalledWith(-1);
    box.remove();
  });

  it('パレットからもキーの一覧を開ける', async () => {
    const { rt } = await mounted();
    act(() => rt.emit({ type: 'palette.run', command: { id: 'cmd:shortcuts', label: 'キーの一覧' } }));
    await flush();
    expect(screen.getByRole('dialog', { name: 'キーボード' })).toBeInTheDocument();
  });
});

describe('次の入力待ちへ（C5）', () => {
  const key = (init: KeyboardEventInit, target: EventTarget = window) => {
    const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    act(() => { target.dispatchEvent(ev); });
    return ev;
  };
  const waiting = (id: string, at: number): SessionDto => ({ ...session, id, providerSessionId: 'u' + id, name: '待ち ' + id, live: 'waiting', lastActivityAt: at });
  // s3 は Claude のタブが生きていて、着いたらその端末にフォーカスできる。
  const agentTab: TabDto = { id: 't3', runId: 'r3', sessionId: 's3', kind: 'agent', title: 'Claude', tmuxName: 'hangar-r3', createdAt: 1, closedAt: null };
  const withWaiting = () => ({ ...boot, sessions: [session, waiting('s2', 300), waiting('s3', 100)], runs: [rootRun('r3', 's3')], tabs: [agentTab] });

  it('⌘I で、待っている時間の長いものから順に開き、端末にフォーカスする', async () => {
    const host: TerminalHost = { ...terminals, focus: vi.fn() };
    const m = make({ boot: withWaiting(), terminals: host });
    m.rt.start();
    render(<Root runtime={m.rt} api={m.deps.api} terminals={host} />);
    act(() => m.handlers[0]!.onOpen());
    await flush();
    expect(key({ key: 'i', metaKey: true }).defaultPrevented).toBe(true);
    await flush();
    expect(m.deps.location.getHash()).toBe('#/session/s3');
    expect(host.focus).toHaveBeenCalledWith('t3');
    key({ key: 'i', metaKey: true });
    await flush();
    expect(m.deps.location.getHash()).toBe('#/session/s2');
    key({ key: 'i', metaKey: true });
    await flush();
    expect(m.deps.location.getHash()).toBe('#/session/s3');
  });

  it('ターミナルにフォーカスがあっても効く', async () => {
    const m = make({ boot: withWaiting() });
    m.rt.start();
    render(<Root runtime={m.rt} api={m.deps.api} terminals={terminals} />);
    act(() => m.handlers[0]!.onOpen());
    await flush();
    const termHost = document.createElement('div');
    termHost.className = 'term-host';
    const ta = document.createElement('textarea');
    termHost.appendChild(ta);
    document.body.appendChild(termHost);
    expect(key({ key: 'i', metaKey: true }, ta).defaultPrevented).toBe(true);
    await flush();
    expect(m.deps.location.getHash()).toBe('#/session/s3');
    termHost.remove();
  });

  it('入力待ちが無ければ、短いトーストで知らせる', async () => {
    await mounted();
    key({ key: 'i', metaKey: true });
    await flush();
    expect(screen.getByText('入力を待っているセッションはありません')).toBeInTheDocument();
  });

  it('キーの一覧に載る', async () => {
    await mounted();
    key({ key: '?', shiftKey: true });
    await flush();
    const dialog = screen.getByRole('dialog', { name: 'キーボード' });
    expect(within(dialog).getByText('次の入力待ちへ')).toBeInTheDocument();
    expect(within(dialog).getByText('⌘I')).toBeInTheDocument();
  });
});

describe('入力欄の Esc（C4）', () => {
  const key = (init: KeyboardEventInit, target: EventTarget) => {
    const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    act(() => { target.dispatchEvent(ev); });
    return ev;
  };

  it('何も開いていなければ、入力欄の Esc でフォーカスを外す', async () => {
    await mounted();
    const box = document.getElementById('global-search')!;
    act(() => box.focus());
    expect(key({ key: 'Escape' }, box).defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(box);
  });

  it('ダイアログの中の入力欄の Esc は、従来どおりダイアログを閉じる', async () => {
    const { rt } = await mounted();
    act(() => rt.emit({ type: 'session.promote.open', id: 's1' }));
    await flush();
    const input = screen.getByLabelText('プロジェクト名');
    act(() => input.focus());
    fireEvent.keyDown(input, { key: 'Escape' });
    await flush();
    expect(screen.queryByLabelText('プロジェクト名')).toBeNull();
  });

  it('パレットの入力欄の Esc は、パレットを閉じる', async () => {
    const { rt } = await mounted();
    act(() => rt.emit({ type: 'palette.open' }));
    await flush();
    fireEvent.keyDown(screen.getByLabelText('コマンドを検索'), { key: 'Escape' });
    await flush();
    expect(screen.queryByLabelText('コマンドパレット')).toBeNull();
  });

  it('ターミナルの Esc は Claude Code のものなので横取りしない', async () => {
    const { rt } = await mounted();
    const host = document.createElement('div');
    host.className = 'term-host';
    const ta = document.createElement('textarea');
    host.appendChild(ta);
    document.body.appendChild(host);
    ta.focus();
    const emit = vi.spyOn(rt, 'emit');
    expect(key({ key: 'Escape' }, ta).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(ta);
    expect(emit).not.toHaveBeenCalled();
    host.remove();
  });

  it('日本語の変換中の Esc は変換を取り消す打鍵なので、欄を離れない', async () => {
    await mounted();
    const box = document.getElementById('global-search')!;
    act(() => box.focus());
    expect(key({ key: 'Escape', isComposing: true }, box).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(box);
    expect(key({ key: 'Escape', keyCode: 229 } as KeyboardEventInit, box).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(box);
  });

  it('部品が自分で Esc を処理したときは、重ねてフォーカスを外さない', async () => {
    await mounted();
    const box = document.getElementById('global-search')!;
    act(() => box.focus());
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    ev.preventDefault();
    act(() => { box.dispatchEvent(ev); });
    expect(document.activeElement).toBe(box);
  });
});

describe('画面に入ったときの一覧のフォーカス（C1）', () => {
  const rows = () => screen.getByTestId('session-rows');

  it('Home に入ると、最近の一覧にフォーカスする', async () => {
    await mounted();
    expect(document.activeElement).toBe(rows());
  });

  it('セッションの一覧の画面に入っても一覧にフォーカスする', async () => {
    const { setHash } = await mounted();
    act(() => (document.activeElement as HTMLElement).blur());
    act(() => setHash('#/sessions'));
    await flush();
    expect(document.activeElement).toBe(rows());
  });

  it('ヘッダーの検索欄で打っている最中は、画面が変わってもフォーカスを奪わない', async () => {
    const { setHash } = await mounted();
    const box = document.getElementById('global-search')!;
    act(() => box.focus());
    act(() => setHash('#/sessions'));
    await flush();
    expect(document.activeElement).toBe(box);
  });

  it('ヘッダーの検索で Enter すると、結果の一覧へ移る', async () => {
    const hit = { sessionId: 's1', matchCount: 1, snippets: [{ seq: 1, role: 'user', text: 'せっしょん' }] };
    await mounted({ api: { search: async () => ({ hits: [hit], total: 1 }) } });
    const box = document.getElementById('global-search') as HTMLInputElement;
    act(() => box.focus());
    box.value = 'せっ';
    fireEvent.keyDown(box, { key: 'Enter' });
    await flush();
    await flush();
    expect(document.activeElement).toBe(rows());
  });
});
