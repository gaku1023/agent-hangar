import * as pty from 'node-pty';
import { createPtyCloser } from './close.ts';
import { ensureSpawnHelper } from './helper.ts';
import type { PtySpawn } from './relay.ts';

// prebuild の spawn-helper は実行権限が落ちていることがあるので、読み込まれた時点で直しておく。
ensureSpawnHelper();

/** 本物の node-pty。テストでは偽の spawn を渡すので、このファイルはサーバ起動時にだけ読まれる。 */
export const nodePtySpawn: PtySpawn = (file, args, opts) => {
  const p = pty.spawn(file, args, { name: opts.name, cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: opts.env as Record<string, string> });
  // Windows の kill は node-pty の補助のプロセスが "AttachConsole failed" を出す競合を持つので、閉じ方を close.ts に任せる。
  // node-pty 1.2 の Windows の pid は、子を pseudoconsole につないだ後で決まる。spawn の直後に写さず、閉じる時に読む。
  const closer = createPtyCloser({ pid: () => p.pid, hardKill: () => p.kill(), killPid: (pid) => process.kill(pid) });
  p.onExit(() => closer.markExited());
  return {
    get pid() { return p.pid; },
    onData: (cb) => { p.onData(cb); },
    onExit: (cb) => { p.onExit((e) => cb({ exitCode: e.exitCode })); },
    write: (d) => p.write(d),
    // 子が終わった後の resize は投げる（Unix は ioctl の EBADF、Windows は "Cannot resize a pty that has already exited"）。
    // 大きさの知らせは WebSocket の受け口から届くので、投げるとサーバごと落ちる。終わった端末の大きさは要らないので捨てる。
    resize: (c, r) => { try { p.resize(c, r); } catch { /* 終わっている */ } },
    kill: () => closer.close(),
  };
};
