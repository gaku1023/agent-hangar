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

  it('存在しない cwd では tmux を呼ばずに投げる', () => {
    expect(() => tmux!.newSession({ name: 'hangar-test-e', cwd: '/nonexistent/dir', command: ['sh'] })).toThrow(/cwd not found/);
    expect(tmux!.hasSession('hangar-test-e')).toBe(false);
  });
});
