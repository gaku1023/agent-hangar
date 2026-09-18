import { describe, expect, it } from 'vitest';
import type { BootstrapDto, RunDto, SessionDto, TabDto } from '@agent-hangar/shared';
import { aliveRunOf, applyBootstrap, applyEventsPage, applyLaunch, applyServerEvent, currentRunOf, eventsKey, initialStore, pruneRuns, tabsOf } from './store.ts';

const session = (id: string, psid: string): SessionDto => ({ id, provider: 'claude-code', providerSessionId: psid, projectId: null, name: id, cwd: '/x', firstPrompt: null, aiTitle: null, startedAt: 1, lastActivityAt: 1, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0 } });
const boot: BootstrapDto = { device: { id: 'd', name: 'mac' }, settings: { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', codePath: null }, projects: [], sessions: [session('s1', 'u1')], live: [], runs: [], tabs: [], index: { phase: 'idle', done: 0, total: 0 }, version: '0' };

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
  it('掃除は、終わっていて開いたタブも参照も無い run だけを落とす', () => {
    // bootstrap で混ぜた分が溜まり続けないように、画面が参照しうるものだけを残す。
    const s = applyBootstrap(initialStore(), {
      ...boot,
      runs: [run('r1', 's1', 9), run('r2', 's2'), run('r3', 's3', 9), run('r4', 's4', 9)],
      tabs: [tab('r1', 'r1', 'agent', 8), tab('t1', 'r1', 'shell', 8), tab('r3', 'r3', 'agent', 8), tab('t3', 'r3', 'shell'), tab('r4', 'r4', 'agent', 8)],
    });
    const pruned = pruneRuns(s, ['s4']);
    // r2 は実行中、r3 は開いたシェルタブが残る、r4 は画面が見ているセッションのもの。
    expect(Object.keys(pruned.runs).sort()).toEqual(['r2', 'r3', 'r4']);
    // 落とした run のタブも一緒に消える。
    expect(Object.keys(pruned.tabs).sort()).toEqual(['r3', 'r4', 't3']);
    expect(currentRunOf(pruned, 's3')?.id).toBe('r3');
    // 落とすものが無ければ同じ参照を返す。
    expect(pruneRuns(pruned, ['s4'])).toBe(pruned);
  });
});
