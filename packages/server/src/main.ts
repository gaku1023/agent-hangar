import { takeServerEnv } from './launch/env.ts';
import { installShutdown, startServer } from './server.ts';

// 受け渡しの値を読んでから、受け継いだ Claude Code の印と hangar の受け渡しの変数を自分の環境から消す（launch/env.ts）。
// ほかの何よりも先に行う。サーバが起こす tmux サーバと claude は、この環境を継ぐ。
const handoff = takeServerEnv();
const startup = startServer({ port: handoff.port, uiDist: handoff.uiDist });
// 受け口は startServer の解決を待たずに立てる。
// /health は listen した時点で 200 を返し、.app はそれを準備完了の合図にしている。
// 待ってから立てると、その間に届いた SIGTERM が既定の扱いでプロセスを即座に殺し、close() が 1 行も走らない。
const stop = installShutdown(startup);
startup
  .then(() => {
    // Tauri などの親が消えたら自分も終わる。
    const ppid = handoff.parentPid;
    if (ppid) {
      setInterval(() => { try { process.kill(ppid, 0); } catch { stop('parent gone'); } }, 5000).unref();
    }
  })
  .catch((e: unknown) => { console.error(e); process.exit(1); });
