import { describe, expect, it } from 'vitest';
import { translator } from '@agent-hangar/shared';
import type { ProjectDto, SessionDto, SettingsDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { durationLabel } from './format.ts';
import { presentHome } from './home.ts';
import { presentPalette } from './palette.ts';
import { presentSession } from './session.ts';
import { presentShell } from './shell.ts';
import { presentToasts } from './toasts.ts';

const NOW = Date.parse('2026-09-02T12:00:00Z');
const project: ProjectDto = { id: 'alpha', name: 'alpha', status: 'active', isScratch: false, path: '/w/alpha', resolved: true, lastActivityAt: NOW, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1 };
const dto = (id: string, over: Partial<SessionDto>): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'alpha', name: id, cwd: '/w/alpha', firstPrompt: 'first', aiTitle: null, startedAt: NOW - 7_200_000, lastActivityAt: NOW - 10_000, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, ...over });

function store(language: 'en' | 'ja'): Store {
  const s = initialStore();
  s.bootstrapped = true;
  s.settings = { language } as SettingsDto;
  s.projects = { alpha: project };
  s.sessions = { w1: dto('w1', { live: 'waiting' }), i1: dto('i1', { live: 'idle' }) };
  s.runs = { rw1: { id: 'rw1', sessionId: 'w1', deviceId: 'd', kind: 'start', tmuxName: 'hangar-rw1', pid: null, startedAt: NOW - 60_000, endedAt: null, endReason: null, heartbeatAt: 1 } };
  return s;
}

/** 1 分に満たない長さの語は、英語では「<1 min」。表示する所がそろって同じ語になる。 */
describe('英語の 1 分未満の表示は <1 min', () => {
  it('durationLabel', () => {
    expect(durationLabel(translator('en'), 30_000)).toBe('<1 min');
    expect(durationLabel(translator('en'), 120_000)).toBe('2 min');
  });

  it('サイドバーの入力待ち', () => {
    const rows = presentShell(initialState(), store('en'), NOW, 'UTC').live.rows;
    expect(rows.find((r) => r.id === 'w1')?.waited).toBe('Waiting <1 min');
  });

  it('ホームの入力待ちの札と、アイドルの札', () => {
    const home = presentHome(initialState(), store('en'), NOW);
    expect(home.attention[0]?.waited).toBe('<1 min');
    expect(home.running.find((c) => c.id === 'i1')?.note).toBe('Idle. Time since last reply: <1 min');
  });

  it('パレットの右端', () => {
    const p = presentPalette({ ...initialState(), overlay: { kind: 'palette' } }, store('en'), '', NOW);
    expect(JSON.stringify(p)).toContain('Waiting <1 min');
  });

  it('セッションの帯', () => {
    const p = presentSession({ ...initialState(), screen: { name: 'session', id: 'w1' } }, store('en'), NOW, 'w1');
    expect(p.strip?.sub).toBe('Waiting <1 min');
  });

  it('トーストの入力待ちの札', () => {
    const p = presentToasts({ ...initialState(), waitingToasts: ['w1'] }, store('en'), NOW);
    expect(p.waiting[0]?.waited).toBe('<1 min');
  });

  it('日本語は変えない', () => {
    expect(durationLabel(translator('ja'), 30_000)).toBe('1 分未満');
    expect(presentToasts({ ...initialState(), waitingToasts: ['w1'] }, store('ja'), NOW).waiting[0]?.waited).toBe('1 分未満');
  });
});
