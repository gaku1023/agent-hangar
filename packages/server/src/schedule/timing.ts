import { SCHEDULE_MAX_EVERY_MINUTES, SCHEDULE_MIN_EVERY_MINUTES, type ScheduleSpec } from '@agent-hangar/shared';
import { MessageError, msg } from '../i18n/message.ts';

const MINUTE = 60_000;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** その日のその時刻。夏時間の切り替えは Date に任せる。 */
function atTime(base: Date, offsetDays: number, time: string): number {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays, h, m).getTime();
}

/** after より後で最初の回。無ければ null。anchor は N 分おきの格子の起点である。 */
export function nextOccurrence(spec: ScheduleSpec, after: number, anchor: number): number | null {
  switch (spec.kind) {
    case 'once': return spec.at > after ? spec.at : null;
    case 'every': {
      const step = spec.minutes * MINUTE;
      return anchor + (Math.floor((after - anchor) / step) + 1) * step;
    }
    case 'weekly': {
      const base = new Date(after);
      for (let i = 0; i <= 7; i++) {
        const t = atTime(base, i, spec.time);
        if (t > after && spec.days.includes(new Date(t).getDay())) return t;
      }
      return null;
    }
  }
}

/** now までに来た最新の回。閉じていた間の回を積まないために、流すのはこの 1 回だけにする。 */
export function latestDue(spec: ScheduleSpec, now: number, anchor: number): number | null {
  switch (spec.kind) {
    case 'once': return spec.at <= now ? spec.at : null;
    case 'every': {
      const step = spec.minutes * MINUTE;
      return now < anchor ? null : anchor + Math.floor((now - anchor) / step) * step;
    }
    case 'weekly': {
      const base = new Date(now);
      for (let i = 0; i >= -7; i--) {
        const t = atTime(base, i, spec.time);
        if (t <= now && spec.days.includes(new Date(t).getDay())) return t;
      }
      return null;
    }
  }
}

/** 外（HTTP と MCP）から来た形を検査して整える。合わなければ投げる。 */
export function parseSpec(v: unknown, now: number): ScheduleSpec {
  const o = (v ?? {}) as { kind?: unknown; at?: unknown; days?: unknown; time?: unknown; minutes?: unknown };
  switch (o.kind) {
    case 'once':
      if (typeof o.at !== 'number' || !Number.isFinite(o.at) || o.at <= now) throw new MessageError(msg('schedules.error.oncePast'));
      return { kind: 'once', at: o.at };
    case 'every':
      if (typeof o.minutes !== 'number' || !Number.isInteger(o.minutes) || o.minutes < SCHEDULE_MIN_EVERY_MINUTES || o.minutes > SCHEDULE_MAX_EVERY_MINUTES) {
        throw new MessageError(msg('schedules.error.every', { min: SCHEDULE_MIN_EVERY_MINUTES, max: SCHEDULE_MAX_EVERY_MINUTES }));
      }
      return { kind: 'every', minutes: o.minutes };
    case 'weekly': {
      const days = Array.isArray(o.days) ? [...new Set(o.days)] : [];
      if (days.length === 0 || !days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) throw new MessageError(msg('schedules.error.days'));
      if (typeof o.time !== 'string' || !TIME.test(o.time)) throw new MessageError(msg('schedules.error.time'));
      return { kind: 'weekly', days: (days as number[]).sort((a, b) => a - b), time: o.time };
    }
    default: throw new MessageError(msg('schedules.error.kind'));
  }
}
