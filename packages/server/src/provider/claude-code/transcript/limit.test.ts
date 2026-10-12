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
  it('入っていなければ何もしない', () => {
    expect(foldLimit(null, {}, [{ kind: 'user', seq: 1, text: 'x' }])).toBeNull();
  });
});
