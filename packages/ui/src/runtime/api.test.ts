import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { accountsFixture } from '../test/accounts.ts';
import { ApiConflictError, createApi, RetentionConflictApiError, type ApiClient } from './api.ts';

function harness(status = 200, body: unknown = { ok: true }) {
  const calls: { url: string; method: string; body: string | undefined }[] = [];
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined });
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { api: createApi(fetchFn), calls };
}

describe('createApi（フェーズ 2）', () => {
  it('経路とメソッドと本文', async () => {
    const { api, calls } = harness();
    await api.launch({ projectId: 'p1', name: 'n' });
    await api.resume('s1'); await api.fork('s1'); await api.killRun('r1'); await api.openTab('r1'); await api.closeTab('r1', 't1');
    await api.openTerminalApp('r1', 't1'); await api.openTerminalApp('r1', null);
    await api.projectOpenTerminal('p1'); await api.createProject({ kind: 'dir', path: '/w/beta', name: 'beta' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/runs', 'POST /api/sessions/s1/resume', 'POST /api/sessions/s1/fork', 'DELETE /api/runs/r1', 'POST /api/runs/r1/tabs', 'DELETE /api/runs/r1/tabs/t1',
      'POST /api/runs/r1/open-terminal', 'POST /api/runs/r1/open-terminal', 'POST /api/projects/p1/open-terminal', 'POST /api/projects',
    ]);
    expect(calls[0]!.body).toBe('{"projectId":"p1","name":"n"}');
    expect(calls[6]!.body).toBe('{"tabId":"t1"}');
    expect(calls[7]!.body).toBe('{}');
    expect(calls[9]!.body).toBe('{"kind":"dir","path":"/w/beta","name":"beta"}');
  });
  it('プロジェクトの作成は place をそのまま送り、未登録の一覧は GET で取る', async () => {
    const { api, calls } = harness();
    const lastCall = () => { const c = calls.at(-1)!; return { ...c, body: c.body === undefined ? undefined : JSON.parse(c.body) as unknown }; };
    await api.createProject({ kind: 'newDir', name: 'fresh', gitInit: true });
    expect(lastCall()).toMatchObject({ url: '/api/projects', method: 'POST', body: { kind: 'newDir', name: 'fresh', gitInit: true } });
    await api.workspaceDirs();
    expect(lastCall()).toMatchObject({ url: '/api/workspace/dirs', method: 'GET' });
  });
  it('変更したファイルの一覧は GET /api/sessions/:id/files で取る', async () => {
    const { api, calls } = harness(200, { files: [{ path: '/w/a.ts', edits: 2, agentId: null }] });
    expect(await api.sessionFiles('s1')).toEqual({ files: [{ path: '/w/a.ts', edits: 2, agentId: null }] });
    expect(calls).toEqual([{ url: '/api/sessions/s1/files', method: 'GET', body: undefined }]);
  });
  it('204 は undefined、失敗は status と経路のエラー', async () => {
    const ok = harness(204);
    expect(await ok.api.openEditor('s1')).toBeUndefined();
    expect(await ok.api.openEditor('s1', '/w/a.ts')).toBeUndefined();
    // ファイルを開くときだけ本文に載せる。
    // 作業ディレクトリを開く道は今までどおり本文を持たない。
    expect(ok.calls.map((c) => [c.url, c.body ?? null])).toEqual([['/api/sessions/s1/open-editor', null], ['/api/sessions/s1/open-editor', '{"file":"/w/a.ts"}']]);
    expect(await ok.api.projectOpenEditor('p1')).toBeUndefined();
    const ng = harness(409, { error: '実行中です' });
    await expect(ng.api.resume('s1')).rejects.toThrow('実行中です');
  });
  it('本文に error が無ければ status と経路を投げる', async () => {
    const ng = harness(500, {});
    await expect(ng.api.bootstrap()).rejects.toThrow('500 /api/bootstrap');
  });
  it('Claude Code との互換は GET /api/compat で取る', async () => {
    const { api, calls } = harness(200, { verifiedVersion: '2.1.292', localVersion: null, drifts: [] });
    expect(await api.compat()).toEqual({ verifiedVersion: '2.1.292', localVersion: null, drifts: [] });
    expect(calls.at(-1)).toMatchObject({ url: '/api/compat', method: 'GET' });
  });
});

describe('フェーズ 3 の経路', () => {
  it('経路とメソッドと本文が合っている', async () => {
    const { api, calls } = harness();
    await api.usageAggregate(30);
    await api.statusline();
    await api.addTodo('p1', '買う');
    await api.setTodoDone('t1', true);
    await api.removeTodo('t1');
    await api.confirmTodo('t1');
    await api.rejectTodo('t1');
    await api.memo('p1');
    await api.saveMemo('p1', '# m');
    await api.setSessionMemo('s1', '一行');
    await api.addArtifact('p1', 'https://claude.ai/code/artifact/x');
    await api.promote('s1', { name: 'n', gitInit: true, moveFiles: false });
    await api.summarizerModels();
    await api.testSummarizer();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/usage/aggregate?days=30', 'GET /api/statusline',
      'POST /api/projects/p1/todos', 'PATCH /api/todos/t1', 'DELETE /api/todos/t1', 'POST /api/todos/t1/confirm', 'POST /api/todos/t1/reject',
      'GET /api/projects/p1/memo', 'PUT /api/projects/p1/memo', 'PATCH /api/sessions/s1',
      'POST /api/projects/p1/artifacts', 'POST /api/sessions/s1/promote',
      'GET /api/summarizer/models', 'POST /api/summarizer/test',
    ]);
    expect(JSON.parse(String(calls[2]!.body))).toEqual({ text: '買う' });
    expect(JSON.parse(String(calls[3]!.body))).toEqual({ done: true });
    expect(JSON.parse(String(calls[8]!.body))).toEqual({ markdown: '# m' });
    expect(JSON.parse(String(calls[9]!.body))).toEqual({ memo: '一行' });
    expect(JSON.parse(String(calls[10]!.body))).toEqual({ url: 'https://claude.ai/code/artifact/x' });
    expect(JSON.parse(String(calls[11]!.body))).toEqual({ name: 'n', gitInit: true, moveFiles: false });
  });
  it('本文を返さない経路は undefined を返す', async () => {
    const no = harness(204);
    await expect(no.api.openArtifact('a1')).resolves.toBeUndefined();
    await expect(no.api.openArtifactEditor('a1')).resolves.toBeUndefined();
    expect(no.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/artifacts/a1/open', 'POST /api/artifacts/a1/open-editor']);
    // 要約の作り直しは 202 と { accepted } を返すが、クライアントは本文を捨てる。
    const accepted = harness(202, { accepted: true });
    await expect(accepted.api.regenerateSummary('s1')).resolves.toBeUndefined();
    expect(accepted.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/sessions/s1/summarize']);
  });
});

describe('フェーズ 4 の同期の経路', () => {
  it('経路とメソッドと本文が合っている', async () => {
    const { api, calls } = harness();
    await api.syncNow();
    await api.syncPause(true);
    await api.resumeHere('s1', false);
    await api.joinToken();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/sync/now', 'POST /api/sync/pause',
      'POST /api/sessions/s1/resume-here', 'GET /api/sync/joinToken',
    ]);
    expect(JSON.parse(String(calls[1]!.body))).toEqual({ paused: true });
    expect(JSON.parse(String(calls[2]!.body))).toEqual({ overwrite: false });
  });
  it('同期の状態と端末の一覧は bootstrap と websocket で届くので、取りに行く口を持たない', () => {
    expectTypeOf<ApiClient>().not.toHaveProperty('syncStatus');
    expectTypeOf<ApiClient>().not.toHaveProperty('devices');
  });
  it('前面化は本文を返さない', async () => {
    const no = harness(204);
    await expect(no.api.syncFocus()).resolves.toBeUndefined();
    expect(no.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/sync/focus']);
  });
  it('この PC で再開の 409 だけが ApiConflictError になる', async () => {
    const conflict = harness(409, { error: 'local_smaller', localSize: 10, remoteSize: 99 });
    await expect(conflict.api.resumeHere('s1', false)).rejects.toBeInstanceOf(ApiConflictError);
    // 本文は 1 度しか読めないので、読み取りが 1 回で済んでいることを中身で確かめる。
    const err = await conflict.api.resumeHere('s1', false).catch((e: unknown) => e);
    expect((err as ApiConflictError).body).toEqual({ error: 'local_smaller', localSize: 10, remoteSize: 99 });
    // 同じ 409 でも別の理由なら、これまでどおりのトーストになる Error である。
    const other = harness(409, { error: '他の端末が実行中です' });
    const e2 = await other.api.resumeHere('s1', true).catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(Error);
    expect(e2).not.toBeInstanceOf(ApiConflictError);
    expect((e2 as Error).message).toBe('他の端末が実行中です');
  });
});

describe('保持期間の API', () => {
  it('経路と本文', async () => {
    const { api, calls } = harness();
    await api.retention(); await api.retentionPreview(365); await api.writeRetention(365, 'abc');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/retention', 'POST /api/retention/preview', 'PUT /api/retention']);
    expect(calls[1]!.body).toBe('{"days":365}');
    expect(calls[2]!.body).toBe('{"days":365,"baseSha256":"abc"}');
  });
  it('409 の retention_conflict は RetentionConflictApiError にする', async () => {
    const { api } = harness(409, { error: 'retention_conflict' });
    await expect(api.writeRetention(365, 'abc')).rejects.toBeInstanceOf(RetentionConflictApiError);
  });
});

describe('createApi（セッションの状態）', () => {
  it('経路とメソッドと本文', async () => {
    const { api, calls } = harness(200, { state: { status: 'done', note: null, returnOn: null, setBy: 'user', setAt: 1, candidate: null } });
    expect(await api.setSessionState('s1', { status: 'done' })).toMatchObject({ state: { status: 'done' } });
    await api.setSessionState('s1', { status: null });
    await api.confirmSessionState('s1', { returnOn: '2026-10-05' });
    await api.confirmSessionState('s1', {});
    await api.rejectSessionState('s1');
    expect(calls.map((c) => `${c.method} ${c.url} ${c.body ?? ''}`)).toEqual([
      'PUT /api/sessions/s1/state {"status":"done"}',
      'PUT /api/sessions/s1/state {"status":null}',
      'POST /api/sessions/s1/state/confirm {"returnOn":"2026-10-05"}',
      'POST /api/sessions/s1/state/confirm {}',
      'POST /api/sessions/s1/state/reject ',
    ]);
  });
  it('409 の本文の一文をそのまま投げる', async () => {
    const ng = harness(409, { error: 'このセッションには確認する提案がありません' });
    await expect(ng.api.confirmSessionState('s1', {})).rejects.toThrow('このセッションには確認する提案がありません');
  });
});

describe('createApi（アカウント）', () => {
  it('9 つの呼び出しの経路とメソッドと本文', async () => {
    const { api, calls } = harness(200, accountsFixture);
    expect(await api.accounts()).toEqual(accountsFixture);
    await api.setCurrentAccount('a1');
    await api.switchAccount('s1', 'a1');
    await api.addAccount('大学');
    await api.updateAccount('a1', { name: '研究室', color: '#7a4a9e' });
    await api.removeAccount('a1');
    await api.loginAccount('a1');
    await api.cancelAccountLogin('a1');
    await api.refreshAccount('a1');
    expect(calls.map((c) => `${c.method} ${c.url} ${c.body ?? ''}`.trimEnd())).toEqual([
      'GET /api/accounts',
      'PUT /api/accounts/current {"id":"a1"}',
      'POST /api/sessions/s1/switch-account {"account":"a1"}',
      'POST /api/accounts {"name":"大学"}',
      'PATCH /api/accounts/a1 {"name":"研究室","color":"#7a4a9e"}',
      'DELETE /api/accounts/a1',
      'POST /api/accounts/a1/login',
      'POST /api/accounts/a1/login/cancel',
      'POST /api/accounts/a1/refresh',
    ]);
  });
  it('202 のログインは本文を捨てて undefined、失敗はサーバの文をそのまま投げる', async () => {
    expect(await harness(202, { accepted: true }).api.loginAccount('a1')).toBeUndefined();
    await expect(harness(409, { error: 'ログインはすでに始まっています' }).api.loginAccount('a1')).rejects.toThrow('ログインはすでに始まっています');
    await expect(harness(409, { error: '同じアカウントです' }).api.switchAccount('s1', 'primary')).rejects.toThrow('同じアカウントです');
  });
});

describe('初期プロンプト欄の API', () => {
  it('promptCommands は projectId を付けて読み、commands を取り出す', async () => {
    const cmd = { name: 'goal', description: '', argumentHint: null, source: 'user', uses: 1 };
    const { api, calls } = harness(200, { commands: [cmd] });
    expect(await api.promptCommands('p1')).toEqual([cmd]);
    expect(calls[0]!.url).toBe('/api/prompt/commands?projectId=p1');
    await api.promptCommands(null);
    expect(calls[1]!.url).toBe('/api/prompt/commands');
  });
  it('promptFiles は projectId と問いを付けて読み、files を取り出す', async () => {
    const { api, calls } = harness(200, { files: ['a.ts'] });
    expect(await api.promptFiles('p1', 'a')).toEqual(['a.ts']);
    expect(calls[0]!.url).toBe('/api/prompt/files?projectId=p1&q=a');
    await api.promptFiles('p1', '');
    expect(calls[1]!.url).toBe('/api/prompt/files?projectId=p1');
  });
  it('uploadDrop は本文をそのまま送り、名前を問い合わせに付ける', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ path: '/h/drops/1-0-a.png', name: 'a b.png', size: 3 }), { status: 201 }));
    const api = createApi(fetchFn as unknown as typeof fetch);
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    expect(await api.uploadDrop(blob, 'a b.png')).toEqual({ path: '/h/drops/1-0-a.png', name: 'a b.png', size: 3 });
    const [url, init] = fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('/api/drops?name=a+b.png');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(blob);
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/octet-stream');
  });
  // 送りきれない間は「送っています」の札が残り、起動もできないままになる。時間切れで失敗に回す（札は外れ、知らせが出る）。
  it('uploadDrop だけが時間切れの signal を付けて送る', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ path: '/h/drops/1-0-a.png', name: 'a.png', size: 1 }), { status: 201 }));
    const api = createApi(fetchFn as unknown as typeof fetch);
    await api.uploadDrop(new Blob(['x']), 'a.png');
    const [, init] = fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal!.aborted).toBe(false);
    await api.existingDrops(['/h/drops/1-0-a.png']);
    expect((fetchFn.mock.calls[1]! as unknown as [string, RequestInit])[1].signal).toBeUndefined();
  });
  it('existingDrops は、残っているパスだけを取り出す', async () => {
    const { api, calls } = harness(200, { paths: ['/d/b.png'] });
    expect(await api.existingDrops(['/d/a.png', '/d/b.png'])).toEqual(['/d/b.png']);
    expect(calls[0]!.url).toBe('/api/drops/existing');
  });
});
