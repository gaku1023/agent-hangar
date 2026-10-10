import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { paneOpsFor, psmuxPaneOps, tmuxPaneOps } from './pane.ts';
import { Tmux } from './tmux.ts';

let cwd: string;
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-pane-')); });
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

/** 呼ばれた引数を記録する偽の tmux。本物は起こさない。 */
function recording(reply: (args: string[]) => { status: number; stdout?: string; stderr?: string } = () => ({ status: 0 })) {
  const calls: string[][] = [];
  const tmux = new Tmux({ tmuxPath: 'tmux', platform: 'linux', exec: (_file, args) => { calls.push(args); const r = reply(args); return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; } });
  return { panes: tmuxPaneOps(tmux), calls };
}

describe('tmuxPaneOps（tmux 不要）', () => {
  it('open は切り離したセッションを作り、状態の行を消す', () => {
    const { panes, calls } = recording();
    panes.open({ name: 'hangar-a', cwd, command: ['sh', '-l'], env: { K: 'v' } });
    expect(calls[0]).toEqual(['new-session', '-d', '-s', 'hangar-a', '-c', cwd, '-x', '120', '-y', '40', '-e', 'K=v', '--', 'sh', '-l']);
    expect(calls[1]).toEqual(['set-option', '-t', '=hangar-a:', 'status', 'off']);
    expect(calls).toHaveLength(2);
  });

  it('open は作れなかったら投げ、状態の行には触らない', () => {
    const { panes, calls } = recording(() => ({ status: 1, stderr: 'duplicate session: hangar-a\n' }));
    expect(() => panes.open({ name: 'hangar-a', cwd, command: ['sh'] })).toThrow('duplicate session');
    expect(calls).toHaveLength(1);
  });

  it('close と capture は名前の完全一致で当てる', () => {
    const { panes, calls } = recording(() => ({ status: 0, stdout: 'a\r\nb\n' }));
    panes.close('hangar-a');
    expect(panes.capture('hangar-a')).toBe('a\nb\n');
    expect(calls).toEqual([['kill-session', '-t', '=hangar-a'], ['capture-pane', '-p', '-t', '=hangar-a:']]);
  });

  it('list は名前の一覧を返し、観測できなかったときは null を返す', () => {
    expect(recording(() => ({ status: 0, stdout: 'hangar-a\nhangar-a-t1\n' })).panes.list()).toEqual(['hangar-a', 'hangar-a-t1']);
    expect(recording(() => ({ status: 1, stderr: 'no server running on /x\n' })).panes.list()).toEqual([]);
    expect(recording(() => ({ status: 1, stderr: 'lost server\n' })).panes.list()).toBeNull();
  });

  it('sendText は文字として送り、sendKey はキーの名前で送る', () => {
    const { panes, calls } = recording();
    panes.sendText('hangar-a', '{');
    panes.sendKey('hangar-a', 'ctrl+o');
    expect(calls).toEqual([['send-keys', '-t', '=hangar-a:', '-l', '{'], ['send-keys', '-t', '=hangar-a:', 'C-o']]);
  });

  it('prepareForOutsideTerminals は、サーバが動いていなければ何も入れない', () => {
    const { panes, calls } = recording(() => ({ status: 1, stderr: 'no server running\n' }));
    panes.prepareForOutsideTerminals();
    expect(calls).toEqual([['show-options', '-s', '-v', 'copy-command']]);
  });
});

/** 呼ばれた引数を記録する偽の psmux。Windows のつもりで組む。 */
function recordingPsmux(reply: (args: string[]) => { status: number; stdout?: string; stderr?: string } = () => ({ status: 0 })) {
  const calls: string[][] = [];
  const tmux = new Tmux({ tmuxPath: 'psmux.exe', socketName: 'ns', platform: 'win32', exec: (_file, args) => { calls.push(args); const r = reply(args); return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; } });
  return { panes: psmuxPaneOps(tmux), calls };
}

describe('psmuxPaneOps（psmux 不要）', () => {
  it('open は名前空間付きで切り離したセッションを作り、状態の行を消す', () => {
    const { panes, calls } = recordingPsmux();
    panes.open({ name: 'hangar-a', cwd, command: ['node.exe', 'wrap.js'], env: { HANGAR_NOTE: '日本語の値' } });
    expect(calls[0]).toEqual(['-L', 'ns', 'new-session', '-d', '-s', 'hangar-a', '-c', cwd, '-x', '120', '-y', '40', '-e', 'HANGAR_NOTE=日本語の値', '--', 'node.exe', 'wrap.js']);
    expect(calls[1]).toEqual(['-L', 'ns', 'set-option', '-t', '=hangar-a:', 'status', 'off']);
    expect(calls).toHaveLength(2);
  });

  it('close は名指しで止め、サーバごとは落とさない', () => {
    const { panes, calls } = recordingPsmux();
    panes.close('hangar-a');
    expect(calls).toEqual([['-L', 'ns', 'kill-session', '-t', '=hangar-a']]);
    expect(calls.flat()).not.toContain('kill-server');
  });

  it('prepareForOutsideTerminals は psmux を一切呼ばない（macOS の端末向けの調整は要らない）', () => {
    // サーバが動いていて、どの設定も欠けている状態でも、何も入れない。
    const { panes, calls } = recordingPsmux(() => ({ status: 0, stdout: 'off\n' }));
    panes.prepareForOutsideTerminals();
    expect(calls).toEqual([]);
  });

  it('list と capture と sendText と sendKey は tmux と同じ口で当てる', () => {
    const { panes, calls } = recordingPsmux(() => ({ status: 0, stdout: 'hangar-a\r\nhangar-a-t1\r\n' }));
    expect(panes.list()).toEqual(['hangar-a', 'hangar-a-t1']);
    expect(panes.capture('hangar-a')).toBe('hangar-a\nhangar-a-t1\n');
    panes.sendText('hangar-a', '{q} 日本語');
    panes.sendKey('hangar-a', 'ctrl+o');
    expect(calls.slice(2)).toEqual([
      ['-L', 'ns', 'send-keys', '-t', '=hangar-a:', '-l', '{q} 日本語'],
      ['-L', 'ns', 'send-keys', '-t', '=hangar-a:', 'C-o'],
    ]);
  });

  it('list は観測できなかったとき null を返す（空の一覧とは別）', () => {
    expect(recordingPsmux(() => ({ status: 1, stderr: 'connection refused\n' })).panes.list()).toBeNull();
  });
});

describe('paneOpsFor', () => {
  it('Windows では psmux 用、それ以外では tmux 用の口を選ぶ', () => {
    const exec = () => ({ status: 0, stdout: 'off\n', stderr: '' });
    for (const [platform, outside] of [['win32', false], ['darwin', true], ['linux', true]] as const) {
      const calls: string[][] = [];
      const tmux = new Tmux({ tmuxPath: 'mux', platform, exec: (f, a) => { calls.push(a); return exec(); } });
      paneOpsFor(tmux, platform).prepareForOutsideTerminals();
      // tmux 用の口は、外の端末の設定を確かめに行く。psmux 用は行かない。
      expect(calls.length > 0, platform).toBe(outside);
    }
  });
});
