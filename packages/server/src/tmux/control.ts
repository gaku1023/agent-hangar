import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { PtyProcess } from '../pty/relay.ts';
import type { Tmux } from './tmux.ts';

/**
 * tmux のコントロールモード（`tmux -C attach`）で、ペインの生の出力を UI の xterm へ流す。
 * 擬似端末の中の `tmux attach` では tmux が画面を描くので、xterm には今の 1 画面しか残らない。
 * 選択も tmux のコピーモードになり（利用者の mouse on）、始点が 1 マスずれ、上端で勝手に送られ、画面の外は選べない。
 * コントロールモードでは tmux は描かず、中のシェルが書いたバイトをそのまま渡すので、
 * 履歴・選択・スクロール・折り返しを xterm が自分で持ち、tmux を挟まない端末と同じ手触りになる。
 * iTerm2 の tmux 連携（tmux -CC）と同じ仕組みである。
 */

/** `%output` の中身を戻す。tmux は 0x20 未満と `\` を `\ooo` の 8 進で送り、ほかのバイトはそのまま送る。行は latin1 で受けて、バイトを保つ。 */
export function unescapeOutput(s: string): Buffer {
  const b = Buffer.from(s, 'latin1');
  const out = Buffer.allocUnsafe(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x5c && i + 3 < b.length && isOct(b[i + 1]!) && isOct(b[i + 2]!) && isOct(b[i + 3]!)) {
      out[n++] = ((b[i + 1]! - 0x30) << 6) | ((b[i + 2]! - 0x30) << 3) | (b[i + 3]! - 0x30);
      i += 3;
    } else out[n++] = b[i]!;
  }
  return out.subarray(0, n);
}
const isOct = (c: number): boolean => c >= 0x30 && c <= 0x37;

type StreamHandlers = {
  /** ペインの出力。 */
  output(pane: string, bytes: Buffer): void;
  /**
   * コマンドの答え。ok は %end なら真、%error なら偽。行は latin1 のまま渡す。
   * fromClient は、標準入力から送ったコマンドへの答えか（%begin の flags が 1）。tmux は 3.0 から、
   * つないだ直後に attach そのものの答えを flags 0 で返す。psmux（3.4.0）はその答えを返さない。flags の無い行は真とみなす。
   */
  block(lines: string[], ok: boolean, fromClient: boolean): void;
  exit(): void;
};

/** コントロールモードの出力を行に分けて読む。塊が行の途中で切れていても、次の塊とつないでから読む。 */
export class ControlStream {
  private rest: Buffer = Buffer.alloc(0);
  private body: string[] | null = null;
  private fromClient = true;
  constructor(private readonly h: StreamHandlers) {}

  feed(chunk: Buffer): void {
    this.rest = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    let nl: number;
    while ((nl = this.rest.indexOf(0x0a)) >= 0) {
      const line = this.rest.toString('latin1', 0, nl);
      this.rest = this.rest.subarray(nl + 1);
      this.line(line);
    }
  }

  private line(line: string): void {
    // 答えの中の行は、% で始まっていても中身として扱う（capture-pane の結果など）。
    if (this.body) {
      if (line.startsWith('%end ') || line.startsWith('%error ')) {
        const lines = this.body;
        this.body = null;
        this.h.block(lines, line.startsWith('%end '), this.fromClient);
      } else this.body.push(line);
      return;
    }
    if (line.startsWith('%begin ')) { this.body = []; this.fromClient = line.split(' ')[3] !== '0'; return; }
    if (line.startsWith('%output ')) {
      const sp = line.indexOf(' ', 8);
      if (sp > 0) this.h.output(line.slice(8, sp), unescapeOutput(line.slice(sp + 1)));
      return;
    }
    if (line === '%exit' || line.startsWith('%exit ')) this.h.exit();
  }
}

/** 一度に送る send-keys のバイト数。コマンドの 1 行を短く保つ。 */
const KEYS_PER_COMMAND = 256;

/** 打鍵のバイトを send-keys -H の列にする。16 進で送れば、制御文字や `;` も tmux に解釈されずに届く。 */
export function sendKeysCommands(pane: string, bytes: Buffer): string[] {
  const cmds: string[] = [];
  for (let i = 0; i < bytes.length; i += KEYS_PER_COMMAND) {
    const hex = [...bytes.subarray(i, i + KEYS_PER_COMMAND)].map((c) => c.toString(16).padStart(2, '0'));
    cmds.push(`send-keys -t ${pane} -H ${hex.join(' ')}`);
  }
  return cmds;
}

/**
 * ペインのモードの旗。display-message の書式（modeFormat）と同じ順で、値は 0 か 1 である。
 * iTerm2 の tmux 連携がつなぎ直しで戻す旗に倣う。
 */
const MODE_FLAGS = [
  ['keypad_cursor_flag', '\x1b[?1h', '\x1b[?1l'],
  ['keypad_flag', '\x1b=', '\x1b>'],
  ['insert_flag', '\x1b[4h', '\x1b[4l'],
  ['wrap_flag', '\x1b[?7h', '\x1b[?7l'],
  ['origin_flag', '\x1b[?6h', '\x1b[?6l'],
  ['cursor_flag', '\x1b[?25h', '\x1b[?25l'],
  ['mouse_standard_flag', '\x1b[?1000h', '\x1b[?1000l'],
  ['mouse_button_flag', '\x1b[?1002h', '\x1b[?1002l'],
  ['mouse_any_flag', '\x1b[?1003h', '\x1b[?1003l'],
  ['mouse_utf8_flag', '\x1b[?1005h', '\x1b[?1005l'],
  ['mouse_sgr_flag', '\x1b[?1006h', '\x1b[?1006l'],
  ['bracket_paste_flag', '\x1b[?2004h', '\x1b[?2004l'],
] as const;
/** display-message の書式の中の、モードの旗の並び。 */
export const MODE_FORMAT = MODE_FLAGS.map(([n]) => `#{${n}}`).join(' ');
/** 旗の値（MODE_FORMAT の順）から、xterm のモードを戻す列。旗を知らない tmux は空を返すので、その旗は触らない。 */
export function modeSequences(values: string[]): string {
  let s = '';
  MODE_FLAGS.forEach(([, on, off], i) => {
    const v = values[i];
    if (v === '1') s += on;
    else if (v === '0') s += off;
  });
  return s;
}

/**
 * つないだ時点の様子を xterm に描く列。
 * 先に xterm の履歴ごと消す。つなぎ直したときに同じ xterm へもう一度描くので、消さないと履歴が重なる。
 * 中のアプリが別画面（vim や less）を使っていれば、履歴を描いてから別画面に入る。抜けたときに履歴が戻る。
 */
export function initialPaint(o: { history: string[]; screen: string[]; cursorX: number; cursorY: number; alternate: boolean; modes?: string }): string {
  let s = '\x1b[H\x1b[2J\x1b[3J';
  if (o.history.length) s += o.history.join('\r\n') + '\r\n';
  if (o.alternate) s += '\x1b[?1049h\x1b[H\x1b[2J';
  s += o.screen.join('\r\n');
  s += o.modes ?? '';
  s += `\x1b[${o.cursorY + 1};${o.cursorX + 1}H`;
  return s;
}

type Spawn = (file: string, args: string[], env?: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;
const defaultSpawn: Spawn = (file, args, env) => nodeSpawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: env ? { ...process.env, ...env } : process.env });

const latin1ToUtf8 = (s: string): string => Buffer.from(s, 'latin1').toString('utf8');

/**
 * `tmux -C attach` を PtyProcess の口で包む。PtyRelay は擬似端末の attach と同じように扱える。
 * 最初の resize で、同じ制御の経路に履歴と今の画面の写しを頼む。tmux は答えと出力を起きた順に流すので、
 * 今の画面の答えより前の出力は写しに含まれていて捨ててよく、後の出力だけを通せばよい。
 */
export function controlSpawn(tmux: Tmux, name: string, spawn: Spawn = defaultSpawn): PtyProcess {
  const pane = tmux.run('display-message', '-p', '-t', `=${name}:`, '#{pane_id}').stdout.trim();
  const child = spawn(tmux.tmuxPath, tmux.controlAttachArgs(name), tmux.env);
  // 終わった子へ書くと EPIPE になる。終わりは exit で知らせるので、ここでは捨てる。
  child.stdin.on('error', () => { /* 同上 */ });
  child.stderr.resume();

  let onData: (d: string) => void = () => {};
  let onExit: (e: { exitCode: number }) => void = () => {};
  const decoder = new TextDecoder('utf-8');
  /** 答えを待っているコマンドの受け手。送った順に並ぶ。attach そのものの答え（fromClient が偽）は数えない。 */
  const replies: ((lines: string[], ok: boolean) => void)[] = [];
  /** 'wait' は今の画面の写しが届くまで（出力は写しに含まれるので捨てる）、'capture' はカーソルの位置を待つ間（溜める）、'live' は出力を通す。 */
  let phase: 'wait' | 'capture' | 'live' = 'wait';
  let painting = false;
  const held: Buffer[] = [];
  let ended = false;

  const command = (c: string, reply: (lines: string[], ok: boolean) => void = () => {}): void => {
    if (ended) return;
    replies.push(reply);
    child.stdin.write(c + '\n');
  };
  const emit = (b: Buffer): void => { const s = decoder.decode(b, { stream: true }); if (s) onData(s); };

  const stream = new ControlStream({
    output: (p, bytes) => {
      if (p !== pane || phase === 'wait') return;
      if (phase === 'capture') held.push(bytes); else emit(bytes);
    },
    block: (lines, ok, fromClient) => { if (fromClient) replies.shift()?.(lines, ok); },
    exit: () => { /* 子の exit で知らせる */ },
  });
  child.stdout.on('data', (d: Buffer) => stream.feed(d));
  child.on('exit', (code) => {
    if (ended) return;
    ended = true;
    onExit({ exitCode: code ?? 0 });
  });
  child.on('error', () => {
    if (ended) return;
    ended = true;
    onExit({ exitCode: 1 });
  });

  const paint = (): void => {
    let history: string[] = [];
    let screen: string[] = [];
    command(`capture-pane -p -e -J -S - -E -1 -t ${pane}`, (lines, ok) => { history = ok ? lines.map(latin1ToUtf8) : []; });
    command(`capture-pane -p -e -t ${pane}`, (lines, ok) => {
      screen = ok ? lines.map(latin1ToUtf8) : [];
      // ここから後の出力は写しに含まれない。カーソルの位置が届くまで溜める。
      phase = 'capture';
    });
    command(`display-message -p -t ${pane} '#{history_size} #{cursor_x} #{cursor_y} #{alternate_on} ${MODE_FORMAT}'`, (lines) => {
      const parts = (lines[0] ?? '').trim().split(' ');
      const [hs, cx, cy, alt] = parts.slice(0, 4).map(Number);
      onData(initialPaint({ history: hs ? history : [], screen, cursorX: cx || 0, cursorY: cy || 0, alternate: alt === 1, modes: modeSequences(parts.slice(4)) }));
      phase = 'live';
      for (const b of held.splice(0)) emit(b);
    });
  };

  return {
    pid: child.pid ?? 0,
    onData(cb) { onData = cb; },
    onExit(cb) { onExit = cb; },
    write(d) { for (const c of sendKeysCommands(pane, Buffer.from(d, 'utf8'))) command(c); },
    resize(cols, rows) {
      command(`refresh-client -C ${cols}x${rows}`);
      if (!painting) { painting = true; paint(); }
    },
    kill() { if (!ended) child.kill(); },
  };
}
