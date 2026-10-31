import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Pacer } from '../platform/pacer.ts';
import { watchRemoteUrl } from '../mobile/remoteUrl.ts';
import { Tmux } from '../tmux/tmux.ts';
import { MuxServers } from '../tmux/servers.ts';

/** 手で解く Promise。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('Pacer（待つ回）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('run が返す Promise が終わるまで、次の回を始めない', async () => {
    const d = deferred<void>();
    let runs = 0;
    const p = new Pacer({ run: () => { runs++; return d.promise; }, fastMs: 100, slowMs: 100, fast: () => false });
    p.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(1);
    d.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(runs).toBe(2);
    p.stop();
  });

  it('回の途中の kick は重ねず、終わってから繰り上げる', async () => {
    const d = deferred<void>();
    let runs = 0;
    const p = new Pacer({ run: () => { runs++; return runs === 1 ? d.promise : undefined; }, fastMs: 5000, slowMs: 5000, fast: () => false });
    p.start();
    await vi.advanceTimersByTimeAsync(5000);
    p.kick(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(1);
    d.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(2);
    p.stop();
  });

  it('断られた Promise は onError に渡し、周期を止めない', async () => {
    const errors: unknown[] = [];
    let runs = 0;
    const p = new Pacer({ run: () => { runs++; return Promise.reject(new Error('x')); }, fastMs: 100, slowMs: 100, fast: () => false, onError: (e) => errors.push(e) });
    p.start();
    await vi.advanceTimersByTimeAsync(250);
    expect(runs).toBe(2);
    expect(errors.length).toBe(2);
    p.stop();
  });
});

describe('Tmux と MuxServers の待たない一覧', () => {
  const async0 = (stdout: string) => vi.fn(async () => ({ status: 0, stdout, stderr: '' }));

  it('listSessionsAsync は待たない口を通り、run の exec を呼ばない', async () => {
    const exec = vi.fn(() => { throw new Error('同期で呼んだ'); });
    const t = new Tmux({ tmuxPath: 'tmux', platform: 'win32', exec, execAsync: async0('a\r\nb\r\n') });
    await expect(t.listSessionsAsync()).resolves.toEqual(['a', 'b']);
    expect(exec).not.toHaveBeenCalled();
  });

  it('起こせなければ null、サーバが無ければ空である（listSessions と同じ）', async () => {
    const failed = new Tmux({ tmuxPath: 'tmux', execAsync: async () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') }) });
    await expect(failed.listSessionsAsync()).resolves.toBeNull();
    const none = new Tmux({ tmuxPath: 'tmux', execAsync: async () => ({ status: 1, stdout: '', stderr: 'no server running on /tmp/x' }) });
    await expect(none.listSessionsAsync()).resolves.toEqual([]);
  });

  it('本物の待たない口は、無いパスを失敗として返し、投げない', async () => {
    await expect(new Tmux({ tmuxPath: '/nonexistent/tmux' }).listSessionsAsync()).resolves.toBeNull();
  });

  it('MuxServers.listAsync は list と同じに既定のサーバの hangar の画面を足す', async () => {
    const own = new Tmux({ tmuxPath: 'tmux', execAsync: async0('hangar-aa\n') });
    const legacy = new Tmux({ tmuxPath: 'tmux', execAsync: async0('hangar-bb\nmine\n') });
    const mux = new MuxServers(own, legacy);
    await expect(mux.listAsync()).resolves.toEqual(['hangar-aa', 'hangar-bb']);
    expect(mux.serverOf('hangar-bb')).toBe(legacy);
  });
});

describe('watchRemoteUrl（待つ読み）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('遅い読みの上に次の読みを重ねず、読めたら onFound を呼ぶ', async () => {
    const d = deferred<{ text: string; width: number | null }>();
    const capture = vi.fn(() => d.promise);
    const found: string[] = [];
    const stop = watchRemoteUrl({ capture, onFound: (u) => found.push(u), timers: { setInterval, clearInterval }, everyMs: 100, forMs: 1000 });
    await vi.advanceTimersByTimeAsync(500);
    expect(capture).toHaveBeenCalledTimes(1);
    d.resolve({ text: 'at https://claude.ai/code/session_abc', width: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(found).toEqual(['https://claude.ai/code/session_abc']);
    stop();
  });

  it('止めた後に返った読みでは onFound を呼ばない', async () => {
    const d = deferred<{ text: string; width: number | null }>();
    const found: string[] = [];
    const stop = watchRemoteUrl({ capture: () => d.promise, onFound: (u) => found.push(u), timers: { setInterval, clearInterval }, everyMs: 100, forMs: 1000 });
    await vi.advanceTimersByTimeAsync(100);
    stop();
    d.resolve({ text: 'https://claude.ai/code/session_abc', width: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(found).toEqual([]);
  });
});
