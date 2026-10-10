import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shellHookLine, shellScriptPath } from './shellHook.ts';
import { bundledHangarIn, createShellWrap } from './shellWrap.ts';

describe('包みの本体と、この PC の状態', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  const wrap = (o: { host?: string; tmuxPath?: string | null; subcommands?: readonly string[]; zshrc?: string; platform?: NodeJS.Platform } = {}) => {
    let tmuxPath = o.tmuxPath === undefined ? '/opt/tmux' : o.tmuxPath;
    let subcommands = o.subcommands ?? ['agents'];
    const w = createShellWrap({
      home, host: o.host ?? '127.0.0.1', port: 4321,
      tmuxPath: () => tmuxPath, subcommands: () => subcommands,
      bundledHangar: null, zshrc: () => o.zshrc ?? path.join(home, '.zshrc'),
      errorLog: () => {},
      // 包みは macOS の zsh のものなので、試験は動いている OS によらず macOS として走らせる。
      platform: o.platform ?? 'darwin',
    });
    return { w, setTmux: (p: string | null) => { tmuxPath = p; }, setSubcommands: (l: readonly string[]) => { subcommands = l; } };
  };
  const script = () => fs.readFileSync(shellScriptPath(home), 'utf8');

  it('本体には、実際に待ち受けているポートと tmux のパスとサブコマンドを埋め込む', () => {
    const { w } = wrap({ subcommands: ['agents', 'newcmd'] });
    w.write();
    const text = script();
    expect(text).toContain('http://127.0.0.1:4321');
    expect(text).toContain('/opt/tmux');
    expect(text).toContain('    agents|newcmd) command claude');
  });

  it('どこからでも受ける待ち受け（0.0.0.0、::）でも、本体が叩く先は手元にする', () => {
    for (const host of ['0.0.0.0', '::']) {
      wrap({ host }).w.write();
      expect(script()).toContain('http://127.0.0.1:4321');
    }
  });

  it('書き直すたびに、そのときの tmux のパスとサブコマンドを読む', () => {
    const t = wrap();
    t.w.write();
    t.setTmux('/usr/local/bin/tmux');
    t.setSubcommands(['other']);
    t.w.write();
    const text = script();
    expect(text).toContain('/usr/local/bin/tmux');
    expect(text).toContain('    other) command claude');
  });

  it('本体を書けなくても投げない', () => {
    // 置き場が普通のファイルの下を指している。
    fs.writeFileSync(path.join(home, 'shell'), 'x');
    expect(() => wrap().w.write()).not.toThrow();
  });

  it('この PC の状態は、~/.zshrc に 1 行があるかと、tmux を実行できるかで決まる', () => {
    const zshrc = path.join(home, '.zshrc');
    const tmux = path.join(home, 'tmux');
    fs.writeFileSync(tmux, '#!/bin/sh\n', { mode: 0o755 });
    const t = wrap({ tmuxPath: tmux, zshrc });
    expect(t.w.hook()).toMatchObject({ state: 'off', zshrc, line: shellHookLine(home) });
    expect(t.w.hook().command).toBe(t.w.installCommand());
    fs.writeFileSync(zshrc, `${shellHookLine(home)}\n`);
    expect(t.w.hook().state).toBe('on');
    // tmux が無ければ、1 行があっても包めない。
    t.setTmux(null);
    expect(t.w.hook().state).toBe('unsupported');
  });

  it('Windows では本体を置かず、この OS では使えないと返す', () => {
    const zshrc = path.join(home, '.zshrc');
    const exe = path.join(home, 'psmux.exe');
    fs.writeFileSync(exe, '', { mode: 0o755 });
    const t = wrap({ tmuxPath: exe, zshrc, platform: 'win32' });
    t.w.write();
    expect(fs.existsSync(shellScriptPath(home))).toBe(false);
    expect(t.w.hook()).toMatchObject({ state: 'unsupported', osSupported: false });
  });

  it('macOS では、この OS で使えると返す', () => {
    expect(wrap().w.hook().osSupported).toBe(true);
  });

  it('同梱の hangar は、サーバの入口の隣の bin/hangar にあるときだけ見つかる', () => {
    expect(bundledHangarIn(home)).toBeNull();
    fs.mkdirSync(path.join(home, 'bin'));
    fs.writeFileSync(path.join(home, 'bin', 'hangar'), '');
    expect(bundledHangarIn(home)).toBe(path.join(home, 'bin', 'hangar'));
  });

  it('Windows では、同梱の hangar は bin\\hangar.cmd である', () => {
    expect(bundledHangarIn(home, 'win32')).toBeNull();
    fs.mkdirSync(path.join(home, 'bin'));
    fs.writeFileSync(path.join(home, 'bin', 'hangar'), '');
    expect(bundledHangarIn(home, 'win32')).toBeNull();
    fs.writeFileSync(path.join(home, 'bin', 'hangar.cmd'), '');
    expect(bundledHangarIn(home, 'win32')).toBe(path.join(home, 'bin', 'hangar.cmd'));
    // macOS の束には hangar.cmd は無く、bin/hangar を見る。
    expect(bundledHangarIn(home, 'darwin')).toBe(path.join(home, 'bin', 'hangar'));
  });
});
