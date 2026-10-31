import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PSMUX, psmuxNamespace, psmuxTestEnv } from '../../test/psmux.ts';
import { waitFor } from '../../test/tmux.ts';
import { controlSpawn } from './control.ts';
import { Tmux } from './tmux.ts';

// Windows の psmux がコントロールモード（tmux/control.ts）に応えるかの確かめ。issue #534。
// hangar は Windows ではまだ -C を使わない（Tmux.supportsControl）。psmux の癖を見張るために置く。
// psmux 3.4.0 は attach そのものの答えを返さず、send-keys には打鍵を届けたうえで毎回 %error を返す。
describe.skipIf(!PSMUX)('controlSpawn（実物の psmux）', () => {
  const env = PSMUX ? psmuxTestEnv() : {};
  const tmux = new Tmux({ tmuxPath: PSMUX ?? 'psmux', socketName: psmuxNamespace(), env });
  const made: string[] = [];
  const cwd = PSMUX ? fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-psmux-ctl-')) : os.tmpdir();
  // 止めるのは自分が作ったセッションだけ。kill-server は呼ばない。
  afterEach(() => { while (made.length) tmux.killSession(made.pop()!); });

  it('つないだ時点の履歴を描き、その後の出力と打鍵を通す', async () => {
    const name = 'hangar-ctl-w1';
    made.push(name);
    tmux.newSession({ name, cwd, command: ['powershell.exe', '-NoProfile', '-NoLogo'] });
    await waitFor(() => tmux.capturePane(name).includes('PS '), 20000);
    tmux.run('send-keys', '-t', `=${name}:`, '1..40 | % { "row$_" }', 'Enter');
    await waitFor(() => tmux.capturePane(name).includes('row40'), 20000);

    const p = controlSpawn(tmux, name);
    let got = '';
    let exited = false;
    p.onData((d) => { got += d; });
    p.onExit(() => { exited = true; });
    p.resize(100, 30);
    // 画面の外へ流れた行も、履歴として届く
    await waitFor(() => got.includes('row40'), 20000);
    expect(got.startsWith('\x1b[H\x1b[2J\x1b[3J')).toBe(true);
    expect(got).toContain('row1\r\n');

    p.write('echo "日本語-$(40+2)"\r');
    await waitFor(() => got.includes('日本語-42'), 20000);

    p.kill();
    await waitFor(() => exited, 10000);
    // 切ったのは attach だけで、シェルは残る
    expect(tmux.run('has-session', '-t', `=${name}`).code).toBe(0);
  }, 60000);
});
