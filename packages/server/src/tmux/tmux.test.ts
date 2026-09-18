import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TMUX, testSocketName, waitFor } from '../../test/tmux.ts';
import { Tmux } from './tmux.ts';

const tmux = TMUX ? new Tmux({ tmuxPath: TMUX, socketName: testSocketName() }) : null;
afterAll(() => tmux?.killServer());

describe('Tmux.args', () => {
  it('ソケット名を先頭に付ける', () => {
    expect(new Tmux({ tmuxPath: '/x/tmux', socketName: 's' }).args('ls')).toEqual(['-L', 's', 'ls']);
    expect(new Tmux({ tmuxPath: '/x/tmux' }).args('ls')).toEqual(['ls']);
    expect(new Tmux({ tmuxPath: '/x/tmux', socketName: 's' }).attachArgs('n')).toEqual(['-L', 's', 'attach', '-t', 'n']);
  });
});

describe.skipIf(!TMUX)('Tmux（実物）', () => {
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

  it('存在しない cwd では tmux を呼ばずに投げる', () => {
    expect(() => tmux!.newSession({ name: 'hangar-test-e', cwd: '/nonexistent/dir', command: ['sh'] })).toThrow(/cwd not found/);
    expect(tmux!.hasSession('hangar-test-e')).toBe(false);
  });
});
