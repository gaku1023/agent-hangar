import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { aggregateUsage, localDay } from './aggregate.ts';

describe('aggregateUsage', () => {
  it('日別とプロジェクト別に束ね、コストは statusline の値だけを足す', () => {
    const db = openDb(':memory:');
    const now = Date.parse('2026-09-17T12:00:00');
    upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/x', home_device: 'd', project_id: 'p1' }, 'd');
    upsertShared(db, 'sessions', { id: 's2', provider: 'claude-code', provider_session_id: 'u2', cwd: '/y', home_device: 'd', project_id: null }, 'd');
    db.prepare('insert into session_stats (session_id, input_tokens, output_tokens) values (?,?,?)').run('s1', 1000, 100);
    db.prepare('insert into session_stats (session_id, input_tokens, output_tokens) values (?,?,?)').run('s2', 50, 5);
    db.prepare('insert into usage_daily values (?,?,?,?)').run('s1', localDay(now), 600, 60);
    db.prepare('insert into usage_daily values (?,?,?,?)').run('s1', localDay(now - 86_400_000), 400, 40);
    db.prepare('insert into usage_daily values (?,?,?,?)').run('s2', localDay(now), 50, 5);
    db.prepare('insert into usage_daily values (?,?,?,?)').run('s2', localDay(now - 40 * 86_400_000), 9, 9);
    db.prepare('insert into session_live_stats (provider_session_id, cost_usd, updated_at) values (?,?,?)').run('u1', 0.25, 1);
    const r = aggregateUsage(db, { days: 30, now });
    expect(r.days).toEqual([
      { day: localDay(now), inputTokens: 650, outputTokens: 65, sessions: 2 },
      { day: localDay(now - 86_400_000), inputTokens: 400, outputTokens: 40, sessions: 1 },
    ]);
    expect(r.projects).toEqual([
      { projectId: 'p1', name: 'alpha', inputTokens: 1000, outputTokens: 100, costUsd: 0.25, sessions: 1 },
      { projectId: null, name: '未分類', inputTokens: 50, outputTokens: 5, costUsd: null, sessions: 1 },
    ]);
  });
  it('localDay はローカル時刻の日付', () => {
    const d = new Date(2026, 8, 17, 23, 59);
    expect(localDay(d.getTime())).toBe('2026-09-17');
  });
});
