import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TMUX, removeTestSocket, testSocketPath, waitFor } from '../../test/tmux.ts';
import { Tmux } from './tmux.ts';

const socketPath = testSocketPath();
const tmux = TMUX ? new Tmux({ tmuxPath: TMUX, socketPath }) : null;
afterAll(() => {
  tmux?.killServer();
  removeTestSocket(socketPath);
});

/** 決まった終了コードと出力を返す偽の tmux を書く。 */
function fakeTmux(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-faketmux-'));
  const bin = path.join(dir, 'tmux');
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

describe('Tmux.args', () => {
  it('ソケットの指定を先頭に付ける', () => {
    expect(new Tmux({ tmuxPath: '/x/tmux', socketName: 's' }).args('ls')).toEqual(['-L', 's', 'ls']);
    expect(new Tmux({ tmuxPath: '/x/tmux', socketPath: '/tmp/d/tmux.sock' }).args('ls')).toEqual(['-S', '/tmp/d/tmux.sock', 'ls']);
    expect(new Tmux({ tmuxPath: '/x/tmux' }).args('ls')).toEqual(['ls']);
  });
  it('attach の target も完全一致にする', () => {
    // 素の名前だと tmux が前方一致に落ちて、終了した run の Claude タブがシェルタブに繋がる。
    expect(new Tmux({ tmuxPath: '/x/tmux', socketName: 's' }).attachArgs('n')).toEqual(['-L', 's', 'attach', '-t', '=n']);
  });
});

describe('Tmux.enableClipboard（偽の tmux）', () => {
  it('tmux を呼べなくても投げない', () => {
    expect(() => new Tmux({ tmuxPath: '/nonexistent/tmux' }).enableClipboard()).not.toThrow();
  });
});

describe('Tmux.listSessions（偽の tmux）', () => {
  it('tmux を呼べなければ null を返す', () => {
    expect(new Tmux({ tmuxPath: '/nonexistent/tmux' }).listSessions()).toBeNull();
  });
  it('サーバが動いていないだけなら空配列を返す', () => {
    const bin = fakeTmux('echo "no server running on /tmp/tmux-501/default" >&2\nexit 1');
    expect(new Tmux({ tmuxPath: bin }).listSessions()).toEqual([]);
  });
  it('それ以外の失敗は null を返す。観測できないことと動いていないことは違う', () => {
    const bin = fakeTmux('echo "lost server" >&2\nexit 1');
    expect(new Tmux({ tmuxPath: bin }).listSessions()).toBeNull();
  });
  it('成功したらセッション名を返す', () => {
    const bin = fakeTmux('echo "hangar-a"\necho "hangar-b"\nexit 0');
    expect(new Tmux({ tmuxPath: bin }).listSessions()).toEqual(['hangar-a', 'hangar-b']);
  });
});

describe.skipIf(!TMUX)('Tmux（実物）', () => {
  it('ソケットは一時ディレクトリの中に置き、消せる', () => {
    const p = testSocketPath();
    const t = new Tmux({ tmuxPath: TMUX!, socketPath: p });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-tmux-'));
    t.newSession({ name: 'hangar-test-sock', cwd, command: ['sh', '-c', 'sleep 30'] });
    expect(fs.existsSync(p)).toBe(true);
    t.killServer();
    removeTestSocket(p);
    expect(fs.existsSync(p)).toBe(false);
    expect(fs.existsSync(path.dirname(p))).toBe(false);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('セッションを作り、見つけ、オプションを変え、消す', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-tmux-'));
    const name = 'hangar-test-a';
    tmux!.newSession({ name, cwd, command: ['sh', '-c', 'sleep 30'] });
    expect(tmux!.hasSession(name)).toBe(true);
    expect(tmux!.listSessions()).toContain(name);
    tmux!.setOption(name, 'status', 'off');
    expect(tmux!.run('show-options', '-t', name, 'status').stdout.trim()).toBe('status off');
    tmux!.killSession(name);
    await waitFor(() => !tmux!.hasSession(name));
    expect(tmux!.listSessions()).not.toContain(name);
    tmux!.killSession(name); // 無くても投げない
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('存在しない cwd では失敗を投げる', () => {
    expect(() => tmux!.newSession({ name: 'hangar-test-b', cwd: '/nonexistent/dir', command: ['sh'] })).toThrow();
  });

  it('send-keys で入力を送れる', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-tmux-'));
    const out = path.join(cwd, 'out.txt');
    tmux!.newSession({ name: 'hangar-test-c', cwd, command: ['sh', '-c', `read -r line; echo "$line" > ${out}`] });
    tmux!.sendKeys('hangar-test-c', 'hello', 'Enter');
    await waitFor(() => fs.existsSync(out));
    expect(fs.readFileSync(out, 'utf8').trim()).toBe('hello');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('前方一致の名前を取り違えない', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-tmux-'));
    const out = path.join(cwd, 'out.txt');
    const long = 'hangar-test-d-long';
    tmux!.newSession({ name: long, cwd, command: ['sh', '-c', `read -r line; echo "$line" > ${out}`] });

    // 短い名前では見つからず、オプションも入力も届かない。
    expect(tmux!.hasSession('hangar-test-d')).toBe(false);
    expect(tmux!.hasSession(long)).toBe(true);
    tmux!.setOption('hangar-test-d', 'status', 'off');
    tmux!.sendKeys('hangar-test-d', 'wrong', 'Enter');
    expect(tmux!.run('show-options', '-t', `${long}:`, 'status').stdout.trim()).toBe('');

    tmux!.killSession('hangar-test-d');
    expect(tmux!.hasSession(long)).toBe(true);

    // 完全一致の名前なら届く。
    tmux!.setOption(long, 'status', 'off');
    expect(tmux!.run('show-options', '-t', `${long}:`, 'status').stdout.trim()).toBe('status off');
    tmux!.sendKeys(long, 'ok', 'Enter');
    await waitFor(() => fs.existsSync(out));
    expect(fs.readFileSync(out, 'utf8').trim()).toBe('ok');

    tmux!.killSession(long);
    await waitFor(() => !tmux!.hasSession(long));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('attach の target はシェルタブに落ちない', async () => {
    // run が終わってシェルタブだけが残った状態。素の名前だと tmux が前方一致でこれに当てる。
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-tmux-'));
    const shellTab = 'hangar-test-f-t1';
    tmux!.newSession({ name: shellTab, cwd, command: ['sh', '-c', 'sleep 30'] });
    const target = tmux!.attachArgs('hangar-test-f').at(-1)!;
    expect(target).toBe('=hangar-test-f');
    // 素の名前は前方一致でシェルタブに当たる。attach は tty が無いところまで進む。
    expect(tmux!.run('has-session', '-t', 'hangar-test-f').code).toBe(0);
    expect(tmux!.run('attach', '-t', 'hangar-test-f').stderr).toContain('not a terminal');
    // 完全一致ならセッションそのものが見つからない。
    expect(tmux!.run('has-session', '-t', target).code).not.toBe(0);
    expect(tmux!.run('attach', '-t', target).stderr).toContain("can't find session");
    tmux!.killSession(shellTab);
    await waitFor(() => !tmux!.hasSession(shellTab));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('enableClipboard は set-clipboard を on にし、アプリの OSC 52 を外の端末へ通させる', () => {
    const p = testSocketPath();
    const t = new Tmux({ tmuxPath: TMUX!, socketPath: p });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-tmux-'));
    t.newSession({ name: 'hangar-test-clip', cwd, command: ['sh', '-c', 'sleep 30'] });
    // 既定の external では、tmux のコピーモードの写しだけが外へ出て、アプリの OSC 52 は捨てられる。
    // 利用者の ~/.tmux.conf に左右されないよう、既定の値に揃えてから試す。
    t.run('set-option', '-s', 'set-clipboard', 'external');
    t.enableClipboard();
    expect(t.run('show-options', '-s', '-v', 'set-clipboard').stdout.trim()).toBe('on');
    t.killServer();
    removeTestSocket(p);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('enableClipboard は利用者が off にしたものを覆さない', () => {
    const p = testSocketPath();
    const t = new Tmux({ tmuxPath: TMUX!, socketPath: p });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-tmux-'));
    t.newSession({ name: 'hangar-test-clip-off', cwd, command: ['sh', '-c', 'sleep 30'] });
    t.run('set-option', '-s', 'set-clipboard', 'off');
    t.enableClipboard();
    expect(t.run('show-options', '-s', '-v', 'set-clipboard').stdout.trim()).toBe('off');
    t.killServer();
    removeTestSocket(p);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('enableClipboard は tmux サーバが動いていなければ何もせず、起こしもしない', () => {
    const p = testSocketPath();
    const t = new Tmux({ tmuxPath: TMUX!, socketPath: p });
    expect(() => t.enableClipboard()).not.toThrow();
    // サーバが起きればソケットができる。
    expect(fs.existsSync(p)).toBe(false);
    removeTestSocket(p);
  });

  it('newSession の env は、もう動いているサーバでも新しいセッションに届く', async () => {
    // tmux の新しいセッションは、起こしたシェルではなくサーバの環境を継ぐ。-e で渡したものだけが届く。
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-tmux-'));
    const out = path.join(cwd, 'env.txt');
    tmux!.newSession({ name: 'hangar-test-env-first', cwd, command: ['sh', '-c', 'sleep 30'] });
    tmux!.newSession({ name: 'hangar-test-env', cwd, command: ['sh', '-c', `printf '%s|%s' "$HANGAR_TEST_A" "$HANGAR_TEST_B" > ${out}`], env: { HANGAR_TEST_A: 'a b', HANGAR_TEST_B: "c'd=e" } });
    await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8') !== '');
    expect(fs.readFileSync(out, 'utf8')).toBe("a b|c'd=e");
    tmux!.killSession('hangar-test-env-first');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  describe('ensureTerminalOptions', () => {
    /** 既定の値に揃えた専用のサーバを起こす。利用者の ~/.tmux.conf に左右されないようにする。 */
    function fresh(): { t: Tmux; cwd: string; done: () => void } {
      const p = testSocketPath();
      const t = new Tmux({ tmuxPath: TMUX!, socketPath: p });
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-tmux-'));
      t.newSession({ name: 'hangar-test-opt-keep', cwd, command: ['sh', '-c', 'sleep 30'] });
      t.run('set-option', '-s', 'copy-command', '');
      t.run('set-option', '-s', 'extended-keys', 'off');
      t.run('set-option', '-s', 'extended-keys-format', 'xterm');
      t.run('set-option', '-su', 'terminal-features');
      t.run('unbind-key', '-n', 'S-Enter');
      return { t, cwd, done: () => { t.killServer(); removeTestSocket(p); fs.rmSync(cwd, { recursive: true, force: true }); } };
    }
    const show = (t: Tmux, key: string) => t.run('show-options', '-s', '-v', key).stdout.trim();

    it('copy-command、extended-keys、extended-keys-format、terminal-features、S-Enter を入れる', () => {
      const { t, done } = fresh();
      t.ensureTerminalOptions();
      expect(show(t, 'copy-command')).toBe('pbcopy');
      expect(show(t, 'extended-keys')).toBe('on');
      expect(show(t, 'extended-keys-format')).toBe('csi-u');
      expect(show(t, 'terminal-features')).toContain('xterm*:extkeys');
      expect(t.run('list-keys', '-T', 'root', 'S-Enter').stdout).toContain('hangar-');
      done();
    });

    it('何度呼んでも terminal-features を重ねない', () => {
      const { t, done } = fresh();
      t.ensureTerminalOptions();
      t.ensureTerminalOptions();
      expect(show(t, 'terminal-features').split('\n').filter((l) => l.includes('xterm*:extkeys'))).toHaveLength(1);
      done();
    });

    it('利用者が決めた値は覆さない', () => {
      const { t, done } = fresh();
      t.run('set-option', '-s', 'copy-command', 'my-copy');
      t.run('set-option', '-s', 'extended-keys', 'always');
      t.run('set-option', '-s', 'extended-keys-format', 'xterm');
      t.run('bind-key', '-n', 'S-Enter', 'send-keys', 'X');
      t.ensureTerminalOptions();
      expect(show(t, 'copy-command')).toBe('my-copy');
      expect(show(t, 'extended-keys')).toBe('always');
      // extended-keys を利用者が既に入れているなら、その書式も利用者のものである。
      expect(show(t, 'extended-keys-format')).toBe('xterm');
      expect(t.run('list-keys', '-T', 'root', 'S-Enter').stdout).not.toContain('hangar-');
      done();
    });

    it('tmux サーバが動いていなければ何もせず、起こしもしない', () => {
      const p = testSocketPath();
      const t = new Tmux({ tmuxPath: TMUX!, socketPath: p });
      expect(() => t.ensureTerminalOptions()).not.toThrow();
      expect(fs.existsSync(p)).toBe(false);
      removeTestSocket(p);
    });

    it('外の端末の Shift+Enter は、run では ESC CR、シェルタブでは CR として中に届く', async () => {
      const { nodePtySpawn } = await import('../pty/nodePty.ts');
      const { t, cwd, done } = fresh();
      t.ensureTerminalOptions();
      // 中のプログラムは端末を生のまま読み、届いたバイトを 16 進で書き出す。
      const dump = (out: string) => ['sh', '-c', `stty raw -echo; dd bs=1 count=2 2>/dev/null | od -An -tx1 | tr -d ' \\n' > ${out}; sleep 5`];
      for (const [name, want] of [['hangar-abc12345', '1b0d'], ['hangar-abc12345-t1', '0d']] as const) {
        const out = path.join(cwd, `${name}.hex`);
        t.newSession({ name, cwd, command: dump(out) });
        const client = nodePtySpawn(TMUX!, t.attachArgs(name), { name: 'xterm-256color', cols: 80, rows: 24, cwd, env: { ...process.env, TERM: 'xterm-256color', TMUX: '' } });
        await new Promise((r) => setTimeout(r, 800));
        // iTerm2 などが送る CSI u の Shift+Enter。シェルタブでは 2 バイト目を待つので、続けて a を送る。
        client.write('\x1b[13;2u');
        if (want === '0d') client.write('a');
        await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8') !== '');
        expect(fs.readFileSync(out, 'utf8')).toBe(want === '0d' ? '0d61' : want);
        client.kill();
      }
      done();
    });
  });

  it('存在しない cwd では tmux を呼ばずに投げる', () => {
    expect(() => tmux!.newSession({ name: 'hangar-test-e', cwd: '/nonexistent/dir', command: ['sh'] })).toThrow(/cwd not found/);
    expect(tmux!.hasSession('hangar-test-e')).toBe(false);
  });
});
