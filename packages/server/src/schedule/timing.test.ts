import type { ScheduleSpec } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import { latestDue, nextOccurrence, parseSpec } from './timing.ts';

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const MON = at(2026, 11, 2, 12, 0); // 2026-11-02 は月曜

describe('次の回', () => {
  it('曜日は、今より後でいちばん近い曜日の時刻', () => {
    const spec: ScheduleSpec = { kind: 'weekly', days: [1, 3], time: '09:00' };
    expect(nextOccurrence(spec, MON, MON)).toBe(at(2026, 11, 4, 9));
    expect(nextOccurrence(spec, at(2026, 11, 2, 8, 59), MON)).toBe(at(2026, 11, 2, 9));
    // ちょうどその時刻は過ぎたものとして次へ進む。同じ回を 2 度流さない。
    expect(nextOccurrence(spec, at(2026, 11, 2, 9), MON)).toBe(at(2026, 11, 4, 9));
  });
  it('N 分おきは、起点から N 分ごとの格子に乗る', () => {
    const spec = { kind: 'every', minutes: 30 } as const;
    expect(nextOccurrence(spec, MON, MON)).toBe(MON + 30 * 60_000);
    expect(nextOccurrence(spec, MON + 95 * 60_000, MON)).toBe(MON + 120 * 60_000);
  });
  it('1 回だけは、その時刻の後は無い', () => {
    const spec = { kind: 'once', at: MON + 1000 } as const;
    expect(nextOccurrence(spec, MON, MON)).toBe(MON + 1000);
    expect(nextOccurrence(spec, MON + 1000, MON)).toBeNull();
  });
});

describe('閉じていた間の回', () => {
  it('曜日は、今までに来た最新の 1 回だけを返す', () => {
    const spec: ScheduleSpec = { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' };
    expect(latestDue(spec, at(2026, 11, 6, 20), at(2026, 10, 1))).toBe(at(2026, 11, 6, 9));
    // 土曜の朝なら金曜の回。
    expect(latestDue(spec, at(2026, 11, 7, 8), at(2026, 10, 1))).toBe(at(2026, 11, 6, 9));
  });
  it('N 分おきは、格子の最新の 1 回', () => {
    expect(latestDue({ kind: 'every', minutes: 30 }, MON + 95 * 60_000, MON)).toBe(MON + 90 * 60_000);
  });
  it('1 回だけは、過ぎていればその時刻', () => {
    expect(latestDue({ kind: 'once', at: MON }, MON + 9, MON - 5)).toBe(MON);
  });
});

describe('予定の形の検査', () => {
  it('正しい形を通す', () => {
    expect(parseSpec({ kind: 'weekly', days: [5, 1, 1], time: '09:30' }, MON)).toEqual({ kind: 'weekly', days: [1, 5], time: '09:30' });
    expect(parseSpec({ kind: 'every', minutes: 5 }, MON)).toEqual({ kind: 'every', minutes: 5 });
    expect(parseSpec({ kind: 'once', at: MON + 1 }, MON)).toEqual({ kind: 'once', at: MON + 1 });
  });
  it.each([
    [{ kind: 'weekly', days: [], time: '09:00' }],
    [{ kind: 'weekly', days: [7], time: '09:00' }],
    [{ kind: 'weekly', days: [1], time: '25:00' }],
    [{ kind: 'every', minutes: 4 }],
    [{ kind: 'every', minutes: 1.5 }],
    [{ kind: 'once', at: MON - 1 }],
    [{ kind: 'cron' }],
    [null],
  ])('%j は断る', (v) => {
    expect(() => parseSpec(v, MON)).toThrow();
  });
});
