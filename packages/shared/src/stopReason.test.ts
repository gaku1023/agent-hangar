import { describe, expect, it } from 'vitest';
import { isParked, liveFilterOf, quietLive } from './liveFilter.ts';
import { translator } from './i18n/t.ts';
import { LIMIT_RESET_AUTO_GRACE_MS, LIMIT_RESET_GRACE_MS, limitKindOf, limitKindText, limitReset, liveWithLimit, resetAtText, stopReasonOf, waitKindOf } from './stopReason.ts';

describe('waitKindOf', () => {
  it('Claude Code が許可として数える値は permission にする', () => {
    expect(waitKindOf('permission prompt')).toBe('permission');
    expect(waitKindOf('sandbox request')).toBe('permission');
    expect(waitKindOf('worker request')).toBe('permission');
  });
  it('入力を求める値は question にする', () => {
    expect(waitKindOf('input needed')).toBe('question');
  });
  it('ダイアログや知らない値は other にする', () => {
    expect(waitKindOf('dialog open')).toBe('other');
    expect(waitKindOf('goal proposal')).toBe('other');
    expect(waitKindOf('something new')).toBe('other');
  });
  it('文字列でなければ null', () => {
    expect(waitKindOf(undefined)).toBeNull();
    expect(waitKindOf(3)).toBeNull();
    expect(waitKindOf('')).toBeNull();
  });
});

describe('limitKindOf', () => {
  it('5 時間と週の枠を見分け、ほかは other にする', () => {
    expect(limitKindOf('five_hour')).toBe('five_hour');
    expect(limitKindOf('seven_day')).toBe('weekly');
    expect(limitKindOf('seven_day_opus')).toBe('weekly');
    expect(limitKindOf('overage')).toBe('other');
    expect(limitKindOf(null)).toBe('other');
  });
});

describe('limitReset', () => {
  it('リセットの時刻から猶予を過ぎたら真', () => {
    expect(limitReset(1000, 1000 + LIMIT_RESET_GRACE_MS - 1)).toBe(false);
    expect(limitReset(1000, 1000 + LIMIT_RESET_GRACE_MS)).toBe(true);
  });
  it('自動で続く予約のあるものは、長めの猶予（LIMIT_RESET_AUTO_GRACE_MS）を待つ', () => {
    expect(LIMIT_RESET_AUTO_GRACE_MS).toBeGreaterThan(LIMIT_RESET_GRACE_MS);
    expect(limitReset(1000, 1000 + LIMIT_RESET_GRACE_MS, true)).toBe(false);
    expect(limitReset(1000, 1000 + LIMIT_RESET_AUTO_GRACE_MS - 1, true)).toBe(false);
    expect(limitReset(1000, 1000 + LIMIT_RESET_AUTO_GRACE_MS, true)).toBe(true);
    expect(limitReset(1000, 1000 + LIMIT_RESET_GRACE_MS, false)).toBe(true);
  });
});

describe('stopReasonOf', () => {
  const limit = { kind: 'five_hour' as const, resetsAt: 10, auto: true, reset: false };
  it('許可を求める入力待ちは permission', () => {
    expect(stopReasonOf({ live: 'waiting', waitingFor: 'permission' })).toBe('permission');
  });
  it('AskUserQuestion の問いを待っているなら、登録が許可と書いても問いとして扱う', () => {
    expect(stopReasonOf({ live: 'waiting', waitingFor: 'permission', activity: { tool: 'AskUserQuestion', summary: '', question: '向きは？' } })).toBeNull();
    expect(stopReasonOf({ live: 'waiting', waitingFor: 'permission', permission: { tool: 'AskUserQuestion', input: '', description: null } })).toBeNull();
  });
  it('問いや不明な入力待ちは理由を付けない', () => {
    expect(stopReasonOf({ live: 'waiting', waitingFor: 'question' })).toBeNull();
    expect(stopReasonOf({ live: 'waiting', waitingFor: 'other' })).toBeNull();
    expect(stopReasonOf({ live: 'waiting' })).toBeNull();
  });
  it('休みで使用制限に当たっていれば limit、猶予を過ぎたら reset', () => {
    expect(stopReasonOf({ live: 'idle', limit })).toBe('limit');
    expect(stopReasonOf({ live: 'idle', limit: { ...limit, reset: true } })).toBe('reset');
  });
  it('作業中や終わったものに使用制限の理由は付けない', () => {
    expect(stopReasonOf({ live: 'busy', limit })).toBeNull();
    expect(stopReasonOf({ live: null, limit })).toBeNull();
  });
});

describe('liveWithLimit', () => {
  it('自動で続かずリセットを過ぎた休みは、入力待ちとして数える', () => {
    const reset = { kind: 'five_hour' as const, resetsAt: 1, auto: false, reset: true };
    expect(liveWithLimit('idle', reset)).toBe('waiting');
    expect(liveFilterOf(liveWithLimit('idle', reset), false)).toBe('waiting');
  });
  it('リセット前は休みのまま（実行中に数える）', () => {
    expect(liveWithLimit('idle', { kind: 'five_hour', resetsAt: 1, auto: true, reset: false })).toBe('idle');
    expect(liveWithLimit('idle', null)).toBe('idle');
    expect(liveWithLimit('busy', { kind: 'five_hour', resetsAt: 1, auto: true, reset: true })).toBe('busy');
  });
  it('Done にしたものは quietLive を通すと入力待ちから外れる', () => {
    expect(quietLive(liveWithLimit('idle', { kind: 'weekly', resetsAt: 1, auto: false, reset: true }), 'done')).toBe('idle');
  });
});

describe('isParked と使用制限', () => {
  it('使用制限で止まっている間は、区切りを付けていても止めない', () => {
    const base = { status: 'paused' as const, setBy: 'user' as const, setAt: 10_000, live: 'idle' as const, processStartedAt: 1000 };
    expect(isParked(base)).toBe(true);
    expect(isParked({ ...base, limited: true })).toBe(false);
  });
});

describe('resetAtText と limitKindText', () => {
  const ja = translator('ja');
  it('今日なら時刻だけ、ほかの日なら日付を添える', () => {
    const now = new Date(2026, 9, 12, 14, 0).getTime();
    expect(resetAtText(ja, new Date(2026, 9, 12, 16, 50).getTime(), now)).toBe('16:50');
    expect(resetAtText(ja, new Date(2026, 9, 15, 9, 0).getTime(), now)).toBe('10/15 09:00');
  });
  it('枠の名前', () => {
    expect(limitKindText(ja, 'five_hour')).toBe('5 時間');
    expect(limitKindText(ja, 'weekly')).toBe('週');
    expect(limitKindText(ja, 'other')).toBe('使用制限');
  });
});
