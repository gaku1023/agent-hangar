import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPtyCloser } from './close.ts';

// node-pty は Windows で pty を閉じるとき、子のコンソールの一覧を取る補助のプロセスを起こす。
// 補助は pty を閉じる直前か後に動くので、すでに無いコンソールにつなごうとして "AttachConsole failed" を出す。
// そこで Windows では、先に子のプロセスだけを終わらせ、node-pty が終了を見て自分で後始末するのを待つ。
describe('createPtyCloser', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const make = (platform: NodeJS.Platform, killPid: (pid: number) => void = () => {}) => {
    const hardKill = vi.fn();
    const killPidFn = vi.fn(killPid);
    const c = createPtyCloser({ pid: 4321, platform, hardKill, killPid: killPidFn, graceMs: 2000 });
    return { c, hardKill, killPid: killPidFn };
  };

  it('Unix では今までどおり pty の kill をそのまま呼ぶ', () => {
    const { c, hardKill, killPid } = make('darwin');
    c.close();
    expect(hardKill).toHaveBeenCalledTimes(1);
    expect(killPid).not.toHaveBeenCalled();
  });

  it('Windows では子のプロセスだけを終わらせ、pty の kill は呼ばない', () => {
    const { c, hardKill, killPid } = make('win32');
    c.close();
    expect(killPid).toHaveBeenCalledWith(4321);
    expect(hardKill).not.toHaveBeenCalled();
    // 終わりを見たら、待ちの後でも pty の kill は呼ばない。
    c.markExited();
    vi.advanceTimersByTime(10_000);
    expect(hardKill).not.toHaveBeenCalled();
  });

  it('Windows で待っても終わらなければ、待ちの後に pty の kill へ落とす', () => {
    const { c, hardKill } = make('win32');
    c.close();
    vi.advanceTimersByTime(1999);
    expect(hardKill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hardKill).toHaveBeenCalledTimes(1);
  });

  it('すでに終わっていれば、どちらも呼ばない', () => {
    const w = make('win32');
    w.c.markExited();
    w.c.close();
    expect(w.killPid).not.toHaveBeenCalled();
    expect(w.hardKill).not.toHaveBeenCalled();
    const u = make('linux');
    u.c.markExited();
    u.c.close();
    expect(u.hardKill).not.toHaveBeenCalled();
  });

  it('何度呼んでも 1 回だけ働く', () => {
    const { c, hardKill, killPid } = make('win32');
    c.close(); c.close();
    vi.advanceTimersByTime(5000); c.close();
    expect(killPid).toHaveBeenCalledTimes(1);
    expect(hardKill).toHaveBeenCalledTimes(1);
  });

  it('子のプロセスがもう無くて killPid が投げても、投げず、待ちの後に落とす', () => {
    const { c, hardKill } = make('win32', () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); });
    expect(() => c.close()).not.toThrow();
    vi.advanceTimersByTime(2000);
    expect(hardKill).toHaveBeenCalledTimes(1);
  });

  it('待ちの後の pty の kill が投げても、投げない', () => {
    const hardKill = vi.fn(() => { throw new Error('boom'); });
    const c = createPtyCloser({ pid: 1, platform: 'win32', hardKill, killPid: () => {}, graceMs: 10 });
    c.close();
    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
    expect(hardKill).toHaveBeenCalled();
  });
});
