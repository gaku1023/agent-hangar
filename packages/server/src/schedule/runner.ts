import type { ScheduleRunResult, ScheduleTarget } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { addRun, advance, dueRows, finishRun, hasRunning, runningRuns, scheduleRow, setRunSession, specOf, targetOf, type ScheduleRow } from './store.ts';
import { latestDue } from './timing.ts';

/** 見直す間隔。時刻の精度はこの長さで足りる。PC が眠ってから覚めたときも、次の見直しで流れる。 */
const TICK_MS = 15_000;

export type ScheduleOutcome = { result: Exclude<ScheduleRunResult, 'running' | 'skipped'>; error?: string };

export type RunnerDeps = {
  db: Db;
  deviceId: string;
  now(): number;
  /** 会話を起こす、または既存の会話へ送る。既存の会話が動いていて送れなければ 'busy'。 */
  launch(s: { id: string; prompt: string; target: ScheduleTarget }): Promise<{ sessionId: string } | 'busy'>;
  /** その会話のターンが終わるか、入力待ちになるまで待つ。 */
  wait(sessionId: string): Promise<ScheduleOutcome>;
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 時刻が来た予定を流す（#549）。
 * 閉じていた間や眠っていた間の回は積まず、最新の 1 回だけ流す。前の回が動いていれば飛ばす。
 * 「動いている」の正は schedule_runs の running の行で、起こし直した後は resumeRunning が待ち直す。
 */
export class ScheduleRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly d: RunnerDeps) {}

  start(): void {
    this.resumeRunning();
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(): void {
    const now = this.d.now();
    for (const r of dueRows(this.d.db, this.d.deviceId, now)) {
      const spec = specOf(r);
      const planned = latestDue(spec, now, r.anchor_at) ?? r.next_at!;
      if (hasRunning(this.d.db, r.id)) {
        // 1 回だけの予定は、飛ばすと二度と流れない。前の回（今すぐ実行）が終わるまで待つ。
        if (spec.kind === 'once') continue;
        addRun(this.d.db, { scheduleId: r.id, plannedAt: planned, now, result: 'skipped' });
        advance(this.d.db, r, now);
        continue;
      }
      advance(this.d.db, r, now);
      this.fire(r, planned);
    }
  }

  /** 今すぐ実行。次の時刻は変えない。 */
  runNow(id: string): 'started' | 'busy' | 'missing' {
    const r = scheduleRow(this.d.db, id);
    if (!r || r.device_id !== this.d.deviceId) return 'missing';
    if (hasRunning(this.d.db, id)) return 'busy';
    const now = this.d.now();
    this.fire(r, now);
    return 'started';
  }

  /** 起こし直す前から動いていた回を待ち直す。会話が決まる前に落ちた回は、もう待てない。 */
  resumeRunning(): void {
    for (const r of runningRuns(this.d.db, this.d.deviceId)) {
      if (r.session_id === null) finishRun(this.d.db, r.id, { now: this.d.now(), result: 'failed' });
      else void this.watch(r.id, r.session_id);
    }
  }

  private fire(r: ScheduleRow, planned: number): void {
    const { db, now } = this.d;
    // 行を先に書く。起動を待つ間に次の見直しが来ても、動いているものとして飛ばす。
    const runId = addRun(db, { scheduleId: r.id, plannedAt: planned, now: now(), result: 'running' });
    void (async () => {
      try {
        const got = await this.d.launch({ id: r.id, prompt: r.prompt, target: targetOf(r) });
        if (got === 'busy') { finishRun(db, runId, { now: now(), result: 'skipped' }); return; }
        setRunSession(db, runId, got.sessionId);
        await this.watch(runId, got.sessionId);
      } catch (e) {
        finishRun(db, runId, { now: now(), result: 'failed', error: errText(e) });
      }
    })();
  }

  private async watch(runId: string, sessionId: string): Promise<void> {
    const { db, now } = this.d;
    try {
      const o = await this.d.wait(sessionId);
      finishRun(db, runId, { now: now(), result: o.result, ...(o.error ? { error: o.error } : {}) });
    } catch (e) {
      finishRun(db, runId, { now: now(), result: 'failed', error: errText(e) });
    }
  }
}
