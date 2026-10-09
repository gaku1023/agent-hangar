import { installShutdown } from './server.ts';

type Started = { close(): Promise<void> };

export type MainDeps = {
  /** サーバを起こす。入口（main.ts）は startServer を渡す。 */
  start: () => Promise<Started>;
  /** Tauri などの親の pid。あれば、親が消えたときに自分も終わる。 */
  parentPid?: number;
  /** 以下は試験が差し替える。既定は process と console である。 */
  exit?: (code: number) => void;
  error?: (e: unknown) => void;
  shutdown?: Parameters<typeof installShutdown>[1];
};

/**
 * サーバのプロセスの入口の本体。起こし、止める受け口を立て、起動が転んだら理由を出して終了コード 1 で終わる。
 * DB の控えが取れないとき（DbBackupError）と、起点より古い版の DB のとき（DbTooOldError）は、ここで文が出てプロセスが止まる。
 * main.ts から切り出したのは、この「理由を出して 1 で終わる」を、子プロセスを起こさずに試験で確かめるためである。
 */
export function runMain(d: MainDeps): Promise<void> {
  const exit = d.exit ?? ((code: number) => process.exit(code));
  const error = d.error ?? ((e: unknown) => console.error(e));
  const startup = d.start();
  // 受け口は起動の解決を待たずに立てる。
  // /health は listen した時点で 200 を返し、.app はそれを準備完了の合図にしている。
  // 待ってから立てると、その間に届いた SIGTERM が既定の扱いでプロセスを即座に殺し、close() が 1 行も走らない。
  const stop = installShutdown(startup, d.shutdown);
  return startup
    .then(() => {
      // Tauri などの親が消えたら自分も終わる。
      const ppid = d.parentPid;
      if (ppid) {
        setInterval(() => { try { process.kill(ppid, 0); } catch { stop('parent gone'); } }, 5000).unref();
      }
    })
    .catch((e: unknown) => { error(e); exit(1); });
}
