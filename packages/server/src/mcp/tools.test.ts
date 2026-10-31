import { RunError } from '../runs/errors.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchParams, LiveSessionDto, ServerEvent } from '@agent-hangar/shared';
import { recordArtifactPublish } from '../artifacts/extract.ts';
import { openDb, type Db } from '../db/open.ts';
import { Publisher } from '../events/publisher.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';
import { IndexerService } from '../indexer/service.ts';
import { claudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import { latestIntent } from '../live/intents.ts';
import { markSeen, onUnread } from '../live/unread.ts';
import { getSession } from '../db/queries.ts';
import { addTodo } from '../projects/todos.ts';
import { assignSessions } from '../projects/registry.ts';
import { rejectSessionState } from '../sessions/states.ts';
import { noteWake } from '../sessions/wake.ts';
import { AccountStore } from '../config/accounts.ts';
import { msg } from '../i18n/message.ts';
import { DeleteError } from '../sessions/trash.ts';
import { UsageTracker } from '../usage/statusline.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA, SESSION_OTHER } from '../../test/fixtures.ts';
import { callTool, ToolError, TOOL_NAMES, type ToolDeps } from './tools.ts';

let dir: string;
let home: string;
let db: Db;
let alphaId: string;
const sent: ServerEvent[] = [];
const live: LiveSessionDto[] = [{ sessionId: SESSION_ALPHA, status: 'busy', name: null, nameSource: null, cwd: '/Users/me/workspace/alpha', pid: 1 }];
const started: LaunchParams[] = [];
let deps: ToolDeps;
/** 道具は行を書くだけである。画面へのイベントは、配る層が書いた行から組んで sent へ渡す。 */
let publisher: Publisher;

beforeEach(async () => {
  dir = copyFixtureClaudeDir(); home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mcp-')); db = openDb(':memory:'); sent.length = 0; started.length = 0;
  await new IndexerService({ db, deviceId: 'd', transcript: claudeTranscriptSource({ claudeDir: dir }), isRunning: () => false }).fullScan();
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: 'd', path: '/Users/me/workspace/alpha', resolved: 1 }, 'd');
  assignSessions(db, 'd');
  alphaId = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
  publisher = new Publisher({ db, deviceId: 'd', live: () => live, hub: { broadcast: (e) => { sent.push(e); } } });
  deps = { db, deviceId: 'd', port: 4177, live: () => live,
    runs: { start: (p) => { started.push(p); return { run: { id: 'r1', sessionId: 'sNew', deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 }, sessionId: 'sNew', tabs: [] }; } },
    usage: () => ({ fiveHour: { usedPercent: 47, resetsAt: 1_760_000_000_000 }, sevenDay: null, updatedAt: 5 }) };
});
afterEach(() => { publisher.stop(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

/** 道具を呼ぶ。イベントは tick の終わりに出るので、呼んだ後にその場で配らせてから返す（失敗したときも同じ）。 */
const call = (name: string, args: Record<string, unknown> = {}, ctx = { sessionId: null as string | null }) => {
  try {
    return callTool(deps, ctx, name, args) as Record<string, unknown>;
  } finally {
    publisher.flush();
  }
};

/**
 * 利用者が足した確定の TODO の ID。MCP の add_todos で足したものは提案になり、完了の候補にできないので、候補の試験はこれで足す。
 * 書いたイベントは、ここで配り終えておく。
 */
const userTodos = (...texts: string[]): string[] => {
  const ids = texts.map((text) => addTodo(db, 'd', { projectId: 'p1', text }).id);
  publisher.flush();
  return ids;
};

/** session_id を取るツールと、それ以外の必須引数。存在の検査をまとめて確かめる。 */
const SESSION_TOOL_CALLS: [string, Record<string, unknown>][] = [
  ['get_transcript', {}],
  ['set_session_summary', { title: 'T', one_liner: 'O', body: 'B', state: 'done', next_steps: [] }],
  ['set_turn_intent', { text: '意図' }],
  ['notify_user', { text: '結果が出ました' }],
  ['open_in_hangar', {}],
  ['propose_session_status', { status: 'done', note: '済んだ' }],
];

describe('MCP tools', () => {
  it('list_projects と get_project', () => {
    const list = call('list_projects') as unknown as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'p1', name: 'alpha', status: 'active', path: '/Users/me/workspace/alpha', open_todo_count: 0 });
    const p = call('get_project', { project_id: 'p1' });
    expect(p).toMatchObject({ id: 'p1', todos: [], artifacts: [] });
    // プロジェクトのノートはやめたので返さない。
    expect(p).not.toHaveProperty('memo');
    expect((p.recent_sessions as { id: string }[]).map((s) => s.id)).toEqual([alphaId]);
    expect(() => call('get_project', { project_id: 'nope' })).toThrow(ToolError);
    call('update_project', { project_id: 'p1', add_todos: ['a'] });
    recordArtifactPublish(db, 'd', { sessionId: alphaId, projectId: 'p1', url: 'https://claude.ai/code/artifact/z', publishedAt: 7, call: { filePath: null, description: 'Z', icon: 'flask' } });
    const p2 = call('get_project', { project_id: 'p1' });
    expect((p2.todos as unknown[]).length).toBe(1);
    expect(p2.artifacts).toEqual([{ id: expect.any(String), url: 'https://claude.ai/code/artifact/z', title: 'Z', icon: 'flask', last_published_at: 7, version_count: 1 }]);
  });
  it('update_project は status と TODO を書き、イベントを配る', () => {
    const r = call('update_project', { project_id: 'p1', status: 'paused', add_todos: ['x', 'y'] }, { sessionId: alphaId });
    expect((r.project as { status: string }).status).toBe('paused');
    // MCP から足した TODO は、利用者が受け入れるまで提案として置かれ、未完の数に入らない。
    expect((r.todos as { text: string; done: boolean; session_id: string | null; suggestion: unknown }[]).map((t) => [t.text, t.done, t.session_id, t.suggestion])).toEqual([['x', false, alphaId, { note: null }], ['y', false, alphaId, { note: null }]]);
    // 状態と TODO を 1 回の呼び出しで変えても、プロジェクトは最後の中身で 1 回だけ届く。
    expect(sent.map((e) => e.type)).toEqual(['todos.update', 'project.upsert']);
    expect(sent[0]).toMatchObject({ type: 'todos.update', projectId: 'p1', todos: [{ text: 'x', suggestion: { note: null } }, { text: 'y' }] });
    expect(sent[1]).toMatchObject({ type: 'project.upsert', project: { id: 'p1', status: 'paused', openTodoCount: 0 } });
    const [u] = userTodos('u');
    const r2 = call('update_project', { project_id: 'p1', toggle_todos: [u!] });
    // toggle_todos は未完を完了にしない。候補にするだけで、未完の数も変わらない。
    expect((r2.todos as { id: string; done: boolean; candidate: unknown }[]).find((t) => t.id === u)).toMatchObject({ done: false, candidate: { session_id: null, note: null } });
    expect(r2.todo_results).toEqual([{ todo_id: u, outcome: 'proposed' }]);
    expect((r2.project as { open_todo_count: number }).open_todo_count).toBe(1);
    expect(() => call('update_project', { project_id: 'p1', status: 'bogus' })).toThrow(ToolError);
    expect(() => call('update_project', { project_id: 'p1', toggle_todos: ['nope'] })).toThrow(/nope/);
  });
  it('propose_done は根拠つきの候補を出し、TODO ごとの結果を返す', () => {
    const [a, b, c] = userTodos('a', 'b', 'c');
    call('update_project', { project_id: 'p1', toggle_todos: [c!] });
    // c は候補になった。完了にするには利用者の操作が要るので、ここでは DB を直接完了にして already_done を作る。
    db.prepare('update todos set done = 1, candidate_at = null where id = ?').run(c);
    sent.length = 0;
    const r2 = call('update_project', { project_id: 'p1', propose_done: [{ todo_id: a, note: ' 直して試験で確かめた ' }, { todo_id: c, note: '済み' }] }, { sessionId: alphaId });
    expect(r2.todo_results).toEqual([{ todo_id: a, outcome: 'proposed' }, { todo_id: c, outcome: 'already_done' }]);
    const briefs = r2.todos as { id: string; done: boolean; candidate: unknown }[];
    expect(briefs.find((t) => t.id === a)).toMatchObject({ done: false, candidate: { session_id: alphaId, note: '直して試験で確かめた' } });
    expect(briefs.find((t) => t.id === b)).toMatchObject({ done: false, candidate: null });
    expect(sent.map((e) => e.type)).toEqual(['todos.update', 'project.upsert']);
    // 2 回目は根拠を書き換えない。
    const r3 = call('update_project', { project_id: 'p1', propose_done: [{ todo_id: a, note: '書き換え' }] }, { sessionId: alphaId });
    expect(r3.todo_results).toEqual([{ todo_id: a, outcome: 'already_candidate' }]);
    expect((r3.todos as { id: string; candidate: { note: string } | null }[]).find((t) => t.id === a)!.candidate!.note).toBe('直して試験で確かめた');
  });
  it('却下されたセッションは同じ TODO の候補を出し直せない（propose_done でも toggle_todos でも）', async () => {
    const { rejectTodo } = await import('../projects/todos.ts');
    const [a] = userTodos('a') as [string];
    call('update_project', { project_id: 'p1', propose_done: [{ todo_id: a, note: 'n' }] }, { sessionId: alphaId });
    rejectTodo(db, 'd', a);
    expect(call('update_project', { project_id: 'p1', propose_done: [{ todo_id: a, note: 'もう一度' }] }, { sessionId: alphaId }).todo_results).toEqual([{ todo_id: a, outcome: 'rejected_before' }]);
    expect(call('update_project', { project_id: 'p1', toggle_todos: [a] }, { sessionId: alphaId }).todo_results).toEqual([{ todo_id: a, outcome: 'rejected_before' }]);
  });
  it('toggle_todos は完了を開き直し、候補には何もしない', async () => {
    const { setTodoDone } = await import('../projects/todos.ts');
    const [a, b] = userTodos('a', 'b');
    setTodoDone(db, 'd', a!, true);
    call('update_project', { project_id: 'p1', toggle_todos: [b!] });
    const r2 = call('update_project', { project_id: 'p1', toggle_todos: [a!, b!] });
    expect(r2.todo_results).toEqual([{ todo_id: a, outcome: 'reopened' }, { todo_id: b, outcome: 'already_candidate' }]);
    expect((r2.todos as { done: boolean }[]).map((t) => t.done)).toEqual([false, false]);
  });
  it('propose_done の検証に落ちる呼び出しは、status も書かず何も配らない', () => {
    const [a] = userTodos('a') as [string];
    sent.length = 0;
    expect(() => call('update_project', { project_id: 'p1', status: 'paused', propose_done: [{ todo_id: a, note: '' }] })).toThrow(ToolError);
    expect((db.prepare('select status from projects where id = ?').get('p1') as { status: string }).status).toBe('active');
    expect(sent).toEqual([]);
  });
  it('同じ TODO が propose_done と toggle_todos の両方にあれば、根拠つきの提案が勝つ', () => {
    const [a] = userTodos('a') as [string];
    const r2 = call('update_project', { project_id: 'p1', toggle_todos: [a], propose_done: [{ todo_id: a, note: '試験で確かめた' }] }, { sessionId: alphaId });
    expect(r2.todo_results).toEqual([{ todo_id: a, outcome: 'proposed' }, { todo_id: a, outcome: 'already_candidate' }]);
    expect((r2.todos as { id: string; candidate: { note: string } | null }[]).find((t) => t.id === a)!.candidate!.note).toBe('試験で確かめた');
  });
  it('propose_done の根拠が空白だけか 200 字を超えるか、見つからない ID があれば、どの TODO も書かない', () => {
    const [a] = userTodos('a') as [string];
    sent.length = 0;
    expect(() => call('update_project', { project_id: 'p1', propose_done: [{ todo_id: a, note: '   ' }] })).toThrow(ToolError);
    expect(() => call('update_project', { project_id: 'p1', propose_done: [{ todo_id: a, note: 'あ'.repeat(201) }] })).toThrow(/200/);
    expect(() => call('update_project', { project_id: 'p1', add_todos: ['b'], propose_done: [{ todo_id: a, note: 'n' }, { todo_id: 'nope', note: 'n' }] })).toThrow(/nope/);
    expect(() => call('update_project', { project_id: 'p1', propose_done: [{ note: 'n' }] })).toThrow(ToolError);
    expect(sent).toEqual([]);
    const p = call('get_project', { project_id: 'p1' });
    expect((p.todos as { text: string; candidate: unknown }[]).map((t) => [t.text, t.candidate])).toEqual([['a', null]]);
    // ちょうど 200 字は通る。
    expect(call('update_project', { project_id: 'p1', propose_done: [{ todo_id: a, note: 'あ'.repeat(200) }] }).todo_results).toEqual([{ todo_id: a, outcome: 'proposed' }]);
  });
  it('update_project の TODO の書き込みは全部成功か全部失敗', () => {
    const [id] = userTodos('x') as [string];
    sent.length = 0;
    expect(() => call('update_project', { project_id: 'p1', add_todos: ['y'], toggle_todos: [id, 'nope'] })).toThrow(/nope/);
    // 途中まで書いた分を残さない。イベントを配らずに DB だけ進むと、UI と食い違ったまま気付けない。
    expect(sent).toEqual([]);
    const p = call('get_project', { project_id: 'p1' });
    expect((p.todos as { text: string; done: boolean; candidate: unknown }[]).map((t) => [t.text, t.done, t.candidate])).toEqual([['x', false, null]]);
    expect(p.open_todo_count).toBe(1);
  });
  it('add_todos は文字列と { text, note } を受け、どれも提案として置く。理由の空白は null にする', () => {
    const r = call('update_project', { project_id: 'p1', add_todos: ['a', { text: 'b', note: ' 試験が無い ' }, { text: 'c', note: '  ' }, { text: 'd' }] }, { sessionId: alphaId });
    expect((r.todos as { text: string; session_id: string | null; suggestion: unknown; candidate: unknown }[]).map((t) => [t.text, t.session_id, t.suggestion, t.candidate])).toEqual([
      ['a', alphaId, { note: null }, null],
      ['b', alphaId, { note: '試験が無い' }, null],
      ['c', alphaId, { note: null }, null],
      ['d', alphaId, { note: null }, null],
    ]);
    expect((r.project as { open_todo_count: number }).open_todo_count).toBe(0);
    // 画面の DTO にも、時刻つきの提案として載る。
    expect(sent[0]).toMatchObject({ type: 'todos.update', todos: [{ text: 'a', suggestion: { note: null, at: expect.any(Number) } }, {}, {}, {}] });
  });
  it('add_todos の項目が崩れているか、理由が 200 字を超えれば、status も TODO も書かない', () => {
    sent.length = 0;
    expect(() => call('update_project', { project_id: 'p1', status: 'paused', add_todos: ['a', { note: 'n' }] })).toThrow(ToolError);
    expect(() => call('update_project', { project_id: 'p1', status: 'paused', add_todos: ['a', 3] })).toThrow(ToolError);
    expect(() => call('update_project', { project_id: 'p1', status: 'paused', add_todos: [{ text: 'a', note: 3 }] })).toThrow(ToolError);
    expect(() => call('update_project', { project_id: 'p1', status: 'paused', add_todos: 'a' })).toThrow(ToolError);
    expect(() => call('update_project', { project_id: 'p1', status: 'paused', add_todos: [{ text: 'a', note: 'あ'.repeat(201) }] })).toThrow(/200/);
    expect(sent).toEqual([]);
    expect((db.prepare('select status from projects where id = ?').get('p1') as { status: string }).status).toBe('active');
    expect(call('get_project', { project_id: 'p1' }).todos).toEqual([]);
    // ちょうど 200 字は通る。
    expect((call('update_project', { project_id: 'p1', add_todos: [{ text: 'a', note: 'あ'.repeat(200) }] }).todos as unknown[]).length).toBe(1);
  });
  it('提案の TODO には、propose_done も toggle_todos も not_accepted を返し、何も書かない', () => {
    const r = call('update_project', { project_id: 'p1', add_todos: ['a'] });
    const a = (r.todos as { id: string }[])[0]!.id;
    sent.length = 0;
    const r2 = call('update_project', { project_id: 'p1', propose_done: [{ todo_id: a, note: '済んだ' }], toggle_todos: [a] }, { sessionId: alphaId });
    expect(r2.todo_results).toEqual([{ todo_id: a, outcome: 'not_accepted' }, { todo_id: a, outcome: 'not_accepted' }]);
    expect((r2.todos as { candidate: unknown; suggestion: unknown }[])[0]).toMatchObject({ candidate: null, suggestion: { note: null } });
    expect(sent).toEqual([]);
  });
  it('update_project は文字列でない status を黙って無視しない', () => {
    expect(() => call('update_project', { project_id: 'p1', status: 12345 })).toThrow(ToolError);
    expect(() => call('update_project', { project_id: 'p1', status: null })).toThrow(ToolError);
    expect((db.prepare('select status from projects where id = ?').get('p1') as { status: string }).status).toBe('active');
  });
  it('list_sessions は running と limit で絞る', () => {
    expect((call('list_sessions') as unknown as unknown[]).length).toBe(3);
    const running = call('list_sessions', { running: true }) as unknown as { id: string; live: string }[];
    expect(running).toEqual([expect.objectContaining({ id: alphaId, live: 'busy' })]);
    expect((call('list_sessions', { running: false, limit: 1 }) as unknown as unknown[]).length).toBe(1);
    expect((call('list_sessions', { project_id: 'p1' }) as unknown as unknown[]).length).toBe(1);
    // セッションのノートは外した。要点に memo の項目は無い。
    for (const s of call('list_sessions') as unknown as Record<string, unknown>[]) expect(s).not.toHaveProperty('memo');
  });
  it('list_sessions は負数の limit を 0 件として扱う', () => {
    expect((call('list_sessions', { limit: -1 }) as unknown as unknown[]).length).toBe(0);
    expect((call('list_sessions', { limit: 0 }) as unknown as unknown[]).length).toBe(0);
  });
  it('search_sessions は抜粋と再開コマンドを返す', () => {
    const r = call('search_sessions', { query: 'チャンネル' });
    expect(r.total).toBe(1);
    const hit = (r.hits as Record<string, unknown>[])[0]!;
    expect(hit).toMatchObject({ session_id: alphaId, title: '動画チャンネルの整理', resume_command: `claude -r ${SESSION_ALPHA}` });
    expect((hit.snippets as unknown[]).length).toBeGreaterThan(0);
  });
  it('list_sessions と search_sessions は、会話を最後に動かした PC を添え、この PC かどうかを言う', () => {
    upsertShared(db, 'devices', { id: 'd', name: 'this-mac', platform: 'darwin', last_seen_at: 1 }, 'd');
    upsertShared(db, 'devices', { id: 'win', name: 'work-pc', platform: 'win32', last_seen_at: 1 }, 'win');
    const brief = () => (call('list_sessions') as unknown as { id: string; device: unknown }[]).find((s) => s.id === alphaId)!;
    expect(brief().device).toEqual({ name: 'this-mac', platform: 'darwin', here: true });
    upsertShared(db, 'runs', { id: 'rw', session_id: alphaId, device_id: 'win', kind: 'resume', tmux_name: 'x', pid: null, launch_params: '{}', started_at: 9, ended_at: 10, end_reason: 'exited', heartbeat_at: 10 }, 'win');
    expect(brief().device).toEqual({ name: 'work-pc', platform: 'win32', here: false });
    const hit = ((call('search_sessions', { query: 'チャンネル' }).hits) as Record<string, unknown>[])[0]!;
    expect(hit.device).toEqual({ name: 'work-pc', platform: 'win32', here: false });
  });
  it('この PC で開ける会話は resume_command を返し、resume_hint は null にする', () => {
    const brief = (call('list_sessions') as unknown as Record<string, unknown>[]).find((s) => s.id === alphaId)!;
    expect(brief).toMatchObject({ resume_command: `claude -r ${SESSION_ALPHA}`, resume_hint: null });
    const hit = ((call('search_sessions', { query: 'チャンネル' }).hits) as Record<string, unknown>[])[0]!;
    expect(hit).toMatchObject({ resume_command: `claude -r ${SESSION_ALPHA}`, resume_hint: null });
  });
  it('この PC にトランスクリプトが無い会話は、claude -r を返さず「この PC で再開」へ案内する（#313）', () => {
    // 他の PC から同期した本文だけがある状態（SessionDto.remoteOnly）にする。
    db.prepare("update transcript_files set device_id = 'win' where session_id = ?").run(alphaId);
    const brief = (call('list_sessions') as unknown as Record<string, unknown>[]).find((s) => s.id === alphaId)!;
    const hit = ((call('search_sessions', { query: 'チャンネル' }).hits) as Record<string, unknown>[])[0]!;
    for (const r of [brief, hit]) {
      expect(r.resume_command).toBeNull();
      expect(r.resume_hint).toEqual(expect.stringContaining('この PC で再開'));
      expect(r.resume_hint).toEqual(expect.stringContaining('open_in_hangar'));
    }
    const recent = ((call('get_project', { project_id: 'p1' }).recent_sessions) as Record<string, unknown>[]).find((s) => s.id === alphaId)!;
    expect(recent.resume_command).toBeNull();
  });
  it('他の PC で実行中の会話は、claude -r を返さずその PC の名前を添えて案内する', () => {
    db.prepare("insert into devices (id, name, platform, last_seen_at, updated_at, origin_device) values ('other', 'mini', 'darwin', ?, 1, 'other')").run(Date.now());
    db.prepare("insert into runs (id, session_id, device_id, kind, tmux_name, launch_params, pid, started_at, ended_at, end_reason, heartbeat_at, updated_at, origin_device) values ('rX', ?, 'other', 'start', 'hangar-rX', '{}', null, 1, null, null, ?, 1, 'other')").run(alphaId, Date.now());
    const brief = (call('list_sessions') as unknown as Record<string, unknown>[]).find((s) => s.id === alphaId)!;
    const hit = ((call('search_sessions', { query: 'チャンネル' }).hits) as Record<string, unknown>[])[0]!;
    for (const r of [brief, hit]) {
      expect(r.resume_command).toBeNull();
      expect(r.resume_hint).toEqual(expect.stringContaining('mini'));
      expect(r.resume_hint).toEqual(expect.stringContaining('この PC で再開'));
    }
  });
  it('get_transcript はセッション別 URL では session_id を省け、既定でツールを落とす', () => {
    const plain = call('get_transcript', {}, { sessionId: alphaId });
    const kinds = (plain.events as { kind: string }[]).map((e) => e.kind);
    expect(kinds).not.toContain('tool_call');
    expect(kinds).not.toContain('thinking');
    expect(kinds).toContain('user');
    // 先頭 3 件は user、thinking、assistant なので、thinking を落として 2 件が残る。
    const withTools = call('get_transcript', { session_id: alphaId, include_tools: true, limit: 3 });
    expect((withTools.events as unknown[]).length).toBe(2);
    expect(withTools.next_seq).toBe(3);
    expect(() => call('get_transcript')).toThrow(/session_id/);
  });
  it('削除したセッション（論理削除）は、本文も要約の書き込みも断る', () => {
    upsertShared(db, 'session_states', { session_id: alphaId, trashed_at: 1 }, 'd', 'session_id');
    softDeleteShared(db, 'sessions', alphaId, 'd');
    const notFound = /セッションが見つかりません/;
    expect(() => call('get_transcript', { session_id: alphaId })).toThrow(notFound);
    expect(() => call('get_transcript', {}, { sessionId: alphaId })).toThrow(notFound);
    expect(() => call('propose_session_status', { session_id: alphaId, status: 'done', note: '済んだ' })).toThrow(notFound);
  });
  it('削除したセッションは、一覧にも検索にもプロジェクトの直近にも出ない', () => {
    const pid = (db.prepare('select project_id from sessions where id = ?').get(alphaId) as { project_id: string | null }).project_id;
    const ids = (v: unknown) => (v as { id?: string; session_id?: string }[]).map((s) => s.id ?? s.session_id);
    expect(pid).not.toBeNull();
    expect(ids(call('list_sessions'))).toContain(alphaId);
    expect(ids(call('search_sessions', { query: 'チャンネル' }).hits)).toContain(alphaId);
    expect(ids(call('get_project', { project_id: pid }).recent_sessions)).toContain(alphaId);
    upsertShared(db, 'session_states', { session_id: alphaId, trashed_at: 1 }, 'd', 'session_id');
    softDeleteShared(db, 'sessions', alphaId, 'd');
    expect(ids(call('list_sessions'))).not.toContain(alphaId);
    expect(ids(call('search_sessions', { query: 'チャンネル' }).hits)).not.toContain(alphaId);
    expect(ids(call('get_project', { project_id: pid }).recent_sessions)).not.toContain(alphaId);
  });
  it('create_session は runs.start を呼び、URL を返す', async () => {
    const r = await call('create_session', { project_id: 'p1', name: 'n', prompt: 'p', permission_mode: 'default' });
    expect(started[0]).toEqual({ projectId: 'p1', name: 'n', prompt: 'p', model: undefined, effort: undefined, permissionMode: 'default', scratch: undefined });
    expect(r).toEqual({ run_id: 'r1', session_id: 'sNew', tmux_name: 'hangar-r1', url: 'http://127.0.0.1:4177/#/session/sNew' });
  });
  it('create_session は agent を省くと Claude Code として起動する', async () => {
    await call('create_session', { project_id: 'p1', model: 'opus' });
    expect(started[0]!.agent).toBeUndefined();
    expect(started[0]!.mode).toBeUndefined();
  });
  it('create_session は agent: opencode と mode を start に渡す', async () => {
    deps = { ...deps, runs: { ...deps.runs, agentEnabled: (k) => k === 'opencode' } };
    await call('create_session', { project_id: 'p1', agent: 'opencode', mode: 'plan', model: 'lmstudio/gemma' });
    expect(started[0]).toMatchObject({ projectId: 'p1', agent: 'opencode', mode: 'plan', model: 'lmstudio/gemma' });
  });
  it('create_session は worktree と add_dirs を start の worktree と addDirs にそのまま渡す', async () => {
    await call('create_session', { project_id: 'p1', worktree: 'fix-login', add_dirs: ['/tmp/a', '/tmp/b'] });
    expect(started[0]).toMatchObject({ worktree: 'fix-login', addDirs: ['/tmp/a', '/tmp/b'] });
  });
  it('create_session は agent: codex を start に渡し、permission_mode を権限の段として使う', async () => {
    deps = { ...deps, runs: { ...deps.runs, agentEnabled: (k) => k === 'codex' } };
    await call('create_session', { project_id: 'p1', agent: 'codex', model: 'gpt-x', permission_mode: 'read-only' });
    expect(started[0]).toMatchObject({ agent: 'codex', model: 'gpt-x', permissionMode: 'read-only' });
  });
  it('opencode と Codex の会話は、素の端末で打てるそれぞれの再開コマンドを返す', () => {
    db.prepare("update sessions set provider = 'codex', provider_session_id = ? where id = ?").run('019a0000-0000-7000-8000-000000000001', alphaId);
    const brief = () => (call('list_sessions') as unknown as Record<string, unknown>[]).find((s) => s.id === alphaId)!;
    expect(brief()).toMatchObject({ resume_command: 'codex resume 019a0000-0000-7000-8000-000000000001', resume_hint: null });
    db.prepare("update sessions set provider = 'opencode', provider_session_id = 'ses_abc' where id = ?").run(alphaId);
    expect(brief()).toMatchObject({ resume_command: 'opencode -s ses_abc', resume_hint: null });
    db.prepare("update sessions set provider_session_id = 'pending:x' where id = ?").run(alphaId);
    expect(brief().resume_command).toBeNull();
  });
  it('create_session は知らない agent を断り、起動しない', () => {
    expect(() => call('create_session', { project_id: 'p1', agent: 'gemini' })).toThrow(ToolError);
    expect(() => call('create_session', { project_id: 'p1', agent: 1 })).toThrow(ToolError);
    expect(started).toEqual([]);
  });
  it('create_session は opencode が無効なら opencode の起動を断る', () => {
    deps = { ...deps, runs: { ...deps.runs, agentEnabled: () => false } };
    expect(() => call('create_session', { project_id: 'p1', agent: 'opencode' })).toThrow(ToolError);
    deps = { ...deps, runs: { start: deps.runs.start } };
    expect(() => call('create_session', { project_id: 'p1', agent: 'opencode' })).toThrow(ToolError);
    expect(started).toEqual([]);
  });
  describe('create_session のアカウント', () => {
    let userHome: string;
    let store: AccountStore;
    let uni: { id: string; name: string };
    beforeEach(() => {
      userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mcp-user-'));
      store = new AccountStore({ home, primaryDir: path.join(userHome, '.claude'), homeDir: userHome });
      uni = store.add({ name: '大学' });
      store.add({ name: '会社' });
      deps = { ...deps, accounts: { store, usage: { of: () => ({ fiveHour: null, sevenDay: null, updatedAt: null }) } } };
    });
    afterEach(() => { fs.rmSync(userHome, { recursive: true, force: true }); });
    const runOf = (sessionId: string, deviceId: string, account: string) =>
      db.prepare("insert into runs (id, session_id, device_id, kind, tmux_name, launch_params, pid, started_at, ended_at, end_reason, heartbeat_at, updated_at, origin_device) values (?, ?, ?, 'start', 'h', ?, null, 1, 2, 'exit', 1, 1, ?)")
        .run(`r-${deviceId}-${account}`, sessionId, deviceId, JSON.stringify({ account }), deviceId);

    it('省くと、呼んだセッションがこの PC で最後に使ったアカウントを引き継ぐ（ヘッダで選んでいるものではなく）', async () => {
      runOf(alphaId, 'd', uni.id);
      const r = await call('create_session', { project_id: 'p1' }, { sessionId: alphaId });
      expect(started[0]!.account).toBe(uni.id);
      expect(r).toMatchObject({ account: '大学' });
    });
    it('ほかの PC の run のアカウントは引かず、いま選んでいるアカウントにする', async () => {
      runOf(alphaId, 'other', uni.id);
      await call('create_session', { project_id: 'p1' }, { sessionId: alphaId });
      expect(started[0]!.account).toBe('primary');
    });
    it('共通の URL（呼んだセッションが分からない）では、いま選んでいるアカウントにする', async () => {
      store.setCurrent(uni.id);
      const r = await call('create_session', { project_id: 'p1' });
      expect(started[0]!.account).toBe(uni.id);
      expect(r).toMatchObject({ account: '大学' });
    });
    it('名前か id で明示したら、引き継ぎより優先する', async () => {
      runOf(alphaId, 'd', uni.id);
      await call('create_session', { project_id: 'p1', account: '会社' }, { sessionId: alphaId });
      await call('create_session', { project_id: 'p1', account: 'primary' }, { sessionId: alphaId });
      expect(started.map((p) => store.get(p.account!)?.name)).toEqual(['会社', 'メイン']);
    });
    it('知らないアカウントは、使える名前を添えて断り、起動しない', () => {
      expect(() => call('create_session', { project_id: 'p1', account: '個人' })).toThrow(/メイン.*大学.*会社/);
      expect(started).toEqual([]);
    });
    it('Claude Code 以外のエージェントにアカウントを渡すと断る。省けば何も渡さない', async () => {
      deps = { ...deps, runs: { ...deps.runs, agentEnabled: () => true } };
      expect(() => call('create_session', { project_id: 'p1', agent: 'opencode', account: '大学' })).toThrow(ToolError);
      runOf(alphaId, 'd', uni.id);
      const r = await call('create_session', { project_id: 'p1', agent: 'codex' }, { sessionId: alphaId });
      expect(started[0]!.account).toBeUndefined();
      expect(r).not.toHaveProperty('account');
    });
  });
  it('create_session は、起動の口が断った理由（この PC に無いモデルと、使えるモデル）をそのまま返す', async () => {
    const why = 'opencode を起動できませんでした: lmstudio/qwen3.6-35b-a3b はこの PC にありません。使えるのは: lmstudio/gemma';
    deps = { ...deps, runs: { start: async () => { throw new RunError(400, why); }, agentEnabled: () => true } };
    await expect(call('create_session', { project_id: 'p1', agent: 'opencode', model: 'lmstudio/qwen3.6-35b-a3b' })).rejects.toThrow(why);
  });
  it('create_session は非同期の start を待ってから答える', async () => {
    deps = { ...deps, runs: { start: async (p) => { started.push(p); await new Promise((r) => setTimeout(r, 5)); return { run: { id: 'r2', sessionId: 'sLater', deviceId: 'd', kind: 'start', tmuxName: 'hangar-r2', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 }, sessionId: 'sLater', tabs: [] }; } } };
    expect(await call('create_session', { project_id: 'p1' })).toEqual({ run_id: 'r2', session_id: 'sLater', tmux_name: 'hangar-r2', url: 'http://127.0.0.1:4177/#/session/sLater' });
  });
  describe('create_session の起動前の準備（#545）', () => {
    const okRun = (sessionId: string) => ({ run: { id: 'rP', sessionId, deviceId: 'd', kind: 'start' as const, tmuxName: 'hangar-rP', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 }, sessionId, tabs: [] });
    /** 準備が走り続ける起動。onPending で仮の行の ID を知らせ、finish か fail を呼ぶまで返らない。 */
    let finish: (() => void) | null;
    let fail: ((e: unknown) => void) | null;
    let running: Set<string>;
    beforeEach(() => {
      finish = null; fail = null; running = new Set();
      deps = { ...deps, launchWaitMs: 5, runs: {
        agentEnabled: () => true,
        prepRunning: (key) => running.has(key),
        start: (p, hooks) => new Promise((resolve, reject) => {
          started.push(p);
          hooks?.onPending?.('sPending');
          if (p.prepKey) running.add(p.prepKey);
          finish = () => { running.clear(); resolve(okRun('sPending')); };
          fail = (e) => { running.clear(); reject(e); };
        }),
      } };
    });
    const parentOf = (id: string) => (db.prepare('select parent_id from session_spawns where session_id = ?').get(id) as { parent_id: string } | undefined)?.parent_id ?? null;

    it('opencode の起動には準備の鍵（prepKey）を添える。画面の札が準備の進みを拾えるようにするため', async () => {
      const r = call('create_session', { project_id: 'p1', agent: 'opencode' });
      finish!();
      await r;
      expect(started[0]!.prepKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    });
    it('準備が待ちの上限を越えたら、起動を待たずに preparing で返す。起動元の下にはその場で入れる', async () => {
      const r = await call('create_session', { project_id: 'p1', agent: 'opencode', name: '準備の確かめ' }, { sessionId: alphaId });
      expect(r).toMatchObject({ session_id: 'sPending', preparing: true, url: 'http://127.0.0.1:4177/#/session/sPending' });
      expect(r).not.toHaveProperty('run_id');
      expect(String(r.note)).toMatch(/準備/);
      expect(parentOf('sPending')).toBe(alphaId);
      finish!();
    });
    it('上限の内に済んだ起動は、これまでどおり run を添えて返す', async () => {
      deps = { ...deps, launchWaitMs: 1_000 };
      const r = call('create_session', { project_id: 'p1', agent: 'opencode' });
      finish!();
      expect(await r).toEqual({ run_id: 'rP', session_id: 'sPending', tmux_name: 'hangar-rP', url: 'http://127.0.0.1:4177/#/session/sPending' });
    });
    it('上限の内に起動が断られたら、これまでどおり理由をその場で返す', async () => {
      deps = { ...deps, launchWaitMs: 1_000 };
      const r = call('create_session', { project_id: 'p1', agent: 'opencode' });
      fail!(new RunError(400, '接続先の準備に失敗しました: exit 1'));
      await expect(r).rejects.toThrow('接続先の準備に失敗しました: exit 1');
    });
    it('準備が走っていなければ、上限を越えても起動を待つ（Claude Code と Codex は準備をしない）', async () => {
      deps = { ...deps, runs: { ...deps.runs, prepRunning: () => false } };
      const r = call('create_session', { project_id: 'p1', agent: 'opencode' }) as unknown as Promise<Record<string, unknown>>;
      await new Promise((res) => setTimeout(res, 20));
      finish!();
      expect(await r).toMatchObject({ run_id: 'rP' });
    });
    it('返した後に起動が失敗したら、理由を起動元の会話の知らせとして利用者に届け、ログにも残す', async () => {
      const seen: string[] = [];
      const off = onUnread((id, text) => { if (id === alphaId) seen.push(text); });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await call('create_session', { project_id: 'p1', agent: 'opencode', name: '準備の確かめ' }, { sessionId: alphaId });
        fail!(new RunError(400, 'opencode を起動できませんでした: 接続先が応答しません'));
        await new Promise((res) => setTimeout(res, 0));
        expect(seen).toHaveLength(1);
        expect(seen[0]).toContain('準備の確かめ');
        expect(seen[0]).toContain('接続先が応答しません');
        expect(getSession(db, live, alphaId)!.unread).toMatchObject({ count: 1 });
        expect(warn.mock.calls.flat().join(' ')).toContain('接続先が応答しません');
      } finally { off(); warn.mockRestore(); }
    });
    it('起動元が分からない（共通の URL）ときも、失敗はログに残し、投げっぱなしにしない', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await call('create_session', { project_id: 'p1', agent: 'opencode' });
        fail!(new Error('boom'));
        await new Promise((res) => setTimeout(res, 0));
        expect(warn.mock.calls.flat().join(' ')).toContain('boom');
      } finally { warn.mockRestore(); }
    });
  });
  describe('会話の寿命（stop_session、resume_session、delete_session）', () => {
    const killed: string[] = [];
    const resumed: { id: string; account?: string }[] = [];
    const trashed: string[] = [];
    const run = (deviceId: string, id = 'rLive') => ({ id, sessionId: alphaId, deviceId, kind: 'start' as const, tmuxName: 'hangar-x', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 });
    let alive: ReturnType<typeof run> | null;
    let trashError: Error | null;
    const asAgent = (provider: string) => db.prepare('update sessions set provider = ? where id = ?').run(provider, alphaId);
    beforeEach(() => {
      killed.length = 0; resumed.length = 0; trashed.length = 0; alive = null; trashError = null;
      deps = {
        ...deps,
        runs: {
          ...deps.runs,
          aliveRun: () => alive,
          kill: (id) => { killed.push(id); },
          resumeWith: (id, o) => { resumed.push({ id, ...(o?.account !== undefined ? { account: o.account } : {}) }); return { run: { ...run('d', 'rRes'), sessionId: id, kind: 'resume', tmuxName: 'hangar-rRes' }, sessionId: id, tabs: [] }; },
        },
        trash: { deleteSession: async (id) => { if (trashError) throw trashError; trashed.push(id); } },
      };
    });

    it('stop_session はこの PC で動く run を止める', () => {
      alive = run('d');
      expect(call('stop_session', { session_id: alphaId })).toEqual({ ok: true, session_id: alphaId, run_id: 'rLive' });
      expect(killed).toEqual(['rLive']);
    });
    it('stop_session は動いていない会話、ほかの PC の run、自分自身、知らない会話を断る', () => {
      expect(() => call('stop_session', { session_id: alphaId })).toThrow(/実行中ではありません/);
      alive = run('other');
      expect(() => call('stop_session', { session_id: alphaId })).toThrow(/他の PC/);
      alive = run('d');
      expect(() => call('stop_session', { session_id: alphaId }, { sessionId: alphaId })).toThrow(/自分自身/);
      expect(() => call('stop_session', { session_id: 'nope' })).toThrow(ToolError);
      expect(() => call('stop_session', {})).toThrow(ToolError);
      expect(killed).toEqual([]);
    });
    it('stop_session はセッション別 URL から、別のセッションを指せる', () => {
      alive = run('d');
      call('stop_session', { session_id: alphaId }, { sessionId: 'someoneElse' });
      expect(killed).toEqual(['rLive']);
    });

    it.each(['claude-code', 'codex', 'opencode'])('resume_session は %s の会話を resumeWith で再開し、create_session と同じ形で返す', async (agent) => {
      asAgent(agent);
      const r = await call('resume_session', { session_id: alphaId });
      expect(resumed).toEqual([{ id: alphaId }]);
      expect(r).toEqual({ run_id: 'rRes', session_id: alphaId, tmux_name: 'hangar-rRes', url: `http://127.0.0.1:4177/#/session/${alphaId}` });
    });
    it('resume_session は opencode の準備が待ちの上限を越えたら preparing で返し、失敗は起動元に知らせる', async () => {
      asAgent('opencode');
      let reject: ((e: unknown) => void) | null = null;
      let key: string | undefined;
      deps = { ...deps, launchWaitMs: 5, runs: { ...deps.runs, prepRunning: (k) => k === key, resumeWith: (_id, o) => { key = o?.prepKey; return new Promise((_res, rej) => { reject = rej; }); } } };
      const seen: string[] = [];
      const off = onUnread((id, text) => { if (id === 'caller') seen.push(text); });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      upsertShared(db, 'sessions', { id: 'caller', provider: 'claude-code', provider_session_id: 'caller-psid', cwd: '/Users/me/workspace/alpha', home_device: 'd', project_id: 'p1', started_at: 1, last_activity_at: 1 }, 'd');
      try {
        const r = await call('resume_session', { session_id: alphaId }, { sessionId: 'caller' });
        expect(key).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
        expect(r).toMatchObject({ session_id: alphaId, preparing: true });
        reject!(new RunError(400, '接続先の準備に失敗しました: exit 3'));
        await new Promise((res) => setTimeout(res, 0));
        expect(seen.join(' ')).toContain('exit 3');
      } finally { off(); warn.mockRestore(); }
    });
    it('resume_session は動いている会話を断る', () => {
      alive = run('d');
      expect(() => call('resume_session', { session_id: alphaId })).toThrow(/すでに実行中/);
      alive = run('other');
      expect(() => call('resume_session', { session_id: alphaId })).toThrow(ToolError);
      expect(() => call('resume_session', { session_id: 'nope' })).toThrow(ToolError);
      expect(resumed).toEqual([]);
    });
    describe('アカウント', () => {
      let userHome: string;
      let store: AccountStore;
      let uni: { id: string; name: string };
      beforeEach(() => {
        userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mcp-user-'));
        store = new AccountStore({ home, primaryDir: path.join(userHome, '.claude'), homeDir: userHome });
        uni = store.add({ name: '大学' });
        store.add({ name: '会社' });
        deps = { ...deps, accounts: { store, usage: { of: () => ({ fiveHour: null, sevenDay: null, updatedAt: null }) } } };
      });
      afterEach(() => { fs.rmSync(userHome, { recursive: true, force: true }); });
      it('Claude Code は名前か id で引いて resumeWith に渡し、名前を返す', async () => {
        expect(await call('resume_session', { session_id: alphaId, account: '大学' })).toMatchObject({ account: '大学' });
        await call('resume_session', { session_id: alphaId, account: uni.id });
        expect(resumed).toEqual([{ id: alphaId, account: uni.id }, { id: alphaId, account: uni.id }]);
      });
      it('省けば何も渡さず（最後に使ったアカウント）、名前だけ添える', async () => {
        db.prepare("insert into runs (id, session_id, device_id, kind, tmux_name, launch_params, pid, started_at, ended_at, end_reason, heartbeat_at, updated_at, origin_device) values ('rOld', ?, 'd', 'start', 'h', ?, null, 1, 2, 'exit', 1, 1, 'd')").run(alphaId, JSON.stringify({ account: uni.id }));
        const r = await call('resume_session', { session_id: alphaId });
        expect(resumed).toEqual([{ id: alphaId }]);
        expect(r).toMatchObject({ account: '大学' });
      });
      it('知らないアカウントは使える名前を添えて断る', () => {
        expect(() => call('resume_session', { session_id: alphaId, account: '個人' })).toThrow(/メイン.*大学.*会社/);
        expect(resumed).toEqual([]);
      });
      it.each(['codex', 'opencode'])('%s にアカウントを渡すと断る。省けば account を返さない', async (agent) => {
        asAgent(agent);
        expect(() => call('resume_session', { session_id: alphaId, account: '大学' })).toThrow(ToolError);
        expect(resumed).toEqual([]);
        expect(await call('resume_session', { session_id: alphaId })).not.toHaveProperty('account');
      });
    });

    it('delete_session は confirmed が true でなければ、題名を添えて断り、消さない', async () => {
      await expect(Promise.resolve().then(() => call('delete_session', { session_id: alphaId }))).rejects.toThrow(/confirmed/);
      await expect(Promise.resolve().then(() => call('delete_session', { session_id: alphaId, confirmed: false }))).rejects.toThrow(ToolError);
      expect(trashed).toEqual([]);
    });
    it.each(['claude-code', 'codex', 'opencode'])('delete_session は %s の会話を、承認つきで消す', async (agent) => {
      asAgent(agent);
      expect(await call('delete_session', { session_id: alphaId, confirmed: true })).toEqual({ ok: true, session_id: alphaId });
      expect(trashed).toEqual([alphaId]);
    });
    it('delete_session は自分自身と知らない会話を断り、trash の断り（動いている会話）はそのまま返す', async () => {
      expect(() => call('delete_session', { session_id: alphaId, confirmed: true }, { sessionId: alphaId })).toThrow(/自分自身/);
      expect(() => call('delete_session', { session_id: 'nope', confirmed: true })).toThrow(ToolError);
      trashError = new DeleteError(409, msg('session.delete.running'));
      await expect(call('delete_session', { session_id: alphaId, confirmed: true })).rejects.toThrow(/実行中のセッションは削除できません/);
      expect(trashed).toEqual([]);
    });
    it('3 つとも、道具の口が無ければ知らない道具として断る', () => {
      deps = { ...deps, runs: { start: deps.runs.start } };
      delete (deps as { trash?: unknown }).trash;
      for (const n of ['stop_session', 'resume_session', 'delete_session']) expect(() => call(n, { session_id: alphaId, confirmed: true })).toThrow(ToolError);
    });
  });
  it('set_session_summary は in_session で保存して配信する', () => {
    const r = call('set_session_summary', { title: 'T', one_liner: 'O', body: 'B', state: 'blocked', next_steps: ['n1'] }, { sessionId: alphaId });
    expect(r).toEqual({ ok: true, session_id: alphaId });
    const row = db.prepare('select * from session_summaries where session_id = ?').get(alphaId) as Record<string, unknown>;
    expect(row).toMatchObject({ title: 'T', one_liner: 'O', state: 'blocked', source: 'in_session', based_on_turns: 2 });
    expect(JSON.parse(row.next_steps as string)).toEqual(['n1']);
    expect(sent.at(-1)).toMatchObject({ type: 'session.upsert', session: { id: alphaId, summary: { title: 'T', source: 'in_session' } } });
    expect(() => call('set_session_summary', { title: 'T', one_liner: 'O', body: 'B', state: 'weird', next_steps: [] }, { sessionId: alphaId })).toThrow(ToolError);
  });
  it('他端末のロックは、MCP から触っても配信から消えない', () => {
    // 他端末で生きている run を入れる。listSessions と getSession に deviceId を渡さないと lock は必ず null になる。
    db.prepare("insert into runs (id, session_id, device_id, kind, tmux_name, launch_params, pid, started_at, ended_at, end_reason, heartbeat_at, updated_at, origin_device) values ('rX', ?, 'other', 'start', 'hangar-rX', '{}', null, 1, null, null, ?, 1, 'other')").run(alphaId, Date.now());
    db.prepare("insert into devices (id, name, platform, last_seen_at, updated_at, origin_device) values ('other', 'mini', 'darwin', ?, 1, 'other')").run(Date.now());
    call('set_session_summary', { session_id: alphaId, title: 'T', one_liner: 'O', body: 'B', state: 'done', next_steps: [] });
    const ev = sent.find((e) => e.type === 'session.upsert');
    expect(ev && ev.type === 'session.upsert' ? ev.session.lock?.deviceName : null).toBe('mini');
  });
  it('get_usage はアカウントごとの値も返す。上の 3 つは最初のアカウントのまま', () => {
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mcp-user-'));
    const store = new AccountStore({ home, primaryDir: path.join(userHome, '.claude'), homeDir: userHome });
    const a = store.add({ name: '大学' });
    store.setCurrent(a.id);
    const tracker = new UsageTracker(db, { accountOf: (sid) => (sid === 'u' ? a.id : 'primary') });
    tracker.ingest({ session_id: 'w', rate_limits: { five_hour: { used_percentage: 82, resets_at: 4_000_000_000 }, seven_day: { used_percentage: 41, resets_at: 4_000_100_000 } } });
    tracker.ingest({ session_id: 'u', rate_limits: { five_hour: { used_percentage: 12, resets_at: 4_000_000_000 }, seven_day: { used_percentage: 9, resets_at: 4_000_100_000 } } });
    deps = { ...deps, usage: () => tracker.current(), accounts: { store, usage: tracker } };
    const out = call('get_usage') as { five_hour: { used_percentage: number }; accounts: { name: string; current: boolean; five_hour: { used_percentage: number } }[] };
    expect(out.five_hour.used_percentage).toBe(82);
    expect(out.accounts.map((x) => [x.name, x.current, x.five_hour.used_percentage])).toEqual([['メイン', false, 82], ['大学', true, 12]]);
    expect(JSON.stringify(out)).not.toContain('@');
    fs.rmSync(userHome, { recursive: true, force: true });
  });
  it('get_usage、open_in_hangar。セッションのノート（set_session_memo）は道具ごと無い', () => {
    expect(TOOL_NAMES).not.toContain('set_session_memo');
    expect(() => call('set_session_memo', { session_id: alphaId, text: 'メモ' })).toThrow(ToolError);
    expect(call('get_usage')).toEqual({ five_hour: { used_percentage: 47, resets_at: 1_760_000_000_000 }, seven_day: null, updated_at: 5 });
    expect(call('open_in_hangar', { session_id: alphaId })).toEqual({ url: `http://127.0.0.1:4177/#/session/${alphaId}`, deep_link: `hangar://session/${alphaId}` });
    expect(call('open_in_hangar', { project_id: 'p1' })).toEqual({ url: 'http://127.0.0.1:4177/#/project/p1', deep_link: 'hangar://project/p1' });
    expect(call('open_in_hangar', {}, { sessionId: alphaId }).url).toContain(alphaId);
    expect(() => call('nope')).toThrow(ToolError);
    expect(TOOL_NAMES).toHaveLength(21);
  });
  it('set_turn_intent は意図を積み、最新を返せるようにする', () => {
    const r = call('set_turn_intent', { text: '  抜けたあと、答え終えた会話だけ止める  ' }, { sessionId: alphaId });
    expect(r).toMatchObject({ ok: true, session_id: alphaId });
    expect(latestIntent(db, alphaId)).toEqual({ at: r.at, text: '抜けたあと、答え終えた会話だけ止める' });
  });
  it('set_turn_intent は積んだ後に onIntent の購読へ会話の ID を知らせ、断ったときは知らせない', async () => {
    const { onIntent } = await import('../live/intents.ts');
    const seen: string[] = [];
    const off = onIntent((id) => seen.push(id));
    try {
      call('set_turn_intent', { text: '受信箱へ知らせる' }, { sessionId: alphaId });
      expect(() => call('set_turn_intent', { text: '   ' }, { sessionId: alphaId })).toThrow(ToolError);
      expect(seen).toEqual([alphaId]);
    } finally {
      off();
    }
  });
  it('set_turn_intent は空と 201 字以上を断る', () => {
    expect(() => call('set_turn_intent', { text: '   ' }, { sessionId: alphaId })).toThrow(ToolError);
    expect(() => call('set_turn_intent', { text: 'あ'.repeat(201) }, { sessionId: alphaId })).toThrow(ToolError);
    expect(call('set_turn_intent', { text: 'あ'.repeat(200) }, { sessionId: alphaId })).toMatchObject({ ok: true });
  });
  it('set_turn_intent はセッション別 URL の他のセッションを指せない', () => {
    expect(() => call('set_turn_intent', { session_id: 'other', text: 'x' }, { sessionId: alphaId })).toThrow(ToolError);
  });
  it('notify_user を 2 回呼ぶと、そのセッションの unread が 2 になり、最新の本文が残る。見ると null になり、Done にしても未読は残る', () => {
    const unread = () => getSession(db, live, alphaId)!.unread;
    expect(unread()).toBeNull();
    expect(call('notify_user', { text: '  一つ目  ' }, { sessionId: alphaId })).toMatchObject({ ok: true, session_id: alphaId, unread: 1 });
    expect(call('notify_user', { text: '二つ目' }, { sessionId: alphaId })).toMatchObject({ ok: true, unread: 2 });
    expect(unread()).toMatchObject({ count: 2, latest: '二つ目' });
    // 画面へは session.upsert が配られる。
    expect(sent.some((e) => e.type === 'session.upsert')).toBe(true);
    upsertShared(db, 'session_states', { session_id: alphaId, status: 'done', set_by: 'user', set_at: 5 }, 'd', 'session_id');
    expect(unread()).toMatchObject({ count: 2 });
    expect(markSeen(db, alphaId)).toBe(true);
    expect(unread()).toBeNull();
    // 行が無ければ何もしない。
    expect(markSeen(db, alphaId)).toBe(false);
  });
  it('notify_user は Done、Archived、Paused にしたセッションでは何も出さない。付けた後に休みから動き出したら出す', () => {
    const seen: string[] = [];
    const off = onUnread((_id, text) => seen.push(text));
    try {
      for (const status of ['done', 'archived', 'paused'] as const) {
        upsertShared(db, 'session_states', { session_id: alphaId, status, set_by: 'conversation', set_at: 1000 }, 'd', 'session_id');
        expect(call('notify_user', { text: status }, { sessionId: alphaId })).toMatchObject({ ok: true, unread: 0, sent: [] });
      }
      expect(seen).toEqual([]);
      expect(getSession(db, live, alphaId)!.unread).toBeNull();
      // 付けた時刻より前に動き出したのは、付けたターンの続きである。
      noteWake(db, alphaId, 999);
      expect(call('notify_user', { text: 'まだ' }, { sessionId: alphaId })).toMatchObject({ sent: [] });
      // 付けた後に休みから動き出した（見張りの終わりや、続けて打った発言）。
      noteWake(db, alphaId, 1001);
      expect(call('notify_user', { text: '通った' }, { sessionId: alphaId })).toMatchObject({ unread: 1, sent: ['unread', 'os', 'phone'] });
      expect(seen).toEqual(['通った']);
    } finally {
      off();
    }
  });
  it('propose_session_status で Done か Paused に確定すると、残っていた未読を消す', () => {
    call('notify_user', { text: '前の知らせ' }, { sessionId: alphaId });
    expect(getSession(db, live, alphaId)!.unread).toMatchObject({ count: 1 });
    call('propose_session_status', { status: 'paused', note: 'CI を待つ', confirmed: true }, { sessionId: alphaId });
    expect(getSession(db, live, alphaId)!.unread).toBeNull();
  });
  it('notify_user は積んだ後に onUnread の購読へ会話の ID と本文と数を知らせ、断ったときは知らせない', () => {
    const seen: [string, string, number][] = [];
    const off = onUnread((id, text, count) => seen.push([id, text, count]));
    try {
      call('notify_user', { text: '知らせる' }, { sessionId: alphaId });
      expect(() => call('notify_user', { text: '   ' }, { sessionId: alphaId })).toThrow(ToolError);
      call('notify_user', { text: 'もう一度' }, { sessionId: alphaId });
      expect(seen).toEqual([[alphaId, '知らせる', 1], [alphaId, 'もう一度', 2]]);
    } finally {
      off();
    }
  });
  it('notify_user の to：省くと設定で入りの先すべて、付けるとその中で入りのものだけ。設定の切が勝つ。unread が無ければ数を増やさない', () => {
    const seen: [number, string[]][] = [];
    const off = onUnread((_id, _text, count, sent) => seen.push([count, sent]));
    const unread = () => getSession(db, live, alphaId)!.unread?.count ?? 0;
    try {
      expect(call('notify_user', { text: 'a' }, { sessionId: alphaId })).toMatchObject({ unread: 1, sent: ['unread', 'os', 'phone'] });
      // スマホにだけ。数は増えず、購読へは今の数と出す先が渡る。
      expect(call('notify_user', { text: 'b', to: ['phone'] }, { sessionId: alphaId })).toMatchObject({ unread: 1, sent: ['phone'] });
      expect(unread()).toBe(1);
      expect(seen.at(-1)).toEqual([1, ['phone']]);
      // 重複はまとめ、順は決まった順にする。
      expect(call('notify_user', { text: 'c', to: ['os', 'unread', 'os'] }, { sessionId: alphaId })).toMatchObject({ unread: 2, sent: ['unread', 'os'] });
      // 設定の切が勝つ。
      deps = { ...deps, settings: () => ({ unreadOs: false, unreadPhone: false }) };
      expect(call('notify_user', { text: 'd', to: ['os', 'phone'] }, { sessionId: alphaId })).toMatchObject({ ok: true, unread: 2, sent: [] });
      expect(call('notify_user', { text: 'e' }, { sessionId: alphaId })).toMatchObject({ unread: 3, sent: ['unread'] });
      // 何も出さないときは購読へも知らせない。
      const n = seen.length;
      call('notify_user', { text: 'f', to: ['phone'] }, { sessionId: alphaId });
      expect(seen).toHaveLength(n);
      // 空の配列、知らない値、配列でないものは断る。
      for (const to of [[], ['email'], ['phone', 'x'], 'phone']) expect(() => call('notify_user', { text: 'g', to }, { sessionId: alphaId })).toThrow(ToolError);
    } finally {
      off();
    }
  });
  it('notify_user の kind：省くと done。決まり（notifyPreference）で kind を含む先だけに出す', () => {
    const rules = { text: '済んだら Mac、判断はスマホにも', unread: ['done', 'ask', 'progress'], os: ['done', 'ask'], phone: ['ask'] } as const;
    deps = { ...deps, settings: () => ({ notifyPreference: { ...rules, unread: [...rules.unread], os: [...rules.os], phone: [...rules.phone] } }) };
    expect(call('notify_user', { text: 'a' }, { sessionId: alphaId })).toMatchObject({ sent: ['unread', 'os'] });
    expect(call('notify_user', { text: 'b', kind: 'done' }, { sessionId: alphaId })).toMatchObject({ sent: ['unread', 'os'] });
    expect(call('notify_user', { text: 'c', kind: 'ask' }, { sessionId: alphaId })).toMatchObject({ sent: ['unread', 'os', 'phone'] });
    expect(call('notify_user', { text: 'd', kind: 'progress' }, { sessionId: alphaId })).toMatchObject({ sent: ['unread'] });
    for (const kind of ['finish', '', 1, null]) expect(() => call('notify_user', { text: 'e', kind }, { sessionId: alphaId })).toThrow(ToolError);
  });
  it('notify_user の既定（設定なし）は unread すべて、os と phone は done・ask。古いスイッチの OFF は空の決まりとして読む', () => {
    expect(call('notify_user', { text: 'a', kind: 'progress' }, { sessionId: alphaId })).toMatchObject({ sent: ['unread'] });
    expect(call('notify_user', { text: 'b', kind: 'ask' }, { sessionId: alphaId })).toMatchObject({ sent: ['unread', 'os', 'phone'] });
    deps = { ...deps, settings: () => ({ unreadBadge: false, unreadPhone: false }) };
    expect(call('notify_user', { text: 'c', kind: 'ask' }, { sessionId: alphaId })).toMatchObject({ sent: ['os'] });
    // notifyPreference があれば古いスイッチより勝つ。
    deps = { ...deps, settings: () => ({ unreadBadge: false, notifyPreference: { text: 't', unread: ['done'], os: [], phone: ['done'] } }) };
    expect(call('notify_user', { text: 'd' }, { sessionId: alphaId })).toMatchObject({ sent: ['unread', 'phone'] });
  });
  it('notify_user の to は kind に勝つが、決まりで空の先（オフ）は to があっても出ない', () => {
    deps = { ...deps, settings: () => ({ notifyPreference: { text: 't', unread: ['done'], os: [], phone: ['ask'] } }) };
    // phone は決まりに done が無くても、to で名指しされたら出す。
    expect(call('notify_user', { text: 'a', kind: 'done', to: ['phone'] }, { sessionId: alphaId })).toMatchObject({ sent: ['phone'] });
    // os は空の配列（オフ）なので、名指しされても出ない。
    expect(call('notify_user', { text: 'b', kind: 'ask', to: ['os', 'phone'] }, { sessionId: alphaId })).toMatchObject({ sent: ['phone'] });
    expect(call('notify_user', { text: 'c', to: ['os'] }, { sessionId: alphaId })).toMatchObject({ sent: [] });
  });
  it('set_notify_preference は決まりを保存して、保存した決まり（省いた項目は埋めて）を返す', () => {
    const saved: unknown[] = [];
    let cur: Record<string, unknown> | null = null;
    deps = { ...deps, settings: () => ({ notifyPreference: cur as never }), saveNotifyPreference: (p) => { saved.push(p); cur = p as never; } };
    const r = call('set_notify_preference', { text: '  済んだら Mac だけ  ', unread: ['done', 'done', 'ask'], os: ['done'], phone: [] }, { sessionId: alphaId });
    expect(r).toEqual({ text: '済んだら Mac だけ', unread: ['done', 'ask'], os: ['done'], phone: [], whileFocused: false, merge: true });
    expect(saved).toHaveLength(1);
    // 保存したあとの notify_user は決まりに従う。
    expect(call('notify_user', { text: 'x', kind: 'ask' }, { sessionId: alphaId })).toMatchObject({ sent: ['unread'] });
    // whileFocused と merge は、渡したときだけ変わり、省けば今の値を保つ。
    expect(call('set_notify_preference', { text: 't', unread: [], os: ['done'], phone: [], whileFocused: true, merge: false })).toMatchObject({ whileFocused: true, merge: false, unread: [] });
    expect(call('set_notify_preference', { text: 't2', unread: ['done'], os: [], phone: [] })).toMatchObject({ whileFocused: true, merge: false });
    expect(call('set_notify_preference', { text: 't3', unread: ['done'], os: [], phone: [], merge: true })).toMatchObject({ whileFocused: true, merge: true });
    expect(saved.at(-1)).toMatchObject({ text: 't3', whileFocused: true, merge: true });
  });
  it('set_notify_preference は必須の欠けと形の違いを断り、何も保存しない。保存の口が無ければ知らない道具として断る', () => {
    const saved: unknown[] = [];
    deps = { ...deps, saveNotifyPreference: (p) => { saved.push(p); } };
    const ok = { text: 't', unread: ['done'], os: ['done'], phone: [] };
    const bad: Record<string, unknown>[] = [
      {}, { ...ok, text: undefined }, { ...ok, text: '   ' }, { ...ok, text: 1 },
      { ...ok, unread: undefined }, { ...ok, os: undefined }, { ...ok, phone: undefined },
      { ...ok, unread: 'done' }, { ...ok, os: ['done', 'email'] }, { ...ok, phone: [1] },
      { ...ok, whileFocused: 'yes' }, { ...ok, merge: 1 },
    ];
    for (const a of bad) expect(() => call('set_notify_preference', a)).toThrow(ToolError);
    expect(saved).toHaveLength(0);
    // セッション別 URL では、ほかのセッションの id を断る。
    expect(() => call('set_notify_preference', { ...ok, session_id: 'other' }, { sessionId: alphaId })).toThrow(ToolError);
    deps = { ...deps, saveNotifyPreference: undefined };
    expect(() => call('set_notify_preference', ok)).toThrow(ToolError);
  });
  it('notify_user は空と 201 字を断り、200 字は通し、別のセッションの id を断る', () => {
    expect(() => call('notify_user', { text: '   ' }, { sessionId: alphaId })).toThrow(ToolError);
    expect(() => call('notify_user', { text: 'あ'.repeat(201) }, { sessionId: alphaId })).toThrow(ToolError);
    expect(call('notify_user', { text: 'あ'.repeat(200) }, { sessionId: alphaId })).toMatchObject({ ok: true });
    expect(() => call('notify_user', { session_id: 'other', text: 'x' }, { sessionId: alphaId })).toThrow(ToolError);
    expect(call('notify_user', { session_id: alphaId, text: '共通 URL でも使える' })).toMatchObject({ ok: true, session_id: alphaId });
  });
  it('同じミリ秒に 2 回書いても両方残り、後の方が最新になる', async () => {
    const { addIntent } = await import('../live/intents.ts');
    const a = addIntent(db, alphaId, '一つ目', 5000);
    const b = addIntent(db, alphaId, '二つ目', 5000);
    expect(b.at).toBe(a.at + 1);
    expect(latestIntent(db, alphaId)?.text).toBe('二つ目');
    expect((db.prepare('select count(*) c from turn_intents where session_id = ?').get(alphaId) as { c: number }).c).toBe(2);
  });
  it('open_in_hangar は実在しない ID を死んだリンクにしない', () => {
    expect(() => call('open_in_hangar', { session_id: 'ghost-session' })).toThrow(ToolError);
    expect(() => call('open_in_hangar', { project_id: 'ghost-project' })).toThrow(ToolError);
    expect(() => call('open_in_hangar', {}, { sessionId: 'ghost-session' })).toThrow(ToolError);
  });
  it('セッションを取るツールは実在しない session_id を拒む', () => {
    for (const [name, args] of SESSION_TOOL_CALLS) {
      expect(() => call(name, { ...args, session_id: 'ghost-session' })).toThrow(ToolError);
    }
  });
  it('セッションを取るツールは Claude の UUID を session_id として受け付けない', () => {
    // session_id は hangar の sessions.id である。provider_session_id を渡しても当たってはならない。
    for (const [name, args] of SESSION_TOOL_CALLS) {
      expect(() => call(name, { ...args, session_id: SESSION_ALPHA })).toThrow(ToolError);
    }
  });
});

describe('セッション別 URL は、そのセッションとそのプロジェクトに閉じる', () => {
  let otherId: string;
  const scoped = () => ({ sessionId: alphaId });
  beforeEach(() => {
    upsertShared(db, 'projects', { id: 'p2', name: 'other', status: 'active', is_scratch: 0 }, 'd');
    upsertShared(db, 'project_roots', { id: 'r2', project_id: 'p2', device_id: 'd', path: '/Users/me/other', resolved: 1 }, 'd');
    assignSessions(db, 'd');
    otherId = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_OTHER) as { id: string }).id;
  });

  it('get_transcript は、セッション別 URL からでも別のセッションの本文を読める', () => {
    // 画面からコピーした宛先の 1 行を渡された Claude が、そのセッションの様子を読むためである（2026-10-15 の利用者の決定）。
    // 書き込みの道具は今までどおり自分のセッションに閉じる（次の it）。
    expect((call('get_transcript', { session_id: otherId }).events as unknown[]).length).toBeGreaterThan(0);
    expect(call('get_transcript', { session_id: otherId }, scoped()).session_id).toBe(otherId);
    // 自分のセッションは、明示しても省いても読める。
    expect(call('get_transcript', { session_id: alphaId }, scoped()).session_id).toBe(alphaId);
    expect(call('get_transcript', {}, scoped()).session_id).toBe(alphaId);
  });

  it('セッションを取る他の道具は、別のセッションを断る', () => {
    for (const [name, args] of SESSION_TOOL_CALLS.filter(([n]) => n !== 'get_transcript')) {
      expect(() => call(name, { ...args, session_id: otherId }, scoped())).toThrow(ToolError);
    }
    // 別のセッションの要約は書かれていない。
    expect((db.prepare('select title from session_summaries where session_id = ?').get(otherId) as { title: string } | undefined)?.title).not.toBe('T');
  });

  it('list_projects は自分のプロジェクトだけを返す', () => {
    expect((call('list_projects') as unknown as { id: string }[]).map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    expect((callTool(deps, scoped(), 'list_projects', {}) as { id: string }[]).map((p) => p.id)).toEqual(['p1']);
  });

  it('update_project はノートを書かない（append_memo はやめた）。渡されたら、やめたことと書く場所を notice で返し、エラーにはしない', () => {
    const r = call('update_project', { project_id: 'p1', append_memo: '書かない' });
    expect(r).not.toHaveProperty('memo');
    expect(r.notice).toBe('プロジェクトのノートは廃止したため、append_memo は保存しませんでした。記録したい内容は、CLAUDE.md などの指示ファイルに書いてください。');
    expect(db.prepare('select markdown from project_memos where project_id = ?').get('p1')).toBeUndefined();
    expect(fs.existsSync(path.join(home, 'projects', 'p1', 'memo.md'))).toBe(false);
    // 他の項目は、いっしょに渡されても今までどおり書く。
    const r2 = call('update_project', { project_id: 'p1', status: 'paused', append_memo: '書かない' });
    expect((r2.project as { status: string }).status).toBe('paused');
    expect(r2.notice).toEqual(expect.any(String));
    // 渡さなければ notice は付けない。
    expect(call('update_project', { project_id: 'p1', status: 'active' })).not.toHaveProperty('notice');
    // 言語は道具の言語に従う。
    deps.language = () => 'en';
    expect(call('update_project', { project_id: 'p1', append_memo: 'x' }).notice).toBe('Project notes have been retired, so append_memo was not written. Write anything you want to keep in an instruction file such as CLAUDE.md.');
  });

  it('get_project と update_project は別のプロジェクトを断る', () => {
    expect(() => call('get_project', { project_id: 'p2' }, scoped())).toThrow(ToolError);
    expect(() => call('update_project', { project_id: 'p2', status: 'archived' }, scoped())).toThrow(ToolError);
    expect((db.prepare('select status from projects where id = ?').get('p2') as { status: string }).status).toBe('active');
    // 自分のプロジェクトは触れる。
    expect(call('get_project', { project_id: 'p1' }, scoped()).id).toBe('p1');
    expect((call('update_project', { project_id: 'p1', status: 'paused' }, scoped()).project as { status: string }).status).toBe('paused');
  });

  it('list_sessions と search_sessions は自分のプロジェクトの外を見せない', () => {
    const list = callTool(deps, scoped(), 'list_sessions', {}) as { id: string }[];
    expect(list.map((s) => s.id)).toEqual([alphaId]);
    expect(() => call('list_sessions', { project_id: 'p2' }, scoped())).toThrow(ToolError);
    const r = callTool(deps, scoped(), 'search_sessions', { query: 'a' }) as { hits: { session_id: string }[] };
    expect(r.hits.every((h) => h.session_id === alphaId)).toBe(true);
    expect(() => call('search_sessions', { query: 'a', project_id: 'p2' }, scoped())).toThrow(ToolError);
  });

  it('create_session は別のプロジェクトで起動しない', () => {
    expect(() => call('create_session', { project_id: 'p2', prompt: 'x' }, scoped())).toThrow(ToolError);
    expect(started).toEqual([]);
    call('create_session', { project_id: 'p1' }, scoped());
    expect(started).toHaveLength(1);
  });

  it('create_session は呼んだセッションを起動元として残し、handoff なら残さない', async () => {
    const parentOf = (id: string) => (db.prepare('select parent_id from session_spawns where session_id = ?').get(id) as { parent_id: string } | undefined)?.parent_id;
    await call('create_session', { project_id: 'p1' }, scoped());
    expect(parentOf('sNew')).toBe(alphaId);
    db.prepare('delete from session_spawns').run();
    await call('create_session', { project_id: 'p1', handoff: true }, scoped());
    expect(parentOf('sNew')).toBeUndefined();
    // 共通の URL では呼んだセッションが分からないので、残さない。
    await call('create_session', { project_id: 'p1' });
    expect(parentOf('sNew')).toBeUndefined();
  });

  it('open_in_hangar は別のプロジェクトのリンクを返さない', () => {
    expect(() => call('open_in_hangar', { project_id: 'p2' }, scoped())).toThrow(ToolError);
    expect(call('open_in_hangar', { project_id: 'p1' }, scoped()).url).toContain('p1');
  });
});

describe('propose_session_status', () => {
  const scoped = () => ({ sessionId: alphaId });
  // 過去の時点は断るので、今を 2026-10-01 12:00（手元の時刻）に止める。Date だけを偽り、タイマーは本物のままにする。
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 9, 1, 12, 0)); });
  afterEach(() => { vi.useRealTimers(); });
  const NONE = { status: null, note: null, returnOn: null, returnTime: null, returnAt: null, setBy: null, setAt: null };
  it('confirmed なしは提案にし、session.upsert を配る', () => {
    const r = call('propose_session_status', { status: 'paused', note: ' 明日の朝 CPU の数字を確かめる ', return_on: '2026-10-02' }, scoped());
    expect(r).toEqual({ outcome: 'proposed', state: { ...NONE, candidate: { status: 'paused', note: '明日の朝 CPU の数字を確かめる', returnOn: '2026-10-02', returnTime: null, returnAt: null, source: 'in_session', at: expect.any(Number) } } });
    expect(sent.map((e) => e.type)).toEqual(['session.upsert']);
    // 配る状態は DTO のままで、returnAt は MCP の返事にだけ添える。
    expect(r.state).toMatchObject((sent[0] as Extract<ServerEvent, { type: 'session.upsert' }>).session.state!);
  });
  it('confirmed: true は状態にし、会話で承認した印を残す。Done は戻る日を持たない', () => {
    const r = call('propose_session_status', { status: 'done', note: '直して main に入れた', return_on: '2026-10-02', confirmed: true }, scoped());
    expect(r).toEqual({ outcome: 'set', state: { status: 'done', note: '直して main に入れた', returnOn: null, returnTime: null, returnAt: null, setBy: 'conversation', setAt: expect.any(Number), candidate: null } });
    expect(sent.map((e) => e.type)).toEqual(['session.upsert']);
  });
  it('同じ状態がすでにあれば already_set で何も書かず、何も配らない', () => {
    call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-10-02', confirmed: true }, scoped());
    sent.length = 0;
    // 書いたかどうかは連番で見る。未送信の差分は同じ行ごとに 1 つへまとまるので、件数では見えない。
    const lastSeq = () => (db.prepare("select max(seq) s from changes where table_name = 'session_states'").get() as { s: number | null }).s;
    const before = lastSeq();
    expect(call('propose_session_status', { status: 'paused', note: '別の根拠', return_on: '2026-10-02', confirmed: true }, scoped()).outcome).toBe('already_set');
    expect(call('propose_session_status', { status: 'done', note: 'n' }, scoped()).outcome).toBe('already_set');
    expect(sent).toEqual([]);
    expect(lastSeq()).toBe(before);
    // 戻る日が違えば会話で選び直したことになる。
    expect(call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-10-05', confirmed: true }, scoped()).outcome).toBe('set');
  });
  it('却下された後の提案は rejected_before。会話で選んだものは通る', () => {
    call('propose_session_status', { status: 'done', note: 'n' }, scoped());
    rejectSessionState(db, 'd', alphaId);
    // 試験が直に書いた却下のイベントを、先に出し切ってから数え始める。
    publisher.flush();
    sent.length = 0;
    expect(call('propose_session_status', { status: 'done', note: 'もう一度' }, scoped()).outcome).toBe('rejected_before');
    expect(sent).toEqual([]);
    expect(call('propose_session_status', { status: 'done', note: '選んだ', confirmed: true }, scoped()).outcome).toBe('set');
  });
  it('誤りの入力は ToolError で、何も書かず、何も配らない（note と return_on の検査は states.ts に任せる）', () => {
    const bad: Record<string, unknown>[] = [
      { status: 'done', note: '' }, { status: 'done', note: '   ' }, { status: 'done', note: 'あ'.repeat(201) }, { status: 'done' },
      { status: 'paused', note: 'n', return_time: '10:00' }, { status: 'paused', note: 'n', return_on: '2026/10/02' }, { status: 'paused', note: 'n', return_on: '2026-02-30' },
      { status: 'paused', note: 'n', return_on: 20261002 }, { status: 'paused', note: 'n', return_on: '2026/10/02', confirmed: true },
      { status: 'done', note: '', confirmed: true }, { status: 'done', note: '   ', confirmed: true }, { status: 'done', confirmed: true },
      { status: 'done', note: 'あ'.repeat(201), confirmed: true }, { status: 'done', note: 'n', return_on: 'garbage' }, { status: 'done', note: 'n', return_on: 'garbage', confirmed: true },
      { status: 'archived', note: 'n' }, { note: 'n' }, { status: 'done', note: 'n', confirmed: 'yes' },
    ];
    for (const args of bad) expect(() => call('propose_session_status', args, scoped()), JSON.stringify(args)).toThrow(ToolError);
    expect(sent).toEqual([]);
    expect(db.prepare('select count(*) c from session_states').get()).toEqual({ c: 0 });
    // ちょうど 200 字は通る。
    expect(call('propose_session_status', { status: 'done', note: 'あ'.repeat(200) }, scoped()).outcome).toBe('proposed');
  });
  it('すでに同じ状態があっても、検査は already_set の比べより先に行う', () => {
    call('propose_session_status', { status: 'done', note: 'n', confirmed: true }, scoped());
    sent.length = 0;
    for (const args of [{ status: 'done', note: 'あ'.repeat(201), confirmed: true }, { status: 'done', note: '', confirmed: true }, { status: 'done', note: 'n', return_on: 'garbage', confirmed: true }]) {
      expect(() => call('propose_session_status', args, scoped()), JSON.stringify(args)).toThrow(ToolError);
    }
    expect(sent).toEqual([]);
    // 形の正しい戻る日は、Done では捨てられて同じ状態と見なされる。
    expect(call('propose_session_status', { status: 'done', note: 'n', return_on: '2026-10-02', confirmed: true }, scoped()).outcome).toBe('already_set');
  });
  it('日付だけの呼び出しは今までどおり通り、時刻は null で返る。今日の日付も通る', () => {
    const r = call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-10-02', confirmed: true }, scoped());
    expect(r).toEqual({ outcome: 'set', state: { status: 'paused', note: 'n', returnOn: '2026-10-02', returnTime: null, returnAt: null, setBy: 'conversation', setAt: expect.any(Number), candidate: null } });
    expect(call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-10-01', confirmed: true }, scoped()).outcome).toBe('set');
  });
  it('日付と時刻を渡すと、時刻と、オフセット付きの時点が返る', () => {
    const r = call('propose_session_status', { status: 'paused', note: 'timer の初回を表示', return_on: '2026-10-01', return_time: '13:30', confirmed: true }, scoped());
    expect(r.outcome).toBe('set');
    const state = r.state as { returnOn: string; returnTime: string; returnAt: string };
    expect(state).toMatchObject({ status: 'paused', returnOn: '2026-10-01', returnTime: '13:30' });
    expect(state.returnAt).toMatch(/^2026-10-01T13:30[+-]\d{2}:\d{2}$/);
    expect(new Date(state.returnAt).getTime()).toBe(new Date(2026, 9, 1, 13, 30).getTime());
    expect((sent[0] as Extract<ServerEvent, { type: 'session.upsert' }>).session.state).toMatchObject({ returnOn: '2026-10-01', returnTime: '13:30' });
    // 同じ日でも時刻が違えば選び直しになり、同じなら already_set。
    expect(call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-10-01', return_time: '13:30', confirmed: true }, scoped()).outcome).toBe('already_set');
    expect(call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-10-01', return_time: '21:50', confirmed: true }, scoped()).outcome).toBe('set');
    expect(call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-10-01', confirmed: true }, scoped()).outcome).toBe('set');
  });
  it('提案（confirmed なし）にも時刻が載る', () => {
    const r = call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-10-02', return_time: '09:00' }, scoped());
    expect((r.state as { candidate: unknown }).candidate).toMatchObject({ returnOn: '2026-10-02', returnTime: '09:00' });
    expect((r.state as { candidate: { returnAt: string } }).candidate.returnAt).toMatch(/^2026-10-02T09:00[+-]\d{2}:\d{2}$/);
  });
  // Paused の戻る日は任意（2026-10-13）。省けば日付なしの提案になり、戻る時点（returnAt）は持たない。
  it('return_on を省いた paused は、日付なしの提案になる', () => {
    const r = call('propose_session_status', { status: 'paused', note: 'レビューの返事を待つ' }, scoped());
    expect(r.outcome).toBe('proposed');
    expect((r.state as { candidate: unknown }).candidate).toMatchObject({ status: 'paused', returnOn: null, returnTime: null, returnAt: null });
  });
  it('不正な時刻は、何が悪いかを言って何も書かない', () => {
    expect(() => call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-10-02', return_time: '25:00', confirmed: true }, scoped())).toThrow(new ToolError('リマインダーの時刻は HH:MM 形式の 00:00〜23:59 で指定してください（25:00）'));
    expect(() => call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-10-02', return_time: 1330 }, scoped())).toThrow(new ToolError('return_time は HH:MM の形式の文字列です'));
    // 時刻だけでは戻る時点にならない。
    expect(() => call('propose_session_status', { status: 'paused', note: 'n', return_time: '13:30' }, scoped())).toThrow(new ToolError('リマインダーの時刻は日付と一緒に指定してください'));
    expect(sent).toEqual([]);
    expect(db.prepare('select count(*) c from session_states').get()).toEqual({ c: 0 });
  });
  it('過去の時点は、渡された時点と今を言って断る。confirmed の有無によらない', () => {
    const offset = /[+-]\d{2}:\d{2}/.source;
    // 今は 2026-10-01 12:00。同じ日の 11:59 と、ちょうど今は過去。
    for (const confirmed of [true, undefined]) {
      expect(() => call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-10-01', return_time: '11:59', confirmed }, scoped())).toThrow(new RegExp(`^リマインダーが過去です（2026-10-01 11:59。現在は 2026-10-01 12:00 ${offset}）$`));
      expect(() => call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-10-01', return_time: '12:00', confirmed }, scoped())).toThrow(/^リマインダーが過去です/);
      expect(() => call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-09-30', confirmed }, scoped())).toThrow(new RegExp(`^リマインダーの日付が過去です（2026-09-30。現在は 2026-10-01 12:00 ${offset}）$`));
      expect(() => call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-09-30', return_time: '23:59', confirmed }, scoped())).toThrow(/^リマインダーが過去です（2026-09-30 23:59。/);
    }
    expect(sent).toEqual([]);
    expect(db.prepare('select count(*) c from session_states').get()).toEqual({ c: 0 });
    // 1 分先は通る。
    expect(call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-10-01', return_time: '12:01', confirmed: true }, scoped()).outcome).toBe('set');
  });
  it('Done は戻る時点を持たないので、過去の日付や時刻が付いていても断らずに捨てる', () => {
    const r = call('propose_session_status', { status: 'done', note: 'n', return_on: '2026-09-01', return_time: '09:00', confirmed: true }, scoped());
    expect(r.state).toMatchObject({ status: 'done', returnOn: null, returnTime: null, returnAt: null });
  });
  it('共通の URL では session_id が要り、セッション別 URL では別のセッションを指せない', () => {
    expect(() => call('propose_session_status', { status: 'done', note: 'n' })).toThrow(/session_id/);
    expect(call('propose_session_status', { session_id: alphaId, status: 'done', note: 'n' }).outcome).toBe('proposed');
    expect(() => call('propose_session_status', { session_id: 'other', status: 'done', note: 'n' }, scoped())).toThrow(ToolError);
  });
});

describe('作者への問い合わせ', () => {
  it('draft_issue_report と submit_issue_report は report の口へ渡す', async () => {
    const draft = vi.fn(async () => ({ draft_id: 'x' }));
    const submit = vi.fn(async () => ({ sent_via: 'gh', url: 'u' }));
    deps = { ...deps, report: { draft, submit } as unknown as NonNullable<ToolDeps['report']> };
    await expect(callTool(deps, { sessionId: null }, 'draft_issue_report', { kind: 'bug' })).resolves.toEqual({ draft_id: 'x' });
    await expect(callTool(deps, { sessionId: alphaId }, 'submit_issue_report', { draft_id: 'x', confirmed: true })).resolves.toEqual({ sent_via: 'gh', url: 'u' });
    expect(draft).toHaveBeenCalledWith({ kind: 'bug' });
    expect(submit).toHaveBeenCalledWith({ draft_id: 'x', confirmed: true });
  });

  it('report の口が無ければ断る', () => {
    expect(() => callTool(deps, { sessionId: null }, 'draft_issue_report', {})).toThrow(ToolError);
  });
});
