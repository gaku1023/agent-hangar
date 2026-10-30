import { describe, expect, it } from 'vitest';
import { translator, type LiveSessionDto, type RunDto, type SessionDto, type SettingsDto, type TabDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentHome, presentHomeBand } from './home.ts';
import { presentSessionRow } from './row.ts';
import { presentSession } from './session.ts';
import { presentSessionList } from './sessions.ts';
import { presentShell } from './shell.ts';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const session = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: null, name: 'name-' + id, cwd: '/w', firstPrompt: 'first', aiTitle: null, startedAt: NOW - 7_200_000, lastActivityAt: NOW - 180_000, lastTurnAt: null, hasTranscript: true, live: null, summary: null, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, newerElsewhere: false, takenOver: null, fromPhone: null, unread: null, spawnedBy: null, ...over });
// 写しの sessionId はエージェントの側の ID（providerSessionId、ここでは 'u' + id）。
const liveOf = (id: string, over: Partial<LiveSessionDto> = {}): LiveSessionDto => ({ sessionId: 'u' + id, status: 'busy', name: null, nameSource: null, cwd: '/w', pid: 1, ...over });
const run = (id: string, sessionId: string): RunDto => ({ id, sessionId, deviceId: 'd', kind: 'start', tmuxName: `hangar-${id}`, pid: null, startedAt: NOW - 60_000, endedAt: null, endReason: null, heartbeatAt: 1 });
const tab = (id: string, runId: string, sessionId: string, kind: TabDto['kind']): TabDto => ({ id, runId, sessionId, kind, title: kind === 'agent' ? 'Claude' : `シェル ${id}`, tmuxName: `hangar-${id}`, createdAt: 1, closedAt: null });

function storeWith(sessions: SessionDto[], opts: { enabled?: boolean; live?: LiveSessionDto[] } = {}): Store {
  const s = initialStore();
  s.bootstrapped = true;
  s.settings = { opencodeEnabled: opts.enabled ?? false } as SettingsDto;
  s.sessions = Object.fromEntries(sessions.map((x) => [x.id, x]));
  s.live = opts.live ?? [];
  return s;
}
const listRows = (store: Store) => presentSessionList(initialState(), store, NOW).rows;
const sideRows = (store: Store) => presentShell(initialState(), store, NOW).live.rows;

describe('一覧の行のエージェントのアイコン', () => {
  it('opencode が切で、opencode の会話が 1 つも無いときは出さない（行に agent を付けない）', () => {
    const store = storeWith([session('a'), session('b', { live: 'busy' })]);
    for (const r of listRows(store)) expect(r).not.toHaveProperty('agent');
    expect(presentSessionRow(store.sessions.a!, store, NOW)).not.toHaveProperty('agent');
  });

  it('opencode を有効にしたら、全部の行に出す。Claude の行は Clawd', () => {
    const store = storeWith([session('a'), session('b', { live: 'busy' })], { enabled: true });
    expect(listRows(store).map((r) => r.agent)).toEqual(['claude-code', 'claude-code']);
  });

  it('切でも opencode の会話が 1 つあれば、全部の行に出す', () => {
    const store = storeWith([session('a'), session('o', { provider: 'opencode' })]);
    expect(Object.fromEntries(listRows(store).map((r) => [r.id, r.agent]))).toEqual({ a: 'claude-code', o: 'opencode' });
  });

  it('種類の無い行（古いサーバ）は Clawd、知らない種類は空の枠', () => {
    const old = session('old') as Partial<SessionDto>;
    delete old.provider;
    const store = storeWith([old as SessionDto, session('x', { provider: 'gemini' as SessionDto['provider'] })], { enabled: true });
    expect(Object.fromEntries(listRows(store).map((r) => [r.id, r.agent]))).toEqual({ old: 'claude-code', x: null });
  });

  it('実行中の写しが opencode なら、セッションの provider が届く前でも opencode にする（写しは providerSessionId で突き合わせる）', () => {
    const store = storeWith([session('o', { live: 'busy' }), session('a', { live: 'busy' })], { live: [liveOf('o', { agent: 'opencode' }), { ...liveOf('x', { agent: 'opencode' }), sessionId: 'a' }] });
    expect(Object.fromEntries(listRows(store).map((r) => [r.id, r.agent]))).toEqual({ o: 'opencode', a: 'claude-code' });
  });
});

describe('Codex の会話があるときの絵の出し分け', () => {
  it('Codex の会話が 1 つあれば、全部の行に出す。Codex が切で会話が無ければ出さない', () => {
    const store = storeWith([session('a'), session('c', { provider: 'codex' as SessionDto['provider'] })]);
    expect(Object.fromEntries(listRows(store).map((r) => [r.id, r.agent]))).toEqual({ a: 'claude-code', c: 'codex' });
    for (const r of listRows(storeWith([session('a')]))) expect(r).not.toHaveProperty('agent');
  });
  it('Codex を有効にしたら、会話が無くても全部の行に出す', () => {
    const store = storeWith([session('a')]);
    store.settings = { codexEnabled: true } as SettingsDto;
    expect(listRows(store).map((r) => r.agent)).toEqual(['claude-code']);
  });
  it('実行中の写しが codex なら、会話の行が届く前でも codex にする', () => {
    const store = storeWith([session('c', { live: 'busy' })], { live: [liveOf('c', { agent: 'codex' })] });
    expect(listRows(store).map((r) => r.agent)).toEqual(['codex']);
  });
});

describe('サイドバーの行のエージェントのアイコン', () => {
  it('切で opencode の会話が無いときは出さない', () => {
    const store = storeWith([session('a', { live: 'busy' })], { live: [liveOf('a')] });
    expect(sideRows(store)[0]).not.toHaveProperty('agent');
  });
  it('出すときは、一覧と同じ種類を名前の右端に置く', () => {
    const store = storeWith([session('a', { live: 'busy' }), session('o', { live: 'idle', provider: 'opencode' })], { live: [liveOf('a'), liveOf('o', { status: 'idle', agent: 'opencode' })] });
    expect(Object.fromEntries(sideRows(store).map((r) => [r.id, r.agent]))).toEqual({ a: 'claude-code', o: 'opencode' });
  });
});

describe('ターミナルの上のタブ', () => {
  it('opencode の会話のエージェントのタブは「opencode」と公式ロゴ。シェルのタブは変えない', () => {
    const store = storeWith([session('o', { live: 'busy', provider: 'opencode' })], { enabled: true });
    store.runs = { r1: run('r1', 'o') };
    store.tabs = { r1: tab('r1', 'r1', 'o', 'agent'), t1: tab('t1', 'r1', 'o', 'shell') };
    expect(presentSession(initialState(), store, NOW, 'o').tabs).toEqual([
      { id: 'r1', title: 'opencode', kind: 'agent', agent: 'opencode', selected: true, closable: false },
      { id: 't1', title: 'シェル t1', kind: 'shell', selected: false, closable: true },
    ]);
  });
  it('Codex の会話のエージェントのタブは「Codex」と同じ絵', () => {
    const store = storeWith([session('c', { live: 'busy', provider: 'codex' as SessionDto['provider'] })]);
    store.runs = { r1: run('r1', 'c') };
    store.tabs = { r1: tab('r1', 'r1', 'c', 'agent') };
    expect(presentSession(initialState(), store, NOW, 'c').tabs).toEqual([{ id: 'r1', title: 'Codex', kind: 'agent', agent: 'codex', selected: true, closable: false }]);
  });
  it('Claude の会話のタブはいまのまま（有効にしていても）', () => {
    const store = storeWith([session('a', { live: 'busy' })], { enabled: true });
    store.runs = { r1: run('r1', 'a') };
    store.tabs = { r1: tab('r1', 'r1', 'a', 'agent') };
    expect(presentSession(initialState(), store, NOW, 'a').tabs).toEqual([{ id: 'r1', title: 'Claude', kind: 'agent', selected: true, closable: false }]);
    expect(presentSession(initialState(), store, NOW, 'a').tabs[0]).not.toHaveProperty('agent');
  });
});

describe('ホームの上の帯（実行中と要対応）の行のアイコン', () => {
  const homeRows = (store: Store) => {
    const h = presentHome(initialState(), store, NOW);
    return { running: h.running, attention: h.attention };
  };
  it('opencode が切で、opencode の会話が無ければ出さない（agent を付けない）', () => {
    const { running, attention } = homeRows(storeWith([session('a', { live: 'busy' }), session('b', { live: 'waiting' })]));
    expect(running.map((r) => r.agent)).toEqual([undefined]);
    expect(attention.map((r) => r.agent)).toEqual([undefined]);
  });
  it('opencode の会話があれば、全部の行にエージェントを付ける', () => {
    const { running, attention } = homeRows(storeWith([session('a', { live: 'busy' }), session('o', { provider: 'opencode', live: 'busy' }), session('w', { provider: 'opencode', live: 'waiting' })]));
    expect(Object.fromEntries(running.map((r) => [r.id, r.agent]))).toEqual({ a: 'claude-code', o: 'opencode' });
    expect(attention.map((r) => r.agent)).toEqual(['opencode']);
  });
  it('設定が入なら、Claude の会話だけでも Clawd を出す', () => {
    const { running } = homeRows(storeWith([session('a', { live: 'busy' })], { enabled: true }));
    expect(running.map((r) => r.agent)).toEqual(['claude-code']);
  });
  it('帯の行にもそのまま渡る', () => {
    const h = presentHome(initialState(), storeWith([session('o', { provider: 'opencode', live: 'busy' })]), NOW);
    const band = presentHomeBand(h, translator('ja'));
    expect(band.groups.find((g) => g.id === 'running')!.rows.map((r) => r.agent)).toEqual(['opencode']);
  });
});
