import fs from 'node:fs';
import path from 'node:path';
import type { Settings } from './paths.ts';

const KNOWN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

/** 子プロセスを起こさずにコマンドの絶対パスを探す。GUI 起動の貧弱な PATH でも Homebrew を見る。 */
export function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = [...(env.PATH ?? '').split(':').filter(Boolean), ...KNOWN_DIRS];
  for (const d of dirs) {
    const p = path.join(d, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* 次へ */ }
  }
  return null;
}

/** 設定に無いツールのパスを探して埋める。既に入っている値は変えない。 */
export function resolveToolPaths(s: Settings, whichFn: (cmd: string) => string | null = which): Settings {
  return { ...s, tmuxPath: s.tmuxPath ?? whichFn('tmux'), codePath: s.codePath ?? whichFn('code') };
}
