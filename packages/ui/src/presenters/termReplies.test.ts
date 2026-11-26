import { describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '@agent-hangar/shared';
import { finishedReplies, pendingAskTexts } from './termReplies.ts';

const EN1 = 'The build passed on all five jobs, and the branch is ready to merge now.';
const EN2 = 'I changed the width of the sidebar and added a test for the narrow case.';
const JA = '幅を変えて、狭いときの試験を足しました。';

const ev = (kinds: [TranscriptEvent['kind'], string][]): TranscriptEvent[] =>
  kinds.map(([kind, text], seq) => (kind === 'tool_call' ? { kind, seq, toolId: 't', name: 'Bash', input: {}, summary: text } : { kind, seq, text } as TranscriptEvent));

describe('finishedReplies', () => {
  it('英語の返答だけを古い順に返し、日本語は外す', () => {
    const events = ev([['user', 'go'], ['assistant', EN1], ['user', 'next'], ['assistant', JA], ['assistant', EN2]]);
    expect(finishedReplies(events, false)).toEqual([EN1, EN2]);
  });

  it('思考も返す（Claude Code は思考の要約を返答と同じ ● の行で出す）', () => {
    const THINK = 'Session is up and the hangar tools are connected; I will wait for your word.';
    const events = ev([['user', 'go'], ['thinking', THINK], ['assistant', EN1], ['user', 'next'], ['thinking', JA], ['assistant', EN2]]);
    expect(finishedReplies(events, false)).toEqual([THINK, EN1, EN2]);
  });

  it('動いている間は、まだ終わっていないターン（最後の指示の後）の返答を外す', () => {
    const events = ev([['user', 'go'], ['assistant', EN1], ['user', 'next'], ['assistant', EN2], ['tool_call', 'ls']]);
    expect(finishedReplies(events, true)).toEqual([EN1]);
  });

  it('動き出しても、最後の指示の後のターンが終わりの印（turn_duration・turn_aborted）で閉じていれば外さない（送った指示がまだ記録に載っていない間）', () => {
    const end = (subtype: string): TranscriptEvent => ({ kind: 'system', seq: 99, text: subtype, subtype });
    const events = ev([['user', 'go'], ['assistant', EN1], ['user', 'next'], ['assistant', EN2]]);
    expect(finishedReplies([...events, end('turn_duration')], true)).toEqual([EN1, EN2]);
    expect(finishedReplies([...events, end('turn_aborted')], true)).toEqual([EN1, EN2]);
    // 終わりの印でない system の行では閉じない。
    expect(finishedReplies([...events, end('stop_hook_summary')], true)).toEqual([EN1]);
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

describe('pendingAskTexts', () => {
  const ask = (seq: number, toolId: string, questions: unknown): TranscriptEvent => ({ kind: 'tool_call', seq, toolId, name: 'AskUserQuestion', input: { questions }, summary: '' });
  const Q = 'What should I do with this session now that the release is out?';
  const D1 = 'The release is finished and the check stays recorded as unverified.';
  const qs = [{ question: Q, header: 'Session', options: [{ label: 'Done', description: D1 }, { label: 'Paused', description: '明日また見る' }, { label: 'Keep going' }] }];

  it('答えを待っている札の、英語の問いと選択肢の説明を返す。選択肢の名前と日本語は外す', () => {
    expect(pendingAskTexts([{ kind: 'assistant', seq: 0, text: EN1 }, ask(1, 'a1', qs)])).toEqual([Q, D1]);
  });

  it('答えた札（同じ toolId の結果がある）は返さない', () => {
    expect(pendingAskTexts([ask(1, 'a1', qs), { kind: 'tool_result', seq: 2, toolId: 'a1', text: 'Done', isError: false }])).toEqual([]);
  });

  it('動いている間でも、札で答えを待っていれば、そのターンの返答は書き終わっているので返す', () => {
    const events: TranscriptEvent[] = [{ kind: 'user', seq: 0, text: 'go' }, { kind: 'assistant', seq: 1, text: EN1 }, ask(2, 'a1', qs)];
    expect(finishedReplies(events, true)).toEqual([EN1]);
    expect(finishedReplies([...events, { kind: 'tool_result', seq: 3, toolId: 'a1', text: 'Done', isError: false }], true)).toEqual([]);
  });

  it('形の崩れた入力では何も返さない', () => {
    expect(pendingAskTexts([ask(1, 'a1', 'oops')])).toEqual([]);
    expect(pendingAskTexts([ask(1, 'a1', [{ question: 3 }])])).toEqual([]);
  });
});
