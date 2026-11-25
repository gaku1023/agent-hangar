import { describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '@agent-hangar/shared';
import { finishedReplies } from './termReplies.ts';

const EN1 = 'The build passed on all five jobs, and the branch is ready to merge now.';
const EN2 = 'I changed the width of the sidebar and added a test for the narrow case.';
const JA = '幅を変えて、狭いときの試験を足しました。';

const ev = (kinds: [TranscriptEvent['kind'], string][]): TranscriptEvent[] =>
  kinds.map(([kind, text], seq) => (kind === 'tool_call' ? { kind, seq, toolId: 't', name: 'Bash', input: {}, summary: text } : { kind, seq, text } as TranscriptEvent));

describe('finishedReplies', () => {
  it('英語の返答だけを古い順に返し、日本語と思考は外す', () => {
    const events = ev([['user', 'go'], ['thinking', EN1], ['assistant', EN1], ['user', 'next'], ['assistant', JA], ['assistant', EN2]]);
    expect(finishedReplies(events, false)).toEqual([EN1, EN2]);
  });

  it('動いている間は、まだ終わっていないターン（最後の指示の後）の返答を外す', () => {
    const events = ev([['user', 'go'], ['assistant', EN1], ['user', 'next'], ['assistant', EN2], ['tool_call', 'ls']]);
    expect(finishedReplies(events, true)).toEqual([EN1]);
  });

  it('同じ文は 1 つにし、新しい方から数えて上限までにする', () => {
    const many = Array.from({ length: 30 }, (_, n) => `Reply number ${n} explains what changed in the branch and why it matters.`);
    const events = ev([['user', 'go'], ...many.map((m) => ['assistant', m] as [TranscriptEvent['kind'], string]), ['assistant', many[29]!]]);
    const out = finishedReplies(events, false);
    expect(out.length).toBe(12);
    expect(out[out.length - 1]).toBe(many[29]);
    expect(new Set(out).size).toBe(out.length);
  });
});
