import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { writeBatch } from '../indexer/write.ts';
import { convertMessages } from '../provider/opencode/transcript/convert.ts';
import { buildLiveDigest } from './digest.ts';

// opencode 2.2.0 の task ツール（子の会話を起こす）の形を写した見本。題と本文は置き換えてある。
const OC = 'ses_parent_fixture';
let db: Db;
let sid: string;

const user = (ts: number, text: string) => ({ type: 'user', text, time: { created: ts } });
const task = (id: string, ts: number, description: string, state: Record<string, unknown>) => ({
  type: 'tool', id, name: 'task',
  state: { input: { description, prompt: 'do it', subagent_type: 'general' }, ...state },
  time: { created: ts, completed: ts + 5 },
});
const done = (child: string, report: string) => ({ status: 'completed', content: [{ type: 'text', text: `task_id: ${child} (for resuming to continue this task if needed)\n\n<task_result>\n${report}\n</task_result>` }] });
const assistant = (ts: number, content: unknown[]) => ({ type: 'assistant', model: { id: 'm', providerID: 'p' }, content, time: { created: ts, completed: ts + 9 } });

function load(messages: unknown[]) {
  sid = writeBatch(db, { agent: 'opencode', providerSessionId: OC, agentId: null, cwd: '/w/oc', reset: true, records: convertMessages(messages) }, { deviceId: 'd' }).sessionId;
}

beforeEach(() => { db = openDb(':memory:'); });

describe('opencode の子の会話（task ツール）のレーン', () => {
  beforeEach(() => {
    load([
      user(1000, '前の指示'),
      assistant(1001, [task('call_prev', 1002, '前のターンの担当', done('ses_prev', 'previous'))]),
      user(2000, '並べて調べて'),
      assistant(2001, [
        task('call_ok', 2002, '行列を調べる', done('ses_child_ok', '# 結果\n見つかった')),
        task('call_fail', 2010, '壊れる担当', { status: 'error', error: { type: 'unknown', message: 'Model not found' } }),
        task('call_int', 2020, '止められた担当', { status: 'error', error: { type: 'aborted', message: 'Tool execution interrupted' } }),
        { type: 'tool', id: 'call_run', name: 'task', state: { status: 'running', input: { description: '動いている担当', prompt: 'p', subagent_type: 'general' } }, time: { created: 2030 } },
      ]),
    ]);
  });

  it('今のターンの task だけをレーンにし、状態と終わりの種別を写す', () => {
    const { agents } = buildLiveDigest(db, sid);
    expect(agents.map((a) => [a.title, a.state, a.endNote])).toEqual([
      ['行列を調べる', 'done', null],
      ['壊れる担当', 'error', null],
      ['止められた担当', 'error', 'interrupted'],
      ['動いている担当', 'running', null],
    ]);
  });

  it('agentId は子の会話の id、報告は結果の 1 行目、子の本文は写さないので linked は偽', () => {
    const [ok, fail, , run] = buildLiveDigest(db, sid).agents;
    expect(ok).toMatchObject({ agentId: 'ses_child_ok', report: '結果', linked: false, last: null });
    expect(fail).toMatchObject({ agentId: 'tool:call_fail', report: 'Model not found' });
    expect(run).toMatchObject({ agentId: 'tool:call_run', report: null });
  });

  it('時刻は task を呼んだメッセージの時刻と、結果の時刻', () => {
    const [ok, , , run] = buildLiveDigest(db, sid).agents;
    expect(ok).toMatchObject({ startedAt: 2001, lastAt: 2007 });
    expect(run).toMatchObject({ startedAt: 2001, lastAt: 2001 });
  });
});
