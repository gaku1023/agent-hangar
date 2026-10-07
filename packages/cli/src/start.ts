import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oneLineError, probeReady, startErrorMessage } from './probe.ts';

/**
 * この CLI のファイルの置き場。
 * 配布版では esbuild が CLI を cli.mjs 1 本にまとめるので、ここは cli.mjs の置き場になる。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 起動が済んだかを見に行く間隔。 */
const READY_POLL_MS = 200;

/**
 * サーバを起こす node の引数。
 * 配布版は cli.mjs の隣の server.mjs を起こす。bundle-server が 2 つを同じ置き場へ出すので、隣に必ずある。
 * リポジトリでは packages/server/src/main.ts を tsx で起こす（bin/hangar.mjs が CLI を起こすのと同じ形）。
 * CLI がサーバのコードを import しないのは、cli.mjs にサーバを二重に束ねないためである。
 */
export function serverArgs(here: string = HERE): string[] {
  const bundled = path.join(here, 'server.mjs');
  if (fs.existsSync(bundled)) return [bundled];
  return ['--import', 'tsx', path.resolve(here, '../../server/src/main.ts')];
}

/**
 * そのポートを自分で一度だけ開いて閉じる。
 * 開けなければ、その失敗（EADDRINUSE など）をそのまま投げる。
 * サーバは子プロセスなので、子が待ち受けに転ぶと端末に出るのは子の生のスタックになる。
 * よくある失敗は、子を起こす前にここで拾って日本語の 1 行にする。
 */
export function assertPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => s.close(() => resolve()));
  });
}

export type StartOptions = {
  port: number;
  /** 起動が済んだときに 1 度だけ呼ぶ。鍵付きの URL の印字とブラウザを開くことは呼び手が持つ。 */
  onReady: () => void;
  /** 子の node に渡す引数。試験が差し替える。既定は serverArgs()。 */
  args?: string[];
};

/**
 * サーバを子プロセスで起こし、起動が済んだら onReady を呼ぶ。
 * 子が終わるまで戻らず、CLI の終了コードにする数を返す。
 * .app の殻（server.rs の spawn_server）と同じく、HANGAR_PORT と HANGAR_PARENT_PID を渡す。
 * HANGAR_PARENT_PID があるので、CLI が強制終了されても、子は main.ts の見張りで自分から降りる。
 */
export async function runStart(o: StartOptions): Promise<number> {
  // 0 を渡すと子は空いているポートを自分で選ぶが、CLI はその番号を知る手が無く、起動を待ち続けてしまう。
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) {
    console.error('ポートは 1 から 65535 の整数で指定してください。');
    return 1;
  }
  try {
    await assertPortFree(o.port);
  } catch (e) {
    console.error(startErrorMessage(e, o.port));
    return 1;
  }
  const child = spawn(process.execPath, o.args ?? serverArgs(), {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, HANGAR_PORT: String(o.port), HANGAR_PARENT_PID: String(process.pid) },
  });
  let gone = false;
  const exited = new Promise<number>((resolve) => {
    child.on('exit', (code) => {
      gone = true;
      resolve(code ?? 1);
    });
    child.on('error', (e) => {
      gone = true;
      console.error(`サーバを起動できませんでした: ${oneLineError(e)}`);
      resolve(1);
    });
  });
  // 端末の Ctrl-C は process group に届くので子にも直に届くが、kill で CLI だけに送られた信号は子へ渡す。
  // サーバの installShutdown は 2 度目の信号を無視するので、重なっても構わない。
  const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((sig) => [sig, (): void => { if (!gone) child.kill(sig); }] as const);
  for (const [sig, h] of handlers) process.on(sig, h);
  try {
    let ready = false;
    while (!gone && !ready) {
      ready = await probeReady(o.port);
      if (!ready) await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    if (ready) o.onReady();
    else console.error('サーバが起動の途中で終わりました。上に出た子のログを見てください。');
    return await exited;
  } finally {
    for (const [sig, h] of handlers) process.off(sig, h);
  }
}
