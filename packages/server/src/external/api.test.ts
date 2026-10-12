import { describe, expect, it } from 'vitest';
import { createExternalApi } from './api.ts';
import { BREAKAWAY_FLAG } from './breakaway.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EditorSetting } from '@agent-hangar/shared';
import { EditorMissingError, type Exec } from './open.ts';
import type { EditorHost } from './editors.ts';

/** ファイルの有無だけを持つ見せかけの PC。 */
function fakeHost(platform: NodeJS.Platform, files: string[], onPath: Record<string, string> = {}): EditorHost {
  return { platform, env: {}, home: platform === 'win32' ? 'C:\\Users\\u' : '/Users/u', exists: (f) => files.includes(f), isExec: (f) => files.includes(f), which: (n) => onPath[n] ?? null, readdir: () => [] };
}

describe('ターミナルとエディタへの受け渡し', () => {
  it('tmux のパスが無ければ、外のターミナルは開かずに設定の欄を案内する', () => {
    const api = createExternalApi({ home: '/nope', settings: () => ({ tmuxPath: null, terminalApp: 'terminal', editor: { id: 'vscode' as const, path: null, fileCmd: '', dirCmd: '', terminal: 'none' as const } }) });
    expect(() => api.openTerminal({ tmuxName: 'hangar-r1' })).toThrow('tmux が見つかりません。設定の「tmux のパス」を入力してください');
  });

  it('外のターミナルは hangar の専用の tmux サーバへつなぎ、前の版のセッションは居るサーバへつなぐ', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' }; };
    const settings = () => ({ tmuxPath: 'C:\\psmux\\psmux.exe', terminalApp: 'windowsTerminal' as const, editor: { id: 'vscode' as const, path: null, fileCmd: '', dirCmd: '', terminal: 'none' as const } });
    await createExternalApi({ home: '/nope', settings, exec, platform: 'win32' }).openTerminal({ tmuxName: 'hangar-r1' });
    expect(calls[0]!.slice(-7)).toEqual(['--', 'C:\\psmux\\psmux.exe', '-L', 'hangar', 'attach', '-t', '=hangar-r1']);
    const socketArgs = (name: string) => (name === 'hangar-old' ? [] : ['-L', 'hangar']);
    await createExternalApi({ home: '/nope', settings, exec, platform: 'win32', socketArgs }).openTerminal({ tmuxName: 'hangar-old' });
    expect(calls[1]!.slice(-5)).toEqual(['--', 'C:\\psmux\\psmux.exe', 'attach', '-t', '=hangar-old']);
  });

  it('設定は呼ばれた時点の値を読む。作ったときの値を覚えない', () => {
    let reads = 0;
    const api = createExternalApi({ home: '/nope', settings: () => { reads++; return { tmuxPath: null, terminalApp: 'terminal', editor: { id: 'vscode' as const, path: null, fileCmd: '', dirCmd: '', terminal: 'none' as const } }; } });
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
  const settings = () => ({ tmuxPath: 'C:\\psmux\\psmux.exe', terminalApp: 'windowsTerminal' as const, editor: { id: 'vscode' as const, path: 'C:\\VS Code\\Code.exe', fileCmd: '', dirCmd: '', terminal: 'none' as const } });
  const host = fakeHost('win32', ['C:\\VS Code\\Code.exe']);

  it('ターミナル、フォルダ、エディタ、URL のどれも、起こし役越しに起こす', async () => {
    const r = record();
    const api = createExternalApi({ home: '/nope', settings, launcher, exec: r.exec, platform: 'win32', host });
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

  // Windows では、起こしたブラウザが出力の管を受け継ぐことがあるので、子が終わったら返す（untilExit）。ほかの OS は今のまま。
  it('URL は、Windows では子が終われば返し、ほかの OS ではいまのまま起こす', async () => {
    for (const o of [{ launcher, platform: 'win32' as const, want: { untilExit: true } }, { launcher: undefined, platform: 'win32' as const, want: { untilExit: true } }, { launcher: undefined, platform: 'darwin' as const, want: undefined }]) {
      const seen: unknown[] = [];
      const exec: Exec = async (_cmd, _args, opts) => { seen.push(opts); return { code: 0, stdout: '', stderr: '' }; };
      await createExternalApi({ home: '/nope', settings, exec, launcher: o.launcher, platform: o.platform }).openUrl('https://example.com/');
      expect(seen).toEqual([o.want]);
    }
  });

  it('URL を開けなければ断る', async () => {
    const exec: Exec = async () => ({ code: 1, stdout: '', stderr: 'no handler' });
    const api = createExternalApi({ home: '/nope', settings, launcher, exec, platform: 'win32' });
    await expect(api.openUrl('https://example.com/')).rejects.toThrow('no handler');
  });
});

describe('エディタで開く', () => {
  const record = () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const exec: Exec = async (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: '', stderr: '' }; };
    return { calls, exec };
  };
  const base = (editor: Partial<EditorSetting>) => () => ({ tmuxPath: null, terminalApp: 'terminal' as const, editor: { id: 'vscode' as const, path: null, fileCmd: '', dirCmd: '', terminal: 'none' as const, ...editor } });
  const mac = fakeHost('darwin', [], { code: '/usr/local/bin/code', zed: '/usr/local/bin/zed', nvim: '/usr/local/bin/nvim' });

  it('ファイルは行まで、フォルダはそのまま開く。今回だけ別のエディタも選べる', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-edapi-'));
    try {
      const file = path.join(dir, 'a.ts');
      fs.writeFileSync(file, 'x');
      const r = record();
      const api = createExternalApi({ home: dir, settings: base({}), exec: r.exec, platform: 'darwin', host: mac });
      await api.openEditor({ target: file, line: 4 });
      await api.openEditor({ target: dir, line: 4 });
      await api.openEditor({ target: file, line: 2, once: 'zed' });
      expect(r.calls).toEqual([
        { cmd: '/usr/local/bin/code', args: ['-g', `${file}:4`] },
        { cmd: '/usr/local/bin/code', args: [dir] },
        { cmd: '/usr/local/bin/zed', args: [`${file}:2`] },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('見つからなければ、ほかに見つかっているエディタを添えて断る', async () => {
    const api = createExternalApi({ home: '/nope', settings: base({ id: 'cursor' }), exec: record().exec, platform: 'darwin', host: mac });
    const e = await api.openEditor({ target: '/w/a.ts' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EditorMissingError);
    expect((e as EditorMissingError).detail.name).toBe('Cursor');
    expect((e as EditorMissingError).others).toEqual(['vscode', 'zed']);
  });

  it('ターミナルの中のエディタは、実行中のセッションならシェルタブで、ほかは外部ターミナルで起こす', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-edterm-'));
    try {
      const r = record();
      const tabs: { sessionId: string; argv: string[] }[] = [];
      const openShellTab = (o: { sessionId: string; argv: string[]; title: string }) => { if (o.sessionId !== 's1') return false; tabs.push({ sessionId: o.sessionId, argv: o.argv }); return true; };
      const api = createExternalApi({ home, settings: base({ id: 'custom', fileCmd: 'nvim +{line} {path}', terminal: 'shell' }), exec: r.exec, platform: 'darwin', host: mac, openShellTab });
      await api.openEditor({ target: '/w/a.ts', line: 9, sessionId: 's1' });
      expect(tabs).toEqual([{ sessionId: 's1', argv: ['/usr/local/bin/nvim', '+9', '/w/a.ts'] }]);
      expect(r.calls).toEqual([]);
      // 実行中の run が無いセッションと、セッションの外（プロジェクト）は外部ターミナルで開く。
      await api.openEditor({ target: '/w/a.ts', line: 9, sessionId: 's2' });
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]!.cmd).toBe('open');
      const cmdFile = r.calls[0]!.args.at(-1)!;
      expect(fs.readFileSync(cmdFile, 'utf8')).toContain("'/usr/local/bin/nvim' '+9' '/w/a.ts'");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('テストは見本のファイルを書き、3 行目を開く', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-edtest-'));
    try {
      const r = record();
      const api = createExternalApi({ home, settings: base({}), exec: r.exec, platform: 'darwin', host: mac });
      const res = await api.testEditor();
      const file = path.join(home, 'hangar-editor-test.md');
      expect(res).toEqual({ ok: true, via: 'cli', file, message: null });
      expect(fs.readFileSync(file, 'utf8').split('\n').length).toBeGreaterThanOrEqual(3);
      expect(r.calls).toEqual([{ cmd: '/usr/local/bin/code', args: ['-g', `${file}:3`] }]);
      const bad = createExternalApi({ home, settings: base({ id: 'cursor' }), exec: r.exec, platform: 'darwin', host: mac });
      expect(await bad.testEditor()).toEqual({ ok: false, via: null, file, message: 'Cursor が見つかりません', missing: true });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('見つけたエディタの一覧と、選んでいるエディタの状態を返す', async () => {
    const api = createExternalApi({ home: '/nope', settings: base({ id: 'zed' }), exec: record().exec, platform: 'darwin', host: mac, version: async () => null });
    const d = await api.editors();
    expect(d.candidates.map((c) => [c.id, c.state])).toEqual([['vscode', 'found'], ['cursor', 'none'], ['windsurf', 'none'], ['zed', 'found'], ['idea', 'none'], ['webstorm', 'none']]);
    expect(d.current).toEqual({ id: 'zed', state: 'found', path: '/usr/local/bin/zed' });
    const custom = createExternalApi({ home: '/nope', settings: base({ id: 'custom', fileCmd: 'subl {path}' }), exec: record().exec, platform: 'darwin', host: mac, version: async () => null });
    expect((await custom.editors()).current).toEqual({ id: 'custom', state: 'none', path: 'subl' });
  });
});
