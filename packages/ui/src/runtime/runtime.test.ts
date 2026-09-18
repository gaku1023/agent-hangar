import { describe, expect, it, vi } from 'vitest';
import type { BootstrapDto, EventsPageDto, LaunchResultDto, MemoDto, ProjectDto, RunDto, ServerEvent, SessionDto, TabDto, TodoDto } from '@agent-hangar/shared';
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
    focus: vi.fn(),
  };
  const rt = createRuntime(deps);
  return { rt, api, wsHandlers, timers, store, terminals: deps.terminals as ReturnType<typeof fakeTerminals>, setHash: deps.location.setHash, focus: deps.focus as ReturnType<typeof vi.fn> };
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

const p3Project = (id: string): ProjectDto => ({ id, name: id, status: 'active', isScratch: false, path: '/w/' + id, resolved: true, lastActivityAt: 1, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 });
const p3Session: SessionDto = { id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: 'p9', name: 's1', cwd: '/w/newp', firstPrompt: null, aiTitle: null, startedAt: 1, lastActivityAt: 1, memo: null, hasTranscript: true, live: null, summary: null, fromScratch: false, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null } };
const p3Todo = (id: string, done: boolean): TodoDto => ({ id, projectId: 'p1', text: 'x', done, position: 1, sessionId: null, updatedAt: 1 });
const p3Run = (id: string, sessionId: string): RunDto => ({ id, sessionId, deviceId: 'd', kind: 'start', tmuxName: `hangar-${id}`, pid: 1, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 });
const p3Tab = (id: string, runId: string, kind: 'agent' | 'shell'): TabDto => ({ id, runId, sessionId: 's1', kind, title: id, tmuxName: `hangar-${runId}-${id}`, createdAt: Number(id.replace(/\D/g, '') || 0), closedAt: null });

describe('フェーズ 3 の効果', () => {
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
    expect(rt.getStore().statusline?.installed).toBe(true);
    expect(rt.getStore().usageAggregate?.days).toHaveLength(1);
    expect(rt.getStore().summarizerModels).toEqual([]);
    // LM Studio に繋がらないのは普通の状態なので、トーストにしない。
    expect(rt.getState().toasts).toEqual([]);
  });
  it('要約器を試すと結果がストアに入る', async () => {
    const testSummarizer = vi.fn(async () => ({ ok: true as const, id: 'lmstudio' as const, ms: 12, summary: { title: 'T', oneLiner: 'O', body: 'B', state: 'done' as const, nextSteps: [], source: 'post_hoc' as const, sourceModel: 'gemma', basedOnTurns: 3 } }));
    const { rt, wsHandlers } = harness({ testSummarizer });
    rt.start();
    wsHandlers[0]!.onOpen();
    await flush();
    rt.emit({ type: 'summarizer.test' });
    await flush();
    expect(rt.getStore().summarizerTest).toMatchObject({ ok: true, id: 'lmstudio', ms: 12 });
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
  it('分割は選択中でない最初のタブを右にし、タブが 1 つなら null を返す', async () => {
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
    expect(rt.getState().toasts.at(-1)?.message).toBe('分割にはタブが 2 つ必要です');
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
