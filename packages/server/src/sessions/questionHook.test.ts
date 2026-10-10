import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { ensureSession } from '../indexer/indexFile.ts';
import { foldActivity } from '../provider/claude-code/transcript/activity.ts';
import { applyQuestionHook } from './questionHook.ts';

/**
 * hook から届いた AskUserQuestion の出入りを、索引と同じ表（session_activity）へ書く。
 * 索引は後から同じ行を前の値として畳むので、ここで書いた問いは、その呼び出しへの答えが本文に載るまで残る。
 */
let db: Db;
let sid: string;
const row = () => db.prepare('select tool, summary, tool_id, question from session_activity where session_id = ?').get(sid) as Record<string, unknown> | undefined;
const asked = (toolId = 't1', question: string | null = '色は？') => ({ kind: 'asked' as const, providerSessionId: 'u1', toolId, summary: 'AskUserQuestion', question });

beforeEach(() => {
  db = openDb(':memory:');
  sid = ensureSession(db, 'u1', '/w', 'd');
});
afterEach(() => db.close());

describe('applyQuestionHook', () => {
  it('問いを出す前の知らせで、問いの文を書く', () => {
    expect(applyQuestionHook(db, sid, asked(), 1)).toBe(true);
    expect(row()).toEqual({ tool: 'AskUserQuestion', summary: 'AskUserQuestion', tool_id: 't1', question: '色は？' });
  });

  it('答えた後の知らせで、同じ呼び出しの問いだけを消す', () => {
    applyQuestionHook(db, sid, asked('t1'), 1);
    expect(applyQuestionHook(db, sid, { kind: 'answered', providerSessionId: 'u1', toolId: 't0' }, 2)).toBe(false);
    expect(row()?.question).toBe('色は？');
    expect(applyQuestionHook(db, sid, { kind: 'answered', providerSessionId: 'u1', toolId: 't1' }, 3)).toBe(true);
    expect(row()?.question).toBeNull();
  });

  it('URL のセッションと、hook の会話が食い違えば書かない', () => {
    expect(applyQuestionHook(db, sid, { ...asked(), providerSessionId: 'u2' }, 1)).toBe(false);
    expect(row()).toBeUndefined();
    expect(applyQuestionHook(db, 'missing', asked(), 1)).toBe(false);
  });

  it('索引が後から同じ呼び出しを畳んでも問いは残り、その答えで消える', () => {
    applyQuestionHook(db, sid, asked('t1'), 1);
    const r = row()!;
    const prev = { tool: r.tool as string, summary: r.summary as string, toolId: r.tool_id as string, question: r.question as string | null };
    const call = { kind: 'tool_call' as const, seq: 0, toolId: 't1', name: 'AskUserQuestion', summary: 'AskUserQuestion', input: { questions: [{ question: '色は？' }] } };
    expect(foldActivity(prev, [call])?.question).toBe('色は？');
    expect(foldActivity(prev, [call, { kind: 'tool_result', seq: 1, toolId: 't1', text: '赤', isError: false }])?.question).toBeNull();
  });
});
