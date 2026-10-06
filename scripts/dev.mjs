#!/usr/bin/env node
// サーバと UI の開発用サーバを並べて起こす。片方が終わったら、もう片方も止めて同じ終了コードで終わる。
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = ['packages/server', 'packages/ui'].map((ws) =>
  spawn(npm, ['run', 'dev', '--workspace', ws], { stdio: 'inherit', shell: process.platform === 'win32' }),
);
let done = false;
const stopAll = (code) => {
  if (done) return;
  done = true;
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exitCode = code ?? 0;
};
for (const c of children) c.on('exit', (code) => stopAll(code));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stopAll(0));
