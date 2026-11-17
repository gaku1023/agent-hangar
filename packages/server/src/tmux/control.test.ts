import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { TMUX, removeTestSocket, testSocketPath, waitFor } from '../../test/tmux.ts';
import { ControlStream, MODE_FORMAT, controlSpawn, initialPaint, modeSequences, sendKeysCommands, unescapeOutput } from './control.ts';
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
  it('pause-after のときの %extended-output を %output と同じに読み、%pause と %continue を知らせる', () => {
    const got: string[] = [];
    const s = new ControlStream({ output: (pane, b) => got.push(`o ${pane} ${b.toString('utf8')}`), block: () => {}, exit: () => {}, pause: (p) => got.push(`pause ${p}`), resume: (p) => got.push(`continue ${p}`) });
    s.feed(Buffer.from('%extended-output %2 150 : a\\015\\012 : b\n%pause %2\n%continue %2\n', 'latin1'));
    expect(got).toEqual(['o %2 a\r\n : b', 'pause %2', 'continue %2']);
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

describe('modeSequences', () => {
  it('旗が 1 ならモードを入れ、0 なら切り、空（旗を知らない tmux）なら触らない', () => {
    const n = MODE_FORMAT.split(' ').length;
    const v = Array<string>(n).fill('');
    v[0] = '1'; // keypad_cursor_flag
    v[3] = '0'; // wrap_flag
    v[8] = '1'; // mouse_any_flag
    v[11] = '1'; // bracket_paste_flag
    expect(modeSequences(v)).toBe('\x1b[?1h\x1b[?7l\x1b[?1003h\x1b[?2004h');
  });
  it('initialPaint は画面の後、カーソルの位置の前に modes を置く', () => {
    expect(initialPaint({ history: [], screen: ['a'], cursorX: 0, cursorY: 0, alternate: false, modes: 'M' })).toBe('\x1b[H\x1b[2J\x1b[3JaM\x1b[1;1H');
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

describe('controlSpawn（流量の制御、偽の tmux）', () => {
  const fakeTmux = (): Tmux => new Tmux({ tmuxPath: 'tmux', exec: () => ({ status: 0, stdout: '%1\n', stderr: '' }) });
  const setup = (pauseAfterOk = true) => {
    const cmds: string[] = [];
    let out: (s: string) => void = () => {};
    let n = 0;
    const child = fakeChild((c, o) => {
      cmds.push(c);
      const body = c.startsWith('capture-pane') ? 'x\n' : c.startsWith('display-message') ? '0 0 0 0\n' : '';
      const bad = !pauseAfterOk && c.startsWith('refresh-client -f');
      o(`%begin 1 ${++n} 1\n${bad ? 'unknown flag\n' : body}%${bad ? 'error' : 'end'} 1 ${n} 1\n`);
    }, (o) => { out = o; });
    const p = controlSpawn(fakeTmux(), 'hangar-x', () => child);
    const got: string[] = [];
    p.onData((d) => got.push(d));
    return { p, cmds, got, out: (s: string) => out(s) };
  };
  it('つなぐとすぐ pause-after を頼み、%pause が来たら続きを頼み、その答えで描き直す', async () => {
    const { p, cmds, got, out } = setup();
    p.resize(80, 10);
    await waitFor(() => got.length === 1);
    expect(cmds[0]).toMatch(/^refresh-client -f pause-after=\d+$/);
    out('%extended-output %1 5 : hello\n');
    await waitFor(() => got.includes('hello'));
    out('%pause %1\n');
    await waitFor(() => cmds.includes("refresh-client -A '%1:continue'"));
    // 止まっている間に届いた分は捨てる（描き直しに含まれる）
    await waitFor(() => got.filter((g) => g.startsWith('\x1b[H')).length === 2);
    expect(cmds.filter((c) => c.startsWith('capture-pane'))).toHaveLength(4);
  });
  it('pause() の間は続きを頼まず、resume() で頼む', async () => {
    const { p, cmds, got, out } = setup();
    p.resize(80, 10);
    await waitFor(() => got.length === 1);
    p.pause?.();
    out('%pause %1\n');
    await new Promise((r) => setTimeout(r, 50));
    expect(cmds).not.toContain("refresh-client -A '%1:continue'");
    p.resume?.();
    await waitFor(() => cmds.includes("refresh-client -A '%1:continue'"));
  });
  it('pause-after を断る tmux（psmux や古い版）では pause/resume を子の読みの止めだけにし、%output の経路は変えない', async () => {
    const { p, cmds, got, out } = setup(false);
    p.resize(80, 10);
    await waitFor(() => got.length === 1);
    out('%output %1 hi\n');
    await waitFor(() => got.includes('hi'));
    out('%pause %1\n');
    await new Promise((r) => setTimeout(r, 50));
    expect(cmds.some((c) => c.includes(':continue'))).toBe(false);
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

  it('つないだ時点のモード（貼り付けの括り、マウス、矢印のアプリケーションモード）を xterm に戻す', async () => {
    const name = 'hangar-ctl-t2';
    tmux.run('new-session', '-d', '-s', name, '-x', '80', '-y', '10', 'sh');
    tmux.run('send-keys', '-t', `=${name}:`, `printf '\\033[?2004h\\033[?1003h\\033[?1006h\\033[?1h\\033[?25l'; echo ready`, 'Enter');
    // 画面には打ったコマンドの 'ready' も出るので、文字ではなく旗が揃うのを待つ（遅い環境では printf が走る前に通ってしまう）
    // bracket_paste_flag は tmux 3.4 の書式に無く（空で返る）、その版では戻せない。ある版だけ見る。
    const hasPaste = tmux.run('display-message', '-p', '-t', `=${name}:`, '#{bracket_paste_flag}').stdout.trim() !== '';
    const readFlags = () => tmux.run('display-message', '-p', '-t', `=${name}:`, '#{mouse_any_flag}#{mouse_sgr_flag}#{keypad_cursor_flag}#{cursor_flag}').stdout.trim();
    await waitFor(() => readFlags() === '1110');
    if (hasPaste) await waitFor(() => tmux.run('display-message', '-p', '-t', `=${name}:`, '#{bracket_paste_flag}').stdout.trim() === '1');

    const p = controlSpawn(tmux, name);
    let got = '';
    p.onData((d) => { got += d; });
    p.resize(80, 10);
    await waitFor(() => got.includes('ready'));
    await waitFor(() => got.includes('\x1b[?1003h'));
    for (const seq of ['\x1b[?1003h', '\x1b[?1006h', '\x1b[?1h', '\x1b[?25l']) expect(got).toContain(seq);
    if (hasPaste) { expect(got).toContain('\x1b[?2004h'); expect(got).not.toContain('\x1b[?2004l'); }
    p.kill();
  });
  it('出力が止まらない yes でも、読みを止めて待たせると %pause のあと %continue で戻り、描き直して打鍵が通る', async () => {
    const name = 'hangar-ctl-t3';
    tmux.run('new-session', '-d', '-s', name, '-x', '80', '-y', '10', 'sh');
    tmux.run('send-keys', '-t', `=${name}:`, 'yes', 'Enter');
    await waitFor(() => tmux.capturePane(name).includes('y'));
    // tmux が %pause を返すのは、同じ pane を別のクライアントが読み続けていて、こちらだけ遅れるとき。
    // 遅れるのがこの 1 つだけなら、tmux は pane の読みを自分で止めるので溜まらない。
    const other = spawn(tmux.tmuxPath, tmux.controlAttachArgs(name), { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...tmux.env } });
    other.stdout.on('data', () => {});
    other.stdin.on('error', () => {});
    const p = controlSpawn(tmux, name, undefined, { pauseAfterSec: 1 });
    let got = '';
    let paints = 0;
    p.onData((d) => { got += d; if (d.startsWith('\x1b[H\x1b[2J\x1b[3J')) paints++; });
    p.resize(80, 10);
    await waitFor(() => paints === 1);
    p.pause?.();
    const before = got.length;
    // 読まずに 1 秒以上待つと、tmux は止める。止まっている間、子の読みは止まったまま
    await new Promise((r) => setTimeout(r, 1800));
    expect(got.length).toBe(before);
    p.resume?.();
    await waitFor(() => paints === 2, 8000);
    // 戻ったあとも出力は流れ続ける
    const mid = got.length;
    await waitFor(() => got.length > mid + 1000, 5000);
    // 打鍵が通る：Ctrl-C で yes を止め、続けて打った行の答えが届く
    p.write('\x03');
    await new Promise((r) => setTimeout(r, 300));
    p.write('echo flow-$((40+2))\r');
    await waitFor(() => got.includes('flow-42'), 8000);
    p.kill();
    other.kill();
  }, 30000);
});
