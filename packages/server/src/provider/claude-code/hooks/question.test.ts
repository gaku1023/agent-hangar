import { describe, expect, it } from 'vitest';
import { readQuestionHook } from './question.ts';

// Claude Code の hook が標準入力に渡す形（2.1.296 で実物を見た）。
const input = { questions: [{ question: '  どちらの色にしますか？\n赤と青です  ', header: '色', options: [{ label: '赤', description: '' }, { label: '青', description: '' }], multiSelect: false }] };
const pre = { session_id: 'u1', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: input, tool_use_id: 'toolu_1' };

describe('readQuestionHook', () => {
  it('PreToolUse の AskUserQuestion から、問いの文と呼び出しの id を取る', () => {
    expect(readQuestionHook(pre)).toEqual({ kind: 'asked', providerSessionId: 'u1', toolId: 'toolu_1', summary: 'AskUserQuestion', question: 'どちらの色にしますか？ 赤と青です' });
  });

  it('PostToolUse と PostToolUseFailure は、答えが済んだ知らせとして読む', () => {
    expect(readQuestionHook({ ...pre, hook_event_name: 'PostToolUse', tool_response: {} })).toEqual({ kind: 'answered', providerSessionId: 'u1', toolId: 'toolu_1' });
    expect(readQuestionHook({ ...pre, hook_event_name: 'PostToolUseFailure' })).toEqual({ kind: 'answered', providerSessionId: 'u1', toolId: 'toolu_1' });
  });

  it('問いの形が崩れていても、呼び出しは残す（問いは null）', () => {
    expect(readQuestionHook({ ...pre, tool_input: { questions: [] } })).toMatchObject({ kind: 'asked', question: null });
  });

  it('ほかの道具、ほかの出来事、サブエージェントの呼び出し、欠けた値は読まない', () => {
    expect(readQuestionHook({ ...pre, tool_name: 'Bash' })).toBeNull();
    expect(readQuestionHook({ ...pre, hook_event_name: 'Notification' })).toBeNull();
    expect(readQuestionHook({ ...pre, agent_id: 'a1' })).toBeNull();
    expect(readQuestionHook({ ...pre, session_id: undefined })).toBeNull();
    expect(readQuestionHook({ ...pre, tool_use_id: '' })).toBeNull();
    expect(readQuestionHook(null)).toBeNull();
    expect(readQuestionHook('x')).toBeNull();
  });
});
