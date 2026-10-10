import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../db/open.ts';
import { RunError } from '../../runs/manager.ts';
import { SESSION_ALPHA } from '../../../test/fixtures.ts';
import { createApp, type AppDeps, type ExternalApi, type RunsApi } from '../app.ts';
import { H, launched, run, testDeps, type TestWorld } from '../testing.ts';

// run の経路（routes/runs.ts）の試験。依存は testDeps() で組み、createApp を通して /api の下から叩く。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let db: Db;
let ws: string;
let deps: AppDeps;
/** 偽物の口が呼ばれた順。testDeps の calls と同じ配列である。 */
let calls: string[];
let runs: RunsApi;
let external: ExternalApi;
const get = (p: string, headers: Record<string, string> = H) => app.request(p, { headers });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

beforeEach(async () => {
  t = await testDeps();
  ({ db, ws, runs, external, deps, calls } = t);
  app = createApp(deps);
});
afterEach(() => { t.dispose(); });

describe('routes', () => {
  it('ターミナルからの起動は base64 の本文を読んで渡し、断ったら理由を返す', async () => {
    const post = (body: unknown) => app.request('/api/runs/terminal', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const b64 = (x: string) => Buffer.from(x).toString('base64');
    const r = await post({ cwd: b64('/w/a'), args: b64(['--model', 'opus'].join('\0')), env: b64('A=1\0') });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ ...launched, attached: false });
    expect(runs.startFromTerminal).toHaveBeenCalledWith({ cwd: '/w/a', args: ['--model', 'opus'], env: { A: '1' } });
    expect((await post({ cwd: 'x' })).status).toBe(400);
    const refused = await post({ cwd: b64('/w/a'), args: b64('--session-id\0x'), env: '' });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain('--session-id');
  });
  it('起動、再開、フォーク、停止', async () => {
    const post = (p: string, body?: unknown) => app.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const r = await post('/api/runs', { projectId: 'p1', name: 'n' });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual(launched);
    expect(runs.start).toHaveBeenCalledWith({ projectId: 'p1', name: 'n' });
    expect((await post('/api/runs', {})).status).toBe(400);
    expect((await post('/api/runs')).status).toBe(400);
    expect((await post('/api/sessions/s1/resume')).status).toBe(201);
    expect((await post('/api/sessions/busy/resume')).status).toBe(409);
    expect((await post('/api/sessions/s1/attach')).status).toBe(201);
    expect((await post('/api/sessions/busy/attach')).status).toBe(409);
    expect((await post('/api/sessions/s1/adopt')).status).toBe(201);
    const a = await post('/api/sessions/busy/adopt');
    expect(a.status).toBe(409);
    expect((await a.json()).error).toBe('作業中です');
    const f = await post('/api/sessions/s1/fork');
    expect((await f.json()).sessionId).toBe('s2');
    const k = await app.request('/api/runs/r1', { method: 'DELETE', headers: H });
    expect((await k.json()).endReason).toBe('killed');
    expect((await app.request('/api/runs/nope', { method: 'DELETE', headers: H })).status).toBe(404);
    expect((await json(await get('/api/runs'))).body.tabs).toHaveLength(2);
  });
  it('タブの追加と削除', async () => {
    const r = await app.request('/api/runs/r1/tabs', { method: 'POST', headers: H });
    expect(r.status).toBe(201);
    expect((await r.json()).tmuxName).toBe('hangar-r1-t1');
    const d = await app.request('/api/runs/r1/tabs/t1', { method: 'DELETE', headers: H });
    expect((await d.json()).closedAt).toBe(3);
    expect(runs.closeTab).toHaveBeenCalledWith('t1');
    // 別の run の URL から他人のタブを閉じさせない。閉じると相手の tmux セッションが落ちる。
    expect((await app.request('/api/runs/r2/tabs/t1', { method: 'DELETE', headers: H })).status).toBe(404);
    expect((await app.request('/api/runs/r1/tabs/nope', { method: 'DELETE', headers: H })).status).toBe(404);
    expect(runs.closeTab).toHaveBeenCalledTimes(1);
  });
  it('指示へ跳ぶ、transcript を閉じる', async () => {
    const post = (p: string, body?: unknown) => app.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const r = await post('/api/runs/r1/jump', { heads: ['一つめ', '二つめ'], index: 0, from: 'bottom' });
    expect(await r.json()).toEqual({ found: true });
    expect(runs.jumpToPrompt).toHaveBeenCalledWith('r1', ['一つめ', '二つめ'], 0, 'bottom');
    // 形の崩れた本文は RunManager に渡さない。長すぎる書き出し、範囲外の index、知らない向き。
    expect((await post('/api/runs/r1/jump', { heads: ['x'.repeat(17)], index: 0, from: 'top' })).status).toBe(400);
    expect((await post('/api/runs/r1/jump', { heads: ['a'], index: 1, from: 'top' })).status).toBe(400);
    expect((await post('/api/runs/r1/jump', { heads: ['a'], index: 0, from: 'side' })).status).toBe(400);
    expect((await post('/api/runs/r1/jump', { heads: Array(1001).fill('a'), index: 0, from: 'top' })).status).toBe(400);
    expect(runs.jumpToPrompt).toHaveBeenCalledTimes(1);
    expect((await post('/api/runs/dead/jump', { heads: ['a'], index: 0, from: 'top' })).status).toBe(409);
    expect(await (await post('/api/runs/r1/leave-transcript')).json()).toEqual({ left: true });
  });
  // Windows のタブや窓の題名に、セッション名を渡す。渡さないと題名が psmux.exe のフルパスになる。
  it('ターミナルで開くとき、セッション名を題名として渡し、シェルタブには名前の後ろにタブの題名を添える', async () => {
    const post = (p: string, body?: unknown) => app.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const alpha = db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string };
    db.prepare('update sessions set custom_title = ? where id = ?').run('日本語の 作業', alpha.id);
    vi.mocked(runs.getRun).mockImplementation((id: string) => (id === 'r1' ? { ...run, sessionId: alpha.id } : null));
    await post('/api/runs/r1/open-terminal', {});
    expect(external.openTerminal).toHaveBeenLastCalledWith({ tmuxName: 'hangar-r1', title: '日本語の 作業' });
    await post('/api/runs/r1/open-terminal', { tabId: 't1' });
    expect(external.openTerminal).toHaveBeenLastCalledWith({ tmuxName: 'hangar-r1-t1', title: '日本語の 作業 (シェル 1)' });
  });
  it('ターミナルで開く、VS Code で開く', async () => {
    const post = (p: string, body?: unknown) => app.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect(await (await post('/api/runs/r1/open-terminal', { tabId: 't1' })).json()).toEqual({ app: 'terminal', fellBack: false });
    expect(external.openTerminal).toHaveBeenCalledWith({ tmuxName: 'hangar-r1-t1' });
    await post('/api/runs/r1/open-terminal', {});
    expect(external.openTerminal).toHaveBeenLastCalledWith({ tmuxName: 'hangar-r1' });
    expect((await post('/api/runs/r1/open-terminal', { tabId: 'nope' })).status).toBe(404);
    expect((await post('/api/runs/nope/open-terminal', {})).status).toBe(404);
    // 終了した run の Claude のタブは開かせない。素の名前で attach すると同じ run のシェルタブに落ちる。
    expect((await post('/api/runs/dead/open-terminal', {})).status).toBe(409);
    expect((await post('/api/runs/dead/open-terminal', { tabId: 'dead' })).status).toBe(409);
    // シェルタブは run が終わった後も開いてよい。
    expect((await post('/api/runs/dead/open-terminal', { tabId: 'dead-t1' })).status).toBe(200);
    expect(external.openTerminal).toHaveBeenLastCalledWith({ tmuxName: 'hangar-dead-t1' });
    const { body: sessions } = await json(await get('/api/sessions'));
    const alpha = sessions.find((s: { providerSessionId: string }) => s.providerSessionId === SESSION_ALPHA);
    expect((await post(`/api/sessions/${alpha.id}/open-editor`)).status).toBe(204);
    expect(external.openEditor).toHaveBeenCalledWith({ target: path.join(ws, 'alpha') });
    expect((await post('/api/sessions/nope/open-editor')).status).toBe(404);
    const { body: list } = await json(await get('/api/projects'));
    expect((await post(`/api/projects/${list[0].id}/open-editor`)).status).toBe(204);
    expect(await (await post(`/api/projects/${list[0].id}/open-terminal`)).json()).toEqual({ app: 'iterm', fellBack: true });
    // 終わった画面の右欄（変更したファイル）から、そのセッションが変えたファイルだけを開ける。
    const edited = '/Users/me/workspace/alpha/channels/a.md';
    expect((await post(`/api/sessions/${alpha.id}/open-editor`, { file: edited })).status).toBe(404);
    db.prepare('update event_index set file_path = ? where file_path = ?').run(`${ws}/alpha/a.md`, edited);
    fs.writeFileSync(`${ws}/alpha/a.md`, 'y');
    fs.writeFileSync(`${ws}/alpha/other.md`, 'z');
    (external.openEditor as ReturnType<typeof vi.fn>).mockClear();
    expect((await post(`/api/sessions/${alpha.id}/open-editor`, { file: `${ws}/alpha/a.md` })).status).toBe(204);
    expect(external.openEditor).toHaveBeenLastCalledWith({ target: `${ws}/alpha/a.md` });
    // あるファイルでも、そのセッションが変えていなければ開かない。
    // 綴りを変えて枠の外へ出るパスも同じ。
    const other = await post(`/api/sessions/${alpha.id}/open-editor`, { file: `${ws}/alpha/other.md` });
    expect(other.status).toBe(404);
    expect((await post(`/api/sessions/${alpha.id}/open-editor`, { file: `${ws}/alpha/x/../a.md` })).status).toBe(404);
    expect((await post(`/api/sessions/${alpha.id}/open-editor`, { file: 'a.md' })).status).toBe(400);
    expect((await post(`/api/sessions/${alpha.id}/open-editor`, { file: 3 })).status).toBe(400);
    // 別のセッションが編集したパスと、このセッションが読んだだけのパスは開かない。
    const indexRow = db.prepare("insert into event_index (session_id, seq, kind, byte_offset, byte_length, file_path_ref, tool_name, file_path) values (?, ?, 'tool_call', 0, 0, 'x', ?, ?)");
    indexRow.run('another-session', 900_001, 'Edit', `${ws}/alpha/other.md`);
    expect((await post(`/api/sessions/${alpha.id}/open-editor`, { file: `${ws}/alpha/other.md` })).status).toBe(404);
    fs.writeFileSync(`${ws}/alpha/read.md`, 'r');
    indexRow.run(alpha.id, 900_002, 'Read', `${ws}/alpha/read.md`);
    expect((await post(`/api/sessions/${alpha.id}/open-editor`, { file: `${ws}/alpha/read.md` })).status).toBe(404);
    // 変えたファイルが、その後ディレクトリに替わっていたら開かない。
    fs.mkdirSync(`${ws}/alpha/became-dir`);
    indexRow.run(alpha.id, 900_003, 'Write', `${ws}/alpha/became-dir`);
    expect((await post(`/api/sessions/${alpha.id}/open-editor`, { file: `${ws}/alpha/became-dir` })).status).toBe(404);
    expect(external.openEditor).toHaveBeenCalledTimes(1);
    (external.openEditor as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('code が無い'));
    const bad = await post(`/api/sessions/${alpha.id}/open-editor`);
    expect(bad.status).toBe(500);
    expect((await bad.json()).error).toBe('code が無い');
  });
  const post = (p: string, body?: unknown, method = 'POST') => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
});

describe('同期の経路', () => {
  const post = (p: string, body?: unknown) => app.request(p, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  it('この PC で再開は 409 で写しとの大きさを返す', async () => {
    const id = (await json(await get('/api/sessions'))).body[0].id;
    expect((await json(await post(`/api/sessions/${id}/resume-here`))).body.sessionId).toBe('s1');
    t.sync.resumeHereResult = { error: 'local_smaller', localSize: 10, remoteSize: 99 };
    const r = await json(await post(`/api/sessions/${id}/resume-here`, { overwrite: false }));
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'local_smaller', localSize: 10, remoteSize: 99 });
    expect(calls).toEqual([`resumeHere:${id}:false`, `resumeHere:${id}:false`]);
  });

  it('この PC で再開の RunError は status と理由を返す', async () => {
    app = createApp({ ...deps, resumeHere: () => { throw new RunError(400, 'このセッションの本文がありません'); } });
    const r = await json(await post('/api/sessions/s1/resume-here', { overwrite: true }));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'このセッションの本文がありません' });
  });

  it('起動と再開とフォークの前に pull を待つ', async () => {
    await post('/api/runs', { projectId: 'p1', name: 'n' });
    await post('/api/sessions/s1/resume');
    await post('/api/sessions/s1/fork');
    expect(calls.filter((c) => c === 'beforeLaunch')).toHaveLength(3);
  });
});
