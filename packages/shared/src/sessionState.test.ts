import { describe, expect, it } from 'vitest';
import { addDays, isReturnOn, localDate, overdueDays, STATE_NOTE_MAX } from './sessionState.ts';

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
