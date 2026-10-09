import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveSessionDto, ServerEvent } from '@agent-hangar/shared';
import { recordArtifactPublish } from '../artifacts/extract.ts';
import { openDb, type Db } from '../db/open.ts';
import { Publisher } from '../events/publisher.ts';
import { upsertShared } from '../db/shared.ts';
import { IndexerService } from '../indexer/service.ts';
import { latestIntent } from '../live/intents.ts';
import { MemoStore } from '../projects/memo.ts';
import { assignSessions } from '../projects/registry.ts';
import { rejectSessionState } from '../sessions/states.ts';
import { AccountStore } from '../config/accounts.ts';
import { UsageTracker } from '../usage/statusline.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA, SESSION_OTHER } from '../../test/fixtures.ts';
import { callTool, ToolError, TOOL_NAMES, type ToolDeps } from './tools.ts';

let dir: string;
let home: string;
let db: Db;
let alphaId: string;
const sent: ServerEvent[] = [];
const live: LiveSessionDto[] = [{ sessionId: SESSION_ALPHA, status: 'busy', name: null, nameSource: null, cwd: '/Users/me/workspace/alpha', pid: 1 }];
const started: unknown[] = [];
let deps: ToolDeps;
/** 道具は行を書くだけである。画面へのイベントは、配る層が書いた行から組んで sent へ渡す。 */
let publisher: Publisher;

beforeEach(async () => {
  dir = copyFixtureClaudeDir(); home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mcp-')); db = openDb(':memory:'); sent.length = 0; started.length = 0;
  await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: 'd', path: '/Users/me/workspace/alpha', resolved: 1 }, 'd');
  assignSessions(db, 'd');
  alphaId = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
  publisher = new Publisher({ db, deviceId: 'd', live: () => live, hub: { broadcast: (e) => { sent.push(e); } } });
  deps = { db, deviceId: 'd', port: 4177, live: () => live,
    runs: { start: (p) => { started.push(p); return { run: { id: 'r1', sessionId: 'sNew', deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 }, sessionId: 'sNew', tabs: [] }; } },
    usage: () => ({ fiveHour: { usedPercent: 47, resetsAt: 1_760_000_000_000 }, sevenDay: null, updatedAt: 5 }),
    memos: new MemoStore({ db, deviceId: 'd', home }) };
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

/** session_id を取るツールと、それ以外の必須引数。存在の検査をまとめて確かめる。 */
const SESSION_TOOL_CALLS: [string, Record<string, unknown>][] = [
  ['get_transcript', {}],
  ['set_session_summary', { title: 'T', one_liner: 'O', body: 'B', state: 'done', next_steps: [] }],
  ['set_session_memo', { text: 'メモ' }],
  ['set_turn_intent', { text: '意図' }],
  ['open_in_hangar', {}],
  ['propose_session_status', { status: 'done', note: '済んだ' }],
];

describe('MCP tools', () => {
  it('list_projects と get_project', () => {
    const list = call('list_projects') as unknown as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'p1', name: 'alpha', status: 'active', path: '/Users/me/workspace/alpha', open_todo_count: 0 });
    const p = call('get_project', { project_id: 'p1' });
    expect(p).toMatchObject({ id: 'p1', memo: null, todos: [], artifacts: [] });
    expect((p.recent_sessions as { id: string }[]).map((s) => s.id)).toEqual([alphaId]);
    expect(() => call('get_project', { project_id: 'nope' })).toThrow(ToolError);
    call('update_project', { project_id: 'p1', add_todos: ['a'], append_memo: 'm' });
    recordArtifactPublish(db, 'd', { sessionId: alphaId, projectId: 'p1', url: 'https://claude.ai/code/artifact/z', publishedAt: 7, call: { filePath: null, description: 'Z', favicon: '🧪' } });
    const p2 = call('get_project', { project_id: 'p1' });
    expect(p2.memo).toBe('m');
    expect((p2.todos as unknown[]).length).toBe(1);
    expect(p2.artifacts).toEqual([{ id: expect.any(String), url: 'https://claude.ai/code/artifact/z', title: 'Z', favicon: '🧪', last_published_at: 7, version_count: 1 }]);
  });
  it('update_project は status、TODO、メモを書き、イベントを配る', () => {
    const r = call('update_project', { project_id: 'p1', status: 'paused', add_todos: ['x', 'y'], append_memo: '## 追記' }, { sessionId: alphaId });
    expect((r.project as { status: string }).status).toBe('paused');
    expect((r.todos as { text: string; done: boolean; session_id: string | null }[]).map((t) => [t.text, t.done, t.session_id])).toEqual([['x', false, alphaId], ['y', false, alphaId]]);
    expect(r.memo).toBe('## 追記');
    // 状態、TODO、メモを 1 回の呼び出しで変えても、プロジェクトは最後の中身で 1 回だけ届く。
    expect(sent.map((e) => e.type)).toEqual(['todos.update', 'memo.update', 'project.upsert']);
    expect(sent[0]).toMatchObject({ type: 'todos.update', projectId: 'p1', todos: [{ text: 'x' }, { text: 'y' }] });
    expect(sent[1]).toMatchObject({ type: 'memo.update', memo: { projectId: 'p1', markdown: '## 追記' } });
    expect(sent[2]).toMatchObject({ type: 'project.upsert', project: { id: 'p1', status: 'paused', openTodoCount: 2, memoHead: '## 追記' } });
    const ids = (r.todos as { id: string }[]).map((t) => t.id);
    const r2 = call('update_project', { project_id: 'p1', toggle_todos: [ids[0]!], append_memo: '続き' });
    // toggle_todos は未完を完了にしない。候補にするだけで、未完の数も変わらない。
    expect((r2.todos as { done: boolean; candidate: unknown }[]).map((t) => [t.done, t.candidate])).toEqual([[false, { session_id: null, note: null }], [false, null]]);
    expect(r2.todo_results).toEqual([{ todo_id: ids[0], outcome: 'proposed' }]);
    expect(r2.memo).toBe('## 追記\n\n続き');
    expect((r2.project as { open_todo_count: number }).open_todo_count).toBe(2);
    expect(() => call('update_project', { project_id: 'p1', status: 'bogus' })).toThrow(ToolError);
    expect(() => call('update_project', { project_id: 'p1', toggle_todos: ['nope'] })).toThrow(/nope/);
  });
  it('propose_done は根拠つきの候補を出し、TODO ごとの結果を返す', () => {
    const r = call('update_project', { project_id: 'p1', add_todos: ['a', 'b', 'c'] });
    const [a, b, c] = (r.todos as { id: string }[]).map((t) => t.id);
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
    const r = call('update_project', { project_id: 'p1', add_todos: ['a'] });
    const a = (r.todos as { id: string }[])[0]!.id;
    call('update_project', { project_id: 'p1', propose_done: [{ todo_id: a, note: 'n' }] }, { sessionId: alphaId });
    rejectTodo(db, 'd', a);
    expect(call('update_project', { project_id: 'p1', propose_done: [{ todo_id: a, note: 'もう一度' }] }, { sessionId: alphaId }).todo_results).toEqual([{ todo_id: a, outcome: 'rejected_before' }]);
    expect(call('update_project', { project_id: 'p1', toggle_todos: [a] }, { sessionId: alphaId }).todo_results).toEqual([{ todo_id: a, outcome: 'rejected_before' }]);
  });
  it('toggle_todos は完了を開き直し、候補には何もしない', async () => {
    const { setTodoDone } = await import('../projects/todos.ts');
    const r = call('update_project', { project_id: 'p1', add_todos: ['a', 'b'] });
    const [a, b] = (r.todos as { id: string }[]).map((t) => t.id);
    setTodoDone(db, 'd', a!, true);
    call('update_project', { project_id: 'p1', toggle_todos: [b!] });
    const r2 = call('update_project', { project_id: 'p1', toggle_todos: [a!, b!] });
    expect(r2.todo_results).toEqual([{ todo_id: a, outcome: 'reopened' }, { todo_id: b, outcome: 'already_candidate' }]);
    expect((r2.todos as { done: boolean }[]).map((t) => t.done)).toEqual([false, false]);
  });
  it('propose_done の検証に落ちる呼び出しは、status も書かず何も配らない', () => {
    const r = call('update_project', { project_id: 'p1', add_todos: ['a'] });
    const a = (r.todos as { id: string }[])[0]!.id;
    sent.length = 0;
    expect(() => call('update_project', { project_id: 'p1', status: 'paused', propose_done: [{ todo_id: a, note: '' }] })).toThrow(ToolError);
    expect((db.prepare('select status from projects where id = ?').get('p1') as { status: string }).status).toBe('active');
    expect(sent).toEqual([]);
  });
  it('同じ TODO が propose_done と toggle_todos の両方にあれば、根拠つきの提案が勝つ', () => {
    const r = call('update_project', { project_id: 'p1', add_todos: ['a'] });
    const a = (r.todos as { id: string }[])[0]!.id;
    const r2 = call('update_project', { project_id: 'p1', toggle_todos: [a], propose_done: [{ todo_id: a, note: '試験で確かめた' }] }, { sessionId: alphaId });
    expect(r2.todo_results).toEqual([{ todo_id: a, outcome: 'proposed' }, { todo_id: a, outcome: 'already_candidate' }]);
    expect((r2.todos as { id: string; candidate: { note: string } | null }[]).find((t) => t.id === a)!.candidate!.note).toBe('試験で確かめた');
  });
  it('propose_done の根拠が空白だけか 200 字を超えるか、見つからない ID があれば、どの TODO も書かない', () => {
    const r = call('update_project', { project_id: 'p1', add_todos: ['a'] });
    const a = (r.todos as { id: string }[])[0]!.id;
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
    const r = call('update_project', { project_id: 'p1', add_todos: ['x'] });
    const id = (r.todos as { id: string }[])[0]!.id;
    sent.length = 0;
    expect(() => call('update_project', { project_id: 'p1', add_todos: ['y'], toggle_todos: [id, 'nope'] })).toThrow(/nope/);
    // 途中まで書いた分を残さない。イベントを配らずに DB だけ進むと、UI と食い違ったまま気付けない。
    expect(sent).toEqual([]);
    const p = call('get_project', { project_id: 'p1' });
    expect((p.todos as { text: string; done: boolean }[]).map((t) => [t.text, t.done])).toEqual([['x', false]]);
    expect(p.open_todo_count).toBe(1);
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
  it('create_session は runs.start を呼び、URL を返す', () => {
    const r = call('create_session', { project_id: 'p1', name: 'n', prompt: 'p', permission_mode: 'default' });
    expect(started[0]).toEqual({ projectId: 'p1', name: 'n', prompt: 'p', model: undefined, effort: undefined, permissionMode: 'default', scratch: undefined });
    expect(r).toEqual({ run_id: 'r1', session_id: 'sNew', tmux_name: 'hangar-r1', url: 'http://127.0.0.1:4177/#/session/sNew' });
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
    call('set_session_memo', { session_id: alphaId, text: 'メモ' });
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
  it('set_session_memo、get_usage、open_in_hangar', () => {
    expect(call('set_session_memo', { session_id: alphaId, text: 'メモ' })).toEqual({ ok: true, session_id: alphaId });
    expect((db.prepare('select memo from session_notes where session_id = ?').get(alphaId) as { memo: string }).memo).toBe('メモ');
    expect(call('get_usage')).toEqual({ five_hour: { used_percentage: 47, resets_at: 1_760_000_000_000 }, seven_day: null, updated_at: 5 });
    expect(call('open_in_hangar', { session_id: alphaId })).toEqual({ url: `http://127.0.0.1:4177/#/session/${alphaId}`, deep_link: `hangar://session/${alphaId}` });
    expect(call('open_in_hangar', { project_id: 'p1' })).toEqual({ url: 'http://127.0.0.1:4177/#/project/p1', deep_link: 'hangar://project/p1' });
    expect(call('open_in_hangar', {}, { sessionId: alphaId }).url).toContain(alphaId);
    expect(() => call('nope')).toThrow(ToolError);
    expect(TOOL_NAMES).toHaveLength(13);
  });
  it('set_turn_intent は意図を積み、最新を返せるようにする', () => {
    const r = call('set_turn_intent', { text: '  抜けたあと、答え終えた会話だけ止める  ' }, { sessionId: alphaId });
    expect(r).toMatchObject({ ok: true, session_id: alphaId });
    expect(latestIntent(db, alphaId)).toEqual({ at: r.at, text: '抜けたあと、答え終えた会話だけ止める' });
  });
  it('set_turn_intent は空と 201 字以上を断る', () => {
    expect(() => call('set_turn_intent', { text: '   ' }, { sessionId: alphaId })).toThrow(ToolError);
    expect(() => call('set_turn_intent', { text: 'あ'.repeat(201) }, { sessionId: alphaId })).toThrow(ToolError);
    expect(call('set_turn_intent', { text: 'あ'.repeat(200) }, { sessionId: alphaId })).toMatchObject({ ok: true });
  });
  it('set_turn_intent はセッション別 URL のほかのセッションを指せない', () => {
    expect(() => call('set_turn_intent', { session_id: 'other', text: 'x' }, { sessionId: alphaId })).toThrow(ToolError);
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

  it('get_transcript は別のセッションの本文を渡さない', () => {
    // 共通 URL からは読める。閉じ込めは URL でセッションが決まっているときだけ効く。
    expect((call('get_transcript', { session_id: otherId }).events as unknown[]).length).toBeGreaterThan(0);
    expect(() => call('get_transcript', { session_id: otherId }, scoped())).toThrow(ToolError);
    // 自分のセッションは、明示しても省いても読める。
    expect(call('get_transcript', { session_id: alphaId }, scoped()).session_id).toBe(alphaId);
    expect(call('get_transcript', {}, scoped()).session_id).toBe(alphaId);
  });

  it('セッションを取るほかの道具も、別のセッションを断る', () => {
    for (const [name, args] of SESSION_TOOL_CALLS) {
      expect(() => call(name, { ...args, session_id: otherId }, scoped())).toThrow(ToolError);
    }
    // 別のセッションのメモも要約も書かれていない。
    expect(db.prepare('select memo from session_notes where session_id = ?').get(otherId)).toBeUndefined();
    expect((db.prepare('select title from session_summaries where session_id = ?').get(otherId) as { title: string } | undefined)?.title).not.toBe('T');
  });

  it('list_projects は自分のプロジェクトだけを返す', () => {
    expect((call('list_projects') as unknown as { id: string }[]).map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    expect((callTool(deps, scoped(), 'list_projects', {}) as { id: string }[]).map((p) => p.id)).toEqual(['p1']);
  });

  it('get_project と update_project は別のプロジェクトを断る', () => {
    expect(() => call('get_project', { project_id: 'p2' }, scoped())).toThrow(ToolError);
    expect(() => call('update_project', { project_id: 'p2', status: 'archived', append_memo: '注入' }, scoped())).toThrow(ToolError);
    expect((db.prepare('select status from projects where id = ?').get('p2') as { status: string }).status).toBe('active');
    expect(fs.existsSync(path.join(home, 'projects', 'p2', 'memo.md'))).toBe(false);
    // 自分のプロジェクトは触れる。
    expect(call('get_project', { project_id: 'p1' }, scoped()).id).toBe('p1');
    expect(call('update_project', { project_id: 'p1', append_memo: 'ok' }, scoped()).memo).toBe('ok');
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
      { status: 'paused', note: 'n' }, { status: 'paused', note: 'n', return_on: '2026/10/02' }, { status: 'paused', note: 'n', return_on: '2026-02-30' },
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
    const r = call('propose_session_status', { status: 'paused', note: 'timer の初回を見る', return_on: '2026-10-01', return_time: '13:30', confirmed: true }, scoped());
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
  it('不正な時刻は、何が悪いかを言って何も書かない', () => {
    expect(() => call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-10-02', return_time: '25:00', confirmed: true }, scoped())).toThrow(new ToolError('戻る時刻は HH:MM の形で、00:00〜23:59 です（25:00）'));
    expect(() => call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-10-02', return_time: 1330 }, scoped())).toThrow(new ToolError('return_time は HH:MM の形の文字列です'));
    // 時刻だけでは戻る時点にならない。
    expect(() => call('propose_session_status', { status: 'paused', note: 'n', return_time: '13:30' }, scoped())).toThrow(new ToolError('Paused には戻る日が要ります'));
    expect(sent).toEqual([]);
    expect(db.prepare('select count(*) c from session_states').get()).toEqual({ c: 0 });
  });
  it('過去の時点は、渡された時点と今を言って断る。confirmed の有無によらない', () => {
    const offset = /[+-]\d{2}:\d{2}/.source;
    // 今は 2026-10-01 12:00。同じ日の 11:59 と、ちょうど今は過去。
    for (const confirmed of [true, undefined]) {
      expect(() => call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-10-01', return_time: '11:59', confirmed }, scoped())).toThrow(new RegExp(`^戻る時点が過去です（2026-10-01 11:59。いまは 2026-10-01 12:00 ${offset}）$`));
      expect(() => call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-10-01', return_time: '12:00', confirmed }, scoped())).toThrow(/^戻る時点が過去です/);
      expect(() => call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-09-30', confirmed }, scoped())).toThrow(new RegExp(`^戻る日が過去です（2026-09-30。いまは 2026-10-01 12:00 ${offset}）$`));
      expect(() => call('propose_session_status', { status: 'paused', note: 'n', return_on: '2026-09-30', return_time: '23:59', confirmed }, scoped())).toThrow(/^戻る時点が過去です（2026-09-30 23:59。/);
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
