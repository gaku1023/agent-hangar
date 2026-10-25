import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPtyCloser } from './close.ts';

// node-pty は Windows で pty を閉じるとき、子のコンソールの一覧を取る補助のプロセスを起こす。
// 補助は pty を閉じる直前か後に動くので、すでに無いコンソールにつなごうとして "AttachConsole failed" を出す。
// そこで Windows では補助を起こさずに閉じ、node-pty が終了を見て自分で後始末するのを待つ。
// 解放の口（release）を渡さないときは、今までどおり子のプロセスだけを終わらせる。
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

  // node-pty 1.2 の Windows は、子の pid を pseudoconsole につないだ後（ready）で決める。spawn の直後は 0 である。
  // pid を spawn の時に写すと、閉じるときに process.kill(0) を呼ぶ。Windows の process.kill(0) はサーバ自身を終わらせる。
  it('Windows では子の pid を閉じる時に読む', () => {
    let pid = 0;
    const killPid = vi.fn();
    const c = createPtyCloser({ pid: () => pid, platform: 'win32', hardKill: () => {}, killPid, graceMs: 2000 });
    pid = 5678;
    c.close();
    expect(killPid).toHaveBeenCalledWith(5678);
  });

  it('Windows で子の pid がまだ決まっていなければ（0）、process.kill を呼ばず pty の kill に任せる', () => {
    const hardKill = vi.fn();
    const killPid = vi.fn();
    const c = createPtyCloser({ pid: () => 0, platform: 'win32', hardKill, killPid, graceMs: 2000 });
    c.close();
    expect(killPid).not.toHaveBeenCalled();
    expect(hardKill).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(hardKill).toHaveBeenCalledTimes(1);
  });

  // node-pty 1.2 の Windows は、子が自分で終わった経路で pseudoconsole（conhost）と conout の Worker を放さない。
  // pty ごとにスレッドが 1 本、私用メモリが約 16MB 残り、開け閉めを繰り返すとサーバが heap out of memory で落ちた。
  // そこで pid が決まっていれば、まず pseudoconsole を閉じて Worker を放す（release）。補助のプロセスは起こさない。
  describe('Windows で解放の口があるとき', () => {
    const makeR = (release: () => boolean = () => true, pid: number | (() => number) = 4321) => {
      const order: string[] = [];
      const hardKill = vi.fn(() => { order.push('hardKill'); });
      const killPid = vi.fn((_: number) => { order.push('killPid'); });
      const rel = vi.fn(() => { order.push('release'); return release(); });
      const c = createPtyCloser({ pid, platform: 'win32', hardKill, killPid, release: rel, graceMs: 2000 });
      return { c, hardKill, killPid, release: rel, order };
    };

    it('先に解放だけを呼び、子の pid と pty の kill は呼ばない', () => {
      const { c, hardKill, killPid, release } = makeR();
      c.close();
      expect(release).toHaveBeenCalledTimes(1);
      expect(killPid).not.toHaveBeenCalled();
      expect(hardKill).not.toHaveBeenCalled();
    });

    it('解放の後に終わりを見たら、待ちの後でも何も呼ばない', () => {
      const { c, hardKill, killPid } = makeR();
      c.close();
      c.markExited();
      vi.advanceTimersByTime(60_000);
      expect(killPid).not.toHaveBeenCalled();
      expect(hardKill).not.toHaveBeenCalled();
    });

    it('待っても終わらなければ子の pid を止め、さらに待って pty の kill へ落とす', () => {
      const { c, hardKill, killPid, order } = makeR();
      c.close();
      vi.advanceTimersByTime(1999);
      expect(killPid).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(killPid).toHaveBeenCalledWith(4321);
      expect(hardKill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1999);
      expect(hardKill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(hardKill).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['release', 'killPid', 'hardKill']);
    });

    it('子の pid を止めた後に終わりを見たら、pty の kill は呼ばない', () => {
      const { c, hardKill, killPid } = makeR();
      c.close();
      vi.advanceTimersByTime(2000);
      expect(killPid).toHaveBeenCalledTimes(1);
      c.markExited();
      vi.advanceTimersByTime(60_000);
      expect(hardKill).not.toHaveBeenCalled();
    });

    it('pid がまだ 0 なら、解放も子の pid も呼ばず、pty の kill に任せる', () => {
      const { c, hardKill, killPid, release } = makeR(() => true, () => 0);
      c.close();
      expect(release).not.toHaveBeenCalled();
      expect(killPid).not.toHaveBeenCalled();
      expect(hardKill).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      expect(hardKill).toHaveBeenCalledTimes(1);
    });

    it('すでに終わっていれば、何も呼ばない', () => {
      const { c, hardKill, killPid, release } = makeR();
      c.markExited();
      c.close();
      vi.advanceTimersByTime(60_000);
      expect(release).not.toHaveBeenCalled();
      expect(killPid).not.toHaveBeenCalled();
      expect(hardKill).not.toHaveBeenCalled();
    });

    it('何度呼んでも、解放は 1 回だけ', () => {
      const { c, hardKill, killPid, release } = makeR();
      c.close(); c.close();
      vi.advanceTimersByTime(4000); c.close();
      expect(release).toHaveBeenCalledTimes(1);
      expect(killPid).toHaveBeenCalledTimes(1);
      expect(hardKill).toHaveBeenCalledTimes(1);
    });

    // 別の版の node-pty で内側の形が違うときは、解放の口は false を返す。今までの閉じ方（子の pid を止めて待つ）に戻る。
    it('解放できなかった（false）ときは、すぐに子の pid を止め、待ちの後に pty の kill へ落とす', () => {
      const { c, hardKill, killPid } = makeR(() => false);
      c.close();
      expect(killPid).toHaveBeenCalledWith(4321);
      expect(hardKill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2000);
      expect(hardKill).toHaveBeenCalledTimes(1);
    });

    it('解放が投げても投げず、解放できなかったときと同じに閉じる', () => {
      const { c, hardKill, killPid } = makeR(() => { throw new Error('boom'); });
      expect(() => c.close()).not.toThrow();
      expect(killPid).toHaveBeenCalledWith(4321);
      vi.advanceTimersByTime(2000);
      expect(hardKill).toHaveBeenCalledTimes(1);
    });
  });

  it('待ちの後の pty の kill が投げても、投げない', () => {
    const hardKill = vi.fn(() => { throw new Error('boom'); });
    const c = createPtyCloser({ pid: 1, platform: 'win32', hardKill, killPid: () => {}, graceMs: 10 });
    c.close();
    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
    expect(hardKill).toHaveBeenCalled();
  });
});
