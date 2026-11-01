import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT, exitCodeOf, runCommand, type RunCommandOptions, type RunServer } from './run.ts';

type ToolCall = { name: string; args: Record<string, unknown> };
type Handler = (c: ToolCall) => unknown;

/** /mcp の偽物。道具ごとの答えを返し、呼ばれた順に控える。throw すると isError の応答になる。 */
function fakeMcp(handler: Handler) {
  const calls: ToolCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname !== '/mcp') return new Response('{}', { status: 404 });
    if ((init?.headers as Record<string, string>).authorization !== 'Bearer tok') return new Response('{}', { status: 401 });
    const m = JSON.parse(String(init!.body)) as { id: number; params: { name: string; arguments: Record<string, unknown> } };
    const call = { name: m.params.name, args: m.params.arguments };
    calls.push(call);
    let result: unknown;
    try {
      result = { content: [{ type: 'text', text: JSON.stringify(handler(call)) }] };
    } catch (e) {
      result = { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
    const body = JSON.stringify({ jsonrpc: '2.0', id: m.id, result });
    // wait_for_session はサーバと同じく SSE で返す。
    if (call.name === 'wait_for_session') return new Response(`event: message\ndata: ${body}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    return new Response(body, { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const PROJECTS = [
  { id: 'p1', name: 'alpha', path: path.resolve('/w/alpha') },
  { id: 'p2', name: 'alpha-sub', path: path.resolve('/w/alpha/sub') },
  { id: 'p3', name: 'other', path: null },
];
const finished = { session_id: 's1', state: 'finished', status: 'idle', last_message: '答えです', waited_seconds: 3, url: 'u' };

function basicHandler(wait: unknown = finished): Handler {
  return ({ name }) => {
    if (name === 'list_projects') return PROJECTS;
    if (name === 'create_session') return { session_id: 's1', run_id: 'r1' };
    if (name === 'wait_for_session') return wait;
    if (name === 'send_to_session') return { session_id: 's1', submitted: true };
    if (name === 'resume_session') return { session_id: 's1', run_id: 'r1' };
    throw new Error(`unexpected ${name}`);
  };
}

function server(o: Partial<RunServer> = {}) {
  const log: string[] = [];
  const s: RunServer = { ensure: async () => ({ owned: false }), stop: async () => { log.push('stop'); }, ...o };
  return { s, log };
}

async function run(handler: Handler, opts: Partial<RunCommandOptions> = {}) {
  const mcp = fakeMcp(handler);
  const out: string[] = [];
  const err: string[] = [];
  const { s, log } = server();
  const code = await runCommand({
    port: 4177, token: 'tok', json: false, timeoutSeconds: 1800, cwd: path.resolve('/w/alpha/sub/deep'), prompt: 'やって',
    fetch: mcp.fetchFn, server: s, isRunning: async () => true, log: (l) => out.push(l), error: (l) => err.push(l), ...opts,
  });
  return { code, calls: mcp.calls, out, err, serverLog: log };
}

describe('exitCodeOf', () => {
  it('終わった 0、失敗 1、時間切れ 3、入力待ち 4。2 はサーバを起こせないとき', () => {
    expect(exitCodeOf('finished')).toBe(0);
    expect(exitCodeOf('failed')).toBe(1);
    expect(exitCodeOf('timeout')).toBe(3);
    expect(exitCodeOf('waiting')).toBe(4);
    expect(EXIT.server).toBe(2);
  });
});

describe('hangar run', () => {
  it('新しい会話を、作業フォルダのいちばん深いプロジェクトで作って待ち、返答を標準出力に出す', async () => {
    const r = await run(basicHandler());
    expect(r.code).toBe(0);
    const create = r.calls.find((c) => c.name === 'create_session')!;
    expect(create.args).toMatchObject({ project_id: 'p2', prompt: 'やって' });
    expect(r.calls.at(-1)).toMatchObject({ name: 'wait_for_session', args: { session_id: 's1' } });
    expect(r.out).toEqual(['答えです']);
  });

  it('--project は id でもパスでも指せる。--agent などは create_session に渡す', async () => {
    const byId = await run(basicHandler(), { project: 'p1', agent: 'codex', model: 'm', name: 'n', effort: 'high', permissionMode: 'auto' });
    expect(byId.calls.find((c) => c.name === 'create_session')!.args).toEqual({ project_id: 'p1', prompt: 'やって', agent: 'codex', model: 'm', name: 'n', effort: 'high', permission_mode: 'auto' });
    const byPath = await run(basicHandler(), { project: path.resolve('/w/alpha') });
    expect(byPath.calls.find((c) => c.name === 'create_session')!.args.project_id).toBe('p1');
  });

  it('プロジェクトが決まらなければ失敗（1）で、会話を作らない', async () => {
    const r = await run(basicHandler(), { cwd: '/nowhere' });
    expect(r.code).toBe(1);
    expect(r.calls.some((c) => c.name === 'create_session')).toBe(false);
    expect(r.err.join('\n')).toMatch(/プロジェクト/);
  });

  it('プロンプトが無い新しい会話は失敗（1）', async () => {
    const r = await run(basicHandler(), { prompt: undefined });
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
  });

  it('--session は動いている会話へ送って待つ', async () => {
    const r = await run(basicHandler(), { session: 's9' });
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => c.name)).toEqual(['send_to_session', 'wait_for_session']);
    expect(r.calls[0]!.args).toEqual({ session_id: 's9', text: 'やって' });
  });

  it('--session が止まっていれば、再開して立ち上がりを待ってから送る', async () => {
    const r = await run(basicHandler(), { session: 's9', isRunning: async () => false });
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ name: 'resume_session', args: { session_id: 's9' } });
    expect(r.calls.map((c) => c.name)).toEqual(['resume_session', 'wait_for_session', 'send_to_session', 'wait_for_session']);
  });

  it('--session だけでプロンプトが無ければ、送らずに待つ', async () => {
    const r = await run(basicHandler(), { session: 's9', prompt: undefined });
    expect(r.calls.map((c) => c.name)).toEqual(['wait_for_session']);
  });

  it('入力待ちは 4 で、何を待っているかを標準エラーに出す', async () => {
    const r = await run(basicHandler({ ...finished, state: 'waiting', waiting: { kind: 'permission', text: 'Bash: ls' }, last_message: null }));
    expect(r.code).toBe(4);
    expect(r.err.join('\n')).toContain('Bash: ls');
  });

  it('時間切れは 3。残りを小分けにして呼び直す', async () => {
    const timeouts: number[] = [];
    let t = 0;
    const h: Handler = (c) => {
      if (c.name === 'wait_for_session') {
        timeouts.push(c.args.timeout_seconds as number);
        t += (c.args.timeout_seconds as number) * 1000;
        return { ...finished, state: 'timeout', status: 'busy', last_message: null };
      }
      return basicHandler()(c);
    };
    const r = await run(h, { timeoutSeconds: 500, now: () => t });
    expect(r.code).toBe(3);
    expect(timeouts).toEqual([240, 240, 20]);
  });

  it('failed は 1', async () => {
    const r = await run(basicHandler({ ...finished, state: 'failed', reason: 'limit' }));
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toMatch(/limit|使用制限/);
  });

  it('--json は結果を 1 行の JSON にまとめる', async () => {
    const r = await run(basicHandler(), { json: true });
    expect(r.out).toHaveLength(1);
    expect(JSON.parse(r.out[0]!)).toMatchObject({ state: 'finished', session_id: 's1', last_message: '答えです', exit_code: 0 });
  });

  it('--json の失敗も 1 行の JSON で、標準エラーは汚さない', async () => {
    const r = await run(() => { throw new Error('断りました'); }, { json: true, project: 'p1' });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out[0]!)).toMatchObject({ state: 'failed', reason: 'rejected', message: '断りました', exit_code: 1 });
    expect(r.err).toEqual([]);
  });

  it('サーバを起こせなければ 2', async () => {
    const mcp = fakeMcp(basicHandler());
    const out: string[] = [];
    const code = await runCommand({
      port: 4177, token: 'tok', json: true, timeoutSeconds: 10, cwd: path.resolve('/w/alpha'), prompt: 'x', fetch: mcp.fetchFn,
      server: { ensure: async () => { throw new Error('boom'); }, stop: async () => undefined }, log: (l) => out.push(l), error: () => undefined,
    });
    expect(code).toBe(2);
    expect(JSON.parse(out[0]!)).toMatchObject({ state: 'failed', reason: 'server_unavailable', exit_code: 2 });
  });

  it('自分で起こしたサーバは終わりに止める。元から居たサーバは止めない', async () => {
    const mcp = fakeMcp(basicHandler());
    const stops: string[] = [];
    await runCommand({ port: 4177, token: 'tok', json: false, timeoutSeconds: 10, cwd: path.resolve('/w/alpha'), prompt: 'x', fetch: mcp.fetchFn, log: () => undefined, error: () => undefined,
      server: { ensure: async () => ({ owned: true }), stop: async () => { stops.push('stop'); } } });
    expect(stops).toEqual(['stop']);
    const r = await run(basicHandler());
    expect(r.serverLog).toEqual([]);
  });

  it('待っている途中でサーバが消えたら（ほかの hangar run が止めた）、起こし直して待ち続ける', async () => {
    let waits = 0;
    let ensures = 0;
    const inner = fakeMcp(basicHandler());
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { params: { name: string } };
      if (body.params.name === 'wait_for_session' && ++waits === 1) throw new TypeError('fetch failed');
      return inner.fetchFn(input, init);
    }) as typeof fetch;
    const out: string[] = [];
    const code = await runCommand({ port: 4177, token: 'tok', json: false, timeoutSeconds: 10, cwd: path.resolve('/w/alpha'), prompt: 'x', fetch: fetchFn, log: (l) => out.push(l), error: () => undefined,
      server: { ensure: async () => { ensures++; return { owned: false }; }, stop: async () => undefined } });
    expect(code).toBe(0);
    expect(ensures).toBe(2);
    expect(out).toEqual(['答えです']);
  });
});
