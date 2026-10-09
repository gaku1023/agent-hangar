import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { IndexerService } from '../indexer/service.ts';
import { callTool, type ToolDeps } from '../mcp/tools.ts';
import { MemoStore } from '../projects/memo.ts';
import { resolveProject } from '../projects/registry.ts';
import { addTodo, confirmTodo, proposeTodoDone, rejectTodo } from '../projects/todos.ts';
import { SummaryJob } from '../summary/job.ts';
import type { Summarizer } from '../summary/types.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { Publisher } from './publisher.ts';

/**
 * 本物の書き手（TODO、置き場の選び直し、MCP の道具、事後要約のジョブ）と配る層をつなぎ、
 * 「書いたら、その行のイベントが 1 回、最新の中身で届く」を書き手ごとに押さえる。
 * サーバは起こさない。経路（HTTP）は書き手を呼ぶだけなので、ここで押さえれば足りる。
 */

const ME = 'dev-me';

let db: Db;
let tmp: string;
let publisher: Publisher;
const sent: ServerEvent[] = [];
const of = <T extends ServerEvent['type']>(type: T) => sent.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type);
/** 準備で溜まった分を出し切って捨て、ここから数え始める。 */
const reset = () => { publisher.flush(); sent.length = 0; };

beforeEach(() => {
  db = openDb(':memory:');
  // 実在するパスにする。パスの比べ方（正規化）を OS に任せるためである。
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-writers-')));
  sent.length = 0;
  publisher = new Publisher({ db, deviceId: ME, live: () => [], hub: { broadcast: (ev) => { sent.push(ev); } } });
});
afterEach(() => { publisher.stop(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function seedProject(id: string, dir: string, scratch = false): void {
  upsertShared(db, 'projects', { id, name: id, status: 'active', is_scratch: scratch ? 1 : 0 }, ME);
  upsertShared(db, 'project_roots', { id: `root-${id}`, project_id: id, device_id: ME, path: dir, resolved: 1 }, ME);
}
function seedSession(id: string, projectId: string | null, cwd: string, homeDevice = ME): void {
  upsertShared(db, 'sessions', { id, provider: 'claude-code', provider_session_id: `uuid-${id}`, project_id: projectId, cwd, home_device: homeDevice }, ME);
}

describe('TODO の候補', () => {
  beforeEach(() => { seedProject('p1', path.join(tmp, 'p1')); });

  it('確定すると、完了になった一覧と、未完の数が減ったプロジェクトが 1 回ずつ届く', () => {
    const t = addTodo(db, ME, { projectId: 'p1', text: 'やる' });
    proposeTodoDone(db, ME, t.id, { sessionId: null, note: '済んだ' });
    reset();
    expect(confirmTodo(db, ME, t.id)?.result).toBe('confirmed');
    publisher.flush();
    expect(sent).toEqual([
      { type: 'todos.update', projectId: 'p1', todos: [expect.objectContaining({ id: t.id, done: true, candidate: null })] },
      { type: 'project.upsert', project: expect.objectContaining({ id: 'p1', openTodoCount: 0 }) },
    ]);
  });

  it('却下すると、候補の外れた一覧と、未完のままのプロジェクトが 1 回ずつ届く', () => {
    const t = addTodo(db, ME, { projectId: 'p1', text: 'やる' });
    proposeTodoDone(db, ME, t.id, { sessionId: null, note: '済んだ' });
    reset();
    expect(rejectTodo(db, ME, t.id)?.result).toBe('rejected');
    publisher.flush();
    expect(sent).toEqual([
      { type: 'todos.update', projectId: 'p1', todos: [expect.objectContaining({ id: t.id, done: false, candidate: null })] },
      { type: 'project.upsert', project: expect.objectContaining({ id: 'p1', openTodoCount: 1 }) },
    ]);
  });

  it('候補でない TODO の確定と却下は、書かないので何も届かない', () => {
    const t = addTodo(db, ME, { projectId: 'p1', text: 'やる' });
    reset();
    expect(confirmTodo(db, ME, t.id)?.result).toBe('not_candidate');
    expect(rejectTodo(db, ME, t.id)?.result).toBe('not_candidate');
    publisher.flush();
    expect(sent).toEqual([]);
  });
});

describe('置き場の選び直し', () => {
  // SessionDto の fromScratch は、クイックセッション用のプロジェクトの置き場（project_roots）から決まる。
  // その置き場を選び直すと、セッションの行は変わらないのに fromScratch が変わる。
  it('クイックセッション用のプロジェクトの置き場を選び直すと、fromScratch が変わるセッションが最新の中身で 1 回ずつ届く', () => {
    const oldRoot = path.join(tmp, 'scratch-old');
    const newRoot = path.join(tmp, 'scratch-new');
    seedProject('scratch', oldRoot, true);
    seedProject('p1', path.join(tmp, 'p1'));
    // 昇格済み（ふつうのプロジェクトに属する）で、作業の場所だけがクイックセッションの置き場の下に残っているセッション。
    seedSession('was', 'p1', path.join(oldRoot, 'a'));
    seedSession('becomes', 'p1', path.join(newRoot, 'b'));
    // 置き場に関わらないセッションと、他の端末のセッションは配らない。
    seedSession('unrelated', 'p1', path.join(tmp, 'p1'));
    seedSession('remote', 'p1', path.join(newRoot, 'c'), 'dev-other');
    reset();
    resolveProject(db, ME, 'scratch', { kind: 'repoint', path: newRoot });
    publisher.flush();
    const got = of('session.upsert').map((e) => [e.session.id, e.session.fromScratch]).sort();
    expect(got).toEqual([['becomes', true], ['was', false]]);
    expect(of('project.upsert').map((e) => e.project.id)).toEqual(['scratch']);
  });

  it('ふつうのプロジェクトの置き場を選び直しても、紐づけの変わらないセッションは配らない', () => {
    seedProject('scratch', path.join(tmp, 'scratch'), true);
    seedProject('p1', path.join(tmp, 'p1'));
    seedSession('s1', 'p1', path.join(tmp, 'p1'));
    reset();
    resolveProject(db, ME, 'p1', { kind: 'repoint', path: path.join(tmp, 'p1-moved') });
    publisher.flush();
    expect(of('session.upsert')).toEqual([]);
    expect(of('project.upsert').map((e) => e.project.id)).toEqual(['p1']);
  });
});

describe('MCP の道具', () => {
  let deps: ToolDeps;
  const call = (name: string, args: Record<string, unknown>) => { try { return callTool(deps, { sessionId: 's1' }, name, args) as Record<string, unknown>; } finally { publisher.flush(); } };
  beforeEach(() => {
    seedProject('p1', path.join(tmp, 'p1'));
    seedSession('s1', 'p1', path.join(tmp, 'p1'));
    deps = { db, deviceId: ME, port: 4177, live: () => [], runs: { start: () => { throw new Error('not in this test'); } },
      usage: () => ({ fiveHour: null, sevenDay: null, updatedAt: null }), memos: new MemoStore({ db, deviceId: ME, home: tmp }) };
    reset();
  });

  it('set_session_summary は、要約の載った session.upsert が 1 回だけ届く', () => {
    call('set_session_summary', { title: 'T', one_liner: 'O', body: 'B', state: 'blocked', next_steps: ['n1'] });
    expect(sent).toEqual([{ type: 'session.upsert', session: expect.objectContaining({ id: 's1', summary: expect.objectContaining({ title: 'T', state: 'blocked', source: 'in_session', nextSteps: ['n1'] }) }) }]);
  });

  it('propose_session_status は、提案でも確定でも、状態の載った session.upsert が 1 回だけ届く', () => {
    expect(call('propose_session_status', { status: 'done', note: '終わった' }).outcome).toBe('proposed');
    expect(sent).toEqual([{ type: 'session.upsert', session: expect.objectContaining({ id: 's1', state: expect.objectContaining({ status: null, candidate: expect.objectContaining({ status: 'done', note: '終わった' }) }) }) }]);
    sent.length = 0;
    expect(call('propose_session_status', { status: 'done', note: '選んだ', confirmed: true }).outcome).toBe('set');
    expect(sent).toEqual([{ type: 'session.upsert', session: expect.objectContaining({ id: 's1', state: expect.objectContaining({ status: 'done', note: '選んだ', candidate: null }) }) }]);
    // 同じ状態をもう一度選んでも、書かないので届かない。
    sent.length = 0;
    expect(call('propose_session_status', { status: 'done', note: '選んだ', confirmed: true }).outcome).toBe('already_set');
    expect(sent).toEqual([]);
  });
});

describe('事後要約のジョブ', () => {
  let claudeDir: string;
  afterEach(() => { fs.rmSync(claudeDir, { recursive: true, force: true }); });

  it('要約と状態の提案を書いても、session.upsert は両方の載った 1 回で、summary.updated の前に届く', async () => {
    claudeDir = copyFixtureClaudeDir();
    await new IndexerService({ db, deviceId: ME, claudeDir, isRunning: () => false }).fullScan();
    const id = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
    const summarizer: Summarizer = {
      id: 'lmstudio',
      available: async () => true,
      summarize: async () => ({ title: 'T', oneLiner: 'O', body: 'B', state: 'done', nextSteps: [], proposal: { status: 'done', note: '片付いた', returnInDays: null } }),
    };
    const job = new SummaryJob({ db, deviceId: ME, summarizers: () => [summarizer], live: () => [], hub: publisher, language: () => 'ja' });
    reset();
    expect(job.enqueue(id, { force: true })).toBe(true);
    await job.idle();
    publisher.flush();
    expect(sent.map((e) => e.type)).toEqual(['summary.pending', 'session.upsert', 'summary.updated']);
    expect(of('session.upsert')[0]!.session).toMatchObject({ id, summary: { title: 'T', source: 'post_hoc', sourceId: 'lmstudio' }, state: { status: null, candidate: { status: 'done', note: '片付いた' } } });
  });
});
