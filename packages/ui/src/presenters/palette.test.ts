import { describe, expect, it } from 'vitest';
import type { ProjectDto, SessionDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { fuzzyScore, presentPalette } from './palette.ts';
import { presentPromote, presentPromoted } from './promote.ts';

const project = (id: string, name: string, isScratch = false): ProjectDto => ({ id, name, status: 'active', isScratch, path: '/w/' + name, resolved: true, lastActivityAt: 1, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 });
const session = (id: string, name: string, oneLiner: string | null): SessionDto => ({
  id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'p1', name, cwd: '/w/alpha', firstPrompt: null, aiTitle: null, startedAt: 1, lastActivityAt: 1, memo: null, hasTranscript: true, live: null,
  summary: oneLiner ? { title: name, oneLiner, body: '', state: 'done', nextSteps: [], source: 'baseline', sourceId: null, sourceModel: null, basedOnTurns: 1, updatedAt: 1 } : null,
  fromScratch: false, stats: { turns: 0, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null },
});

const withPalette = () => ({ ...initialState(), overlay: { kind: 'palette' as const } });
const store = (): Store => ({ ...initialStore(), projects: { p1: project('p1', 'alpha'), sc: project('sc', 'スクラッチ', true) }, sessions: { s1: session('s1', '動画の変換', '動画を mp4 に変換した'), s2: session('s2', 'ログの整理', null) } });

describe('fuzzyScore', () => {
  it('部分列で一致し、前で連続するほど高い', () => {
    expect(fuzzyScore('abc', 'xyz')).toBe(0);
    expect(fuzzyScore('abc', 'abcdef')).toBeGreaterThan(fuzzyScore('abc', 'a1b2c3'));
    expect(fuzzyScore('abc', 'abcdef')).toBeGreaterThan(fuzzyScore('abc', 'zzzzabcdef'));
    expect(fuzzyScore('ABC', 'abcdef')).toBeGreaterThan(0);
    expect(fuzzyScore('', 'なんでも')).toBe(1);
    expect(fuzzyScore('abcd', 'abc')).toBe(0);
  });
});

describe('presentPalette', () => {
  it('パレットが開いていなければ null', () => {
    expect(presentPalette(initialState(), store(), '')).toBeNull();
  });
  it('空の入力はコマンド、プロジェクト、セッションの順に並べる', () => {
    const p = presentPalette(withPalette(), store(), '')!;
    expect(p.query).toBe('');
    expect(p.items.slice(0, 4).map((i) => i.id)).toEqual(['cmd:new-session', 'cmd:new-scratch', 'cmd:settings', 'cmd:rebuild-index']);
    expect(p.items.map((i) => i.id)).toContain('project:sc');
    expect(p.items.map((i) => i.id)).toContain('session:s1');
  });
  it('入力で絞り、要約の 1 文でも当たる', () => {
    const a = presentPalette(withPalette(), store(), 'alpha')!;
    expect(a.items[0]!.id).toBe('project:p1');
    const b = presentPalette(withPalette(), store(), 'mp4')!;
    expect(b.items.map((i) => i.id)).toEqual(['session:s1']);
    const c = presentPalette(withPalette(), store(), 'zzzz')!;
    expect(c.items).toEqual([]);
  });
  it('後から届いた新しいセッションが 30 件の枠から落ちない', () => {
    // session.upsert は辞書の末尾に鍵を足すので、積んだ順のままだと新しいセッションが枠の外に出てしまう。
    const many: Record<string, SessionDto> = {};
    for (let i = 0; i < 60; i++) many[`x${i}`] = { ...session(`x${i}`, `セッション ${i}`, null), lastActivityAt: 1000 + i };
    const fresh = { ...session('fresh', 'いま起こしたセッション', null), lastActivityAt: 9999 };
    const p = presentPalette(withPalette(), { ...store(), sessions: { ...many, fresh } }, '')!;
    expect(p.items.map((i) => i.id)).toContain('session:fresh');
    expect(p.items.filter((i) => i.kind === 'session')[0]!.id).toBe('session:fresh');
  });
  it('後から届いた新しいプロジェクトもセッションより上に残る', () => {
    const many: Record<string, ProjectDto> = {};
    for (let i = 0; i < 40; i++) many[`q${i}`] = { ...project(`q${i}`, `古い ${i}`), lastActivityAt: 1000 + i };
    const fresh = { ...project('fresh', '新しい'), lastActivityAt: 9999 };
    const p = presentPalette(withPalette(), { ...store(), projects: { ...many, fresh } }, '')!;
    expect(p.items.map((i) => i.id)).toContain('project:fresh');
    expect(p.items.filter((i) => i.kind === 'project')[0]!.id).toBe('project:fresh');
  });
  it('30 件までに切る', () => {
    const many: Record<string, SessionDto> = {};
    for (let i = 0; i < 60; i++) many[`x${i}`] = session(`x${i}`, `セッション ${i}`, null);
    const p = presentPalette(withPalette(), { ...store(), sessions: many }, '')!;
    expect(p.items).toHaveLength(30);
  });
});

describe('presentPromote と presentPromoted', () => {
  it('昇格ダイアログはセッション名と run の生死と送信の状態を出す', () => {
    const s = { ...withPalette(), overlay: { kind: 'promote' as const, sessionId: 's1' }, promote: { kind: 'failed' as const, message: '同じ名前があります' } };
    expect(presentPromote(s, store())).toEqual({ sessionId: 's1', sessionName: '動画の変換', runAlive: false, submitting: false, error: '同じ名前があります' });
    expect(presentPromote(initialState(), store())).toBeNull();
    const alive = { ...initialStore(), ...store(), runs: { r1: { id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'start' as const, tmuxName: 'x', pid: 1, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 } } };
    expect(presentPromote({ ...s, promote: { kind: 'submitting' as const } }, alive)).toMatchObject({ runAlive: true, submitting: true, error: null });
  });
  it('完了ダイアログは移動の可否と理由を出す', () => {
    const s = { ...initialState(), overlay: { kind: 'promoted' as const, projectId: 'p1', moved: false, reason: 'run が生きています' } };
    expect(presentPromoted(s, store())).toEqual({ projectId: 'p1', projectName: 'alpha', moved: false, reason: 'run が生きています' });
    expect(presentPromoted(initialState(), store())).toBeNull();
  });
});
