import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { TMUX, removeTestSocket, testSocketPath, waitFor } from '../../test/tmux.ts';
import { ControlStream, controlSpawn, initialPaint, sendKeysCommands, unescapeOutput } from './control.ts';
import { Tmux } from './tmux.ts';

describe('unescapeOutput', () => {
  it('8 進のエスケープをバイトに戻し、ほかはそのまま残す', () => {
    expect(unescapeOutput('\\033[31mA\\134B\\015\\012')).toEqual(Buffer.from('\x1b[31mA\\B\r\n', 'latin1'));
  });
  it('UTF-8 のバイトは latin1 で受けたまま戻す', () => {
    const utf8 = Buffer.from('日本', 'utf8').toString('latin1');
    expect(unescapeOutput(utf8).toString('utf8')).toBe('日本');
  });
});

describe('ControlStream', () => {
  it('%output を 1 行ずつ読み、行をまたぐ塊でも崩さない', () => {
    const out: [string, string][] = [];
    const s = new ControlStream({ output: (pane, b) => out.push([pane, b.toString('utf8')]), block: () => {}, exit: () => {} });
    const line = Buffer.from('%output %3 ' + Buffer.from('あ\\015\\012', 'utf8').toString('latin1') + '\n', 'latin1');
    s.feed(line.subarray(0, 13));
    s.feed(line.subarray(13));
    expect(out).toEqual([['%3', 'あ\r\n']]);
  });
  it('%begin から %end までを 1 つの答えとして渡す', () => {
    const blocks: { lines: string[]; ok: boolean }[] = [];
    const s = new ControlStream({ output: () => {}, block: (lines, ok) => blocks.push({ lines, ok }), exit: () => {} });
    s.feed(Buffer.from('%begin 1 2 1\nfoo\nbar\n%end 1 2 1\n%begin 1 3 1\nnope\n%error 1 3 1\n', 'latin1'));
    expect(blocks).toEqual([{ lines: ['foo', 'bar'], ok: true }, { lines: ['nope'], ok: false }]);
  });
  it('答えが利用者のコマンドへのもの（%begin の flags が 1）かを添える。attach そのものの答えは 0', () => {
    const got: boolean[] = [];
    const s = new ControlStream({ output: () => {}, block: (_l, _ok, fromClient) => got.push(fromClient), exit: () => {} });
    s.feed(Buffer.from('%begin 1 1 0\n%end 1 1 0\n%begin 1 2 1\n%end 1 2 1\n%begin 1 3\n%end 1 3\n', 'latin1'));
    expect(got).toEqual([false, true, true]);
  });
  it('%exit で終わりを知らせる', () => {
    let exited = false;
    const s = new ControlStream({ output: () => {}, block: () => {}, exit: () => { exited = true; } });
    s.feed(Buffer.from('%exit\n', 'latin1'));
    expect(exited).toBe(true);
  });
});

describe('sendKeysCommands', () => {
  it('打鍵を 16 進の send-keys にする', () => {
    expect(sendKeysCommands('%1', Buffer.from('a\r', 'utf8'))).toEqual(['send-keys -t %1 -H 61 0d']);
  });
  it('長い貼り付けは分けて送る', () => {
    const cmds = sendKeysCommands('%1', Buffer.alloc(600, 0x61));
    expect(cmds.length).toBeGreaterThan(1);
    expect(cmds.join(' ').match(/61/g)).toHaveLength(600);
  });
});

describe('initialPaint', () => {
  it('xterm の履歴ごと消してから、履歴、今の画面、カーソルの順に描く', () => {
    const s = initialPaint({ history: ['h1', 'h2'], screen: ['s1', 's2'], cursorX: 3, cursorY: 1, alternate: false });
    expect(s).toBe('\x1b[H\x1b[2J\x1b[3Jh1\r\nh2\r\ns1\r\ns2\x1b[2;4H');
  });
  it('中のアプリが別画面を使っているときは、履歴を描いてから別画面に入る', () => {
    const s = initialPaint({ history: ['h1'], screen: ['vim'], cursorX: 0, cursorY: 0, alternate: true });
    expect(s).toBe('\x1b[H\x1b[2J\x1b[3Jh1\r\n\x1b[?1049h\x1b[H\x1b[2Jvim\x1b[1;1H');
  });
});

/** controlSpawn に渡す偽の子。送られたコマンドを 1 行ずつ answer に渡し、onStart でつないだ直後の出力を流す。 */
function fakeChild(answer: (cmd: string, out: (s: string) => void) => void, onStart: (out: (s: string) => void) => void): ChildProcessWithoutNullStreams {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 1, kill: () => { child.emit('exit', 0); } });
  const out = (s: string): void => { child.stdout.write(Buffer.from(s, 'latin1')); };
  let rest = '';
  child.stdin.on('data', (d: Buffer) => {
    rest += d.toString('latin1');
    let nl: number;
    while ((nl = rest.indexOf('\n')) >= 0) { const c = rest.slice(0, nl); rest = rest.slice(nl + 1); answer(c, out); }
  });
  queueMicrotask(() => onStart(out));
  return child as unknown as ChildProcessWithoutNullStreams;
}

describe('controlSpawn（答えの数え方）', () => {
  const fakeTmux = (): Tmux => new Tmux({ tmuxPath: 'tmux', exec: () => ({ status: 0, stdout: '%1\n', stderr: '' }) });
  /** capture-pane と display-message に答える。n は答えの番号。echo は psmux のようにコマンドの行を写し返す。keysError は psmux のように send-keys に %error を返す。 */
  const reply = (n: number, cmd: string, out: (s: string) => void, o: { echo?: boolean; keysError?: boolean } = {}): void => {
    if (o.echo) out(cmd + '\n');
    let body = '';
    if (cmd.startsWith('capture-pane') && cmd.includes(' -S -')) body = 'old1\nold2\n';
    else if (cmd.startsWith('capture-pane')) body = 'now1\nnow2\n';
    else if (cmd.startsWith('display-message')) body = '2 4 1 0\n';
    const bad = o.keysError === true && cmd.startsWith('send-keys');
    out(`%begin 1 ${n} 1\n${bad ? 'command timed out\n' : body}%${bad ? 'error' : 'end'} 1 ${n} 1\n`);
  };
  const painted = initialPaint({ history: ['old1', 'old2'], screen: ['now1', 'now2'], cursorX: 4, cursorY: 1, alternate: false });
  const run = async (child: () => ChildProcessWithoutNullStreams, before?: (p: ReturnType<typeof controlSpawn>) => void): Promise<string> => {
    const p = controlSpawn(fakeTmux(), 'hangar-x', child);
    let got = '';
    p.onData((d) => { got += d; });
    before?.(p);
    p.resize(80, 10);
    await waitFor(() => got.includes('now2'), 2000, 5);
    return got;
  };

  it('tmux：つないだときに来る attach の答え（flags 0）を数えず、頼んだ順に答えを受ける', async () => {
    let n = 1;
    expect(await run(() => fakeChild((c, out) => reply(++n, c, out), (out) => out('%begin 1 1 0\n%end 1 1 0\n')))).toBe(painted);
  });

  it('psmux：attach の答えが来ず、コマンドの行が写し返されても、答えがずれない', async () => {
    let n = 0;
    expect(await run(() => fakeChild((c, out) => reply(++n, c, out, { echo: true }), (out) => out('%window-add @1\n%session-changed $0 x\n')))).toBe(painted);
  });

  it('psmux：send-keys が %error を返しても、後の答えの受け手はずれない', async () => {
    let n = 0;
    expect(await run(() => fakeChild((c, out) => reply(++n, c, out, { echo: true, keysError: true }), () => {}), (p) => p.write('a'))).toBe(painted);
  });
});

describe.skipIf(!TMUX)('controlSpawn（実物の tmux）', () => {
  const socketPath = testSocketPath();
  const tmux = new Tmux({ tmuxPath: TMUX ?? 'tmux', socketPath });
  afterAll(() => { tmux.killServer(); removeTestSocket(socketPath); });

  it('つないだ時点の履歴を描き、その後の出力と打鍵を通す', async () => {
    const name = 'hangar-ctl-t1';
    tmux.run('new-session', '-d', '-s', name, '-x', '80', '-y', '10', 'sh');
    tmux.run('send-keys', '-t', `=${name}:`, 'seq 1 40', 'Enter');
    await waitFor(() => tmux.capturePane(name).includes('40'));

    const p = controlSpawn(tmux, name);
    let got = '';
    let exited = false;
    p.onData((d) => { got += d; });
    p.onExit(() => { exited = true; });
    p.resize(80, 10);
    // 画面の外へ流れた 1 行目も、履歴として届く
    await waitFor(() => got.includes('40'));
    expect(got.startsWith('\x1b[H\x1b[2J\x1b[3J')).toBe(true);
    expect(got).toMatch(/\b1\r\n2\r\n3\r\n/);

    p.write('echo 日本語-$((40+2))\r');
    await waitFor(() => got.includes('日本語-42'));

    p.kill();
    await waitFor(() => exited);
    // 切ったのは attach だけで、シェルは残る
    expect(tmux.run('has-session', '-t', `=${name}`).code).toBe(0);
  });
});
