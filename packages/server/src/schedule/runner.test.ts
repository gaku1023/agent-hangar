import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import type { Db } from '../db/open.ts';
import { ScheduleRunner, type RunnerDeps, type ScheduleOutcome } from './runner.ts';
import { createSchedule, deleteSchedule, listSchedules, updateSchedule } from './store.ts';

let tmp: string;
let db: Db;
let now: number;
const T0 = new Date(2026, 10, 2, 8, 0).getTime();
const MIN = 60_000;

/** 手で進める起動と待ち。終わらせるまで前の回は動いたままになる。 */
function fakeDeps(over: Partial<RunnerDeps> = {}) {
  const launched: { id: string; prompt: string }[] = [];
  const waits = new Map<string, (o: ScheduleOutcome) => void>();
  const deps: RunnerDeps = {
    db, deviceId: 'dev-a', now: () => now,
    launch: async (s) => { launched.push({ id: s.id, prompt: s.prompt }); return { sessionId: `s-${launched.length}` }; },
    wait: (sid) => new Promise((res) => { waits.set(sid, res); }),
    ...over,
  };
  return { deps, launched, waits };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const every30 = (over = {}) => createSchedule(db, { deviceId: 'dev-a', prompt: 'p', spec: { kind: 'every', minutes: 30 }, target: { kind: 'new', projectId: 'pj' }, projectId: 'pj', fromSessionId: null, now, ...over });
const runsOf = (id: string) => listSchedules(db, 'dev-a').find((x) => x.id === id)!.runs;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-schedule-'));
  db = openDb(path.join(tmp, 'h.db'), { backupDir: path.join(tmp, 'b') });
  now = T0;
});
afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('定期の実行', () => {
  it('時刻が来る前は動かさず、来たら 1 回流す', async () => {
    const s = every30();
    const { deps, launched } = fakeDeps();
    const r = new ScheduleRunner(deps);
    r.tick();
    expect(launched).toEqual([]);
    now = T0 + 30 * MIN;
    r.tick();
    await flush();
    expect(launched).toEqual([{ id: s.id, prompt: 'p' }]);
    expect(runsOf(s.id)[0]).toMatchObject({ result: 'running', sessionId: 's-1' });
  });

  it('閉じていた間の回は積まず、最新の 1 回だけ流して、次の時刻は今より後になる', async () => {
    const s = every30();
    const { deps, launched } = fakeDeps();
    const r = new ScheduleRunner(deps);
    now = T0 + 10 * 60 * MIN + 5 * MIN;
    r.tick();
    r.tick();
    await flush();
    expect(launched).toHaveLength(1);
    expect(runsOf(s.id)).toHaveLength(1);
    expect(runsOf(s.id)[0]!.plannedAt).toBe(T0 + 10 * 60 * MIN);
    expect(listSchedules(db, 'dev-a')[0]!.nextAt).toBe(T0 + 10 * 60 * MIN + 30 * MIN);
  });

  it('前の回が動いていれば次の回を飛ばし、終われば次は流す', async () => {
    const s = every30();
    const { deps, launched, waits } = fakeDeps();
    const r = new ScheduleRunner(deps);
    now = T0 + 30 * MIN;
    r.tick();
    await flush();
    now = T0 + 60 * MIN;
    r.tick();
    await flush();
    expect(launched).toHaveLength(1);
    expect(runsOf(s.id).map((x) => x.result)).toEqual(['skipped', 'running']);
    waits.get('s-1')!({ result: 'finished' });
    await flush();
    now = T0 + 90 * MIN;
    r.tick();
    await flush();
    expect(launched).toHaveLength(2);
  });

  it('既存の会話が動いている（busy）なら、その回は飛ばす', async () => {
    const s = every30();
    const { deps } = fakeDeps({ launch: async () => 'busy' });
    const r = new ScheduleRunner(deps);
    now = T0 + 30 * MIN;
    r.tick();
    await flush();
    expect(runsOf(s.id)[0]).toMatchObject({ result: 'skipped' });
  });

  it('起動に失敗したら failed で残し、理由を持つ', async () => {
    const s = every30();
    const { deps } = fakeDeps({ launch: async () => { throw new Error('nope'); } });
    const r = new ScheduleRunner(deps);
    now = T0 + 30 * MIN;
    r.tick();
    await flush();
    expect(runsOf(s.id)[0]).toMatchObject({ result: 'failed', error: 'nope' });
  });

  it('履歴は直近の 5 件だけ残す', async () => {
    const s = every30();
    const { deps, waits } = fakeDeps();
    const r = new ScheduleRunner(deps);
    for (let i = 1; i <= 7; i++) {
      now = T0 + i * 30 * MIN;
      r.tick();
      await flush();
      waits.get(`s-${i}`)!({ result: 'finished' });
      await flush();
    }
    const runs = runsOf(s.id);
    expect(runs).toHaveLength(5);
    expect(runs[0]!.plannedAt).toBe(T0 + 7 * 30 * MIN);
  });

  it('1 回だけは流したら止まり、次の時刻を持たない', async () => {
    const s = createSchedule(db, { deviceId: 'dev-a', prompt: 'p', spec: { kind: 'once', at: T0 + MIN }, target: { kind: 'new', projectId: 'pj' }, projectId: 'pj', fromSessionId: null, now });
    const { deps, launched } = fakeDeps();
    const r = new ScheduleRunner(deps);
    now = T0 + 5 * MIN;
    r.tick();
    r.tick();
    await flush();
    expect(launched).toHaveLength(1);
    const after = listSchedules(db, 'dev-a').find((x) => x.id === s.id)!;
    expect(after).toMatchObject({ enabled: false, nextAt: null });
  });

  it('一時停止の間は流さず、再開したら今より後の次の時刻から', async () => {
    const s = every30();
    updateSchedule(db, s.id, { enabled: false }, now);
    const { deps, launched } = fakeDeps();
    const r = new ScheduleRunner(deps);
    now = T0 + 100 * MIN;
    r.tick();
    await flush();
    expect(launched).toEqual([]);
    const back = updateSchedule(db, s.id, { enabled: true }, now);
    expect(back.nextAt).toBe(now + 30 * MIN);
  });

  it('ほかの PC の予定は流さない', async () => {
    every30({ deviceId: 'dev-b' });
    const { deps, launched } = fakeDeps();
    const r = new ScheduleRunner(deps);
    now = T0 + 100 * MIN;
    r.tick();
    await flush();
    expect(launched).toEqual([]);
  });

  it('今すぐ実行は次の時刻を変えず、動いている間は busy を返す', async () => {
    const s = every30();
    const { deps, launched } = fakeDeps();
    const r = new ScheduleRunner(deps);
    const next = listSchedules(db, 'dev-a')[0]!.nextAt;
    expect(r.runNow(s.id)).toBe('started');
    expect(r.runNow(s.id)).toBe('busy');
    await flush();
    expect(launched).toHaveLength(1);
    expect(listSchedules(db, 'dev-a')[0]!.nextAt).toBe(next);
  });

  it('起こし直したら、動いたままの回を待ち直す。会話の分からない回は failed にする', async () => {
    const s = every30();
    const { deps, waits } = fakeDeps();
    db.prepare("insert into schedule_runs (id, schedule_id, planned_at, started_at, result, session_id) values ('r1', ?, 1, 1, 'running', 's-old')").run(s.id);
    db.prepare("insert into schedule_runs (id, schedule_id, planned_at, started_at, result, session_id) values ('r2', ?, 2, 2, 'running', null)").run(s.id);
    const r = new ScheduleRunner(deps);
    r.resumeRunning();
    await flush();
    expect(runsOf(s.id).find((x) => x.id === 'r2')!.result).toBe('failed');
    waits.get('s-old')!({ result: 'waiting' });
    await flush();
    expect(runsOf(s.id).find((x) => x.id === 'r1')!.result).toBe('waiting');
  });

  it('動いている間に予定を消しても、終わりの書き込みで落ちない', async () => {
    const s = every30();
    const { deps, waits } = fakeDeps();
    const r = new ScheduleRunner(deps);
    r.runNow(s.id);
    await flush();
    deleteSchedule(db, s.id);
    waits.get('s-1')!({ result: 'finished' });
    await flush();
    expect(listSchedules(db, 'dev-a')).toEqual([]);
  });
});
