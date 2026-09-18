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
    const ins = db.prepare('insert into usage_daily (session_id, day, file_path, input_tokens, output_tokens) values (?,?,?,?,?)');
    db.prepare('insert into session_stats (session_id, input_tokens, output_tokens) values (?,?,?)').run('s1', 1000, 100);
    db.prepare('insert into session_stats (session_id, input_tokens, output_tokens) values (?,?,?)').run('s2', 50, 5);
    ins.run('s1', localDay(now), '/p/s1.jsonl', 600, 60);
    ins.run('s1', localDay(now - 86_400_000), '/p/s1.jsonl', 400, 40);
    ins.run('s2', localDay(now), '/p/s2.jsonl', 50, 5);
    ins.run('s2', localDay(now - 40 * 86_400_000), '/p/s2.jsonl', 9, 9);
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
  it('日別もプロジェクト別も論理削除したセッションを数えない', () => {
    const db = openDb(':memory:');
    const now = Date.parse('2026-09-17T12:00:00');
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/x', home_device: 'd', project_id: null }, 'd');
    upsertShared(db, 'sessions', { id: 's2', provider: 'claude-code', provider_session_id: 'u2', cwd: '/y', home_device: 'd', project_id: null, deleted_at: 1 }, 'd');
    db.prepare('insert into session_stats (session_id, input_tokens, output_tokens) values (?,?,?)').run('s1', 100, 10);
    db.prepare('insert into session_stats (session_id, input_tokens, output_tokens) values (?,?,?)').run('s2', 999, 99);
    const ins = db.prepare('insert into usage_daily (session_id, day, file_path, input_tokens, output_tokens) values (?,?,?,?,?)');
    ins.run('s1', localDay(now), '/p/s1.jsonl', 100, 10);
    ins.run('s2', localDay(now), '/p/s2.jsonl', 999, 99);
    const r = aggregateUsage(db, { days: 30, now });
    expect(r.days).toEqual([{ day: localDay(now), inputTokens: 100, outputTokens: 10, sessions: 1 }]);
    expect(r.projects).toEqual([{ projectId: null, name: '未分類', inputTokens: 100, outputTokens: 10, costUsd: null, sessions: 1 }]);
  });
  it('同じ days なら日別の合計とプロジェクト別の合計が一致する', () => {
    const db = openDb(':memory:');
    const now = Date.parse('2026-09-17T12:00:00');
    upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
    upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/x', home_device: 'd', project_id: 'p1' }, 'd');
    upsertShared(db, 'sessions', { id: 's2', provider: 'claude-code', provider_session_id: 'u2', cwd: '/y', home_device: 'd', project_id: null }, 'd');
    // session_stats は全期間の和なので、窓の外のぶんまで入っている。
    db.prepare('insert into session_stats (session_id, input_tokens, output_tokens) values (?,?,?)').run('s1', 1_000_000, 100_000);
    db.prepare('insert into session_stats (session_id, input_tokens, output_tokens) values (?,?,?)').run('s2', 500, 50);
    const ins = db.prepare('insert into usage_daily (session_id, day, file_path, input_tokens, output_tokens) values (?,?,?,?,?)');
    ins.run('s1', localDay(now), '/p/s1.jsonl', 300, 30);
    ins.run('s1', localDay(now), '/p/s1-sub.jsonl', 100, 10);
    ins.run('s1', localDay(now - 2 * 86_400_000), '/p/s1.jsonl', 200, 20);
    ins.run('s1', localDay(now - 40 * 86_400_000), '/p/s1.jsonl', 999_400, 99_940); // 窓の外
    ins.run('s2', localDay(now), '/p/s2.jsonl', 500, 50);
    const total = (rows: { inputTokens: number; outputTokens: number }[]) => rows.reduce((a, r) => ({ i: a.i + r.inputTokens, o: a.o + r.outputTokens }), { i: 0, o: 0 });
    const r = aggregateUsage(db, { days: 7, now });
    expect(total(r.days)).toEqual({ i: 1100, o: 110 });
    expect(total(r.projects)).toEqual(total(r.days));
    expect(r.projects).toEqual([
      { projectId: 'p1', name: 'alpha', inputTokens: 600, outputTokens: 60, costUsd: null, sessions: 1 },
      { projectId: null, name: '未分類', inputTokens: 500, outputTokens: 50, costUsd: null, sessions: 1 },
    ]);
    // 窓を広げれば両方が同じだけ増える。
    const wide = aggregateUsage(db, { days: 60, now });
    expect(total(wide.projects)).toEqual(total(wide.days));
    expect(total(wide.days)).toEqual({ i: 1_000_500, o: 100_050 });
  });
  it('localDay はローカル時刻の日付', () => {
    const d = new Date(2026, 8, 17, 23, 59);
    expect(localDay(d.getTime())).toBe('2026-09-17');
  });
});
