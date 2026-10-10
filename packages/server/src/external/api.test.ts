import { describe, expect, it } from 'vitest';
import { createExternalApi } from './api.ts';
import { BREAKAWAY_FLAG } from './breakaway.ts';
import type { Exec } from './open.ts';

describe('ターミナルとエディタへの受け渡し', () => {
  it('tmux のパスが無ければ、外のターミナルは開かずに設定の欄を案内する', () => {
    const api = createExternalApi({ home: '/nope', settings: () => ({ tmuxPath: null, terminalApp: 'terminal', codePath: null }) });
    expect(() => api.openTerminal({ tmuxName: 'hangar-r1' })).toThrow('tmux が見つかりません。設定の「tmux のパス」を入力してください');
  });

  it('設定は呼ばれた時点の値を読む。作ったときの値を覚えない', () => {
    let reads = 0;
    const api = createExternalApi({ home: '/nope', settings: () => { reads++; return { tmuxPath: null, terminalApp: 'terminal', codePath: null }; } });
    expect(reads).toBe(0);
    expect(() => api.openTerminal({ tmuxName: 'a' })).toThrow();
    expect(() => api.openTerminal({ tmuxName: 'a' })).toThrow();
    expect(reads).toBe(2);
  });
});

// Windows の殻はサーバをジョブに入れ、Hangar を閉じるとジョブごと止める。
// サーバがそのまま起こした外のアプリもジョブに入り、道連れになる。殻が起こし役の場所（launcher）を渡したら、外のアプリは起こし役越しに起こす。
describe('外のアプリをジョブの外で起こす（Windows）', () => {
  const launcher = 'C:\\Hangar\\Hangar.exe';
  const record = () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const exec: Exec = async (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: '', stderr: '' }; };
    return { calls, exec };
  };
  const settings = () => ({ tmuxPath: 'C:\\psmux\\psmux.exe', terminalApp: 'windowsTerminal' as const, codePath: 'C:\\VS Code\\Code.exe' });

  it('ターミナル、フォルダ、エディタ、URL のどれも、起こし役越しに起こす', async () => {
    const r = record();
    const api = createExternalApi({ home: '/nope', settings, launcher, exec: r.exec, platform: 'win32' });
    await api.openTerminal({ tmuxName: 'hangar-r1' });
    await api.openDirTerminal({ dir: 'D:\\w' });
    await api.openEditor({ target: 'D:\\w\\a.md' });
    await api.openUrl('https://example.com/?a=1&b=2');
    expect(r.calls.map((c) => [c.cmd, c.args[0], c.args[1]])).toEqual([
      [launcher, BREAKAWAY_FLAG, 'wt.exe'],
      [launcher, BREAKAWAY_FLAG, 'wt.exe'],
      [launcher, BREAKAWAY_FLAG, 'C:\\VS Code\\Code.exe'],
      [launcher, BREAKAWAY_FLAG, 'rundll32.exe'],
    ]);
    expect(r.calls[3]!.args[2]).toBe('url.dll,FileProtocolHandler https://example.com/?a=1&b=2');
  });

  it('起こし役が無い（端末から起こしたサーバ）か、Windows でなければ、直に起こす', async () => {
    for (const o of [{ launcher: undefined, platform: 'win32' as const }, { launcher, platform: 'darwin' as const }]) {
      const r = record();
      const api = createExternalApi({ home: '/nope', settings, exec: r.exec, ...o });
      await api.openUrl('https://example.com/');
      expect(r.calls[0]!.cmd).toBe(o.platform === 'win32' ? 'rundll32.exe' : 'open');
    }
  });

  it('URL を開けなければ断る', async () => {
    const exec: Exec = async () => ({ code: 1, stdout: '', stderr: 'no handler' });
    const api = createExternalApi({ home: '/nope', settings, launcher, exec, platform: 'win32' });
    await expect(api.openUrl('https://example.com/')).rejects.toThrow('no handler');
  });
});
