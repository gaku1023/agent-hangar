import { describe, expect, it } from 'vitest';
import { addDays, isReturnOn, isReturnTime, localDate, localTime, overdueDays, returnAtIso, returnAtMs, STATE_NOTE_MAX } from './sessionState.ts';

/** 手元の暦の時刻。試験を走らせる機械のタイムゾーンによらず、同じ日付になる。 */
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe('isReturnOn', () => {
  it('YYYY-MM-DD の形で、暦にある日だけを通す', () => {
    expect(isReturnOn('2026-10-02')).toBe(true);
    expect(isReturnOn('2028-02-29')).toBe(true);
    for (const s of ['2026-02-29', '2026-13-01', '2026-10-32', '2026-00-10', '2026-1-2', '2026/10/02', '20261002', ' 2026-10-02', '2026-10-02T00:00', '']) {
      expect(isReturnOn(s), s).toBe(false);
    }
  });
});

describe('localDate', () => {
  it('手元の暦の日付を返す。夜中の 0 時の前後で日が変わる', () => {
    expect(localDate(at(2026, 10, 1, 23, 59))).toBe('2026-10-01');
    expect(localDate(at(2026, 10, 2, 0, 0))).toBe('2026-10-02');
    expect(localDate(at(2026, 1, 5))).toBe('2026-01-05');
  });
});

describe('addDays', () => {
  it('月と年をまたぎ、負の日数も足せる', () => {
    expect(addDays('2026-10-01', 1)).toBe('2026-10-02');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDays('2026-10-01', 7)).toBe('2026-10-08');
    expect(addDays('2026-10-01', 0)).toBe('2026-10-01');
  });
  it('形の違う日付は投げる', () => {
    expect(() => addDays('2026/10/01', 1)).toThrow();
  });
});

describe('overdueDays', () => {
  it('今日なら 0、過ぎていれば日数、先なら null', () => {
    const now = at(2026, 10, 1, 9);
    expect(overdueDays('2026-10-01', now)).toBe(0);
    expect(overdueDays('2026-09-28', now)).toBe(3);
    expect(overdueDays('2026-10-02', now)).toBeNull();
  });
  it('夏時間のある地域でも、日の数え方が 1 日ずれない', () => {
    // 手元の暦の日付どうしを UTC の 0 時に置いて引くので、23 時間や 25 時間の日があっても割り切れる。
    expect(overdueDays('2026-01-01', at(2026, 7, 1))).toBe(181);
  });
  it('形の違う日付は先の日と同じに扱う（今日戻るに出さない）', () => {
    expect(overdueDays('いつか', at(2026, 10, 1))).toBeNull();
  });
  it('理由の上限は 200 字', () => {
    expect(STATE_NOTE_MAX).toBe(200);
  });
});

describe('isReturnTime', () => {
  it('HH:MM の形で、00:00〜23:59 だけを通す', () => {
    for (const s of ['00:00', '09:05', '13:30', '23:59']) expect(isReturnTime(s), s).toBe(true);
    for (const s of ['24:00', '25:00', '12:60', '9:05', '13:3', '1330', '13:30:00', ' 13:30', '13：30', '']) expect(isReturnTime(s), s).toBe(false);
  });
});

describe('localTime', () => {
  it('手元の時刻を HH:MM で返す', () => {
    expect(localTime(at(2026, 10, 5, 9, 5))).toBe('09:05');
    expect(localTime(at(2026, 10, 5, 23, 59))).toBe('23:59');
  });
});

describe('returnAtMs', () => {
  it('戻る日と時刻を、手元の時刻として読む', () => {
    expect(returnAtMs('2026-10-05', '13:30')).toBe(at(2026, 10, 5, 13, 30));
    expect(returnAtMs('2026-10-05', '00:00')).toBe(at(2026, 10, 5, 0, 0));
  });
  it('日付か時刻の形が違えば NaN', () => {
    expect(returnAtMs('2026-02-30', '13:30')).toBeNaN();
    expect(returnAtMs('2026-10-05', '25:00')).toBeNaN();
  });
});

describe('returnAtIso', () => {
  it('手元のオフセットを付けて、どのゾーンで読んだかを残す', () => {
    const iso = returnAtIso('2026-10-05', '13:30')!;
    expect(iso).toMatch(/^2026-10-05T13:30[+-]\d{2}:\d{2}$/);
    // 付けたオフセットで読み直すと、同じ時点になる。
    expect(new Date(iso).getTime()).toBe(at(2026, 10, 5, 13, 30));
  });
  it('形が違えば null', () => {
    expect(returnAtIso('2026-10-05', '25:00')).toBeNull();
  });
});
