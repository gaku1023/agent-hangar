import { describe, expect, it } from 'vitest';
import { ApiConflictError, createApi } from './api.ts';

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
    await api.projectOpenTerminal('p1'); await api.createProject('beta', '/w/beta');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/runs', 'POST /api/sessions/s1/resume', 'POST /api/sessions/s1/fork', 'DELETE /api/runs/r1', 'POST /api/runs/r1/tabs', 'DELETE /api/runs/r1/tabs/t1',
      'POST /api/runs/r1/open-terminal', 'POST /api/runs/r1/open-terminal', 'POST /api/projects/p1/open-terminal', 'POST /api/projects',
    ]);
    expect(calls[0]!.body).toBe('{"projectId":"p1","name":"n"}');
    expect(calls[6]!.body).toBe('{"tabId":"t1"}');
    expect(calls[7]!.body).toBe('{}');
    expect(calls[9]!.body).toBe('{"name":"beta","path":"/w/beta"}');
  });
  it('204 は undefined、失敗は status と経路のエラー', async () => {
    const ok = harness(204);
    expect(await ok.api.openEditor('s1')).toBeUndefined();
    expect(await ok.api.projectOpenEditor('p1')).toBeUndefined();
    const ng = harness(409, { error: '実行中です' });
    await expect(ng.api.resume('s1')).rejects.toThrow('実行中です');
  });
  it('本文に error が無ければ status と経路を投げる', async () => {
    const ng = harness(500, {});
    await expect(ng.api.bootstrap()).rejects.toThrow('500 /api/bootstrap');
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
    await api.memo('p1');
    await api.saveMemo('p1', '# m');
    await api.setSessionMemo('s1', '一行');
    await api.addArtifact('p1', 'https://claude.ai/code/artifact/x');
    await api.promote('s1', { name: 'n', gitInit: true, moveFiles: false });
    await api.summarizerModels();
    await api.testSummarizer();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/usage/aggregate?days=30', 'GET /api/statusline',
      'POST /api/projects/p1/todos', 'PATCH /api/todos/t1', 'DELETE /api/todos/t1',
      'GET /api/projects/p1/memo', 'PUT /api/projects/p1/memo', 'PATCH /api/sessions/s1',
      'POST /api/projects/p1/artifacts', 'POST /api/sessions/s1/promote',
      'GET /api/summarizer/models', 'POST /api/summarizer/test',
    ]);
    expect(JSON.parse(String(calls[2]!.body))).toEqual({ text: '買う' });
    expect(JSON.parse(String(calls[3]!.body))).toEqual({ done: true });
    expect(JSON.parse(String(calls[6]!.body))).toEqual({ markdown: '# m' });
    expect(JSON.parse(String(calls[7]!.body))).toEqual({ memo: '一行' });
    expect(JSON.parse(String(calls[8]!.body))).toEqual({ url: 'https://claude.ai/code/artifact/x' });
    expect(JSON.parse(String(calls[9]!.body))).toEqual({ name: 'n', gitInit: true, moveFiles: false });
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
    await api.syncStatus();
    await api.syncNow();
    await api.syncPause(true);
    await api.resumeHere('s1', false);
    await api.joinToken();
    await api.configPreview();
    await api.configPull();
    await api.devices();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/sync/status', 'POST /api/sync/now', 'POST /api/sync/pause',
      'POST /api/sessions/s1/resume-here', 'GET /api/sync/joinToken',
      'GET /api/sync/config/preview', 'POST /api/sync/config/pull', 'GET /api/devices',
    ]);
    expect(JSON.parse(String(calls[2]!.body))).toEqual({ paused: true });
    expect(JSON.parse(String(calls[3]!.body))).toEqual({ overwrite: false });
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
