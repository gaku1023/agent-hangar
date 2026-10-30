import { describe, it, expect, vi } from 'vitest';
import type { LaunchPrepDto } from '@agent-hangar/shared';
import { LaunchPreps, LaunchPrepCancelled } from '../../../runs/launchPrep.ts';
import { LmServerStarter } from './serverStart.ts';

const provider = { id: 'lmstudio', baseURL: 'http://127.0.0.1:1234/v1' };
const ready = () => Response.json({ models: [] });
function prep() {
  const events: LaunchPrepDto[] = [];
  const run = new LaunchPreps({ broadcast: (e) => events.push(e.prep) }).begin(undefined);
  return { run, events };
}
function rig(o: { running?: boolean; find?: () => string | null; command?: (args: string[], signal: AbortSignal) => Promise<void> } = {}) {
  let running = o.running ?? false;
  const calls: string[][] = [];
  const service = new LmServerStarter({
    find: o.find ?? (() => '/tools/lms'),
    fetch: (async () => { if (!running) throw new TypeError('fetch failed'); return ready(); }) as typeof fetch,
    run: async (_bin, args, signal) => { calls.push(args); if (o.command) await o.command(args, signal); if (args[0] === 'server') running = true; },
  });
  return { service, calls };
}

describe('LM Studio サーバーの自動起動', () => {
  it('API を確認してから起動し、接続できたら完了を配る', async () => {
    const r = rig(), p = prep();
    await r.service.ensure(provider, p.run);
    expect(r.calls).toEqual([['daemon', 'up'], ['server', 'start', '--port', '1234', '--bind', '127.0.0.1']]);
    expect(p.events[0]!.steps[0]).toMatchObject({ kind: 'local-server', action: 'server-start', state: 'running' });
    expect(p.events.at(-1)!.steps[0]).toMatchObject({ state: 'done' });
  });
  it('起動済みなら CLI を探さず進行表示もしない', async () => {
    const r = rig({ running: true, find: () => { throw new Error('must not find'); } }), p = prep();
    await r.service.ensure(provider, p.run);
    expect(r.calls).toEqual([]); expect(p.events).toEqual([]);
  });
  it.each([
    { id: 'ollama', baseURL: provider.baseURL },
    { id: 'lmstudio', baseURL: 'http://192.168.3.40:1234/v1' },
    { id: 'lmstudio', baseURL: 'https://127.0.0.1:1234/v1' },
    { id: 'lmstudio', baseURL: 'http://user:secret@127.0.0.1:1234/v1' },
    { id: 'lmstudio', baseURL: 'http://127.0.0.1:1234/proxy/v1' },
    { id: 'lmstudio', baseURL: null },
  ])('自動起動の対象外には触らない: %j', async (target) => {
    const p = prep();
    await new LmServerStarter({ fetch: (async () => { throw new Error('must not fetch'); }) as typeof fetch, find: () => { throw new Error('must not find'); } }).ensure(target, p.run);
    expect(p.events).toEqual([]);
  });
  it('HTTP エラーは停止とみなさない', async () => {
    const p = prep();
    await new LmServerStarter({ fetch: (async () => new Response('', { status: 401 })) as typeof fetch, find: () => { throw new Error('must not find'); } }).ensure(provider, p.run);
    expect(p.events).toEqual([]);
  });
  it('設定されたポートと IPv6 のループバックで起動する', async () => {
    const r = rig();
    await r.service.ensure({ id: 'lmstudio', baseURL: 'http://[::1]:5432/v1/' }, prep().run);
    expect(r.calls[1]).toEqual(['server', 'start', '--port', '5432', '--bind', '::1']);
  });
  it('CLI がなければサーバーの段で失敗する', async () => {
    const r = rig({ find: () => null }), p = prep();
    await expect(r.service.ensure(provider, p.run)).rejects.toThrow('起動コマンド');
    expect(p.events.at(-1)!.steps[0]).toMatchObject({ state: 'failed' });
  });
  it('daemon の起動が失敗したら server start に進まない', async () => {
    const r = rig({ command: async () => { throw new Error('exit 1'); } }), p = prep();
    await expect(r.service.ensure(provider, p.run)).rejects.toThrow('サーバー');
    expect(r.calls).toHaveLength(1);
    expect(p.events.at(-1)!.steps[0]).toMatchObject({ state: 'failed' });
  });
  it('同時開始は共有し、一人の中止で他の開始を止めない', async () => {
    let unblock!: () => void;
    const gate = new Promise<void>((r) => { unblock = r; });
    const r = rig({ command: async (args) => { if (args[0] === 'daemon') await gate; } });
    const a = prep(), b = prep();
    const one = r.service.ensure(provider, a.run), two = r.service.ensure(provider, b.run);
    const cancelled = expect(one).rejects.toBeInstanceOf(LaunchPrepCancelled);
    await vi.waitFor(() => expect(r.calls).toHaveLength(1));
    a.run.cancel(); await cancelled; unblock(); await two;
    expect(r.calls).toHaveLength(2);
    expect(b.events.at(-1)!.steps[0]?.state).toBe('done');
  });
  it('全員中止した起動の後でも再試行できる', async () => {
    let first = true;
    const r = rig({ command: async (_args, signal) => {
      if (!first) return; first = false;
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
    const p = prep(), pending = r.service.ensure(provider, p.run);
    const cancelled = expect(pending).rejects.toBeInstanceOf(LaunchPrepCancelled);
    await vi.waitFor(() => expect(r.calls).toHaveLength(1)); p.run.cancel(); await cancelled;
    await r.service.ensure(provider, prep().run);
    expect(r.calls.filter((c) => c[0] === 'server')).toHaveLength(1);
  });
  it('CLI が成功しても API が起きなければ時間制限で失敗する', async () => {
    const p = prep();
    const service = new LmServerStarter({ find: () => '/tools/lms', run: async () => {}, timeoutMs: 30, pollMs: 1, fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    await expect(service.ensure(provider, p.run)).rejects.toThrow('サーバー');
    expect(p.events.at(-1)!.steps[0]?.state).toBe('failed');
  });
});
