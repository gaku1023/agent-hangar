import { randomUUID } from 'node:crypto';
import { SCHEDULE_PROMPT_MAX, SCHEDULE_RUNS_KEPT, SCHEDULES_MAX, type ScheduleDto, type ScheduleRunDto, type ScheduleRunResult, type ScheduleSpec, type ScheduleTarget } from '@agent-hangar/shared';
import { touchRow } from '../db/notify.ts';
import type { Db } from '../db/open.ts';
import { MessageError, msg } from '../i18n/message.ts';
import { sessionTitleOf } from '../mobile/feed.ts';
import { nextOccurrence } from './timing.ts';

/**
 * 予定と実行の履歴（#549）。手元だけの表で同期しない。device_id は、DB を別の PC へ写したときに二重に実行しないための印である。
 * 一覧は表の知らせで画面へ配る（events/publisher.ts）。履歴を書いたときも schedules の行として知らせる。
 */
export type ScheduleRow = {
  id: string; device_id: string; project_id: string | null; prompt: string; spec: string; target: string;
  enabled: number; next_at: number | null; anchor_at: number; from_session_id: string | null; created_at: number; updated_at: number;
};
type RunRow = { id: string; schedule_id: string; planned_at: number; started_at: number; ended_at: number | null; result: ScheduleRunResult; session_id: string | null; error: string | null };

export const specOf = (r: ScheduleRow): ScheduleSpec => JSON.parse(r.spec) as ScheduleSpec;
export const targetOf = (r: ScheduleRow): ScheduleTarget => JSON.parse(r.target) as ScheduleTarget;

function checkPrompt(prompt: string): void {
  if (!prompt.trim()) throw new MessageError(msg('schedules.error.promptRequired'));
  if (prompt.length > SCHEDULE_PROMPT_MAX) throw new MessageError(msg('schedules.error.promptTooLong', { max: SCHEDULE_PROMPT_MAX }));
}

const runDto = (db: Db, r: RunRow): ScheduleRunDto => ({
  id: r.id, plannedAt: r.planned_at, startedAt: r.started_at, endedAt: r.ended_at, result: r.result, sessionId: r.session_id,
  sessionTitle: r.session_id ? sessionTitleOf(db, r.session_id) : null, error: r.error,
});

function dto(db: Db, r: ScheduleRow): ScheduleDto {
  const target = targetOf(r);
  const runs = db.prepare('select * from schedule_runs where schedule_id = ? order by started_at desc, rowid desc').all(r.id) as RunRow[];
  const project = r.project_id ? db.prepare('select name from projects where id = ?').get(r.project_id) as { name: string } | undefined : undefined;
  return {
    id: r.id, prompt: r.prompt, spec: specOf(r), target, projectId: r.project_id, projectName: project?.name ?? null,
    sessionTitle: target.kind === 'session' ? sessionTitleOf(db, target.sessionId) : null,
    enabled: r.enabled === 1, nextAt: r.next_at, runs: runs.map((x) => runDto(db, x)),
  };
}

export const scheduleRow = (db: Db, id: string): ScheduleRow | undefined => db.prepare('select * from schedules where id = ?').get(id) as ScheduleRow | undefined;

/** この PC の予定。動いているものを先に、作った新しい順で並べる。 */
export function listSchedules(db: Db, deviceId: string, projectId?: string): ScheduleDto[] {
  const rows = db.prepare('select * from schedules where device_id = ? order by enabled desc, created_at desc, rowid desc').all(deviceId) as ScheduleRow[];
  return rows.filter((r) => projectId === undefined || r.project_id === projectId).map((r) => dto(db, r));
}

export function getSchedule(db: Db, deviceId: string, id: string): ScheduleDto | null {
  const r = scheduleRow(db, id);
  return r && r.device_id === deviceId ? dto(db, r) : null;
}

export function createSchedule(db: Db, o: { deviceId: string; prompt: string; spec: ScheduleSpec; target: ScheduleTarget; projectId: string | null; fromSessionId: string | null; now: number }): ScheduleDto {
  checkPrompt(o.prompt);
  const count = (db.prepare('select count(*) c from schedules where device_id = ?').get(o.deviceId) as { c: number }).c;
  if (count >= SCHEDULES_MAX) throw new MessageError(msg('schedules.error.tooMany', { max: SCHEDULES_MAX }));
  const id = randomUUID();
  db.prepare('insert into schedules (id, device_id, project_id, prompt, spec, target, enabled, next_at, anchor_at, from_session_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)')
    .run(id, o.deviceId, o.projectId, o.prompt, JSON.stringify(o.spec), JSON.stringify(o.target), nextOccurrence(o.spec, o.now, o.now), o.now, o.fromSessionId, o.now, o.now);
  touchRow(db, 'schedules', id);
  return dto(db, scheduleRow(db, id)!);
}

/** 変える。時刻を変えたか、止めていたものを再開したら、今を起点に次の回を決め直す。過ぎた回はさかのぼらない。 */
export function updateSchedule(db: Db, id: string, p: { prompt?: string; spec?: ScheduleSpec; target?: ScheduleTarget; projectId?: string | null; enabled?: boolean }, now: number): ScheduleDto {
  const r = scheduleRow(db, id);
  if (!r) throw new MessageError(msg('schedules.error.notFound', { id }));
  if (p.prompt !== undefined) checkPrompt(p.prompt);
  const spec = p.spec ?? specOf(r);
  const enabled = p.enabled ?? r.enabled === 1;
  const reset = p.spec !== undefined || (enabled && r.enabled !== 1);
  const anchor = reset ? now : r.anchor_at;
  const next = !enabled ? null : reset ? nextOccurrence(spec, now, now) : r.next_at;
  // 1 回だけの予定で、その時刻が過ぎたものは再開できない。
  if (enabled && next === null) throw new MessageError(msg('schedules.error.oncePast'));
  db.prepare('update schedules set prompt = ?, spec = ?, target = ?, project_id = ?, enabled = ?, next_at = ?, anchor_at = ?, updated_at = ? where id = ?')
    .run(p.prompt ?? r.prompt, JSON.stringify(spec), p.target ? JSON.stringify(p.target) : r.target, p.projectId !== undefined ? p.projectId : r.project_id, enabled ? 1 : 0, next, anchor, now, id);
  touchRow(db, 'schedules', id);
  return dto(db, scheduleRow(db, id)!);
}

export function deleteSchedule(db: Db, id: string): boolean {
  const done = db.transaction(() => {
    db.prepare('delete from schedule_runs where schedule_id = ?').run(id);
    return db.prepare('delete from schedules where id = ?').run(id).changes > 0;
  })();
  if (done) touchRow(db, 'schedules', id);
  return done;
}

/** 古い履歴を落とす。動いている回は残す。 */
function prune(db: Db, scheduleId: string): void {
  db.prepare(`delete from schedule_runs where schedule_id = ? and result != 'running' and id not in (
    select id from schedule_runs where schedule_id = ? order by started_at desc, rowid desc limit ?)`).run(scheduleId, scheduleId, SCHEDULE_RUNS_KEPT);
}

export function addRun(db: Db, o: { scheduleId: string; plannedAt: number; now: number; result: ScheduleRunResult }): string {
  const id = randomUUID();
  db.prepare('insert into schedule_runs (id, schedule_id, planned_at, started_at, ended_at, result) values (?, ?, ?, ?, ?, ?)')
    .run(id, o.scheduleId, o.plannedAt, o.now, o.result === 'running' ? null : o.now, o.result);
  prune(db, o.scheduleId);
  touchRow(db, 'schedules', o.scheduleId);
  return id;
}

export function setRunSession(db: Db, runId: string, sessionId: string): void {
  const r = db.prepare('select schedule_id from schedule_runs where id = ?').get(runId) as { schedule_id: string } | undefined;
  if (!r) return;
  db.prepare('update schedule_runs set session_id = ? where id = ?').run(sessionId, runId);
  touchRow(db, 'schedules', r.schedule_id);
}

/** 回を閉じる。予定ごと消されていれば何もしない。 */
export function finishRun(db: Db, runId: string, o: { now: number; result: ScheduleRunResult; error?: string }): void {
  const r = db.prepare('select schedule_id from schedule_runs where id = ?').get(runId) as { schedule_id: string } | undefined;
  if (!r) return;
  db.prepare('update schedule_runs set ended_at = ?, result = ?, error = ? where id = ?').run(o.now, o.result, o.error ?? null, runId);
  prune(db, r.schedule_id);
  touchRow(db, 'schedules', r.schedule_id);
}

export const hasRunning = (db: Db, scheduleId: string): boolean => db.prepare("select 1 from schedule_runs where schedule_id = ? and result = 'running' limit 1").get(scheduleId) !== undefined;

export const runningRuns = (db: Db, deviceId: string): { id: string; session_id: string | null }[] =>
  db.prepare("select r.id, r.session_id from schedule_runs r join schedules s on s.id = r.schedule_id where r.result = 'running' and s.device_id = ?").all(deviceId) as { id: string; session_id: string | null }[];

export const dueRows = (db: Db, deviceId: string, now: number): ScheduleRow[] =>
  db.prepare('select * from schedules where device_id = ? and enabled = 1 and next_at is not null and next_at <= ?').all(deviceId, now) as ScheduleRow[];

/** 流した（飛ばした）後の次の時刻。1 回だけは流したら止める。 */
export function advance(db: Db, r: ScheduleRow, now: number): void {
  const spec = specOf(r);
  const next = nextOccurrence(spec, now, r.anchor_at);
  db.prepare('update schedules set next_at = ?, enabled = ? where id = ?').run(next, next === null ? 0 : 1, r.id);
  touchRow(db, 'schedules', r.id);
}
