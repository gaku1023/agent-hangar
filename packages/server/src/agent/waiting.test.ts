import type { TranscriptEvent } from '@agent-hangar/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { writeBatch } from '../indexer/write.ts';
import type { IndexRecord } from './types.ts';
import { pendingQuestionOf } from './waiting.ts';

/** 画面の札が読めないときの、hook と本文に残った問い（統括の list_pending_asks が使う）。 */

const ASK_INPUT = {
  questions: [
    { question: 'このセッションをどうしますか', header: 'セッション', multiSelect: false, options: [{ label: 'Done にする', description: '済んだ' }, { label: 'まだ続ける', description: '続ける' }] },
    { question: '2 問目', header: '次', multiSelect: false, options: [{ label: 'A' }] },
  ],
};

let db: Db;
let id: string;
const rec = (events: TranscriptEvent[]): IndexRecord => ({ events, facts: { isUserTurn: false }, locator: { kind: 'stored' } });
const setActivity = (question: string | null, toolId = 't1', tool = 'AskUserQuestion') =>
  db.prepare('insert or replace into session_activity (session_id, tool, summary, tool_id, question, updated_at) values (?,?,?,?,?,1)').run(id, tool, '', toolId, question);

beforeEach(() => {
  db = openDb(':memory:');
  id = writeBatch(db, { agent: 'opencode', providerSessionId: 'p1', agentId: null, cwd: '/w', reset: true, records: [rec([
    { kind: 'assistant', seq: 0, ts: 1, text: 'はじめ' },
    { kind: 'tool_call', seq: 1, ts: 2, toolId: 't1', name: 'AskUserQuestion', input: ASK_INPUT, summary: '' },
  ])] }, { deviceId: 'd' }).sessionId;
});

describe('pendingQuestionOf', () => {
  it('問いの文と、その呼び出しの最初の問いの選択肢を返す', () => {
    setActivity('このセッションをどうしますか');
    expect(pendingQuestionOf(db, id)).toEqual({ text: 'このセッションをどうしますか', options: ['Done にする', 'まだ続ける'] });
  });
  it('呼び出しが本文にまだ無ければ、文だけ返して選択肢は空', () => {
    setActivity('このセッションをどうしますか', 't-missing');
    expect(pendingQuestionOf(db, id)).toEqual({ text: 'このセッションをどうしますか', options: [] });
  });
  it('問いが無い（答えた後、ほかの道具）なら null', () => {
    expect(pendingQuestionOf(db, id)).toBeNull();
    setActivity(null);
    expect(pendingQuestionOf(db, id)).toBeNull();
    setActivity('x', 't1', 'Bash');
    expect(pendingQuestionOf(db, id)).toBeNull();
  });
});
