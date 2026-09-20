import { describe, expect, it } from 'vitest';
import type { ArtifactDto, BootstrapDto, MemoDto, RunDto, SessionDto, SyncStatusBody, TabDto, TodoDto } from '@agent-hangar/shared';
import { aliveRunOf, applyBootstrap, applyConfigPreview, applyEventsPage, applyJoinToken, applyLaunch, applyServerEvent, artifactsOf, currentRunOf, emptyUsage, eventsKey, initialStore, pruneEvents, pruneRuns, tabsOf, todosOf } from './store.ts';

const session = (id: string, psid: string): SessionDto => ({ id, provider: 'claude-code', providerSessionId: psid, projectId: null, name: id, cwd: '/x', firstPrompt: null, aiTitle: null, startedAt: 1, lastActivityAt: 1, memo: null, hasTranscript: true, live: null, summary: null, fromScratch: false, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, lock: null, remoteOnly: false });
const boot: BootstrapDto = { device: { id: 'd', name: 'mac' }, settings: { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, syncClaudeConfig: false, nodePath: null }, projects: [], sessions: [session('s1', 'u1')], live: [], runs: [], tabs: [], usage: { fiveHour: null, sevenDay: null, updatedAt: null }, todos: [], artifacts: [], summaryPending: [], index: { phase: 'idle', done: 0, total: 0 }, version: '0', sync: { state: 'off', url: null, lastPushAt: null, lastPullAt: null, pending: 0, error: null, deviceCount: 0, claudeConfig: { enabled: false, confirmed: false }, skipped: [], sweepPending: null }, devices: [] };

describe('store', () => {
  it('bootstrap を正規化して入れる', () => {
    const s = applyBootstrap(initialStore(), boot);
    expect(s.bootstrapped).toBe(true);
    expect(s.sessions.s1?.name).toBe('s1');
    expect(s.device).toEqual({ id: 'd', name: 'mac' });
  });
  it('session.upsert は差し替え、live.update は各セッションの live を引き直す', () => {
    let s = applyBootstrap(initialStore(), boot);
    s = applyServerEvent(s, { type: 'session.upsert', session: { ...session('s1', 'u1'), name: 'renamed' } });
    expect(s.sessions.s1?.name).toBe('renamed');
    s = applyServerEvent(s, { type: 'live.update', live: [{ sessionId: 'u1', status: 'busy', name: null, nameSource: null, cwd: '/x', pid: 1 }] });
    expect(s.sessions.s1?.live).toBe('busy');
    s = applyServerEvent(s, { type: 'live.update', live: [] });
    expect(s.sessions.s1?.live).toBeNull();
  });
  it('関係ないイベントは同じ参照を返す', () => {
    const s = applyBootstrap(initialStore(), boot);
    expect(applyServerEvent(s, { type: 'toast', level: 'info', message: 'x' })).toBe(s);
  });
  it('events のページを追記できる', () => {
    let s = initialStore();
    const k = eventsKey('s1', null);
    s = applyEventsPage(s, k, { sessionId: 's1', events: [{ kind: 'user', seq: 0, text: 'a' }], total: 2, nextSeq: 1 }, false);
    s = applyEventsPage(s, k, { sessionId: 's1', events: [{ kind: 'assistant', seq: 1, text: 'b' }], total: 2, nextSeq: null }, true);
    expect(s.events[k]?.items.map((e) => e.seq)).toEqual([0, 1]);
    expect(s.events[k]?.nextSeq).toBeNull();
    // 同じ seq が重なって届いても増えない
    s = applyEventsPage(s, k, { sessionId: 's1', events: [{ kind: 'assistant', seq: 1, text: 'b' }], total: 2, nextSeq: null }, true);
    expect(s.events[k]?.items).toHaveLength(2);
  });
  it('transcript.appended は該当セッションの events を再読込対象にする', () => {
    let s = applyEventsPage(initialStore(), eventsKey('s1', null), { sessionId: 's1', events: [], total: 0, nextSeq: null }, false);
    s = applyServerEvent(s, { type: 'transcript.appended', sessionId: 's1', count: 1 });
    expect(s.events[eventsKey('s1', null)]?.total).toBe(1);
  });
});

const run = (id: string, sessionId: string, endedAt: number | null = null): RunDto => ({ id, sessionId, deviceId: 'd', kind: 'start', tmuxName: `hangar-${id}`, pid: null, startedAt: Number(id.slice(1)), endedAt, endReason: endedAt ? 'exited' : null, heartbeatAt: 1 });
const tab = (id: string, runId: string, kind: 'agent' | 'shell', closedAt: number | null = null): TabDto => ({ id, runId, sessionId: 's1', kind, title: kind === 'agent' ? 'Claude' : id, tmuxName: `hangar-${runId}-${id}`, createdAt: Number(id.replace(/\D/g, '') || 0), closedAt });

describe('runs と tabs', () => {
  it('run.started は run と tabs を入れ、tab.upsert と run.ended は差し替える', () => {
    let s = initialStore();
    s = applyServerEvent(s, { type: 'run.started', run: run('r1', 's1'), tabs: [tab('r1', 'r1', 'agent')] });
    expect(aliveRunOf(s, 's1')?.id).toBe('r1');
    s = applyServerEvent(s, { type: 'tab.upsert', tab: tab('t2', 'r1', 'shell') });
    s = applyServerEvent(s, { type: 'tab.upsert', tab: tab('t1', 'r1', 'shell') });
    expect(tabsOf(s, 'r1').map((t) => t.id)).toEqual(['r1', 't1', 't2']);
    s = applyServerEvent(s, { type: 'tab.upsert', tab: tab('t1', 'r1', 'shell', 5) });
    expect(tabsOf(s, 'r1').map((t) => t.id)).toEqual(['r1', 't2']);
    s = applyServerEvent(s, { type: 'run.ended', run: run('r1', 's1', 9) });
    expect(aliveRunOf(s, 's1')).toBeNull();
    expect(currentRunOf(s, 's1')?.id).toBe('r1');
    s = applyServerEvent(s, { type: 'tab.upsert', tab: tab('t2', 'r1', 'shell', 6) });
    expect(currentRunOf(s, 's1')).toBeNull();
  });
  it('applyLaunch と最新の run', () => {
    let s = applyLaunch(initialStore(), { run: run('r1', 's1', 3), sessionId: 's1', tabs: [] });
    s = applyLaunch(s, { run: run('r2', 's1'), sessionId: 's1', tabs: [tab('r2', 'r2', 'agent')] });
    expect(aliveRunOf(s, 's1')?.id).toBe('r2');
    expect(applyServerEvent(s, { type: 'run.upsert', run: { ...run('r2', 's1'), pid: 7 } }).runs.r2?.pid).toBe(7);
  });
  it('bootstrap の runs と tabs を入れる', () => {
    const s = applyBootstrap(initialStore(), { ...boot, runs: [run('r1', 's1')], tabs: [tab('r1', 'r1', 'agent')] });
    expect(aliveRunOf(s, 's1')?.id).toBe('r1');
    expect(tabsOf(s, 'r1')).toHaveLength(1);
  });
  it('bootstrap を取り直しても、すでに知っている run と tab は消えない', () => {
    // 終了した run のスクロールバックを見ている最中に取り直しても、画面が変わらないようにする。
    let s = applyBootstrap(initialStore(), { ...boot, runs: [run('r1', 's1', 9)], tabs: [tab('r1', 'r1', 'agent'), tab('t1', 'r1', 'shell')] });
    s = applyBootstrap(s, { ...boot, runs: [run('r2', 's2')], tabs: [tab('r2', 'r2', 'agent')] });
    expect(Object.keys(s.runs).sort()).toEqual(['r1', 'r2']);
    expect(tabsOf(s, 'r1').map((t) => t.id)).toEqual(['r1', 't1']);
    expect(aliveRunOf(s, 's2')?.id).toBe('r2');
  });
  it('掃除は、終わっていてシェルタブも参照も無い run だけを落とす', () => {
    // bootstrap で混ぜた分が溜まり続けないように、画面が参照しうるものだけを残す。
    // agent タブはサーバが run から合成するので closedAt は常に null である。
    const s = applyBootstrap(initialStore(), {
      ...boot,
      runs: [run('r1', 's1', 9), run('r2', 's2'), run('r3', 's3', 9), run('r4', 's4', 9)],
      tabs: [tab('r1', 'r1', 'agent'), tab('t1', 'r1', 'shell', 8), tab('r2', 'r2', 'agent'), tab('r3', 'r3', 'agent'), tab('t3', 'r3', 'shell'), tab('r4', 'r4', 'agent')],
    });
    const pruned = pruneRuns(s, ['s4']);
    // r2 は実行中、r3 は開いたシェルタブが残る、r4 は画面が見ているセッションのもの。
    expect(Object.keys(pruned.runs).sort()).toEqual(['r2', 'r3', 'r4']);
    // 落とした run のタブは、閉じたシェルタブも agent タブも一緒に消える。
    expect(Object.keys(pruned.tabs).sort()).toEqual(['r2', 'r3', 'r4', 't3']);
    expect(currentRunOf(pruned, 's3')?.id).toBe('r3');
    // 落とすものが無ければ同じ参照を返す。
    expect(pruneRuns(pruned, ['s4'])).toBe(pruned);
  });
  it('起動と終了を繰り返しても、掃除を挟めば溜まらない', () => {
    // サーバは生きた run と開いたシェルタブが残る run しか返さないので、終わった run は bootstrap から消える。
    let s = initialStore();
    for (let i = 0; i < 20; i++) {
      const r = run(`r${i}`, `s${i}`);
      s = applyServerEvent(s, { type: 'run.started', run: r, tabs: [tab(`r${i}`, `r${i}`, 'agent')] });
      s = applyServerEvent(s, { type: 'run.ended', run: { ...r, endedAt: 9 } });
      s = pruneRuns(applyBootstrap(s, boot), []);
    }
    expect(Object.keys(s.runs)).toEqual([]);
    expect(Object.keys(s.tabs)).toEqual([]);
  });
});

const todo = (id: string, projectId: string, position: number, done = false): TodoDto => ({ id, projectId, text: id, done, position, sessionId: null, updatedAt: 1 });
const art = (id: string, projectId: string | null, last: number, sessionIds: string[] = ['s1']): ArtifactDto => ({ id, projectId, url: `https://claude.ai/code/artifact/${id}`, title: id, description: null, favicon: '📊', filePath: null, fileExists: false, firstPublishedAt: 1, lastPublishedAt: last, versionCount: 1, sessionIds });

describe('フェーズ 3 のストア', () => {
  it('bootstrap は使用量と TODO とアーティファクトと要約の待ちを入れる', () => {
    const s = applyBootstrap(initialStore(), { ...boot, usage: { fiveHour: { usedPercent: 47, resetsAt: null }, sevenDay: null, updatedAt: 9 }, todos: [todo('t2', 'p1', 2), todo('t1', 'p1', 1)], artifacts: [art('a1', 'p1', 5)], summaryPending: ['s1'] });
    expect(s.usage.fiveHour?.usedPercent).toBe(47);
    expect(todosOf(s, 'p1').map((t) => t.id)).toEqual(['t1', 't2']);
    expect(artifactsOf(s, { projectId: 'p1' }).map((a) => a.id)).toEqual(['a1']);
    expect(s.summaryPending).toEqual({ s1: true });
  });
  it('todos.update はそのプロジェクトだけを置き換える', () => {
    let s = applyBootstrap(initialStore(), { ...boot, todos: [todo('t1', 'p1', 1), todo('t2', 'p1', 2), todo('t9', 'p2', 1)] });
    s = applyServerEvent(s, { type: 'todos.update', projectId: 'p1', todos: [todo('t2', 'p1', 2, true)] });
    expect(todosOf(s, 'p1').map((t) => [t.id, t.done])).toEqual([['t2', true]]);
    expect(todosOf(s, 'p2').map((t) => t.id)).toEqual(['t9']);
  });
  it('usage、memo、artifact、要約の待ちのイベントを取り込む', () => {
    let s = applyBootstrap(initialStore(), boot);
    s = applyServerEvent(s, { type: 'usage.update', usage: { fiveHour: null, sevenDay: { usedPercent: 7, resetsAt: 2 }, updatedAt: 3 } });
    expect(s.usage.sevenDay?.usedPercent).toBe(7);
    const memo: MemoDto = { projectId: 'p1', markdown: '# m', updatedAt: 4 };
    s = applyServerEvent(s, { type: 'memo.update', memo });
    expect(s.memos.p1).toEqual(memo);
    s = applyServerEvent(s, { type: 'artifact.upsert', artifact: art('a1', 'p1', 5) });
    s = applyServerEvent(s, { type: 'artifact.upsert', artifact: art('a2', 'p1', 9) });
    s = applyServerEvent(s, { type: 'artifact.upsert', artifact: art('a3', 'p2', 7, ['s2']) });
    expect(artifactsOf(s, { projectId: 'p1' }).map((a) => a.id)).toEqual(['a2', 'a1']);
    expect(artifactsOf(s, { sessionId: 's2' }).map((a) => a.id)).toEqual(['a3']);
    expect(artifactsOf(s, {}).map((a) => a.id)).toEqual(['a2', 'a3', 'a1']);
    s = applyServerEvent(s, { type: 'summary.pending', sessionId: 's1' });
    expect(s.summaryPending.s1).toBe(true);
    s = applyServerEvent(s, { type: 'summary.updated', sessionId: 's1' });
    expect(s.summaryPending.s1).toBeUndefined();
    s = applyServerEvent(s, { type: 'summary.pending', sessionId: 's1' });
    s = applyServerEvent(s, { type: 'summary.failed', sessionId: 's1', message: 'x' });
    expect(s.summaryPending.s1).toBeUndefined();
  });
});

describe('フェーズ 3 の繰り越し', () => {
  it('フェーズ 3 の項目を返さないサーバでも、既定値で埋めて画面を立てる', () => {
    // 古いサーバは usage、todos、artifacts、summaryPending を返さない。
    const old = { ...boot } as Partial<BootstrapDto>;
    delete old.usage; delete old.todos; delete old.artifacts; delete old.summaryPending;
    const s = applyBootstrap(initialStore(), old as BootstrapDto);
    expect(s.bootstrapped).toBe(true);
    expect(s.usage).toEqual(emptyUsage());
    expect(s.todos).toEqual({});
    expect(s.artifacts).toEqual({});
    expect(s.summaryPending).toEqual({});
  });
  it('最終公開が同じアーティファクトは id の昇順で、届いた順に依らない', () => {
    const ids = ['ab', 'aa', 'ac'];
    const fill = (order: string[]) => order.reduce((s, id) => applyServerEvent(s, { type: 'artifact.upsert', artifact: art(id, 'p1', 5) }), initialStore());
    expect(artifactsOf(fill(ids), {}).map((a) => a.id)).toEqual(['aa', 'ab', 'ac']);
    expect(artifactsOf(fill([...ids].reverse()), {}).map((a) => a.id)).toEqual(['aa', 'ab', 'ac']);
    // 新しいものが先という並びは変わらない。
    let s = fill(ids);
    s = applyServerEvent(s, { type: 'artifact.upsert', artifact: art('zz', 'p1', 9) });
    expect(artifactsOf(s, {}).map((a) => a.id)).toEqual(['zz', 'aa', 'ab', 'ac']);
  });
  it('本文の掃除は、開いていないセッションのぶんだけ落とす', () => {
    // 「もっと読む」で積んだページは、開いている限り残す。
    const first = { sessionId: 's1', events: [{ kind: 'user' as const, seq: 0, text: 'a' }], total: 2, nextSeq: 1 };
    const more = { sessionId: 's1', events: [{ kind: 'assistant' as const, seq: 1, text: 'b' }], total: 2, nextSeq: null };
    let s = applyEventsPage(initialStore(), eventsKey('s1', null), first, false);
    s = applyEventsPage(s, eventsKey('s1', null), more, true);
    s = applyEventsPage(s, eventsKey('s1', 'agent-1'), first, false);
    s = applyEventsPage(s, eventsKey('s2', null), first, false);
    s = applyEventsPage(s, eventsKey('s3', null), first, false);
    const pruned = pruneEvents(s, ['s1']);
    expect(Object.keys(pruned.events).sort()).toEqual(['s1:', 's1:agent-1']);
    expect(pruned.events[eventsKey('s1', null)]?.items.map((e) => e.seq)).toEqual([0, 1]);
    // 落とすものが無ければ同じ参照を返す。
    expect(pruneEvents(pruned, ['s1'])).toBe(pruned);
  });
  it('セッションを渡り歩いても、掃除を挟めば本文は溜まらない', () => {
    let s = initialStore();
    for (let i = 0; i < 20; i++) {
      const id = `s${i}`;
      s = applyEventsPage(s, eventsKey(id, null), { sessionId: id, events: [{ kind: 'user', seq: 0, text: 'a' }], total: 1, nextSeq: null }, false);
      s = pruneEvents(s, [id]);
    }
    expect(Object.keys(s.events)).toEqual(['s19:']);
  });
});

describe('store の同期', () => {
  it('bootstrap の sync と devices を入れ、イベントで差し替える', () => {
    let s = applyBootstrap(initialStore(), boot);
    expect(s.sync?.state).toBe('off');
    expect(s.devices).toEqual([]);
    s = applyServerEvent(s, { type: 'sync.status', status: { state: 'pushing', url: 'https://h', lastPushAt: 1, lastPullAt: 2, pending: 4, error: null, deviceCount: 2, claudeConfig: { enabled: true, confirmed: true }, skipped: [], sweepPending: null } });
    expect(s.sync).toMatchObject({ state: 'pushing', pending: 4 });
    s = applyServerEvent(s, { type: 'devices.update', devices: [{ id: 'd', name: 'mac', platform: 'darwin', lastSeenAt: 1, self: true }] });
    expect(s.devices).toHaveLength(1);
    expect(applyServerEvent(s, { type: 'sync.applied', table: 'projects', rowId: 'p1' })).toBe(s);
  });
  it('bootstrap が運ぶ sync と devices をそのまま入れる', () => {
    const sync = { state: 'idle' as const, url: 'https://h', lastPushAt: 1000, lastPullAt: 2000, pending: 5, error: null, deviceCount: 2, claudeConfig: { enabled: false, confirmed: false }, skipped: [], sweepPending: 7 };
    const s = applyBootstrap(initialStore(), { ...boot, sync, devices: [{ id: 'd2', name: 'mini', platform: 'darwin', lastSeenAt: 3, self: false }] });
    expect(s.sync).toEqual(sync);
    expect(s.devices).toHaveLength(1);
  });
  it('sync.status で、片付いた取り残しと回復した失敗が消える', () => {
    // レビュアの再現筋である。サーバが 0 件になっても画面が 3 件のまま固まっていた。
    // 片付いたことが画面に届かないと、件数を出す意味そのものが無くなる。
    const sync: SyncStatusBody = { state: 'idle', url: 'https://h', lastPushAt: 1, lastPullAt: 2, pending: 0, error: null, deviceCount: 2, claudeConfig: { enabled: false, confirmed: false }, skipped: [{ key: 'transcripts/mini/u1.jsonl.gz', attempts: 3, message: '復号できません' }], sweepPending: 3 };
    let s = applyBootstrap(initialStore(), { ...boot, sync });
    expect(s.sync).toMatchObject({ sweepPending: 3 });
    expect(s.sync?.skipped).toHaveLength(1);
    s = applyServerEvent(s, { type: 'sync.status', status: { ...sync, skipped: [], sweepPending: 0 } });
    expect(s.sync).toMatchObject({ sweepPending: 0, skipped: [] });
  });
  it('付録を持たない古いサーバの sync.status では、件数を引き継がずに落とす', () => {
    // 古い数字を残すのは、何も出さないより悪い。分からないときは分からないと出す。
    const sync: SyncStatusBody = { state: 'idle', url: 'https://h', lastPushAt: 1, lastPullAt: 2, pending: 0, error: null, deviceCount: 2, claudeConfig: { enabled: false, confirmed: false }, skipped: [{ key: 'k1', attempts: 3, message: 'x' }], sweepPending: 1500 };
    let s = applyBootstrap(initialStore(), { ...boot, sync });
    const { skipped: _s, sweepPending: _p, ...older } = sync;
    s = applyServerEvent(s, { type: 'sync.status', status: older as SyncStatusBody });
    expect(s.sync).toMatchObject({ sweepPending: null, skipped: [] });
  });
  it('sync と devices を持たない古いサーバでも壊れない', () => {
    const { sync: _sync, devices: _devices, ...older } = boot;
    const s = applyBootstrap(initialStore(), older as BootstrapDto);
    expect(s.sync).toBeNull();
    expect(s.devices).toEqual([]);
  });
  it('参加トークンと設定の下見を持つ', () => {
    let s = initialStore();
    expect(s.joinToken).toBeNull();
    expect(s.configPreview).toBeNull();
    expect(s.sync).toBeNull();
    expect(s.devices).toEqual([]);
    s = applyJoinToken(s, 'tok');
    expect(s.joinToken).toBe('tok');
    s = applyConfigPreview(s, { entries: [], confirmed: true });
    expect(s.configPreview).toEqual({ entries: [], confirmed: true });
    expect(applyJoinToken(s, null).joinToken).toBeNull();
    expect(applyConfigPreview(s, null).configPreview).toBeNull();
  });
});
