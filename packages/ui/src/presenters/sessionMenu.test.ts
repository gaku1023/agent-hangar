import { describe, expect, it } from 'vitest';
import { translator, type ProjectDto, type RunDto, type SessionDto, type TabDto } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { moveTargetIds, presentSessionMenu, sessionMenuEntries, type SessionMenuProps } from './sessionMenu.ts';

const NOW = new Date(2026, 9, 16, 12, 0).getTime();
const ja = translator('ja');
const en = translator('en');
const session = (over: Partial<SessionDto> = {}): SessionDto => ({ id: 's1', provider: 'claude-code', providerSessionId: 'u1', projectId: 'p1', name: 'ログイン画面の直し', cwd: '/Users/me/src/app', firstPrompt: 'first', aiTitle: null, startedAt: NOW - 7_200_000, lastActivityAt: NOW - 60_000, hasTranscript: true, live: null, summary: null, stats: { turns: 12, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, newerElsewhere: false, ...over });
const project = (over: Partial<ProjectDto> = {}): ProjectDto => ({ id: 'p1', name: 'app', status: 'active', isScratch: false, path: '/Users/me/src/app', resolved: true, lastActivityAt: null, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1, unresolved: null, ...over });
const run = (over: Partial<RunDto> = {}): RunDto => ({ id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: NOW - 60_000, endedAt: null, endReason: null, heartbeatAt: NOW, ...over });
const shellTab = (id: string): TabDto => ({ id, runId: 'r1', sessionId: 's1', kind: 'shell', title: 'zsh', tmuxName: `hangar-${id}`, createdAt: NOW, closedAt: null });
const storeWith = (s: SessionDto, extra: Partial<Store> = {}): Store => ({ ...initialStore(), sessions: { [s.id]: s }, projects: { p1: project(), p2: project({ id: 'p2', name: 'paper' }) }, ...extra } as Store);

const keys = (m: SessionMenuProps) => sessionMenuEntries(ja, m).map((e) => e.key);
const entry = (m: SessionMenuProps, key: string) => sessionMenuEntries(ja, m).find((e) => e.key === key)!;

describe('セッションのメニューの中身（presentSessionMenu）', () => {
  it('終わった会話は、状態の 4 つ、プロジェクトを変更、削除を並べ、停止は出さない', () => {
    const s = session({ state: { status: 'done', setBy: 'user', setAt: NOW, note: null, returnOn: null, candidate: null } as SessionDto['state'] });
    const m = presentSessionMenu(storeWith(s), s, ja);
    expect(m).toMatchObject({ id: 's1', name: 'ログイン画面の直し', status: 'done', stop: null, moveBlocked: null, resumeHere: null });
    expect(keys(m)).toEqual(['active', 'paused', 'done', 'archived', 'move', 'copyId', 'delete']);
  });
  it('hangar で動いている会話は停止を押せ、削除は出さない（止めると出る）', () => {
    const s = session({ live: 'busy' });
    const m = presentSessionMenu(storeWith(s, { runs: { r1: run() }, tabs: { t2: shellTab('t2') } }), s, ja);
    expect(m.stop).toEqual({ runId: 'r1', working: true, aside: false, shellTabs: 1 });
    expect(keys(m)).toEqual(['active', 'paused', 'done', 'archived', 'move', 'copyId', 'stop']);
    expect(entry(m, 'stop')).toMatchObject({ label: '停止', danger: true, disabled: null, send: { type: 'session.kill', runId: 'r1', working: true, aside: false, shellTabs: 1 } });
  });
  it('外部ターミナルで動いている会話は、停止を外部ターミナルの理由で押せず、削除は出さない', () => {
    const s = session({ live: 'idle' });
    const m = presentSessionMenu(storeWith(s), s, ja);
    expect(m.stop).toBe('external');
    expect(entry(m, 'stop')).toMatchObject({ disabled: '外部ターミナルで実行中', danger: true, send: null });
    expect(keys(m)).not.toContain('delete');
  });
  it('本文の消えた会話も、移動と削除は押せる（消すのは hangar の行と印だけになる）', () => {
    const s = session({ hasTranscript: false });
    const m = presentSessionMenu(storeWith(s), s, ja);
    expect(entry(m, 'move').disabled).toBeNull();
    expect(entry(m, 'copyId')).toMatchObject({ label: 'セッション ID をコピー', disabled: null, send: { type: 'session.copyId', id: m.id } });
    expect(entry(m, 'delete').disabled).toBeNull();
  });
  it('ほかに移せるプロジェクトが無ければ、プロジェクトを変更を理由を添えて押せない', () => {
    const s = session();
    const m = presentSessionMenu({ ...storeWith(s), projects: { p1: project() } } as Store, s, ja);
    expect(entry(m, 'move').disabled).toBe('移動できるプロジェクトがありません');
  });
  it('ほかの PC の会話は、先頭に「この PC で再開」を置く', () => {
    const s = session({ remoteOnly: true });
    const m = presentSessionMenu(storeWith(s), s, ja);
    expect(keys(m)[0]).toBe('resumeHere');
    expect(entry(m, 'resumeHere')).toMatchObject({ label: 'この PC で再開', disabled: null, send: { type: 'session.resumeHere.open', id: 's1' } });
  });
});

describe('移せる先（moveTargetIds）', () => {
  it('クイックセッションは全 PC で 1 つなので、この PC の場所がまだ無くても移せる先に並べる。しまったプロジェクトといまの所属は除く', () => {
    const store = { ...initialStore(), projects: {
      p1: project(), p2: project({ id: 'p2', name: 'paper', status: 'archived' }),
      q: project({ id: 'q', name: 'quick', isScratch: true, path: null }),
    } } as Store;
    expect(moveTargetIds(store, 'p1')).toEqual(['q']);
    expect(moveTargetIds(store, 'q')).toEqual(['p1']);
  });
});

describe('セッションのメニューの項目（sessionMenuEntries）', () => {
  const base = (over: Partial<SessionMenuProps> = {}): SessionMenuProps => ({ id: 's1', name: 'n', status: null, resumeHere: null, stop: null, moveBlocked: null, ...over });
  it('状態の 4 つは、いまの状態に ✓ を付け、色の点と打鍵の印 u・p・d・a を持つ', () => {
    for (const status of [null, 'paused', 'done', 'archived'] as const) {
      const states = sessionMenuEntries(ja, base({ status })).slice(0, 4);
      expect(states.map((e) => [e.label, e.dot, e.kbd])).toEqual([['Active', 'active', 'u'], ['Paused', 'paused', 'p'], ['Done', 'done', 'd'], ['Archived', 'archived', 'a']]);
      expect(states.filter((e) => e.checked).map((e) => e.key)).toEqual([status ?? 'active']);
      expect(states.every((e) => e.checked !== undefined)).toBe(true);
    }
  });
  it('状態を選ぶと、その状態にする。Paused は戻る日のダイアログを開く', () => {
    const e = sessionMenuEntries(ja, base({ status: 'done' }));
    expect(e.find((x) => x.key === 'active')!.send).toEqual({ type: 'session.state.set', id: 's1', status: null });
    expect(e.find((x) => x.key === 'paused')!.send).toEqual({ type: 'session.pause.open', id: 's1', from: 'menu' });
    expect(e.find((x) => x.key === 'archived')!.send).toEqual({ type: 'session.state.set', id: 's1', status: 'archived' });
  });
  it('いまの状態を選び直したときは、Paused ならダイアログを開き、ほかは何もしない', () => {
    expect(sessionMenuEntries(ja, base({ status: 'paused' })).find((x) => x.key === 'paused')!.send).toEqual({ type: 'session.pause.open', id: 's1', from: 'menu' });
    expect(sessionMenuEntries(ja, base({ status: 'done' })).find((x) => x.key === 'done')!.send).toBeNull();
    expect(sessionMenuEntries(ja, base({ status: 'archived' })).find((x) => x.key === 'archived')!.send).toBeNull();
    expect(sessionMenuEntries(ja, base({ status: null })).find((x) => x.key === 'active')!.send).toBeNull();
  });
  it('プロジェクトを変更（m）の前と、停止の前に区切りを置く。動いている間は削除を出さず、危険色は停止だけ', () => {
    const e = sessionMenuEntries(ja, base({ stop: { runId: 'r1', working: false, aside: false, shellTabs: 0 } }));
    const move = e.find((x) => x.key === 'move')!;
    expect(move).toMatchObject({ label: 'プロジェクトを変更…', kbd: 'm', separatorBefore: true, send: { type: 'session.move.open', id: 's1' } });
    expect(e.find((x) => x.key === 'stop')!.separatorBefore).toBe(true);
    expect(e.filter((x) => x.danger).map((x) => x.key)).toEqual(['stop']);
    // 停止の補足の 1 行は出さない。
    expect(e.find((x) => x.key === 'stop')!.note).toBeUndefined();
  });
  it('停止が無いときは、削除の前に区切りを置く。削除は確認のダイアログを開く', () => {
    const del = sessionMenuEntries(ja, base()).find((x) => x.key === 'delete')!;
    expect(del).toMatchObject({ separatorBefore: true, disabled: null, send: { type: 'session.delete.open', id: 's1' } });
  });
  it('英語の画面では英語の短い語にする', () => {
    expect(sessionMenuEntries(en, base({ stop: 'external' })).map((x) => x.label)).toEqual(['Active', 'Paused', 'Done', 'Archived', 'Change project…', 'Copy session ID', 'Stop']);
    expect(sessionMenuEntries(en, base()).map((x) => x.label)).toEqual(['Active', 'Paused', 'Done', 'Archived', 'Change project…', 'Copy session ID', 'Delete…']);
  });
});
