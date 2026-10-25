import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ProviderPrep } from '@agent-hangar/shared';
import type { LaunchPrep } from '../../runs/launchPrep.ts';
import { opencodeBaseEnv } from './serve/env.ts';
import { killGroup } from './serve/spawn.ts';

/**
 * 接続先の準備（docs/design.md「接続先の準備」）。OpenAI 互換サーバーの行ごとに利用者が書いたコマンドを、会話を始める前に走らせる。
 * 判定はコマンドに任せる。終了コード 0 で準備済み、それ以外は出力の最後の行を理由にして起動を止める。
 * URL の応答では判定しない。GPU を自分で返すサーバーは、返した後も応答し、次の要求で数分かけて取り直すからである。
 *
 * 同じ接続先を使う会話が並んだら、走っている準備を 1 本にまとめて待つ。待つ会話が全部やめたら、コマンドを止める。
 * 準備が済んだ会話を「使っている会話」として数え、その接続先を使う最後の会話が終わったら、止める時期（分）の後に止めるコマンドを走らせる。
 * 止めるのを待つ間に新しい会話が準備を始めたら、止めるのをやめる。止めている最中なら、止め終わるのを待ってから準備する。
 * hangar を閉じたときは止めない（opencode の会話は閉じても続くため）。起こし直す前から動いている会話は数えない。
 */

/** コマンドを走らせた結果。code は終了コード（信号で終わったら null）、tail は出力の最後の空でない行。 */
export type PrepCommandResult = { code: number | null; tail: string };
/** コマンドを走らせる口。signal が切れたらプロセスの木ごと止めて返る。試験で差し替える。 */
export type PrepCommandRunner = (command: string, signal: AbortSignal) => Promise<PrepCommandResult>;

/** 準備のコマンドが動いてよい上限。立ち上がりに 10 分ほどかかるサーバーがあるので、それより長くとる。 */
export const PREP_COMMAND_TIMEOUT_MS = 20 * 60_000;

/** 準備に失敗した。message が画面に出す理由である。 */
export class ProviderPrepFailed extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ProviderPrepFailed';
  }
}

export type ProviderPrepsDeps = {
  /** 接続先ごとの準備（設定の opencodeProviderPrep）。呼ばれた時点の値を読む。 */
  preps: () => Record<string, ProviderPrep>;
  /** 終了コード 0 以外の理由の文。出力が無いときに使う。 */
  exitReason: (code: number | null) => string;
  /** 上限を過ぎて止めたときの理由の文。 */
  timeoutReason: (minutes: number) => string;
  run?: PrepCommandRunner;
  timeoutMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
  /** 止めるコマンドの失敗の知らせ。 */
  report?: (providerId: string, reason: string) => void;
};

type Running = { promise: Promise<PrepCommandResult>; abort: AbortController; waiters: number };

export class ProviderPreps {
  private readonly running = new Map<string, Running>();
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly stopTimers = new Map<string, unknown>();
  /** 接続先ごとの、準備が済んで動いている会話（hangar の会話の ID）。 */
  private readonly users = new Map<string, Set<string>>();
  private readonly run: PrepCommandRunner;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly deps: ProviderPrepsDeps) {
    this.run = deps.run ?? runPrepCommand;
    this.setTimer = deps.setTimeout ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; });
    this.clearTimer = deps.clearTimeout ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  /** 準備のある接続先の ID のうち、ids に入っているもの（並びは ids のまま）。 */
  configured(ids: readonly string[]): string[] {
    const preps = this.deps.preps();
    return [...new Set(ids)].filter((id) => Object.hasOwn(preps, id));
  }

  /** 準備のある接続先が 1 つでもあるか。無ければ、使う接続先を serve に聞きにいかない。 */
  any(): boolean {
    return Object.keys(this.deps.preps()).length > 0;
  }

  /**
   * 接続先の準備を走らせる（走っていれば相乗りして待つ）。済んだら sessionId を使っている会話に数える。
   * 進みは prep の段（kind は command、action は run、target は接続先の名前）で配る。失敗は ProviderPrepFailed で投げる。
   */
  async prepare(providerId: string, name: string, sessionId: string, prep: Pick<LaunchPrep, 'step' | 'signal' | 'throwIfCancelled'>): Promise<void> {
    const conf = this.deps.preps()[providerId];
    if (!conf) return;
    this.cancelStop(providerId);
    const step = prep.step('command', name, 'run');
    await this.stopping.get(providerId);
    prep.throwIfCancelled();
    let r = this.running.get(providerId);
    if (!r) {
      const abort = new AbortController();
      const timeoutMs = this.deps.timeoutMs ?? PREP_COMMAND_TIMEOUT_MS;
      let timedOut = false;
      const timer = this.setTimer(() => { timedOut = true; abort.abort(); }, timeoutMs);
      const run: Running = {
        abort, waiters: 0,
        promise: this.run(conf.start, abort.signal).then(
          (res) => (timedOut ? { code: null, tail: this.deps.timeoutReason(Math.round(timeoutMs / 60_000)) } : res),
        ).finally(() => {
          this.clearTimer(timer);
          if (this.running.get(providerId) === run) this.running.delete(providerId);
        }),
      };
      r = run;
      this.running.set(providerId, run);
    }
    const shared = r;
    shared.waiters += 1;
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      shared.waiters -= 1;
      if (shared.waiters === 0) shared.abort.abort();
    };
    const cancelled = new Promise<null>((resolve) => {
      if (prep.signal.aborted) resolve(null);
      prep.signal.addEventListener('abort', () => resolve(null), { once: true });
    });
    const res = await Promise.race([shared.promise, cancelled]);
    if (res === null) {
      leave();
      prep.throwIfCancelled();
      return;
    }
    left = true;
    if (res.code === 0) {
      step.done();
      const set = this.users.get(providerId) ?? new Set<string>();
      set.add(sessionId);
      this.users.set(providerId, set);
      return;
    }
    const reason = res.tail || this.deps.exitReason(res.code);
    step.fail(reason);
    throw new ProviderPrepFailed(reason);
  }

  /** 会話が終わった。その接続先を使う会話が無くなったら、止める時期の後に止めるコマンドを走らせる。 */
  release(sessionId: string): void {
    for (const [providerId, set] of this.users) {
      if (!set.delete(sessionId) || set.size > 0) continue;
      this.users.delete(providerId);
      const conf = this.deps.preps()[providerId];
      if (!conf?.stop || conf.stopAfter === null) continue;
      this.cancelStop(providerId);
      this.stopTimers.set(providerId, this.setTimer(() => { this.stopTimers.delete(providerId); this.stop(providerId); }, conf.stopAfter * 60_000));
    }
  }

  private cancelStop(providerId: string): void {
    const t = this.stopTimers.get(providerId);
    if (t === undefined) return;
    this.clearTimer(t);
    this.stopTimers.delete(providerId);
  }

  /** 止めるコマンドを走らせる。待つ間に会話が戻っていたら走らせない。 */
  private stop(providerId: string): void {
    const conf = this.deps.preps()[providerId];
    if (!conf?.stop || this.users.has(providerId) || this.running.has(providerId)) return;
    const abort = new AbortController();
    const timer = this.setTimer(() => abort.abort(), this.deps.timeoutMs ?? PREP_COMMAND_TIMEOUT_MS);
    const done = this.run(conf.stop, abort.signal)
      .then((res) => { if (res.code !== 0) this.deps.report?.(providerId, res.tail || this.deps.exitReason(res.code)); })
      .catch((e: unknown) => { this.deps.report?.(providerId, e instanceof Error ? e.message : String(e)); })
      .finally(() => { this.clearTimer(timer); if (this.stopping.get(providerId) === done) this.stopping.delete(providerId); });
    this.stopping.set(providerId, done);
  }

  /** 待っている止める時期を全部捨てる（試験と後片付け）。 */
  dispose(): void {
    for (const t of this.stopTimers.values()) this.clearTimer(t);
    this.stopTimers.clear();
  }
}

/** 色づけの印（ESC [ … 字）を外す。理由の 1 行に混ぜないためである。 */
const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');

/** 出力の最後の空でない行。 */
export function lastLine(out: string): string {
  const lines = stripAnsi(out).split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? '';
}

/** 出力のうち持っておく末尾の長さ。最後の行だけ使うので、長い出力をまるごと持たない。 */
const TAIL_BYTES = 8192;

/**
 * 準備のコマンドを走らせる。
 * macOS と Linux はログインシェル（`$SHELL -lc`）で走らせる。空の環境（serve と同じ土台）に ~/.local/bin を足し、シェルの読み込みに PATH を組ませる。
 * Windows は PowerShell（-NoProfile）で、serve と同じ許可リストの環境で走らせる。
 * hangar と呼び手の印（CLAUDE 系、HANGAR_*）と API キーは持ち込まない。標準入力は閉じる（待たせない）。
 */
export const runPrepCommand: PrepCommandRunner = (command, signal) => new Promise((resolve, reject) => {
  const win = process.platform === 'win32';
  const env = win ? opencodeBaseEnv(process.execPath) : opencodeBaseEnv('/usr/bin/env');
  if (!win && env.HOME) env.PATH = `${path.posix.join(env.HOME, '.local', 'bin')}:${env.PATH ?? ''}`;
  const argv = win
    ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command]
    : [env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh'), '-lc', command];
  const child = spawn(argv[0]!, argv.slice(1), { env, cwd: env.HOME ?? env.USERPROFILE, stdio: ['ignore', 'pipe', 'pipe'], detached: !win, windowsHide: true });
  let tail = '';
  const take = (b: Buffer) => { tail = (tail + b.toString('utf8')).slice(-TAIL_BYTES); };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  const kill = () => {
    if (!child.pid || child.exitCode !== null) return;
    killGroup(child.pid, 'SIGTERM');
    setTimeout(() => { if (child.exitCode === null && child.pid) killGroup(child.pid, 'SIGKILL'); }, 3000).unref();
  };
  if (signal.aborted) kill();
  else signal.addEventListener('abort', kill, { once: true });
  child.once('error', reject);
  child.once('close', (code) => {
    signal.removeEventListener('abort', kill);
    resolve({ code, tail: lastLine(tail) });
  });
});
