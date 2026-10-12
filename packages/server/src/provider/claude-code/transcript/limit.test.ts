import { describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '@agent-hangar/shared';
import { foldLimit, rateLimitOf } from './limit.ts';

// Claude Code が使用制限に当たったときに本文へ書く合成の assistant 行（2.1.291 の実物の形。値は作りもの）。
const hit = (over: Record<string, unknown> = {}) => ({
  type: 'assistant', timestamp: '2026-10-07T07:04:33.314Z', error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429,
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit · resets 5:50pm" }] },
  quotaLimits: { status: 'rejected', resetsAt: 1_791_363_000, rateLimitType: 'five_hour', overageStatus: 'rejected', isUsingOverage: false },
  ...over,
});
const HIT_AT = Date.parse('2026-10-07T07:04:33.314Z');
const sys = (text: string, subtype = 'informational'): TranscriptEvent => ({ kind: 'system', seq: 0, text, subtype });

describe('rateLimitOf', () => {
  it('枠とリセットの時刻（秒をミリ秒に）を読む', () => {
    expect(rateLimitOf(hit())).toEqual({ kind: 'five_hour', resetsAt: 1_791_363_000_000 });
    expect(rateLimitOf(hit({ quotaLimits: { resetsAt: 1_791_363_000, rateLimitType: 'seven_day' } }))).toEqual({ kind: 'weekly', resetsAt: 1_791_363_000_000 });
  });
  it('リセットの時刻を持たない rate_limit（一時の混雑など）と、ほかの行は使用制限ではない', () => {
    expect(rateLimitOf(hit({ quotaLimits: undefined }))).toBeNull();
    expect(rateLimitOf(hit({ error: 'overloaded' }))).toBeNull();
    expect(rateLimitOf({ type: 'user', error: 'rate_limit' })).toBeNull();
    expect(rateLimitOf(null)).toBeNull();
  });
});

describe('foldLimit', () => {
  it('合成の行で使用制限に入る。自動の続きの予約はまだ無い', () => {
    expect(foldLimit(null, hit(), [{ kind: 'assistant', seq: 0, text: 'x' }])).toEqual({ kind: 'five_hour', resetsAt: 1_791_363_000_000, auto: false, hitAt: HIT_AT });
  });
  it('「continuing automatically」の知らせで、自動の続きの予約ありにする', () => {
    const l = foldLimit(null, hit(), []);
    expect(foldLimit(l, {}, [sys('Usage limit reached · continuing automatically at 5:50pm · esc to cancel')])?.auto).toBe(true);
  });
  it('ターンの終わりや裏のタスクの知らせでは抜けない', () => {
    const l = foldLimit(null, hit(), []);
    expect(foldLimit(l, {}, [sys('', 'turn_duration')])).toBe(l);
    expect(foldLimit(l, {}, [sys('<task-notification>…')])).toBe(l);
  });
  it('次の指示、返答、ツールの呼び出しで抜ける', () => {
    const l = foldLimit(null, hit(), []);
    expect(foldLimit(l, {}, [{ kind: 'user', seq: 1, text: '続けて' }])).toBeNull();
    expect(foldLimit(l, {}, [{ kind: 'assistant', seq: 1, text: 'はい' }])).toBeNull();
    expect(foldLimit(l, {}, [{ kind: 'tool_call', seq: 1, toolId: 't', name: 'Bash', input: {}, summary: 'Bash' }])).toBeNull();
  });
  it('Esc で自動の続きを取り消した知らせで、予約なしに戻す（2.1.296 の実物の文）。予約し直せばまた立てる', () => {
    const l = foldLimit(foldLimit(null, hit(), []), {}, [sys('Usage limit reached · continuing automatically at 11:17am · esc to cancel')]);
    expect(l?.auto).toBe(true);
    const cancelled = foldLimit(l, {}, [sys('Automatic continue cancelled · /rate-limit-options to re-arm')]);
    expect(cancelled).toMatchObject({ kind: 'five_hour', auto: false });
    // 背面へ移したときなどの文も同じ頭で始まる。切った知らせは使用制限から抜けない（リセットを待っているのは同じ）。
    expect(foldLimit(l, {}, [sys('Automatic continue cancelled · this session moved to the background, so the task will not resume on its own when the usage limit resets')])?.auto).toBe(false);
    expect(foldLimit(l, {}, [sys('Automatic continue was turned off · this task will not resume on its own')])?.auto).toBe(false);
    expect(foldLimit(cancelled, {}, [sys('Usage limit reached again · continuing automatically at 11:17am · esc to cancel')])?.auto).toBe(true);
  });
  it('使用制限の行より時刻の前の指示は、後から書かれても抜けない（初めの発言ですぐ 429 が返ったとき）', () => {
    const l = foldLimit(null, hit(), []);
    // Claude Code は使用制限の行を先に書き、時刻の早い初めの発言の行を後から書くことがある。
    expect(foldLimit(l, { type: 'user', timestamp: '2026-10-07T07:04:33.100Z' }, [{ kind: 'user', seq: 1, text: 'はじめ' }])).toBe(l);
    // 時刻の後の指示では、今までどおり抜ける。時刻の無い行も抜ける。
    expect(foldLimit(l, { type: 'user', timestamp: '2026-10-07T07:05:00.000Z' }, [{ kind: 'user', seq: 2, text: '続けて' }])).toBeNull();
    expect(foldLimit(l, { type: 'user' }, [{ kind: 'user', seq: 2, text: '続けて' }])).toBeNull();
  });
  it('入っていなければ何もしない', () => {
    expect(foldLimit(null, {}, [{ kind: 'user', seq: 1, text: 'x' }])).toBeNull();
  });
});
