import { startServer } from './server.ts';

const port = process.env.HANGAR_PORT ? Number(process.env.HANGAR_PORT) : undefined;
startServer({ port }).then((s) => {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // 接続の後始末が終わらなくても 3 秒で終了する。
    setTimeout(() => process.exit(0), 3000).unref();
    s.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // Tauri などの親が消えたら自分も終わる。
  if (process.env.HANGAR_PARENT_PID) {
    const ppid = Number(process.env.HANGAR_PARENT_PID);
    setInterval(() => { try { process.kill(ppid, 0); } catch { stop(); } }, 5000).unref();
  }
}).catch((e) => { console.error(e); process.exit(1); });
