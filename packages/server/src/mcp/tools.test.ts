import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveSessionDto, ServerEvent } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { IndexerService } from '../indexer/service.ts';
import { assignSessions } from '../projects/registry.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { callTool, ToolError, TOOL_NAMES, type ToolDeps } from './tools.ts';

let dir: string;
let db: Db;
let alphaId: string;
const sent: ServerEvent[] = [];
const live: LiveSessionDto[] = [{ sessionId: SESSION_ALPHA, status: 'busy', name: null, nameSource: null, cwd: '/Users/me/workspace/alpha', pid: 1 }];
const started: unknown[] = [];
let deps: ToolDeps;

beforeEach(async () => {
  dir = copyFixtureClaudeDir(); db = openDb(':memory:'); sent.length = 0; started.length = 0;
  await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: 'd', path: '/Users/me/workspace/alpha', resolved: 1 }, 'd');
  assignSessions(db, 'd');
  alphaId = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
  deps = { db, deviceId: 'd', port: 4177, live: () => live, hub: { broadcast: (e) => sent.push(e) },
    runs: { start: (p) => { started.push(p); return { run: { id: 'r1', sessionId: 'sNew', deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 }, sessionId: 'sNew', tabs: [] }; } } };
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const call = (name: string, args: Record<string, unknown> = {}, ctx = { sessionId: null as string | null }) => callTool(deps, ctx, name, args) as Record<string, unknown>;

/** session_id を取るツールと、それ以外の必須引数。存在の検査をまとめて確かめる。 */
const SESSION_TOOL_CALLS: [string, Record<string, unknown>][] = [
  ['get_transcript', {}],
  ['set_session_summary', { title: 'T', one_liner: 'O', body: 'B', state: 'done', next_steps: [] }],
  ['set_session_memo', { text: 'メモ' }],
  ['open_in_hangar', {}],
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
  });
  it('update_project は status だけ書き、TODO とメモは not_yet', () => {
    const r = call('update_project', { project_id: 'p1', status: 'paused', add_todos: ['x'] });
    expect((r.project as { status: string }).status).toBe('paused');
    expect(r.not_yet).toEqual({ fields: ['add_todos'], message: 'フェーズ 3 で対応します' });
    expect(sent.at(-1)).toMatchObject({ type: 'project.upsert', project: { id: 'p1', status: 'paused' } });
    expect(() => call('update_project', { project_id: 'p1', status: 'bogus' })).toThrow(ToolError);
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
  it('set_session_memo、get_usage、open_in_hangar', () => {
    expect(call('set_session_memo', { session_id: alphaId, text: 'メモ' })).toEqual({ ok: true, session_id: alphaId });
    expect((db.prepare('select memo from sessions where id = ?').get(alphaId) as { memo: string }).memo).toBe('メモ');
    expect(call('get_usage')).toEqual({ not_yet: 'フェーズ 3 で対応します' });
    expect(call('open_in_hangar', { session_id: alphaId })).toEqual({ url: `http://127.0.0.1:4177/#/session/${alphaId}`, deep_link: `hangar://session/${alphaId}` });
    expect(call('open_in_hangar', { project_id: 'p1' })).toEqual({ url: 'http://127.0.0.1:4177/#/project/p1', deep_link: 'hangar://project/p1' });
    expect(call('open_in_hangar', {}, { sessionId: alphaId }).url).toContain(alphaId);
    expect(() => call('nope')).toThrow(ToolError);
    expect(TOOL_NAMES).toHaveLength(11);
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
