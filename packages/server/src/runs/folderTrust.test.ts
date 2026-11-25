import { describe, expect, it } from 'vitest';
import { FolderTrustLive, isFolderTrustRow, watchTrustDialog } from './folderTrust.ts';

const SCREEN = ' Accessing workspace:\n\n D:\\workspace\\ops\n\n Quick safety check: Is this a project you created or one you trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n';

/** 手で進める時計。 */
function manualTimers() {
  const fns = new Map<number, () => void>();
  let n = 0;
  return {
    timers: { setInterval: ((fn: () => void) => { fns.set(++n, fn); return n as unknown as ReturnType<typeof setInterval>; }) as typeof setInterval, clearInterval: ((id: number) => { fns.delete(id); }) as unknown as typeof clearInterval },
    tick: () => { for (const fn of [...fns.values()]) fn(); },
    active: () => fns.size,
  };
}

describe('FolderTrustLive', () => {
  it('確認を入力待ちの行として足し、外すと消える。同じパスの重ねでは知らせない', () => {
    const l = new FolderTrustLive(() => 5);
    const seen: number[] = [];
    l.onChange((live) => seen.push(live.length));
    l.set('u1', { cwd: 'D:\\workspace\\ops', path: 'D:\\workspace\\ops' });
    l.set('u1', { cwd: 'D:\\workspace\\ops', path: 'D:\\workspace\\ops' });
    const [row] = l.current();
    expect(row).toMatchObject({ sessionId: 'u1', status: 'waiting', waitingFor: 'permission', permission: { tool: 'FolderTrust', input: 'D:\\workspace\\ops', description: null }, pid: 0, statusAt: 5 });
    expect(isFolderTrustRow(row!)).toBe(true);
    l.clear('u1');
    l.clear('u1');
    expect(l.current()).toEqual([]);
    expect(seen).toEqual([1, 0]);
  });
});

describe('watchTrustDialog', () => {
  it('登録が無い間は画面を読み、確認の出入りのたびに知らせる。変わらなければ知らせない', () => {
    const t = manualTimers();
    let screen = 'starting…';
    const got: (string | null)[] = [];
    watchTrustDialog({ capture: () => screen, registered: () => false, onDialog: (d) => got.push(d?.path ?? null), timers: t.timers });
    t.tick();
    expect(got).toEqual([]);
    screen = SCREEN;
    t.tick();
    t.tick();
    expect(got).toEqual(['D:\\workspace\\ops']);
    screen = '❯ Try "x"';
    t.tick();
    expect(got).toEqual(['D:\\workspace\\ops', null]);
  });
  it('登録が現れたら確認を外して止まる', () => {
    const t = manualTimers();
    let reg = false;
    const got: (string | null)[] = [];
    watchTrustDialog({ capture: () => SCREEN, registered: () => reg, onDialog: (d) => got.push(d?.path ?? null), timers: t.timers });
    t.tick();
    reg = true;
    t.tick();
    expect(got).toEqual(['D:\\workspace\\ops', null]);
    expect(t.active()).toBe(0);
  });
  it('返す関数で止める。読めなかった回は投げず、遅い読みの上に重ねない', async () => {
    const t = manualTimers();
    let calls = 0;
    let release!: (s: string) => void;
    const got: unknown[] = [];
    const stop = watchTrustDialog({ capture: () => { calls++; return calls === 1 ? Promise.reject(new Error('x')) : new Promise<string>((r) => { release = r; }); }, registered: () => false, onDialog: (d) => got.push(d), timers: t.timers });
    t.tick();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    t.tick();
    t.tick();
    expect(calls).toBe(2);
    stop();
    release(SCREEN);
    await Promise.resolve(); await Promise.resolve();
    expect(got).toEqual([]);
    expect(t.active()).toBe(0);
  });
});
