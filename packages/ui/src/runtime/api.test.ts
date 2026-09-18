import { describe, expect, it } from 'vitest';
import { createApi } from './api.ts';

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
