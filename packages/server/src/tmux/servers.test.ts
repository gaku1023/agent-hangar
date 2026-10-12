import { afterAll, afterEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { TMUX, removeTestSocket, testSocketPath, waitFor } from '../../test/tmux.ts';
import { HANGAR_SOCKET, hangarMux, MuxServers } from './servers.ts';
import { paneOpsFor } from './pane.ts';
import { Tmux, type TmuxExec } from './tmux.ts';

/**
 * 偽の tmux。サーバ（-L の名前、無ければ default）ごとにセッション名の一覧を持ち、呼ばれた引数を残す。
 * list-sessions と has-session と kill-session だけを真似る。
 */
function fakeServers(sessions: Record<string, string[] | 'fail'>): { exec: TmuxExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: TmuxExec = (_file, args) => {
    calls.push(args);
    const server = args[0] === '-L' ? args[1]! : 'default';
    const rest = args[0] === '-L' ? args.slice(2) : args;
    const list = sessions[server] ?? [];
    if (list === 'fail') return { status: 1, stdout: '', stderr: 'permission denied' };
    if (rest[0] === 'list-sessions') return list.length ? { status: 0, stdout: list.join('\n') + '\n', stderr: '' } : { status: 1, stdout: '', stderr: 'no server running on /tmp/tmux-501/x' };
    if (rest[0] === 'kill-session') { sessions[server] = list.filter((n) => `=${n}` !== rest[2]); return { status: 0, stdout: '', stderr: '' }; }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}
const serverOf = (args: string[]) => (args[0] === '-L' ? args[1] : 'default');

describe('hangar の専用の tmux サーバ', () => {
  it('名前は hangar で、新しい画面は -L hangar のサーバに作る。古い run を探すのは既定のサーバ', () => {
    expect(HANGAR_SOCKET).toBe('hangar');
    const m = hangarMux('/x/tmux');
    expect(m.own.args('ls')).toEqual(['-L', 'hangar', 'ls']);
    expect(m.legacy?.args('ls')).toEqual(['ls']);
    expect(m.own.tmuxPath).toBe('/x/tmux');
  });

  it('一覧は専用のサーバと、既定のサーバに残った hangar の画面を合わせる。利用者自身のセッションは入れない', () => {
    const f = fakeServers({ hangar: ['hangar-0000aaaa0000aaaa'], default: ['work', 'hangar-1111bbbb1111bbbb', 'hangar-1111bbbb1111bbbb-t1', 'hangar-notes'] });
    const m = hangarMux('/x/tmux', { exec: f.exec, platform: 'darwin' });
    expect(m.list()).toEqual(['hangar-0000aaaa0000aaaa', 'hangar-1111bbbb1111bbbb', 'hangar-1111bbbb1111bbbb-t1']);
  });

  it('古いサーバに居る画面はそちらで扱い、ほかは専用のサーバで扱う', () => {
    const f = fakeServers({ hangar: ['hangar-0000aaaa0000aaaa'], default: ['hangar-1111bbbb1111bbbb'] });
    const m = hangarMux('/x/tmux', { exec: f.exec, platform: 'darwin' });
    // まだ一覧を読んでいなくても、最初に問われたときに既定のサーバを見る。
    expect(m.serverOf('hangar-1111bbbb1111bbbb')).toBe(m.legacy);
    expect(m.serverOf('hangar-0000aaaa0000aaaa')).toBe(m.own);
    expect(m.serverOf('hangar-2222cccc2222cccc')).toBe(m.own);
  });

  it('既定のサーバに hangar の画面が残っていなければ、それからは既定のサーバを見ない', () => {
    const f = fakeServers({ hangar: ['hangar-0000aaaa0000aaaa'], default: ['hangar-1111bbbb1111bbbb', 'work'] });
    const m = hangarMux('/x/tmux', { exec: f.exec, platform: 'darwin' });
    m.list();
    const ops = paneOpsFor(m, 'darwin');
    ops.close('hangar-1111bbbb1111bbbb');
    expect(f.calls.at(-1)).toEqual(['kill-session', '-t', '=hangar-1111bbbb1111bbbb']);
    expect(m.list()).toEqual(['hangar-0000aaaa0000aaaa']);
    const before = f.calls.length;
    expect(m.list()).toEqual(['hangar-0000aaaa0000aaaa']);
    // 2 回目は専用のサーバだけを読む。
    expect(f.calls.slice(before).map(serverOf)).toEqual(['hangar']);
  });

  it('既定のサーバを読めなければ、古い run の生死が分からないので一覧は null（観測できない）', () => {
    const f = fakeServers({ hangar: ['hangar-0000aaaa0000aaaa'], default: 'fail' });
    expect(hangarMux('/x/tmux', { exec: f.exec, platform: 'darwin' }).list()).toBeNull();
    const g = fakeServers({ hangar: 'fail', default: [] });
    expect(hangarMux('/x/tmux', { exec: g.exec, platform: 'darwin' }).list()).toBeNull();
  });

  it('移行の相手が無い組（試験や、古いサーバを持たない口）は専用のサーバだけを読む', () => {
    const f = fakeServers({ hangar: ['hangar-0000aaaa0000aaaa'], default: ['hangar-1111bbbb1111bbbb'] });
    const m = new MuxServers(new Tmux({ tmuxPath: '/x/tmux', socketName: 'hangar', exec: f.exec, platform: 'darwin' }), null);
    expect(m.list()).toEqual(['hangar-0000aaaa0000aaaa']);
    expect(m.serverOf('hangar-1111bbbb1111bbbb')).toBe(m.own);
    expect(f.calls.map(serverOf)).toEqual(['hangar']);
  });

  it('画面の口：作るのは専用のサーバ、閉じる、読む、送るは居るサーバ、外の端末の設定は専用のサーバだけ', () => {
    const f = fakeServers({ hangar: [], default: ['hangar-1111bbbb1111bbbb'] });
    const m = hangarMux('/x/tmux', { exec: f.exec, platform: 'darwin' });
    const ops = paneOpsFor(m, 'darwin');
    expect(ops.list()).toEqual(['hangar-1111bbbb1111bbbb']);
    f.calls.length = 0;
    ops.open({ name: 'hangar-2222cccc2222cccc', cwd: os.tmpdir(), command: ['sh'] });
    ops.capture('hangar-1111bbbb1111bbbb');
    ops.sendText('hangar-1111bbbb1111bbbb', 'q');
    ops.sendKey('hangar-1111bbbb1111bbbb', 'ctrl+o');
    ops.capture('hangar-2222cccc2222cccc');
    ops.prepareForOutsideTerminals();
    const byCommand = f.calls.map((a) => `${serverOf(a)} ${(a[0] === '-L' ? a.slice(2) : a).slice(0, 1).join('')}`);
    expect(byCommand.slice(0, 6)).toEqual(['hangar new-session', 'hangar set-option', 'default capture-pane', 'default send-keys', 'default send-keys', 'hangar capture-pane']);
    // 外の端末のための設定（サーバ全体のオプション）は、既定のサーバへは 1 つも入れない。
    expect(f.calls.slice(6).every((a) => serverOf(a) === 'hangar')).toBe(true);
    expect(f.calls.length).toBeGreaterThan(6);
  });
});

/**
 * 実物の tmux で、更新の前に既定のサーバで動き出した run を、専用のサーバへ移った後も扱えることを確かめる。
 * どちらのサーバも試験用のソケット（-S の一時パス）で模す。利用者の tmux には触れない。
 * 後始末は kill-session で名指しして止め、最後のセッションが消えればサーバも降りる。
 */
describe.skipIf(!TMUX)('専用のサーバへの移行（実物の tmux）', () => {
  const ownSock = testSocketPath();
  const oldSock = testSocketPath();
  const own = new Tmux({ tmuxPath: TMUX ?? 'tmux', socketPath: ownSock });
  const old = new Tmux({ tmuxPath: TMUX ?? 'tmux', socketPath: oldSock });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mux-'));
  afterEach(() => {
    for (const t of [own, old]) for (const n of t.listSessions() ?? []) t.killSession(n);
  });
  afterAll(() => {
    removeTestSocket(ownSock);
    removeTestSocket(oldSock);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('古いサーバの run は終わるまでそこで扱い、新しい画面は専用のサーバに作る', async () => {
    old.newSession({ name: 'hangar-1111bbbb1111bbbb', cwd, command: ['sh', '-c', 'echo legacy-here; sleep 30'] });
    old.newSession({ name: 'mine', cwd, command: ['sh', '-c', 'sleep 30'] });
    const m = new MuxServers(own, old);
    const ops = paneOpsFor(m, 'darwin');
    expect(ops.list()).toEqual(['hangar-1111bbbb1111bbbb']);
    await waitFor(() => ops.capture('hangar-1111bbbb1111bbbb').includes('legacy-here'));
    ops.open({ name: 'hangar-2222cccc2222cccc', cwd, command: ['sh', '-c', 'sleep 30'] });
    expect(own.hasSession('hangar-2222cccc2222cccc')).toBe(true);
    expect(old.hasSession('hangar-2222cccc2222cccc')).toBe(false);
    expect(new Set(ops.list())).toEqual(new Set(['hangar-1111bbbb1111bbbb', 'hangar-2222cccc2222cccc']));
    // attach も居るサーバへつなぐ。
    expect(m.serverOf('hangar-1111bbbb1111bbbb').attachArgs('hangar-1111bbbb1111bbbb')).toEqual(['-S', oldSock, 'attach', '-t', '=hangar-1111bbbb1111bbbb']);
    ops.close('hangar-1111bbbb1111bbbb');
    expect(old.hasSession('hangar-1111bbbb1111bbbb')).toBe(false);
    // 利用者自身のセッションには触れない。
    expect(old.hasSession('mine')).toBe(true);
    expect(ops.list()).toEqual(['hangar-2222cccc2222cccc']);
  });
});
