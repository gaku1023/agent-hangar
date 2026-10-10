import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmuxPaneOps } from './pane.ts';
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
