import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PeerChatAsk } from '@agent-hangar/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { PSMUX, psmuxNamespace, psmuxTestEnv } from '../../../test/psmux.ts';
import { TMUX, removeTestSocket, testSocketPath, waitFor } from '../../../test/tmux.ts';
import { psmuxPaneOps, tmuxPaneOps, type PaneOps } from '../../tmux/pane.ts';
import { Tmux } from '../../tmux/tmux.ts';
import { answerPaneOf, createPeerAnswerer } from './answer.ts';

// 実物のペイン（Mac と Linux は tmux、Windows は psmux）に、answerAsk と interruptRun が打つキーが 1 回ずつ届くことの確かめ。
// ペインの中は、許可の札か走っているターンの画面を描き、受け取ったバイトを 16 進で 1 行ずつ記録する Node のスクリプトである。
// どちらの裏も無い環境では丸ごと飛ぶ。

const SCRIPT = `
const fs = require('fs');
const [mode, log] = process.argv.slice(2);
const RULE = '╌'.repeat(44);
process.stdin.setRawMode(true);
process.stdin.resume();
const dialog = [' Bash command', RULE, ' echo hi > a.txt', RULE, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and always allow access to this project', '   3. No', ' Esc to cancel · Tab to amend'].join('\\n');
const running = ['● Bash(sleep 100)', '  ⎿  Running…', '', '✻ Working… (3s · esc to interrupt)'].join('\\n');
process.stdout.write(mode === 'perm' ? dialog : running);
process.stdin.on('data', (d) => {
  fs.appendFileSync(log, d.toString('hex') + '\\n');
  if (mode === 'perm' && d[0] >= 0x31 && d[0] <= 0x39) process.stdout.write('\\x1b[2J\\x1b[H● allowed');
  if (mode === 'run' && d[0] === 0x1b) process.stdout.write('\\x1b[2J\\x1b[H● interrupted');
});
`;

const real = process.platform === 'win32' ? PSMUX : TMUX;

describe.skipIf(!real)('answerAsk と interruptRun（実物のペイン）', () => {
  const made: string[] = [];
  const dirs: string[] = [];
  const socketPath = process.platform === 'win32' ? '' : testSocketPath();
  const env = process.platform === 'win32' && PSMUX ? psmuxTestEnv() : {};
  const tmux = real
    ? new Tmux(process.platform === 'win32' ? { tmuxPath: real, socketName: psmuxNamespace(), env } : { tmuxPath: real, socketPath })
    : null;
  const panes: PaneOps | null = tmux ? (process.platform === 'win32' ? psmuxPaneOps(tmux) : tmuxPaneOps(tmux)) : null;
  afterAll(() => {
    // 止めるのは自分が作ったセッションだけ。
    // kill-server は Windows では呼べない。
    for (const n of made) tmux?.killSession(n);
    if (process.platform !== 'win32') { tmux?.killServer(); removeTestSocket(socketPath); }
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function start(name: string, mode: 'perm' | 'run') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-answer-'));
    dirs.push(dir);
    const script = path.join(dir, 'fake.cjs');
    const log = path.join(dir, 'keys.log');
    fs.writeFileSync(script, SCRIPT);
    fs.writeFileSync(log, '');
    made.push(name);
    panes!.open({ name, cwd: dir, command: [process.execPath, script, mode, log] });
    const keys = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    return { keys, answerer: createPeerAnswerer({ pane: (id) => (id === name ? answerPaneOf(panes!, name) : null) }) };
  }

  const ask: PeerChatAsk = {
    askId: 'real-1',
    kind: 'permission',
    tool: 'Bash',
    input: 'echo hi > a.txt',
    options: [{ key: 'allow', label: 'Yes' }, { key: 'always', label: 'Yes, and always allow access to this project' }, { key: 'deny', label: 'No' }],
    multi: false,
    allowText: false,
  };

  it('許可の答えは数字 1 回のキーで届き、札が閉じる。2 度目は何も打たない', async () => {
    const t = start('hangar-ans-perm', 'perm');
    await waitFor(() => panes!.capture('hangar-ans-perm').includes('Do you want to proceed?'), 15_000);
    expect(await t.answerer.answerAsk('hangar-ans-perm', ask, ['deny'])).toEqual({ ok: true, label: 'No' });
    // 3 行目の No の数字（3）だけが 1 回届く。
    expect(t.keys()).toEqual(['33']);
    expect(await t.answerer.answerAsk('hangar-ans-perm', ask, ['allow'])).toEqual({ ok: false, reason: 'already-answered' });
    expect(t.keys()).toEqual(['33']);
  }, 40_000);

  it('画面の札が違えば何も打たない', async () => {
    const t = start('hangar-ans-mis', 'perm');
    await waitFor(() => panes!.capture('hangar-ans-mis').includes('Do you want to proceed?'), 15_000);
    expect(await t.answerer.answerAsk('hangar-ans-mis', { ...ask, askId: 'real-2', input: 'rm -rf /' }, ['allow'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(t.keys()).toEqual([]);
  }, 40_000);

  it('Escape は 1 回だけ届き、札が出ている画面には打たない', async () => {
    const t = start('hangar-ans-run', 'run');
    await waitFor(() => panes!.capture('hangar-ans-run').includes('esc to interrupt'), 15_000);
    expect(await t.answerer.interruptRun('hangar-ans-run')).toEqual({ ok: true, sent: true });
    await waitFor(() => t.keys().length > 0, 10_000);
    // 少し待っても増えない（2 回目が遅れて届かない）。
    await new Promise((r) => setTimeout(r, 500));
    expect(t.keys()).toEqual(['1b']);

    const p = start('hangar-ans-nodlg', 'perm');
    await waitFor(() => panes!.capture('hangar-ans-nodlg').includes('Do you want to proceed?'), 15_000);
    expect(await p.answerer.interruptRun('hangar-ans-nodlg')).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(p.keys()).toEqual([]);
  }, 60_000);
});
