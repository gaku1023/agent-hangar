import * as pty from 'node-pty';
import { ensureSpawnHelper } from './helper.ts';
import type { PtySpawn } from './relay.ts';

// prebuild の spawn-helper は実行権限が落ちていることがあるので、読み込まれた時点で直しておく。
ensureSpawnHelper();

/** 本物の node-pty。テストでは偽の spawn を渡すので、このファイルはサーバ起動時にだけ読まれる。 */
export const nodePtySpawn: PtySpawn = (file, args, opts) => {
  const p = pty.spawn(file, args, { name: opts.name, cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: opts.env as Record<string, string> });
  return {
    pid: p.pid,
    onData: (cb) => { p.onData(cb); },
    onExit: (cb) => { p.onExit((e) => cb({ exitCode: e.exitCode })); },
    write: (d) => p.write(d),
    resize: (c, r) => p.resize(c, r),
    kill: () => p.kill(),
  };
};
