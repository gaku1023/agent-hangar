import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TMUX, removeTestSocket, testSocketPath, waitFor } from '../../test/tmux.ts';
import { psmuxPaneOps, tmuxPaneOps } from './pane.ts';
import { Tmux } from './tmux.ts';

const fake = (platform: NodeJS.Platform = 'linux', reply: (args: string[]) => { status: number; stderr?: string } = () => ({ status: 0 })) => {
  const calls: string[][] = [];
  const t = new Tmux({ tmuxPath: 'tmux', platform, exec: (_f, args) => { calls.push(args); const r = reply(args); return { status: r.status, stdout: '', stderr: r.stderr ?? '' }; } });
  return { t, calls };
};

describe('Tmux.pasteText（偽の実行）', () => {
  it('名前付きのバッファに入れて bracketed paste（-p）で貼り、バッファは貼った後に消す（-d）', () => {
    const { t, calls } = fake();
    t.pasteText('hangar-a', 'one\ntwo');
    expect(calls).toHaveLength(2);
    const buf = calls[0]![2]!;
    expect(calls[0]).toEqual(['set-buffer', '-b', buf, '--', 'one\ntwo']);
    expect(buf).toMatch(/^hangar-paste-/);
    expect(calls[1]).toEqual(['paste-buffer', '-p', '-d', '-b', buf, '-t', '=hangar-a:']);
  });
  it('貼れなかったら投げ、残ったバッファを消す', () => {
    const { t, calls } = fake('linux', (a) => (a[0] === 'paste-buffer' ? { status: 1, stderr: "can't find pane: hangar-a\n" } : { status: 0 }));
    expect(() => t.pasteText('hangar-a', 'x')).toThrow("can't find pane");
    expect(calls.at(-1)![0]).toBe('delete-buffer');
  });
  it('バッファに入れられなかったら投げる', () => {
    const { t } = fake('linux', (a) => (a[0] === 'set-buffer' ? { status: 1, stderr: 'unknown command: set-buffer\n' } : { status: 0 }));
    expect(() => t.pasteText('hangar-a', 'x')).toThrow('unknown command');
  });
});

describe('PaneOps の貼り付けと Enter（偽の実行）', () => {
  it('pasteText は貼り付けで送り、sendKey の enter は Enter キーで送る', () => {
    const { t, calls } = fake();
    const panes = tmuxPaneOps(t);
    panes.pasteText!('hangar-a', 'a\nb');
    panes.sendKey('hangar-a', 'enter');
    expect(calls.map((c) => c[0])).toEqual(['set-buffer', 'paste-buffer', 'send-keys']);
    expect(calls[2]).toEqual(['send-keys', '-t', '=hangar-a:', 'Enter']);
  });
  it('psmux でも同じ口で貼る', () => {
    const { t, calls } = fake('win32');
    psmuxPaneOps(t).pasteText!('hangar-a', 'x');
    expect(calls.map((c) => c[0])).toEqual(['set-buffer', 'paste-buffer']);
  });
});

const socketPath = testSocketPath();
const tmux = TMUX ? new Tmux({ tmuxPath: TMUX, socketPath }) : null;
afterAll(() => {
  tmux?.killServer();
  removeTestSocket(socketPath);
});

describe.skipIf(!TMUX)('Tmux.pasteText（実物）', () => {
  it('複数行を 1 回の貼り付けとして届ける', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-tmux-'));
    const name = 'hangar-test-paste';
    // 貼り付けのモード（2004）を有効にして、届いたバイトを見えるように写す。
    tmux!.newSession({ name, cwd, command: ['sh', '-c', `printf '\\033[?2004h'; cat -v`] });
    await new Promise((r) => setTimeout(r, 400));
    tmux!.pasteText(name, 'one\ntwo\n\nfour');
    await waitFor(() => tmux!.capturePane(name).includes('four'));
    const screen = tmux!.capturePane(name);
    // 括弧（^[[200~ と ^[[201~）で囲まれて、1 回の貼り付けとして届く。
    expect(screen).toContain('^[[200~one');
    expect(screen).toContain('four^[[201~');
    tmux!.killSession(name);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
