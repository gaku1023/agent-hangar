import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveSessionDto, ServerEvent } from '@agent-hangar/shared';
import type { Db } from '../../db/open.ts';
import { softDeleteShared, upsertShared } from '../../db/shared.ts';
import { TOOL_NAMES } from '../../mcp/tools.ts';
import { issueMcpSecret } from '../../runs/secrets.ts';
import { proposeSessionState, setSessionState } from '../../sessions/states.ts';
import { SESSION_ALPHA } from '../../../test/fixtures.ts';
import { createApp, type AppDeps, type ExternalApi, type RunsApi, type SummaryApi, type SummaryEnqueueOpts } from '../app.ts';
import { H, run, testDeps, testResult, TOKEN, type TestWorld } from '../testing.ts';

// セッションの経路（routes/sessions.ts）の試験。依存は testDeps() で組み、createApp を通して /api の下から叩く。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let dir: string;
let db: Db;
let ws: string;
let deps: AppDeps;
let sent: ServerEvent[];
let runs: RunsApi;
let external: ExternalApi;
let summary: SummaryApi & { enqueued: [string, SummaryEnqueueOpts | undefined][] };
/** ワークスペースから登録される唯一のプロジェクト alpha の id。 */
let list0ProjectId: () => string;
const get = (p: string, headers: Record<string, string> = H) => app.request(p, { headers });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

beforeEach(async () => {
  t = await testDeps();
  ({ db, ws, runs, external, summary, deps } = t);
  dir = t.claudeDir; sent = t.events; list0ProjectId = t.alphaProjectId;
  app = createApp(deps);
});
afterEach(() => { t.dispose(); });

describe('routes', () => {
  it('セッションと本文とサブエージェント', async () => {
    const { body: sessions } = await json(await get('/api/sessions'));
    const alpha = sessions.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA);
    expect((await json(await get(`/api/sessions/${alpha.id}`))).body.name).toBe('channels-cleanup');
    const { body: page } = await json(await get(`/api/sessions/${alpha.id}/events?fromSeq=0&limit=5`));
    expect(page.events).toHaveLength(5);
    expect(page.nextSeq).toBe(5);
    expect((await json(await get(`/api/sessions/${alpha.id}/subagents`))).body).toEqual(['abc123']);
    expect((await json(await get(`/api/sessions/${alpha.id}/events?agentId=abc123`))).body.events).toHaveLength(2);
    expect((await get('/api/sessions/nope')).status).toBe(404);
  });
  it('本文は最新の側からも、その手前へも読める', async () => {
    const { body: sessions } = await json(await get('/api/sessions'));
    const alpha = sessions.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA);
    const { body: latest } = await json(await get(`/api/sessions/${alpha.id}/events?latest=1&limit=5`));
    expect(latest.events.map((e: { seq: number }) => e.seq)).toEqual([12, 13, 14, 15, 16]);
    expect(latest.total).toBe(17);
    // 末尾から読んだページに「次の前向きのページ」は無い。
    expect(latest.nextSeq).toBeNull();
    const { body: older } = await json(await get(`/api/sessions/${alpha.id}/events?before=12&limit=5`));
    expect(older.events.map((e: { seq: number }) => e.seq)).toEqual([7, 8, 9, 10, 11]);
    // 先頭より古い行は無い。
    expect((await json(await get(`/api/sessions/${alpha.id}/events?before=0`))).body.events).toEqual([]);
  });
  it('本文ファイルが消えていれば 404', async () => {
    const { body: sessions } = await json(await get('/api/sessions'));
    const alpha = sessions.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA);
    for (const f of fs.readdirSync(path.join(dir, 'projects'), { recursive: true }) as string[]) {
      if (f.includes(SESSION_ALPHA) && f.endsWith('.jsonl')) fs.rmSync(path.join(dir, 'projects', f));
    }
    const r = await get(`/api/sessions/${alpha.id}/events`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'このセッションの本文はこの PC にありません' });
  });
  it('GET /api/sessions/:id/live はライブの要約を返し、無いセッションは 404', async () => {
    const id = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
    const r = await json(await get(`/api/sessions/${id}/live`));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sessionId: id, intent: null });
    expect(Array.isArray(r.body.agents)).toBe(true);
    expect((await get('/api/sessions/ghost/live')).status).toBe(404);
  });
  it('GET /api/sessions/:id/live は、渡された要約器を使う（裏の印と覚えを共有し、同じ要約を二度作らない）', async () => {
    const id = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
    const asked: string[] = [];
    app = createApp({ ...deps, digester: { digest: (sid) => { asked.push(sid); return { sessionId: sid, turnStartSeq: 42, intent: null, agents: [] }; } } });
    expect((await json(await get(`/api/sessions/${id}/live`))).body).toEqual({ sessionId: id, turnStartSeq: 42, intent: null, agents: [] });
    expect(asked).toEqual([id]);
  });
  it('検索', async () => {
    const { body } = await json(await get('/api/search?q=' + encodeURIComponent('チャンネル')));
    expect(body.total).toBe(1);
    expect((await json(await get('/api/search?q=channels'))).body.hits).toHaveLength(1);
    expect((await json(await get('/api/search?q='))).body).toEqual({ hits: [], total: 0 });
    // キーワードが無くても、触ったファイルで絞れる。
    expect((await json(await get('/api/search?q=&file=a.md'))).body.total).toBe(1);
    // 続きは offset で読む。件数は全件のまま。
    expect((await json(await get('/api/search?q=channels&offset=1'))).body).toEqual({ hits: [], total: 1 });
  });
  it('検索の状態の絞り込みは、実行中（作業中、休み、起動中）、入力待ち、終了に分ける', async () => {
    const { body: sessions } = await json(await get('/api/sessions'));
    const alpha = sessions.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA);
    const total = async (live: string) => (await json(await get(`/api/search?q=channels&live=${live}`))).body.total;
    // run も Claude の一覧も無ければ終了。
    expect(await total('ended')).toBe(1);
    expect(await total('running')).toBe(0);
    // hangar の run が生きていれば、Claude の一覧に載る前でも起動中として実行中に数える。
    vi.mocked(runs.listAlive).mockReturnValue({ runs: [{ ...run, sessionId: alpha.id }], tabs: [] });
    expect(await total('running')).toBe(1);
    expect(await total('ended')).toBe(0);
    // 入力待ちは run があっても実行中に入れず、別に数える。
    const waiting: LiveSessionDto = { sessionId: SESSION_ALPHA, status: 'waiting', name: null, nameSource: null, cwd: ws, pid: 1 };
    app = createApp({ ...deps, live: () => [waiting] });
    expect(await total('waiting')).toBe(1);
    expect(await total('running')).toBe(0);
  });
  it('検索は、区切りを付けて休みのまま残っているものを実行中にも Active にも数えない', async () => {
    const { body: sessions } = await json(await get('/api/sessions'));
    const alpha = sessions.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA);
    const total = async (qs: string) => (await json(await get(`/api/search?q=channels&${qs}`))).body.total;
    const idle: LiveSessionDto = { sessionId: SESSION_ALPHA, status: 'idle', name: null, nameSource: null, cwd: ws, pid: 1, procStart: 'Fri Oct  2 02:30:05 2026' };
    vi.mocked(runs.listAlive).mockReturnValue({ runs: [{ ...run, sessionId: alpha.id }], tabs: [] });
    app = createApp({ ...deps, live: () => [idle] });
    expect(await total('live=running')).toBe(1);
    setSessionState(db, 'd', alpha.id, { status: 'paused', note: '明日見る', returnOn: '2026-10-03', setBy: 'conversation', now: Date.UTC(2026, 9, 2, 3, 0, 0) });
    expect(await total('live=running')).toBe(0);
    expect(await total('live=ended')).toBe(1);
    expect(await total('status=active')).toBe(0);
    // 作業中に戻れば、印が付いていても実行中に数える。
    app = createApp({ ...deps, live: () => [{ ...idle, status: 'busy' }] });
    expect(await total('live=running')).toBe(1);
    // Active は状態の無いものなので、印の付いたものは作業中でも Paused に数える。
    expect(await total('status=active')).toBe(0);
    expect(await total('status=paused')).toBe(1);
  });
  it('検索はセッションの状態（status）と、Archived を除く印（hideArchived）を受け、知らない値は無視する', async () => {
    const id = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
    setSessionState(db, 'd', id, { status: 'archived', setBy: 'user' });
    const total = async (qs: string) => (await json(await get(`/api/search?q=channels${qs}`))).body.total;
    expect(await total('')).toBe(1);
    expect(await total('&hideArchived=true')).toBe(0);
    expect(await total('&status=archived&hideArchived=true')).toBe(1);
    expect(await total('&status=done')).toBe(0);
    // 知らない値は絞り込みなしとして扱う。
    expect(await total('&status=bogus')).toBe(1);
    // なくした none も知らない値で、絞り込みなしになる。
    expect(await total('&status=none')).toBe(1);
  });
  it('変更したファイルの一覧は、編集系のツールの呼び出しをパスでまとめて、索引した順に返す', async () => {
    const id = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
    const at = '/Users/me/workspace/alpha/channels/a.md';
    // 索引にあるのは、メイン会話の Edit 1 回だけ。
    expect(await json(await get(`/api/sessions/${id}/files`))).toEqual({ status: 200, body: { files: [{ path: at, edits: 1, agentId: null }] } });
    const row = db.prepare("insert into event_index (session_id, seq, kind, byte_offset, byte_length, file_path_ref, parent_agent, tool_name, file_path) values (?, ?, 'tool_call', 0, 0, 'x', ?, ?, ?)");
    row.run(id, 900_001, null, 'Edit', at);
    row.run(id, 900_002, null, 'MultiEdit', at);
    // サブエージェントだけが触ったファイルは、そのサブエージェントの id を添える。
    row.run(id, 900_003, 'abc123', 'Write', '/w/only-agent.ts');
    row.run(id, 900_004, 'def456', 'Edit', '/w/only-agent.ts');
    // サブエージェントが先に触り、メイン会話も触ったファイルは null。
    row.run(id, 900_005, 'abc123', 'Edit', '/w/both.ts');
    row.run(id, 900_006, null, 'NotebookEdit', '/w/both.ts');
    // 読んだだけのパスと、パスの無い呼び出しと、ほかのセッションの編集は入れない。
    row.run(id, 900_007, null, 'Read', '/w/read-only.ts');
    row.run(id, 900_008, null, 'Edit', null);
    row.run('another-session', 900_009, null, 'Edit', '/w/other-session.ts');
    const { status, body } = await json(await get(`/api/sessions/${id}/files`));
    expect(status).toBe(200);
    expect(body).toEqual({ files: [
      { path: at, edits: 3, agentId: null },
      { path: '/w/only-agent.ts', edits: 2, agentId: 'abc123' },
      { path: '/w/both.ts', edits: 2, agentId: null },
    ] });
  });
  it('変更したファイルの一覧は、見つからないセッションに 404、編集の無いセッションに空の一覧を返す', async () => {
    expect((await get('/api/sessions/nope/files')).status).toBe(404);
    const id = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
    db.prepare('delete from event_index where session_id = ?').run(id);
    expect(await json(await get(`/api/sessions/${id}/files`))).toEqual({ status: 200, body: { files: [] } });
    expect((await app.request(`/api/sessions/${id}/files`)).status).toBe(401);
  });
  it('外部連携の失敗は、トークンを伏せて 1 行に切り詰めて返す', async () => {
    const { body: sessions } = await json(await get('/api/sessions'));
    const alpha = sessions.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA);
    const fail = (message: string) => (external.openEditor as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error(message));
    fail(`spawn failed: --mcp-config {"token":"${TOKEN}"}\n2 行目`);
    const r = await post(`/api/sessions/${alpha.id}/open-editor`);
    expect(r.status).toBe(500);
    const msg = (await r.json()).error as string;
    expect(msg).not.toContain(TOKEN);
    expect(msg).toContain('***');
    expect(msg).not.toContain('2 行目');
    fail('あ'.repeat(500));
    const long = await post(`/api/sessions/${alpha.id}/open-editor`);
    expect(((await long.json()).error as string).length).toBeLessThanOrEqual(201);
  });
  const post = (p: string, body?: unknown, method = 'POST') => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const alphaId = async () => { const { body } = await json(await get('/api/sessions')); return body.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA).id as string; };
  it('セッションのメモ、昇格、要約', async () => {
    const id = await alphaId();
    const r = await post(`/api/sessions/${id}`, { memo: '一行' }, 'PATCH');
    expect((await r.json()).memo).toBe('一行');
    expect(sent.at(-1)).toMatchObject({ type: 'session.upsert', session: { id, memo: '一行' } });
    expect((await post('/api/sessions/nope', { memo: 'x' }, 'PATCH')).status).toBe(404);
    const p = await post(`/api/sessions/${id}/promote`, { name: 'newp', gitInit: false, moveFiles: true });
    expect(p.status).toBe(201);
    expect(await p.json()).toMatchObject({ moved: true, reason: null, project: { id: list0ProjectId() }, session: { id } });
    expect((await post(`/api/sessions/${id}/promote`, { name: 'taken', gitInit: false, moveFiles: false })).status).toBe(409);
    expect((await post(`/api/sessions/${id}/promote`, { gitInit: false })).status).toBe(400);
    const s = await post(`/api/sessions/${id}/summarize`);
    expect(s.status).toBe(202);
    // 手動の作り直しは土台かどうかもレジストリも問わない。
    expect(summary.enqueued).toContainEqual([id, { force: true }]);
    await get(`/api/sessions/${id}/events?latest=1`);
    // セッションを開いたときは既定のまま（土台かどうかとレジストリの両方を見る）。
    // 画面を開く呼び出しは最新の側を求める呼び出しなので、契機はそこに付ける。
    expect(summary.enqueued).toContainEqual([id, undefined]);
    summary.enqueued.length = 0;
    await get(`/api/sessions/${id}/events?fromSeq=5`);
    await get(`/api/sessions/${id}/events?before=5`);
    await get(`/api/sessions/${id}/events?latest=1&agentId=abc123`);
    expect(summary.enqueued).toEqual([]);
    expect((await json(await get('/api/summarizer/models'))).body).toEqual({ models: ['gemma'] });
    expect((await json(await post('/api/summarizer/test'))).body).toEqual(testResult);
  });
  it('要約の受け付けが投げても呼び手の操作は成立する', async () => {
    // 要約は補助の機能なので、受け付けに失敗しても 500 にしない。GET /events と同じ扱いにそろえる。
    const id = await alphaId();
    summary.enqueue = () => { throw new Error('要約器が壊れています'); };
    const r = await post(`/api/sessions/${id}/summarize`);
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ accepted: false });
    expect((await get(`/api/sessions/${id}/events?latest=1`)).status).toBe(200);
  });
});

describe('同期の経路', () => {
  const post = (p: string, body?: unknown) => app.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  it('他端末で走っている run はロックとして出る', async () => {
    // listSessions と getSession に自端末の ID を渡さないと、ロックは一切出ない。
    const all = (await json(await get('/api/sessions'))).body as { id: string; projectId: string | null }[];
    const target = all.find((s) => s.projectId !== null)!;
    const id = target.id;
    upsertShared(db, 'devices', { id: 'mini', name: 'mini', platform: 'darwin', last_seen_at: Date.now(), deleted_at: null }, 'mini');
    upsertShared(db, 'runs', {
      id: 'remote-run', session_id: id, device_id: 'mini', kind: 'start', tmux_name: 'hangar-remote',
      pid: null, launch_params: '{}', started_at: Date.now(), ended_at: null, end_reason: null, heartbeat_at: Date.now(), deleted_at: null,
    }, 'mini');
    const lock = { deviceId: 'mini', deviceName: 'mini', runId: 'remote-run', stale: false };
    expect((await json(await get('/api/sessions'))).body.find((s: { id: string }) => s.id === id).lock).toMatchObject(lock);
    expect((await json(await get(`/api/sessions/${id}`))).body.lock).toMatchObject(lock);
    expect((await json(await get('/api/bootstrap'))).body.sessions.find((s: { id: string }) => s.id === id).lock).toMatchObject(lock);
    const byProject = (await json(await get(`/api/sessions?projectId=${target.projectId!}`))).body as { id: string; lock: unknown }[];
    expect(byProject.find((s) => s.id === id)?.lock).toMatchObject(lock);
  });
});

describe('セッションの状態', () => {
  const send = (p: string, body?: unknown, method = 'POST', headers: Record<string, string> = H) =>
    app.request(p, { method, headers: { ...headers, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const alphaId = () => (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
  const err = async (r: Response) => ((await r.json()) as { error: string }).error;

  it('PUT と確定は戻る時刻も受け、形の違う時刻は 400 で何が悪いかを返す', async () => {
    const id = alphaId();
    const r = await send(`/api/sessions/${id}/state`, { status: 'paused', returnOn: '2026-10-05', returnTime: '13:30' }, 'PUT');
    expect(r.status).toBe(200);
    expect((await r.json()).state).toMatchObject({ status: 'paused', returnOn: '2026-10-05', returnTime: '13:30' });
    const bad = await send(`/api/sessions/${id}/state`, { status: 'paused', returnOn: '2026-10-05', returnTime: '25:00' }, 'PUT');
    expect(bad.status).toBe(400);
    expect(await err(bad)).toBe('戻る時刻は HH:MM の形で、00:00〜23:59 です（25:00）');
    expect((await send(`/api/sessions/${id}/state`, { status: 'paused', returnOn: '2026-10-05', returnTime: 1330 }, 'PUT')).status).toBe(400);
    await send(`/api/sessions/${id}/state`, { status: null }, 'PUT');
    proposeSessionState(db, 'd', id, { status: 'paused', note: '明日見る', returnOn: '2026-10-02', returnTime: '09:00', source: 'in_session' });
    expect((await send(`/api/sessions/${id}/state/confirm`, { returnOn: '2026-10-05', returnTime: 930 })).status).toBe(400);
    const ok = await send(`/api/sessions/${id}/state/confirm`, { returnOn: '2026-10-05', returnTime: '21:50' });
    expect((await ok.json()).state).toMatchObject({ status: 'paused', returnOn: '2026-10-05', returnTime: '21:50' });
  });
  it('PUT は手で状態を変え、session.upsert を配る', async () => {
    const id = alphaId();
    const r = await send(`/api/sessions/${id}/state`, { status: 'paused', note: '明日の朝見る', returnOn: '2026-10-02' }, 'PUT');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ state: { status: 'paused', note: '明日の朝見る', returnOn: '2026-10-02', returnTime: null, setBy: 'user', setAt: expect.any(Number), candidate: null } });
    expect(sent.at(-1)).toMatchObject({ type: 'session.upsert', session: { id, state: { status: 'paused' } } });
    // Done は戻る日を持たない。
    expect((await (await send(`/api/sessions/${id}/state`, { status: 'done', returnOn: '2026-10-02' }, 'PUT')).json()).state).toMatchObject({ status: 'done', returnOn: null });
    // null は Active に戻す。
    expect((await (await send(`/api/sessions/${id}/state`, { status: null }, 'PUT')).json()).state).toMatchObject({ status: null, note: null, returnOn: null, candidate: null });
  });
  it('PUT の誤りは 400 と 404。本文はトーストに出せる日本語の一文', async () => {
    const id = alphaId();
    const paused = await send(`/api/sessions/${id}/state`, { status: 'paused' }, 'PUT');
    expect(paused.status).toBe(400);
    expect(await err(paused)).toBe('Paused には戻る日が要ります');
    for (const body of [{}, { status: 'active' }, { status: 'done', note: 5 }, { status: 'paused', returnOn: 20261002 }, { status: 'paused', returnOn: '2026-02-30' }, { status: 'done', note: 'あ'.repeat(201) }]) {
      const r = await send(`/api/sessions/${id}/state`, body, 'PUT');
      expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 400]);
      expect(await err(r)).toMatch(/[ぁ-んァ-ン一-龥]/);
    }
    expect(db.prepare('select count(*) c from session_states').get()).toEqual({ c: 0 });
    const missing = await send('/api/sessions/nope/state', { status: 'done' }, 'PUT');
    expect(missing.status).toBe(404);
    expect(await err(missing)).toBe('セッションが見つかりません');
    // 論理削除したセッションも見つからない扱いにする。
    softDeleteShared(db, 'sessions', id, 'd');
    expect((await send(`/api/sessions/${id}/state`, { status: 'done' }, 'PUT')).status).toBe(404);
  });
  it('confirm は提案を状態にし、日を変えればその日にする。提案が無ければ 409', async () => {
    const id = alphaId();
    const none = await send(`/api/sessions/${id}/state/confirm`);
    expect(none.status).toBe(409);
    expect(await err(none)).toBe('このセッションには確かめる提案がありません');
    proposeSessionState(db, 'd', id, { status: 'paused', note: '明日見る', returnOn: '2026-10-02', source: 'in_session' });
    expect((await send(`/api/sessions/${id}/state/confirm`, { returnOn: '2026-02-30' })).status).toBe(400);
    sent.length = 0;
    const ok = await send(`/api/sessions/${id}/state/confirm`, { returnOn: '2026-10-05' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).state).toEqual({ status: 'paused', note: '明日見る', returnOn: '2026-10-05', returnTime: null, setBy: 'user', setAt: expect.any(Number), candidate: null });
    expect(sent.map((e) => e.type)).toEqual(['session.upsert']);
    expect((await send(`/api/sessions/${id}/state/confirm`)).status).toBe(409);
    expect((await send('/api/sessions/nope/state/confirm')).status).toBe(404);
  });
  it('reject は提案を消し、同じセッションから出し直させない。提案が無ければ 409', async () => {
    const id = alphaId();
    expect((await send(`/api/sessions/${id}/state/reject`)).status).toBe(409);
    proposeSessionState(db, 'd', id, { status: 'done', note: '直した', returnOn: null, source: 'post_hoc' });
    sent.length = 0;
    const ok = await send(`/api/sessions/${id}/state/reject`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).state).toMatchObject({ status: null, candidate: null });
    expect(sent.map((e) => e.type)).toEqual(['session.upsert']);
    expect(proposeSessionState(db, 'd', id, { status: 'done', note: 'もう一度', returnOn: null, source: 'post_hoc' }).outcome).toBe('rejected_before');
    expect((await send('/api/sessions/nope/state/reject')).status).toBe(404);
  });
  it('MCP からは呼べない。run に配る秘密は /api を開けず、MCP のツールにも確定と却下は無い', async () => {
    const id = alphaId();
    const auth = { authorization: `Bearer ${issueMcpSecret(db, id, 1)}` };
    for (const [p, m] of [[`/api/sessions/${id}/state`, 'PUT'], [`/api/sessions/${id}/state/confirm`, 'POST'], [`/api/sessions/${id}/state/reject`, 'POST']] as const) {
      expect([p, (await send(p, { status: 'done' }, m, auth)).status]).toEqual([p, 401]);
    }
    expect(TOOL_NAMES.filter((n) => /state|status/.test(n))).toEqual(['propose_session_status']);
  });
});

// 経路は行を書くだけで、画面へのイベントは配る層（events/publisher.ts）が組む。
// 書いた行のイベントが、1 回だけ、最新の中身で届くことを経路ごとに押さえる。
describe('書いた行のイベントは配る層から届く', () => {
  const send = (p: string, body?: unknown, method = 'POST') => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const of = <T extends ServerEvent['type']>(type: T) => sent.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type);
  const sessionsOf = async () => (await json(await get('/api/sessions'))).body as { id: string; projectId: string | null; providerSessionId: string }[];

  describe('セッション', () => {
    const alpha = async () => (await sessionsOf()).find((s) => s.providerSessionId === SESSION_ALPHA)!;

    it('1 行メモを書くと、その session.upsert が 1 回だけ届く', async () => {
      const { id } = await alpha();
      await send(`/api/sessions/${id}`, { memo: '一行' }, 'PATCH');
      expect(sent).toEqual([{ type: 'session.upsert', session: expect.objectContaining({ id, memo: '一行' }) }]);
    });

    it('状態を付ける、提案を確定する、却下する、のどれでも session.upsert が 1 回だけ届く', async () => {
      const { id } = await alpha();
      await send(`/api/sessions/${id}/state`, { status: 'done' }, 'PUT');
      expect(sent).toEqual([{ type: 'session.upsert', session: expect.objectContaining({ id, state: expect.objectContaining({ status: 'done' }) }) }]);
      await send(`/api/sessions/${id}/state`, { status: null }, 'PUT');
      proposeSessionState(db, 'd', id, { status: 'done', note: '終わった', returnOn: null, source: 'in_session' });
      await Promise.resolve();
      sent.length = 0;
      await send(`/api/sessions/${id}/state/confirm`, {});
      expect(sent).toEqual([{ type: 'session.upsert', session: expect.objectContaining({ id, state: expect.objectContaining({ status: 'done', candidate: null }) }) }]);
      // 確かめる提案が無ければ、書かないので何も届かない。
      sent.length = 0;
      expect((await send(`/api/sessions/${id}/state/reject`)).status).toBe(409);
      expect(sent).toEqual([]);
    });

    it('昇格すると、新しいプロジェクト、移ったセッション、1 件減った元のプロジェクトが 1 回ずつ届く', async () => {
      const s = await alpha();
      const from = s.projectId!;
      app = createApp({ ...deps, promote: (o) => {
        // 本物の昇格（projects/promote.ts）と同じく、1 つのトランザクションでプロジェクトを作ってセッションを付け替える。
        db.transaction(() => {
          upsertShared(db, 'projects', { id: 'promoted', name: o.name, status: 'active', is_scratch: 0 }, 'd');
          const row = db.prepare('select * from sessions where id = ?').get(o.sessionId) as Record<string, unknown>;
          upsertShared(db, 'sessions', { ...row, project_id: 'promoted' }, 'd');
        })();
        return { projectId: 'promoted', moved: false, reason: null };
      } });
      const r = await send(`/api/sessions/${s.id}/promote`, { name: 'newp', gitInit: false, moveFiles: false });
      expect(r.status).toBe(201);
      expect(await r.json()).toMatchObject({ project: { id: 'promoted' }, session: { id: s.id, projectId: 'promoted' } });
      expect(of('project.upsert').map((e) => e.project.id).sort()).toEqual([from, 'promoted'].sort());
      // 元のプロジェクトは、セッションが抜けた後の中身で届く。
      expect(of('project.upsert').find((e) => e.project.id === from)!.project.lastActivityAt).toBeNull();
      expect(of('session.upsert')).toEqual([{ type: 'session.upsert', session: expect.objectContaining({ id: s.id, projectId: 'promoted' }) }]);
    });
  });
});
