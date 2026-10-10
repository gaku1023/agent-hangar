import { describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '@agent-hangar/shared';
import { firstQuestion, foldActivity } from './activity.ts';

const call = (toolId: string, name: string, input: unknown, summary = name): TranscriptEvent => ({ kind: 'tool_call', seq: 0, toolId, name, input, summary });
const result = (toolId: string): TranscriptEvent => ({ kind: 'tool_result', seq: 0, toolId, text: 'ok', isError: false });
/** AskUserQuestion の入力の形。問いは questions の配列に入る。 */
const ask = (question: unknown) => ({ questions: [{ question, header: 'h', options: [{ label: 'a', description: 'x' }, { label: 'b', description: 'y' }], multiSelect: false }] });

describe('firstQuestion', () => {
  it('最初の問いの文を取り出し、改行と続く空白を 1 つの空白にまとめる', () => {
    expect(firstQuestion(ask('図 3 の凡例は\n右上に  置きますか？'))).toBe('図 3 の凡例は 右上に 置きますか？');
  });
  it('入力の形が崩れていれば null', () => {
    for (const bad of [null, 'x', 3, {}, { questions: [] }, { questions: 'x' }, { questions: [null] }, { questions: [{ question: 3 }] }, ask('   ')]) {
      expect(firstQuestion(bad), JSON.stringify(bad)).toBeNull();
    }
  });
  it('長すぎる問いは 300 字で切る', () => {
    expect(firstQuestion(ask('あ'.repeat(400)))!.length).toBe(300);
  });
});

describe('foldActivity', () => {
  it('最後のツール呼び出しを残す', () => {
    expect(foldActivity(null, [call('t1', 'Read', {}, 'a.ts'), call('t2', 'Edit', {}, 'b.ts')])).toEqual({ tool: 'Edit', summary: 'b.ts', toolId: 't2', question: null });
  });
  it('呼び出しが無ければ前の値をそのまま返す', () => {
    const prev = { tool: 'Bash', summary: 'ls', toolId: 't0', question: null };
    expect(foldActivity(prev, [{ kind: 'assistant', seq: 0, text: 'hi' }])).toBe(prev);
    expect(foldActivity(null, [])).toBeNull();
  });
  it('AskUserQuestion の問いを持ち、その呼び出しへの答えが来たら問いを消す', () => {
    const asked = foldActivity(null, [call('q1', 'AskUserQuestion', ask('どちらにしますか？'))]);
    expect(asked?.question).toBe('どちらにしますか？');
    expect(foldActivity(asked, [result('other')])?.question).toBe('どちらにしますか？');
    expect(foldActivity(asked, [result('q1')])).toEqual({ tool: 'AskUserQuestion', summary: 'AskUserQuestion', toolId: 'q1', question: null });
  });
  it('AskUserQuestion でない呼び出しと、入力の崩れた AskUserQuestion は問いを持たない', () => {
    expect(foldActivity(null, [call('t1', 'Bash', ask('x'))])?.question).toBeNull();
    expect(foldActivity(null, [call('q1', 'AskUserQuestion', { nope: 1 })])?.question).toBeNull();
  });
});
