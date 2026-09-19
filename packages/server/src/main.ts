import { installShutdown, startServer } from './server.ts';

const port = process.env.HANGAR_PORT ? Number(process.env.HANGAR_PORT) : undefined;
const startup = startServer({ port });
// 受け口は startServer の解決を待たずに立てる。
// /health は listen した時点で 200 を返し、.app はそれを準備完了の合図にしている。
// 待ってから立てると、その間に届いた SIGTERM が既定の扱いでプロセスを即座に殺し、close() が 1 行も走らない。
const stop = installShutdown(startup);
startup
  .then(() => {
    // Tauri などの親が消えたら自分も終わる。
    if (process.env.HANGAR_PARENT_PID) {
      const ppid = Number(process.env.HANGAR_PARENT_PID);
      setInterval(() => { try { process.kill(ppid, 0); } catch { stop(); } }, 5000).unref();
    }
  })
  .catch((e: unknown) => { console.error(e); process.exit(1); });
