import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PSMUX, psmuxNamespace } from '../../test/psmux.ts';
import { waitFor } from '../../test/tmux.ts';
import { nodePtySpawn } from '../pty/nodePty.ts';
import { Tmux } from './tmux.ts';

// Windows の psmux を相手にした確かめ。macOS と Linux、psmux の無い Windows では丸ごと飛ぶ。
describe.skipIf(!PSMUX)('Tmux（実物の psmux）', () => {
  const tmux = new Tmux({ tmuxPath: PSMUX!, socketName: psmuxNamespace() });
  const made: string[] = [];
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-psmux-'));
  const start = (name: string, command: string[], env?: Record<string, string>): void => {
    made.push(name);
    tmux.newSession({ name, cwd, command, env });
  };
  // 止めるのは自分が作ったセッションだけ。kill-server は呼ばない。
  afterEach(() => { while (made.length) tmux.killSession(made.pop()!); });

  it('サーバが無いうちは空の一覧を返す', () => {
    expect(new Tmux({ tmuxPath: PSMUX!, socketName: psmuxNamespace() }).listSessions()).toEqual([]);
  });

  it('切り離して作り、完全一致で見つけ、名指しで止める', async () => {
    start('hangar-a1', ['cmd.exe']);
    start('hangar-a1-t1', ['cmd.exe']);
    expect(tmux.hasSession('hangar-a1')).toBe(true);
    // 前方一致に落ちない。hangar-a は hangar-a1 に当たらない。
    expect(tmux.hasSession('hangar-a')).toBe(false);
    expect(tmux.listSessions()!.sort()).toEqual(['hangar-a1', 'hangar-a1-t1']);
    tmux.killSession('hangar-a1');
    await waitFor(() => !tmux.hasSession('hangar-a1'));
    expect(tmux.hasSession('hangar-a1-t1')).toBe(true);
  });

  it('作業フォルダと環境変数を渡す。日本語の値も壊さない', async () => {
    start('hangar-env', ['cmd.exe', '/k', 'echo [%HANGAR_NOTE%] & cd'], { HANGAR_NOTE: '日本語の値' });
    await waitFor(() => tmux.capturePane('hangar-env').includes('[日本語の値]'), 10_000);
    expect(tmux.capturePane('hangar-env').toLowerCase()).toContain(fs.realpathSync(cwd).toLowerCase());
  });

  it('文字をそのまま送り、画面から読む', async () => {
    start('hangar-keys', ['cmd.exe']);
    await waitFor(() => tmux.capturePane('hangar-keys').includes('>'), 10_000);
    tmux.sendKeys('hangar-keys', '-l', 'echo {q} 日本語');
    tmux.sendKeys('hangar-keys', 'Enter');
    await waitFor(() => tmux.capturePane('hangar-keys').split('\n').some((l) => l.trim() === '{q} 日本語'), 10_000);
  });

  it('無い作業フォルダは、作る前に断る', () => {
    expect(() => tmux.newSession({ name: 'hangar-nocwd', cwd: path.join(cwd, 'nope'), command: ['cmd.exe'] })).toThrow(/cwd not found/);
    expect(tmux.hasSession('hangar-nocwd')).toBe(false);
  });

  // hangar の画面の端末は、接続ごとに node-pty で attach を起こす。2 つのタブで同じセッションを開ける必要がある。
  it('node-pty 越しに 2 つの口からつなぎ、片方が抜けてもセッションは残る', async () => {
    start('hangar-att', ['cmd.exe']);
    const open = () => {
      let out = '';
      const p = nodePtySpawn(tmux.tmuxPath, tmux.attachArgs('hangar-att'), { name: 'xterm-256color', cols: 100, rows: 30, cwd: os.homedir(), env: process.env });
      p.onData((d) => { out += d; });
      return { p, text: () => out };
    };
    const a = open();
    const b = open();
    try {
      await waitFor(() => a.text().length > 0 && b.text().length > 0, 10_000);
      a.p.write('echo from-a\r');
      await waitFor(() => a.text().includes('from-a') && b.text().includes('from-a'), 10_000);
      a.p.kill();
      await new Promise((r) => setTimeout(r, 1000));
      expect(tmux.hasSession('hangar-att')).toBe(true);
      b.p.write('echo from-b\r');
      await waitFor(() => b.text().includes('from-b'), 10_000);
    } finally {
      try { a.p.kill(); } catch { /* 既に終わっている */ }
      try { b.p.kill(); } catch { /* 既に終わっている */ }
    }
  }, 40_000);
});
