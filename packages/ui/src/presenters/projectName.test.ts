import { translator, type ProjectDto, type SessionDto, type SettingsDto, type UsageAggregateDto } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentHome } from './home.ts';
import { presentPalette } from './palette.ts';
import { projectDisplayName } from './projectName.ts';
import { presentProject } from './project.ts';
import { presentSession } from './session.ts';
import { presentSessionList } from './sessions.ts';
import { presentSettings } from './settings.ts';
import { parseQuery } from '../lib/searchTokens.ts';

// プロジェクトに属さないセッションのまとまり（擬似プロジェクト）は、DB の名前ではなく辞書の名前で出す。

const NOW = new Date(2026, 9, 10, 9, 0).getTime();
const H = 3_600_000;
const ja = translator('ja');
const en = translator('en');

const project = (id: string, name: string, isScratch = false): ProjectDto => ({ id, name, status: 'active', isScratch, path: `/w/${id}`, resolved: true, lastActivityAt: NOW - H, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 });
const session = (id: string, projectId: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId, name: id, cwd: '/w', firstPrompt: null, aiTitle: null, startedAt: NOW - 2 * H, lastActivityAt: NOW - H, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 1, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, ...over });
const storeOf = (language: 'ja' | 'en', over: Partial<Store> = {}): Store => ({
  ...initialStore(), bootstrapped: true, settings: { language } as unknown as SettingsDto,
  projects: { alpha: project('alpha', 'alpha'), sc: project('sc', 'スクラッチ', true) },
  sessions: { a1: session('a1', 'alpha'), q1: session('q1', 'sc') },
  ...over,
});

describe('projectDisplayName', () => {
  it('擬似プロジェクトは、DB の名前ではなく辞書の名前を言語で出す。ふつうのプロジェクトは名前のまま', () => {
    expect(projectDisplayName({ name: 'スクラッチ', isScratch: true }, ja)).toBe('クイックセッション');
    expect(projectDisplayName({ name: 'スクラッチ', isScratch: true }, en)).toBe('Quick sessions');
    expect(projectDisplayName({ name: 'alpha', isScratch: false }, ja)).toBe('alpha');
    expect(projectDisplayName({ name: 'alpha', isScratch: false }, en)).toBe('alpha');
  });
});

describe.each([['ja', 'クイックセッション'], ['en', 'Quick sessions']] as const)('擬似プロジェクトの表示名（%s）', (language, quick) => {
  const store = storeOf(language);

  it('一覧の行のプロジェクト名と、プロジェクトの絞り込みの選択肢', () => {
    const p = presentSessionList(initialState(), store, NOW);
    expect(p.rows.find((r) => r.id === 'q1')!.projectName).toBe(quick);
    expect(p.rows.find((r) => r.id === 'a1')!.projectName).toBe('alpha');
    expect(p.projects.map((x) => x.name)).toContain(quick);
    expect(p.projects.map((x) => x.name)).not.toContain('スクラッチ');
  });
  it('絞り込みの条件の行と、欄の project: の語も同じ名前になる', () => {
    const state = { ...initialState(), search: { ...initialState().search, filter: { projectId: 'sc' } } };
    const p = presentSessionList(state, store, NOW);
    expect(p.conditions).toContain(quick);
    expect(parseQuery(`project:"${quick}"`, p.projects).filter).toMatchObject({ projectId: 'sc' });
  });
  it('そのまとまりの画面の見出し', () => {
    expect(presentProject(initialState(), store, NOW, 'sc').name).toBe(quick);
    expect(presentProject(initialState(), store, NOW, 'alpha').name).toBe('alpha');
  });
  it('セッション画面の親の名前', () => {
    expect(presentSession(initialState(), store, NOW, 'q1').parent).toMatchObject({ label: quick });
  });
  it('ホームの札と、パレットの副題', () => {
    const live = { ...store, sessions: { ...store.sessions, q1: session('q1', 'sc', { live: 'waiting' }), q2: session('q2', 'sc', { live: 'busy' }) } };
    const h = presentHome(initialState(), live, NOW);
    expect(h.attention[0]!.projectName).toBe(quick);
    expect(h.running[0]!.meta).toContain(quick);
    const palette = presentPalette({ ...initialState(), overlay: { kind: 'palette' } }, live, '', NOW)!;
    expect(JSON.stringify(palette)).toContain(quick);
    expect(JSON.stringify(palette)).not.toContain('スクラッチ');
  });
  it('設定の使用量の表のプロジェクト名', () => {
    const usage: UsageAggregateDto = { days: [], projects: [{ projectId: 'sc', name: 'スクラッチ', inputTokens: 1, outputTokens: 1, costUsd: null, sessions: 1 }, { projectId: 'alpha', name: 'alpha', inputTokens: 1, outputTokens: 1, costUsd: null, sessions: 1 }] };
    const p = presentSettings(initialState(), { ...store, usageAggregate: usage });
    expect(p.usageAggregate!.projects.map((x) => x.name)).toEqual([quick, 'alpha']);
  });
});
