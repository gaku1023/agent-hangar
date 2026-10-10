import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapDto, RunDto, ServerEvent, SessionDto, TabDto } from '@agent-hangar/shared';
import { Root } from './Root.tsx';
import type { ApiClient } from './runtime/api.ts';
import { createRuntime, type RuntimeDeps } from './runtime/runtime.ts';
import type { TerminalHost } from './runtime/terminals.ts';
import { accountsFixture } from './test/accounts.ts';
import { fakeApiExtras } from './test/fakeApi.ts';
import { FOCUS_IDS, focusSoon } from './runtime/focusSoon.ts';
import { SWIPE_STALE_HIDE_MS } from './swipe.ts';
import { fakeMotionTokens } from './test/motion.ts';

const boot: BootstrapDto = { device: { id: 'd', name: 'mac' }, settings: { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, nodePath: null, claudePath: null }, projects: [{ id: 'p1', name: 'alpha', status: 'active', isScratch: false, path: '/w/alpha', resolved: true, lastActivityAt: Date.now(), runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 }], sessions: [], live: [], runs: [], tabs: [], todos: [], artifacts: [], summaryPending: [], index: { phase: 'idle', done: 0, total: 0 }, version: '1', sync: { state: 'off', url: null, lastPushAt: null, lastPullAt: null, pending: 0, error: null, deviceCount: 0, limitedUntil: null, paused: false, skipped: [], sweepPending: null, oncePass: false }, devices: [], retention: null, cloudUsage: null, accounts: { currentId: 'primary', accounts: [], sessions: {} } };

// ターミナルの接続はこのテストの対象ではないので、何もしない偽物を渡す。
const terminals: TerminalHost = { connect: vi.fn(), disconnect: vi.fn(), mount: vi.fn(), status: () => null, fit: vi.fn(), focus: vi.fn(), paste: vi.fn(), zoom: vi.fn(), fontSize: () => 13, painted: () => true, subscribe: () => () => {}, dispose: vi.fn(), link: () => ({ retryAt: null, dropped: false, gaveUp: false, detached: false }), reconnect: vi.fn() };

const session: SessionDto = { id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: 'p1', name: 'せっしょん', cwd: '/w/alpha', firstPrompt: null, aiTitle: null, startedAt: Date.now(), lastActivityAt: Date.now(), memo: null, hasTranscript: true, live: null, summary: null, fromScratch: false, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null };

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
    // main.tsx と同じく、フォーカスの対象を id で探して当てる。
    focus: (t) => focusSoon(() => document.getElementById(FOCUS_IDS[t]), (cb) => { requestAnimationFrame(cb); }),
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

/** 入力欄の打鍵を確かめるための、画面の外に置く欄。ヘッダーには打つ欄が無い（押す錠剤である）。 */
const fields: HTMLElement[] = [];
afterEach(() => { for (const el of fields.splice(0)) el.remove(); });
function textField(): HTMLInputElement {
  const el = document.createElement('input');
  document.body.append(el);
  fields.push(el);
  return el;
}

describe('Root', () => {
  it('起動からホーム、プロジェクトへ遷移、未解決ダイアログ', async () => {
    const { rt, deps, handlers, setHash } = make();
    rt.start();
    render(<Root runtime={rt} api={deps.api} terminals={terminals} />);
    expect(screen.getByText('読み込んでいます')).toBeInTheDocument();
    act(() => handlers[0]!.onOpen());
    await flush();
    // Home は一覧が主役で、見出しは「セッション」。最近とプロジェクトの 1 行は無い。
    expect(screen.getByRole('heading', { level: 2, name: /^セッション\d+ 件$/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: '最近' })).toBeNull();
    act(() => setHash('#/projects'));
    expect(screen.getByRole('heading', { level: 1, name: 'プロジェクト' })).toBeInTheDocument();
    expect(screen.getByText('alpha')).toBeInTheDocument();
    act(() => rt.emit({ type: 'project.resolve.open', id: 'p1' }));
    await flush();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('/w/alpha2')).toBeInTheDocument();
  });
  describe('未解決のプロジェクト（2.11.5）', () => {
    const lost = { id: 'p9', name: 'old-shop', status: 'active' as const, isScratch: false, path: '/w/old-shop', resolved: false, lastActivityAt: 1, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1, unresolved: { kind: 'missing' as const, previousPath: '/w/old-shop', deviceName: null } };
    const arrived = (id: string) => ({ ...lost, id, name: id, path: null, unresolved: { kind: 'elsewhere' as const, previousPath: `/o/${id}`, deviceName: 'Mac mini' } });
    const bootWith = (projects: BootstrapDto['projects']): BootstrapDto => ({ ...boot, projects: [...boot.projects, ...projects] });

    it('起動時には、場所の消えたプロジェクトがあってもダイアログを出さない。帯の 4 つ目の錠剤に 1 件と出て、届いただけの 3 件は数えない', async () => {
      await mounted({ boot: bootWith([lost, arrived('x1'), arrived('x2'), arrived('x3')]) });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('button', { name: '場所の不明なプロジェクト 1' })).toBeInTheDocument();
    });

    it('錠剤から引き出しを開き、「場所を再指定」を押したときだけダイアログが開く。Esc で閉じ、錠剤は残る', async () => {
      await mounted({ boot: bootWith([lost]) });
      fireEvent.click(screen.getByRole('button', { name: '場所の不明なプロジェクト 1' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '場所を再指定、old-shop' }));
      await flush();
      const dialog = screen.getByRole('dialog', { name: 'old-shop のディレクトリが見つかりません' });
      expect(dialog).toHaveTextContent('/w/old-shop');
      fireEvent.keyDown(screen.getByLabelText('新しいパス'), { key: 'Escape' });
      await flush();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('button', { name: '場所の不明なプロジェクト 1' })).toBeInTheDocument();
    });

    it('サーバが project.unresolved を流しても、ダイアログは出ない', async () => {
      const { handlers } = await mounted({ boot: bootWith([lost]) });
      act(() => handlers[0]!.onEvent({ type: 'project.unresolved', projectId: 'p9' }));
      await flush();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('他の PC から届いただけのプロジェクトは、帯に数えず、プロジェクトの一覧に「この PC にパスがありません」の札で出る。札から「場所を再指定」が開く', async () => {
      const { setHash } = await mounted({ boot: bootWith([arrived('x1'), arrived('x2')]) });
      expect(screen.queryByRole('button', { name: /^場所の不明なプロジェクト/ })).toBeNull();
      act(() => setHash('#/projects'));
      await flush();
      const flags = screen.getAllByRole('button', { name: 'この PC にパスがありません' });
      expect(flags).toHaveLength(2);
      fireEvent.click(flags[0]!);
      await flush();
      expect(screen.getByRole('dialog', { name: 'x1 はこの PC にパスがありません' })).toHaveTextContent('Mac mini でのパス');
    });

    it('同期で他の PC のプロジェクトが降りたら、札を 1 枚だけ出す。「あとで決める」で下がる', async () => {
      const { handlers } = await mounted();
      act(() => { for (const id of ['x1', 'x2', 'x3']) handlers[0]!.onEvent({ type: 'project.upsert', project: arrived(id) }); });
      await flush();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getAllByText('他の PC のプロジェクト 3 件が届きました。この PC にはフォルダがありません')).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'あとで決める' }));
      expect(screen.queryByText(/件が届きました/)).toBeNull();
    });

    it('札の「プロジェクトで見る」で、プロジェクトの一覧へ移る', async () => {
      const { handlers } = await mounted();
      act(() => handlers[0]!.onEvent({ type: 'project.upsert', project: arrived('x1') }));
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'プロジェクトで見る' }));
      await flush();
      expect(screen.getByRole('heading', { level: 1, name: 'プロジェクト' })).toBeInTheDocument();
      expect(screen.queryByText(/件が届きました/)).toBeNull();
    });
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
  it('キーボード。/ と ⌘K でパレットが開き、Esc で閉じる', async () => {
    const { rt, deps, handlers } = make();
    rt.start();
    render(<Root runtime={rt} api={deps.api} terminals={terminals} />);
    act(() => handlers[0]!.onOpen());
    await flush();
    fireEvent.keyDown(window, { key: '/' });
    expect(screen.getByLabelText('コマンドパレット')).toBeInTheDocument();
    // パレットの入力欄での / は文字なので、横取りしない。
    fireEvent.keyDown(screen.getByLabelText('移動・操作'), { key: '/' });
    expect(screen.getByLabelText('コマンドパレット')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByLabelText('コマンドパレット')).toBeNull();
    // ほかの入力欄で打つ / も文字である。
    const field = textField();
    field.focus();
    fireEvent.keyDown(field, { key: '/' });
    expect(screen.queryByLabelText('コマンドパレット')).toBeNull();
    field.blur();
    // ヘッダーの錠剤を押しても開く。
    fireEvent.click(screen.getByRole('button', { name: '移動・操作' }));
    expect(screen.getByLabelText('コマンドパレット')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    // 仮の板を本物のパレットに差し替えたので、見出しの文字ではなく入力欄のラベルで探す。
    expect(screen.getByLabelText('コマンドパレット')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByLabelText('コマンドパレット')).toBeNull();
    // 未解決のダイアログは、押して開くので、Esc で閉じる。
    act(() => rt.emit({ type: 'project.resolve.open', id: 'p1' }));
    await flush();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
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
    fireEvent.click(screen.getByText('キャンセル'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('書きかけのまま閉じた新しいセッションは、次に開くと下書きとして戻る', async () => {
    const { rt, deps, handlers } = make();
    rt.start();
    render(<Root runtime={rt} api={deps.api} terminals={terminals} />);
    act(() => handlers[0]!.onOpen());
    await flush();
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true })); });
    fireEvent.change(screen.getByLabelText('初期プロンプト（任意）'), { target: { value: 'API の節を書く' } });
    fireEvent.keyDown(screen.getByLabelText('初期プロンプト（任意）'), { key: 'Escape' });
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(rt.getState().newSessionDraft).toEqual({ name: '', prompt: 'API の節を書く', attachments: [] });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true })); });
    await flush();
    expect(screen.getByLabelText('初期プロンプト（任意）')).toHaveValue('API の節を書く');
    expect(within(screen.getByRole('dialog')).getByText('下書き')).toBeInTheDocument();
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
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['メイン会話', 'agent-1']);
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

  it('グローバルのキーが UiAction になる', async () => {
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

  it('端末の無いセッション画面（終わったセッションの本文だけ）の ⌘+ ⌘− ⌘0 はブラウザに渡す', async () => {
    const zoom = vi.fn();
    const { wsHandlers, setHash } = await mounted({ terminals: { ...terminals, zoom } });
    act(() => setHash('#/session/s1'));
    await flush();
    expect(key({ key: '=', metaKey: true })).toBe(true);
    expect(key({ key: '-', metaKey: true })).toBe(true);
    expect(key({ key: '0', metaKey: true })).toBe(true);
    // run が終わってシェルタブも残っていなければ、端末は画面に無い。
    act(() => wsHandlers[0]!.onEvent({ type: 'run.started', run: { ...rootRun('r1', 's1'), endedAt: 2 }, tabs: [rootTab('t1', 'r1', 'agent')] }));
    await flush();
    expect(key({ key: '=', metaKey: true })).toBe(true);
    expect(zoom).not.toHaveBeenCalled();
  });

  it('⌘F は本文が出ているセッション画面でだけ受け、欄を開いてフォーカスする。ターミナルが出ていれば奪わない', async () => {
    const { rt, wsHandlers, setHash } = await mounted();
    // セッション画面の外ではブラウザに渡す。
    expect(key({ key: 'f', metaKey: true })).toBe(true);
    act(() => setHash('#/session/s1'));
    await flush();
    expect(key({ key: 'f', metaKey: true })).toBe(false);
    await flush();
    const box = screen.getByRole('searchbox', { name: 'トランスクリプト内を検索' });
    expect(box).toHaveFocus();
    // Esc で閉じる。
    fireEvent.keyDown(box, { key: 'Escape' });
    await flush();
    expect(screen.queryByRole('searchbox', { name: 'トランスクリプト内を検索' })).toBeNull();
    // ダイアログやパレットを開いている間は、裏の本文の欄を開かない。
    for (const open of [{ type: 'palette.open' as const }, { type: 'shortcuts.open' as const }]) {
      act(() => rt.emit(open));
      await flush();
      expect(key({ key: 'f', metaKey: true })).toBe(true);
      await flush();
      expect(screen.queryByRole('searchbox', { name: 'トランスクリプト内を検索' })).toBeNull();
      act(() => rt.emit(open.type === 'palette.open' ? { type: 'palette.close' } : { type: 'overlay.close' }));
      await flush();
    }
    // ターミナルが出ていれば、⌘F はターミナルとブラウザのものである。
    act(() => wsHandlers[0]!.onEvent({ type: 'run.started', run: rootRun('r1', 's1'), tabs: [rootTab('t1', 'r1', 'agent')] }));
    await flush();
    expect(key({ key: 'f', metaKey: true })).toBe(true);
  });

  it('本文の中の検索の欄は Mediator の State に持たず、画面を離れて戻っても語ごと残る', async () => {
    const { rt, setHash } = await mounted();
    act(() => setHash('#/session/s1'));
    await flush();
    key({ key: 'f', metaKey: true });
    await flush();
    fireEvent.change(screen.getByRole('searchbox', { name: 'トランスクリプト内を検索' }), { target: { value: '語' } });
    expect(rt.getState().sessionView.s1 ?? {}).not.toHaveProperty('find');
    act(() => setHash('#/'));
    await flush();
    expect(screen.queryByRole('searchbox', { name: 'トランスクリプト内を検索' })).toBeNull();
    act(() => setHash('#/session/s1'));
    await flush();
    const box = screen.getByRole('searchbox', { name: 'トランスクリプト内を検索' });
    expect(box).toHaveValue('語');
    expect(box).toHaveFocus();
  });

  it('パレットの入力は Root が持ち、閉じると空に戻る', async () => {
    const { rt } = await mounted();
    act(() => rt.emit({ type: 'palette.open' }));
    await flush();
    const input = screen.getByLabelText('移動・操作') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'alp' } });
    expect((screen.getByLabelText('移動・操作') as HTMLInputElement).value).toBe('alp');
    act(() => rt.emit({ type: 'palette.close' }));
    await flush();
    act(() => rt.emit({ type: 'palette.open' }));
    await flush();
    expect((screen.getByLabelText('移動・操作') as HTMLInputElement).value).toBe('');
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
    expect(screen.getByText('ここで新しいセッションを開始')).toBeTruthy();
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
    expect(screen.getByRole('dialog', { name: 'トランスクリプトを置き換えますか' })).toBeInTheDocument();
    expect(screen.getByText('他の PC のトランスクリプト 4.0 KB')).toBeInTheDocument();
    // Esc の扱いはフェーズ 3 のままで、新しいオーバーレイも overlayKind !== 'none' の枝で閉じる。
    key({ key: 'Escape' });
    await flush();
    expect(screen.queryByRole('dialog', { name: 'トランスクリプトを置き換えますか' })).toBeNull();
  });

  it('一覧から削除は確認を挟み、件数を出し、Esc で未解決のダイアログへ戻る', async () => {
    const resolveProject = vi.fn(async () => ({}));
    const { rt } = await mounted({ api: { resolveProject } });
    act(() => rt.emit({ type: 'project.resolve.open', id: 'p1' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '一覧から削除' }));
    await flush();
    const dialog = screen.getByRole('dialog', { name: '一覧から削除しますか' });
    expect(dialog).toHaveTextContent('プロジェクト alpha を一覧から削除し、1 件のセッションを未分類に戻します。');
    expect(resolveProject).not.toHaveBeenCalled();
    key({ key: 'Escape' });
    await flush();
    expect(screen.queryByRole('dialog', { name: '一覧から削除しますか' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'alpha のディレクトリが見つかりません' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '一覧から削除' }));
    await flush();
    fireEvent.click(within(screen.getByRole('dialog', { name: '一覧から削除しますか' })).getByRole('button', { name: '一覧から削除' }));
    await flush();
    expect(resolveProject).toHaveBeenCalledWith('p1', { kind: 'unlink' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // 確認の中のボタンにフォーカスがあるときの Esc は、確認の殻が受けて既定を止める。
  // Root の Esc も重ねて閉じると、戻ったはずの未解決のダイアログまで「あとで」で閉じてしまう。
  it('一覧から削除の確認の中の Esc は 1 度だけ閉じ、未解決のダイアログへ戻る', async () => {
    const { rt } = await mounted();
    act(() => rt.emit({ type: 'project.resolve.open', id: 'p1' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '一覧から削除' }));
    await flush();
    const cancel = within(screen.getByRole('dialog', { name: '一覧から削除しますか' })).getByRole('button', { name: 'キャンセル' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Escape' });
    await flush();
    expect(screen.queryByRole('dialog', { name: '一覧から削除しますか' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'alpha のディレクトリが見つかりません' })).toBeInTheDocument();
    expect(screen.getByLabelText('新しいパス')).toHaveFocus();
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
    const outside = screen.getByRole('button', { name: 'VS Code で開く' });
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

  it('確認ダイアログを開いている間の ⌘W は、裏のシェルタブを閉じず、窓にも渡さない', async () => {
    const { rt } = await sessionWithShell();
    act(() => rt.emit({ type: 'tab.select', tabId: 't2' }));
    act(() => rt.emit({ type: 'session.kill', runId: 'r1', working: true, shellTabs: 1 }));
    await flush();
    expect(screen.getByRole('dialog', { name: '停止しますか' })).toBeInTheDocument();
    const emit = vi.spyOn(rt, 'emit');
    expect(key({ key: 'w', metaKey: true }, paneHost('t2')).defaultPrevented).toBe(true);
    expect(key({ key: 'w', metaKey: true }).defaultPrevented).toBe(true);
    expect(emit).not.toHaveBeenCalled();
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
    expect(screen.getByRole('dialog', { name: 'キーボードショートカット' })).toBeInTheDocument();
    expect(screen.getByText('コマンドパレット（検索と移動）')).toBeInTheDocument();
    expect(screen.getByText('⌘K / /')).toBeInTheDocument();
    key({ key: 'Escape' });
    await flush();
    expect(screen.queryByRole('dialog', { name: 'キーボードショートカット' })).toBeNull();
  });

  it('入力中の ? は文字なので、一覧を開かない', async () => {
    await mounted();
    fireEvent.keyDown(textField(), { key: '?', shiftKey: true });
    await flush();
    expect(screen.queryByRole('dialog', { name: 'キーボードショートカット' })).toBeNull();
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
    expect(key({ key: 'Backspace' }, textField()).defaultPrevented).toBe(false);
    const host = document.createElement('div');
    host.className = 'term-host';
    const ta = document.createElement('textarea');
    host.appendChild(ta);
    document.body.appendChild(host);
    expect(key({ key: 'Backspace' }, ta).defaultPrevented).toBe(false);
    host.remove();
  });

  // 確認や入力のあるダイアログを開いたまま、裏の画面だけを移さない（入力待ちのカードと同じ規則）。
  it('確認や入力のあるダイアログの裏では、⌘, も ⌘[ ⌘] も画面を移さない', async () => {
    const { rt, go, setHash, deps } = await mounted();
    act(() => setHash('#/projects'));
    act(() => rt.emit({ type: 'session.new.open', scratch: true }));
    await flush();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    key({ key: ',', metaKey: true });
    key({ key: '[', metaKey: true });
    key({ key: ']', metaKey: true });
    await flush();
    expect(deps.location.getHash()).toBe('#/projects');
    expect(go).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('確認や入力のあるダイアログの裏では、スワイプの矢印も出さず画面も移さない', async () => {
    const { rt, go, setHash } = await mounted();
    act(() => setHash('#/projects'));
    act(() => rt.emit({ type: 'session.new.open', scratch: true }));
    await flush();
    phaseOn();
    const hint = screen.getByTestId('swipe-hint');
    beginGesture();
    for (let i = 0; i < 6; i++) wheel(-20);
    expect(hint.dataset.dir).toBeUndefined();
    endGesture();
    expect(go).not.toHaveBeenCalled();
    expect(hint.dataset.dir).toBeUndefined();
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
    // 本物の時計で 80ms ずつ待つと、負荷で待ちが延びたときに、片付いた後を見てしまう。
    // 片付けのタイマーは離した瞬間に張られるので、そこから偽の時計に替えて、進める時間を自分で決める。
    const restore = fakeMotionTokens({ '--dur-exit': '120ms' });
    try {
      const { setHash } = await mounted();
      act(() => setHash('#/projects'));
      phaseOn();
      const hint = screen.getByTestId('swipe-hint');
      beginGesture();
      for (let i = 0; i < 6; i++) wheel(-20);
      vi.useFakeTimers();
      endGesture();
      expect(hint.dataset.done).toBe('true');
      // 消える動きの長さ（120ms）が終わっても、まだ片付けない。
      act(() => { vi.advanceTimersByTime(120); });
      expect(hint.dataset.dir).toBe('back');
      // 余りの 10ms が過ぎたら片付ける。
      act(() => { vi.advanceTimersByTime(10); });
      expect(hint.dataset.dir).toBeUndefined();
    } finally { vi.useRealTimers(); restore(); }
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
    expect(screen.getByRole('dialog', { name: 'キーボードショートカット' })).toBeInTheDocument();
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

  it('ダイアログを開いている間の ⌘I は、裏で画面を移さない', async () => {
    const m = make({ boot: withWaiting() });
    m.rt.start();
    render(<Root runtime={m.rt} api={m.deps.api} terminals={terminals} />);
    act(() => m.handlers[0]!.onOpen());
    await flush();
    act(() => m.rt.emit({ type: 'shortcuts.open' }));
    await flush();
    const before = m.deps.location.getHash();
    expect(key({ key: 'i', metaKey: true }).defaultPrevented).toBe(false);
    await flush();
    expect(m.deps.location.getHash()).toBe(before);
    expect(screen.getByRole('dialog', { name: 'キーボードショートカット' })).toBeInTheDocument();
  });

  it('パレットを開いているときの ⌘I は、パレットを閉じて移る', async () => {
    const m = make({ boot: withWaiting() });
    m.rt.start();
    render(<Root runtime={m.rt} api={m.deps.api} terminals={terminals} />);
    act(() => m.handlers[0]!.onOpen());
    await flush();
    act(() => m.rt.emit({ type: 'palette.open' }));
    await flush();
    expect(key({ key: 'i', metaKey: true }).defaultPrevented).toBe(true);
    await flush();
    expect(m.deps.location.getHash()).toBe('#/session/s3');
    expect(screen.queryByLabelText('コマンドパレット')).toBeNull();
  });

  it('入力待ちが無ければ、短いトーストで知らせる', async () => {
    await mounted();
    key({ key: 'i', metaKey: true });
    await flush();
    expect(screen.getByText('入力待ちのセッションはありません')).toBeInTheDocument();
  });

  it('キーの一覧に載る', async () => {
    await mounted();
    key({ key: '?', shiftKey: true });
    await flush();
    const dialog = screen.getByRole('dialog', { name: 'キーボードショートカット' });
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
    const box = textField();
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
    fireEvent.keyDown(screen.getByLabelText('移動・操作'), { key: 'Escape' });
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
    const box = textField();
    act(() => box.focus());
    expect(key({ key: 'Escape', isComposing: true }, box).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(box);
    expect(key({ key: 'Escape', keyCode: 229 } as KeyboardEventInit, box).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(box);
  });

  it('部品が自分で Esc を処理したときは、重ねてフォーカスを外さない', async () => {
    await mounted();
    const box = textField();
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

  it('別の画面から Home に戻っても一覧にフォーカスする', async () => {
    const { setHash } = await mounted();
    act(() => setHash('#/projects'));
    await flush();
    act(() => (document.activeElement as HTMLElement).blur());
    act(() => setHash('#/'));
    await flush();
    expect(document.activeElement).toBe(rows());
  });

  it('#/sessions?q= のリンクは、ホームの検索として開く（セッションの一覧の画面は無くなった）', async () => {
    const search = vi.fn(async () => ({ hits: [], total: 0 }));
    const { setHash } = await mounted({ api: { search } });
    act(() => setHash('#/projects'));
    await flush();
    act(() => setHash('#/sessions?q=%E5%8B%95%E7%94%BB'));
    await flush();
    expect(screen.getByRole('heading', { level: 1, name: 'ホーム' })).toBeInTheDocument();
    expect(screen.getByLabelText('キーワード')).toHaveValue('動画');
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ q: '動画' }));
  });

  it('入力欄で打っている最中は、画面が変わってもフォーカスを奪わない', async () => {
    const { setHash } = await mounted();
    const box = textField();
    act(() => box.focus());
    act(() => setHash('#/projects'));
    await flush();
    expect(document.activeElement).toBe(box);
  });

  it('パレットの全文検索の行を選ぶと、ホームの検索へ移って結果の一覧へフォーカスする', async () => {
    const hit = { sessionId: 's1', matchCount: 1, snippets: [{ seq: 1, role: 'user', text: 'せっしょん', agentId: null }] };
    const search = vi.fn(async () => ({ hits: [hit], total: 1 }));
    const { deps } = await mounted({ api: { search } });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.change(screen.getByLabelText('移動・操作'), { target: { value: 'せっ' } });
    fireEvent.click(screen.getByRole('option', { name: /ホームで『せっ』をトランスクリプトから検索/ }));
    await flush();
    await flush();
    expect(deps.location.getHash()).toBe(`#/?q=${encodeURIComponent('せっ')}`);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ q: 'せっ' }));
    expect(document.activeElement).toBe(rows());
  });

  // 最後の行の件数は、ホームの欄に同じ語を打ったときの件数である。打つたびには引かず、少し待ってから 1 回だけ引く。
  it('パレットに語を打つと、少し待ってから、ホームの欄に出る件数を最後の行に添える', async () => {
    const search = vi.fn(async (p: { q: string }) => ({ hits: [], total: p.q === 'せっ' ? 12 : 3 }));
    await mounted({ api: { search } });
    const countCalls = () => search.mock.calls.filter(([p]) => (p as { limit?: number }).limit === 1);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = screen.getByLabelText('移動・操作');
    const settle = () => act(() => new Promise((r) => setTimeout(r, 400)));
    // 何も打っていないあいだは引かない。
    await settle();
    expect(countCalls()).toHaveLength(0);
    fireEvent.change(input, { target: { value: 'せ' } });
    fireEvent.change(input, { target: { value: 'せっ' } });
    const last = () => screen.getByRole('option', { name: /トランスクリプトから検索/ });
    expect(last()).not.toHaveTextContent('件');
    await settle();
    // 続けて打った分は 1 回にまとめ、その語で、名前と要約とトランスクリプトを数える（欄の検索と同じ条件）。
    expect(countCalls()).toEqual([[{ q: 'せっ', limit: 1, hideArchived: true }]]);
    expect(last()).toHaveTextContent('12 件');
    // 語が変われば、古い件数は出さない。
    fireEvent.change(input, { target: { value: 'せっし' } });
    expect(last()).not.toHaveTextContent('12 件');
    await settle();
    expect(last()).toHaveTextContent('3 件');
  });

  it('件数を引けなくても、パレットはそのまま使える', async () => {
    const search = vi.fn(async () => { throw new Error('down'); });
    await mounted({ api: { search } });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.change(screen.getByLabelText('移動・操作'), { target: { value: 'せっ' } });
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(screen.getByRole('option', { name: /トランスクリプトから検索/ })).not.toHaveTextContent('件');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('パレットから同じ語で検索し直しても、結果の一覧へ移る（⌘↵）', async () => {
    const hit = { sessionId: 's1', matchCount: 1, snippets: [{ seq: 1, role: 'user', text: 'せっしょん', agentId: null }] };
    await mounted({ api: { search: async () => ({ hits: [hit], total: 1 }) } });
    const settle = () => act(() => new Promise((r) => setTimeout(r, 100)));
    for (let n = 0; n < 2; n++) {
      fireEvent.keyDown(window, { key: 'k', metaKey: true });
      const input = screen.getByLabelText('移動・操作');
      fireEvent.change(input, { target: { value: 'せっ' } });
      fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
      await settle();
      expect(document.activeElement).toBe(rows());
    }
  });
  // Paused の入力（B1）。Dialog の殻が持つ Esc と、開いた元へのフォーカスの戻りを Root ごしに確かめる。
  it('「⋯」から Paused の入力を開き、Esc で閉じると「⋯」へフォーカスが戻る', async () => {
    await mounted();
    const more = screen.getByRole('button', { name: 'せっしょん のステータス' });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: /Paused にする/ }));
    const dialog = screen.getByRole('dialog', { name: 'Paused にする' });
    expect(dialog).toBeInTheDocument();
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('Paused の入力で送ると、API の結果を待たずに閉じて、PUT に戻る日と理由が載る', async () => {
    const setSessionState = vi.fn(() => new Promise<never>(() => {}));
    await mounted({ api: { setSessionState } });
    fireEvent.click(screen.getByRole('button', { name: 'せっしょん のステータス' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Paused にする/ }));
    fireEvent.change(screen.getByLabelText('理由'), { target: { value: '数字を見る' } });
    fireEvent.click(screen.getByRole('button', { name: 'Paused にする' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(setSessionState).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'paused', note: '数字を見る', returnOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }));
  });
});

describe('アカウントの切り替え（セッション画面）', () => {
  /** s1 が動いている 2 アカウントの画面。s1 は対応に無いので会社（最初のアカウント）で動いている。 */
  const open = async (api: Partial<ApiClient>) => {
    const m = await mounted({ boot: { ...boot, sessions: [{ ...session, live: 'busy' }], accounts: accountsFixture }, api });
    act(() => m.setHash('#/session/s1'));
    await flush();
    return m;
  };
  /** ヘッダから大学を選ぶ。 */
  const chooseUniv = async () => {
    fireEvent.click(screen.getByRole('button', { name: /^アカウントを切り替え（現在は 会社/ }));
    await flush();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /大学/ }));
    await flush();
  };

  it('ヘッダで別のアカウントを選ぶと確認が出て、承諾すると switchAccount を呼び、確認が閉じる', async () => {
    const switchAccount = vi.fn(fakeApiExtras().switchAccount);
    await open({ switchAccount });
    await chooseUniv();
    const dialog = screen.getByRole('dialog', { name: '大学 に切り替えますか？' });
    // 動いている作業中のセッションなので、中断の注意も出る。
    expect(dialog).toHaveTextContent('途中の作業が中断されます。');
    expect(switchAccount).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '切り替える' }));
    await flush();
    expect(switchAccount).toHaveBeenCalledWith('s1', 'a1');
    expect(screen.queryByRole('dialog', { name: '大学 に切り替えますか？' })).toBeNull();
  });

  it('確認でキャンセルすると何も呼ばず、確認が閉じる', async () => {
    const switchAccount = vi.fn(fakeApiExtras().switchAccount);
    await open({ switchAccount });
    await chooseUniv();
    fireEvent.click(within(screen.getByRole('dialog', { name: '大学 に切り替えますか？' })).getByRole('button', { name: 'キャンセル' }));
    await flush();
    expect(switchAccount).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '大学 に切り替えますか？' })).toBeNull();
  });

  it('サーバが断ったら、その文がトーストに出て、確認は閉じたまま、画面は元のセッションである', async () => {
    const refusal = 'このセッションにはまだ本文がありません。先に会話を始めてから切り替えてください。';
    const switchAccount = vi.fn(async () => { throw new Error(refusal); });
    const { go } = await open({ switchAccount });
    await chooseUniv();
    fireEvent.click(within(screen.getByRole('dialog', { name: '大学 に切り替えますか？' })).getByRole('button', { name: '切り替える' }));
    await flush();
    expect(switchAccount).toHaveBeenCalledWith('s1', 'a1');
    expect(screen.getByText(refusal)).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '大学 に切り替えますか？' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('せっしょん');
    expect(go).not.toHaveBeenCalled();
  });
});
