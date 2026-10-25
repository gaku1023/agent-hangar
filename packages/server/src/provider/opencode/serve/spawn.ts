import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import { needsShell } from '../../../platform/exec.ts';
import { spawnRun, type ProcRun } from '../../../platform/proc.ts';

/**
 * `opencode serve` を 1 本起こし、認証つきの GET が 200 を返すまで待つ。
 *
 * - 待ち受けは 127.0.0.1 だけにする。
 * - パスワードは起動ごとに 32 バイトの乱数を作り、環境変数 `OPENCODE_SERVER_PASSWORD` で渡す。
 *   argv に載せると `ps` で誰からも読めるので載せない。DB とログにも書かない（持つのはメモリだけ）。
 * - ポートは空きを取って渡し、取ってから渡すまでの間に塞がれて落ちたら取り直す。
 * - macOS と Linux は、プロセスのまとまりの頭として起こす（detached）。止めるときは、serve が起こした子（LSP など）ごとまとまりに信号を送る。
 * - Windows は detached にせず、windowsHide で起こす。標準入出力を 1 つも継がないので、libuv はこれを `CREATE_NO_WINDOW` にし、
 *   serve は見えないコンソールを持つ。serve の上で動く道具（シェル、git など）はそのコンソールを継ぐので、黒い窓を開かない。
 *   detached（`DETACHED_PROCESS`）にするとコンソールが無くなり、道具を起こすたびに新しい窓が開く。
 *   止めるときは taskkill でプロセスの木ごと止める（killGroup）。Windows にはまとまりへの信号が無いからである。
 */

export const SERVE_HOST = '127.0.0.1';
/** basic 認証のユーザー名。opencode 2.x の既定である。 */
export const SERVE_USERNAME = 'opencode';
/** 応答の確かめに使う GET。認証が無ければ 401、あれば 200 を返す。 */
export const READY_PATH = '/api/session/active';

/** 起動に失敗した理由。locked は `database is locked`、port-in-use はポートが塞がっていた。 */
export type ServeStartReason = 'locked' | 'port-in-use' | 'exited' | 'timeout' | 'spawn';

export class ServeStartError extends Error {
  constructor(readonly reason: ServeStartReason, message: string) {
    super(message);
    this.name = 'ServeStartError';
  }
}

/** 起動ごとのパスワード。32 バイトの乱数を base64url で文字にする。 */
export function newServePassword(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function authHeader(password: string): string {
  return `Basic ${Buffer.from(`${SERVE_USERNAME}:${password}`).toString('base64')}`;
}

/** 127.0.0.1 の空きポートを 1 つ取る。閉じてから返すので、渡すまでの間に塞がれることはある（spawn の側で取り直す）。 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, SERVE_HOST, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

const treeKillRun = spawnRun(10_000);

/**
 * serve をプロセスの木ごと止める。送れたら真。もう居なければ偽。
 * macOS と Linux はプロセスのまとまりへ信号を送り、まとまりに送れなければ（まとまりの頭でない）プロセスだけに送る。
 * Windows には SIGTERM もまとまりへの信号も無いので、信号に依らず `taskkill /T /F` で木ごと強制で止める。
 * 穏やかに止める段は、信号の前の interrupt（API）が受け持つ。
 * pid が正の整数でなければ何もしない。0 や負の数を process.kill に渡すと、hangar 自身のまとまりに信号が届くからである。
 */
export function killGroup(pid: number, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform, run: ProcRun = treeKillRun): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (platform === 'win32') {
    if (run('taskkill.exe', ['/PID', String(pid), '/T', '/F']).status === 0) return true;
    // 木の一部を止められなくても、頭が居なくなっていれば止まっている。居続けていれば、呼び手が間をおいて重ねて止める。
    return isProcessAlive(pid);
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // まとまりが無い。下でプロセスだけに送る。
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type ServeProcess = {
  pid: number;
  port: number;
  url: string;
  password: string;
  /** 起こした時刻（エポックのミリ秒）。残った serve の掃除で、pid の使い回しを見分けるのに使う。 */
  startedAt: number;
  child: ChildProcess;
  /** プロセスが終わると解決する。 */
  exited: Promise<void>;
};

export type StartServeOptions = {
  bin: string;
  /** 空の環境（env.ts の serveEnv）。パスワードはここで足す。 */
  env: NodeJS.ProcessEnv;
  pickPort?: () => Promise<number>;
  /** ポートが塞がっていたときに取り直す上限（最初の 1 回を含む）。 */
  portAttempts?: number;
  /** 応答を待つ上限。過ぎたら止めて投げる。 */
  readyTimeoutMs?: number;
  pollMs?: number;
};

const LOCKED = /database is locked/i;
const PORT_IN_USE = /EADDRINUSE|address already in use|Is port \d+ in use/i;
/** 失敗の理由を読むために持つ出力の末尾の長さ。 */
const TAIL_BYTES = 8192;

/** serve を起こし、応答するまで待つ。ポートが塞がっていたら取り直す。ほかの失敗は ServeStartError で投げる。 */
export async function startServe(o: StartServeOptions): Promise<ServeProcess> {
  const password = newServePassword();
  const attempts = o.portAttempts ?? 5;
  for (let i = 0; ; i++) {
    const port = await (o.pickPort ?? pickFreePort)();
    try {
      return await launchOnce(o, port, password);
    } catch (e) {
      if (e instanceof ServeStartError && e.reason === 'port-in-use' && i + 1 < attempts) continue;
      throw e;
    }
  }
}

async function launchOnce(o: StartServeOptions, port: number, password: string): Promise<ServeProcess> {
  const url = `http://${SERVE_HOST}:${port}`;
  const startedAt = Date.now();
  // .cmd と .bat は cmd.exe 越しにしか起こせない。npm の包みは findOpencode が指す先の .exe に読み替えるので、ここに来るのはそれ以外の包みである。
  // cmd.exe には引数を引用せずにつないで渡すが、渡すのは決まった語とポートの数だけなので崩れない。場所は空白を含みうるので引用で包む。
  const viaShell = needsShell(o.bin);
  const child = spawn(viaShell ? `"${o.bin}"` : o.bin, ['serve', '--hostname', SERVE_HOST, '--port', String(port)], {
    env: { ...o.env, OPENCODE_SERVER_PASSWORD: password },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
    shell: viaShell,
  });
  // 出力は読み続ける（読まないとパイプが詰まって serve が止まる）。失敗の理由を見るために末尾だけ持つ。
  let tail = '';
  const keep = (b: Buffer): void => { tail = (tail + b.toString('utf8')).slice(-TAIL_BYTES); };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  let gone = false;
  let spawnError: Error | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => { gone = true; resolve(); });
    child.once('error', (e) => {
      spawnError = e;
      // 起こせなかったときは exit が来ないことがある。
      if (child.pid === undefined) { gone = true; resolve(); }
    });
  });
  // パスワードが出力に混じっていても、投げる文には載せない。
  const why = (): string => tail.split(password).join('***').trim().slice(-500);
  const pollMs = o.pollMs ?? 100;
  const deadline = Date.now() + (o.readyTimeoutMs ?? 20_000);
  for (;;) {
    if (gone) {
      if (spawnError) throw new ServeStartError('spawn', `opencode serve could not start: ${(spawnError as Error).message}`);
      const out = why();
      const reason: ServeStartReason = LOCKED.test(out) ? 'locked' : PORT_IN_USE.test(out) ? 'port-in-use' : 'exited';
      throw new ServeStartError(reason, `opencode serve exited before it answered (${reason}): ${out}`);
    }
    if (Date.now() > deadline) {
      if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL');
      await exited;
      throw new ServeStartError('timeout', `opencode serve did not answer within the time limit: ${why()}`);
    }
    try {
      const r = await fetch(url + READY_PATH, { headers: { authorization: authHeader(password) }, signal: AbortSignal.timeout(1000) });
      await r.arrayBuffer().catch(() => undefined);
      if (r.status === 200 && child.pid !== undefined && !gone) return { pid: child.pid, port, url, password, startedAt, child, exited };
    } catch {
      // まだ待ち受けていない。
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, pollMs))]);
  }
}
