import { describe, expect, it, vi } from 'vitest';
import { disposeConoutWorker, nodePtySpawn, releaseConpty } from './nodePty.ts';

// 実物の node-pty。Windows の実物は nodePty.win.test.ts と nodePtyRace.win.test.ts が見る。
describe.skipIf(process.platform === 'win32')('nodePtySpawn（macOS と Linux の実物）', () => {
  // 端末の大きさの知らせは、WebSocket のメッセージの受け口から届く。そこで投げると、サーバのプロセスごと落ちる。
  // 子が終わった後に届くことは普通にある（タブを閉じる途中で、画面の大きさが変わる）。
  it('子が終わった後の resize で投げない', async () => {
    const p = nodePtySpawn('/bin/sh', ['-c', 'exit 0'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
    expect(p.pid).toBeGreaterThan(0);
    await new Promise<void>((resolve) => { p.onExit(() => resolve()); });
    // 終わりの通知の後、node-pty が fd を閉じ終えるのを待つ。
    await new Promise((r) => setTimeout(r, 200));
    expect(() => p.resize(100, 30)).not.toThrow();
    expect(() => p.kill()).not.toThrow();
  });
});

// Windows の node-pty の内側（WindowsTerminal._agent）を真似た偽物で、解放の呼び方を見る。実物は nodePtyRelease.win.test.ts が見る。
describe('releaseConpty と disposeConoutWorker（node-pty の内側の偽物）', () => {
  const fake = () => {
    const kill = vi.fn();
    const resize = vi.fn();
    const dispose = vi.fn();
    const agent = { _pty: 7, _useConptyDll: false, _ptyNative: { kill, resize }, _conoutSocketWorker: { dispose } };
    return { p: { _agent: agent }, agent, kill, resize, dispose };
  };

  it('native の kill（pseudoconsole を閉じる）と conout の Worker の dispose を呼び、true を返す', () => {
    const f = fake();
    expect(releaseConpty(f.p)).toBe(true);
    expect(f.kill).toHaveBeenCalledWith(7, false);
    expect(f.dispose).toHaveBeenCalledTimes(1);
  });

  // 閉じた pseudoconsole の handle を、待ちの後の node-pty の kill がもう一度閉じないようにする（二重の ClosePseudoConsole）。
  it('解放の後は、node-pty の内側からの native の kill を空にし、ほかの native の呼び出しはそのまま通す', () => {
    const f = fake();
    releaseConpty(f.p);
    f.agent._ptyNative.kill(7, false);
    expect(f.kill).toHaveBeenCalledTimes(1);
    f.agent._ptyNative.resize(7, 80, 24, false);
    expect(f.resize).toHaveBeenCalledWith(7, 80, 24, false);
  });

  it('native の kill や dispose が投げても投げず、残りを呼ぶ', () => {
    const f = fake();
    f.kill.mockImplementation(() => { throw new Error('boom'); });
    f.dispose.mockImplementation(() => { throw new Error('boom'); });
    expect(releaseConpty(f.p)).toBe(true);
    expect(f.dispose).toHaveBeenCalledTimes(1);
  });

  it('内側の形が違う（_agent が無い、別の版）ときは何もせず false を返す', () => {
    expect(releaseConpty({})).toBe(false);
    expect(releaseConpty(null)).toBe(false);
    expect(releaseConpty({ _agent: { _pty: 7, _ptyNative: {} } })).toBe(false);
    const f = fake();
    (f.agent as { _pty: unknown })._pty = undefined;
    expect(releaseConpty(f.p)).toBe(false);
    expect(f.kill).not.toHaveBeenCalled();
    expect(f.dispose).not.toHaveBeenCalled();
  });

  it('disposeConoutWorker は Worker の dispose だけを呼び、native の kill は呼ばない', () => {
    const f = fake();
    disposeConoutWorker(f.p);
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(f.kill).not.toHaveBeenCalled();
    expect(() => disposeConoutWorker({})).not.toThrow();
  });
});
