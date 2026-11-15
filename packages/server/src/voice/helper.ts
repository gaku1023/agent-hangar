import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { isVoiceEvent, type VoiceCommand } from '@agent-hangar/shared';

export type VoiceHelperStatus = 'unavailable' | 'starting' | 'ready' | 'crashed';

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const MAX_CONSECUTIVE_CRASHES = 5;
/** これだけ動き続けてから落ちたときは、続けて落ちたとは数えない。 */
const STABLE_MS = 60_000;
/** stop で quit を送ってから SIGTERM までの長さ、SIGTERM から SIGKILL までの長さ、待つ全体の上限。 */
const STOP_TERM_MS = 2000;
const STOP_KILL_MS = 4000;
const STOP_GIVE_UP_MS = 5000;

/** 補助 hangar-voice の場所。darwin 以外と、見つからないときは null（画面は今のマイクの動きに戻る）。 */
export function resolveVoiceBin(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (p: string) => boolean): string | null {
  if (platform !== 'darwin') return null;
  const fromEnv = env.HANGAR_VOICE_BIN;
  if (fromEnv && exists(fromEnv)) return fromEnv;
  const dev = path.resolve(import.meta.dirname, '../../../../apps/voice-mac/dist/hangar-voice');
  return exists(dev) ? dev : null;
}

/**
 * 補助プロセスの起動と見張り。標準入出力の 1 行 1 JSON で話す（型は shared/voice.ts）。
 * 落ちたら 1 秒、2 秒、4 秒…（上限 30 秒）で起こし直し、5 回続けて落ちたら unavailable で止まる。サーバは落ちない。
 * 補助の ev は 'event' で流す。
 */
export class VoiceHelper extends EventEmitter {
  private readonly bin: string | null;
  private readonly spawnFn: typeof nodeSpawn;
  private readonly now: () => number;
  private child: ChildProcess | null = null;
  private state: VoiceHelperStatus = 'unavailable';
  private crashes = 0;
  private startedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(opts: { bin: string | null; spawn?: typeof nodeSpawn; now?: () => number }) {
    super();
    this.bin = opts.bin;
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.now = opts.now ?? Date.now;
  }

  get status(): VoiceHelperStatus { return this.state; }

  start(): void {
    if (this.bin === null || this.child) return;
    this.stopping = false;
    this.launch(this.bin);
  }

  send(cmd: VoiceCommand): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return;
    try { stdin.write(`${JSON.stringify(cmd)}\n`); } catch { /* 落ちかけの補助。exit で扱う */ }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const child = this.child;
    this.state = 'unavailable';
    if (!child || child.exitCode != null || child.signalCode != null) return;
    // quit に応じなければ SIGTERM、それにも応じなければ SIGKILL を送る。それでも終わらなければ待たずに戻る（サーバの終了を止めない）。
    await new Promise<void>((resolve) => {
      const timers: NodeJS.Timeout[] = [];
      const finish = () => {
        for (const t of timers) clearTimeout(t);
        child.off('exit', finish);
        resolve();
      };
      const kill = (sig: NodeJS.Signals) => () => { try { child.kill(sig); } catch { /* 既に終わっている */ } };
      child.once('exit', finish);
      timers.push(setTimeout(kill('SIGTERM'), STOP_TERM_MS), setTimeout(kill('SIGKILL'), STOP_KILL_MS), setTimeout(finish, STOP_GIVE_UP_MS));
      this.send({ cmd: 'quit' });
    });
  }

  private launch(bin: string): void {
    this.state = 'starting';
    this.startedAt = this.now();
    let child: ChildProcess;
    try {
      child = this.spawnFn(bin, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      this.onExit();
      return;
    }
    this.child = child;
    child.stdin?.on('error', () => { /* 書き込み先が閉じた。exit で扱う */ });
    if (child.stdout) {
      readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    }
    child.once('error', () => { if (this.child === child) this.onExit(); });
    child.once('exit', () => { if (this.child === child) this.onExit(); });
  }

  private onLine(line: string): void {
    let ev: unknown;
    try { ev = JSON.parse(line); } catch { return; }
    // 形の合わない行は捨てる。受け手が読み違えて、readline の中で投げないため。
    if (!isVoiceEvent(ev)) return;
    if (ev.ev === 'ready') this.state = 'ready';
    this.emit('event', ev);
  }

  private onExit(): void {
    this.child = null;
    if (this.stopping || this.bin === null) { this.state = 'unavailable'; return; }
    this.crashes = this.now() - this.startedAt >= STABLE_MS ? 1 : this.crashes + 1;
    if (this.crashes >= MAX_CONSECUTIVE_CRASHES) { this.state = 'unavailable'; return; }
    this.state = 'crashed';
    const wait = Math.min(BACKOFF_START_MS * 2 ** (this.crashes - 1), BACKOFF_MAX_MS);
    const bin = this.bin;
    this.timer = setTimeout(() => { this.timer = null; if (!this.stopping) this.launch(bin); }, wait);
  }
}
