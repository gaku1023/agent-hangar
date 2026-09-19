#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/index.ts');
const child = spawn(process.execPath, ['--import', 'tsx', entry, ...process.argv.slice(2)], { stdio: 'inherit' });

// spawnSync だと、この包みが止まっているあいだ signal を受けられず、
// 包みの PID を kill してもサーバ本体が生き残ってポートを掴み続ける。
// 端末からの Ctrl-C は process group に届くので気付きにくい（実物確認で見つかった）。
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { if (child.exitCode === null && child.signalCode === null) child.kill(sig); });
}
child.on('exit', (code, signal) => {
  // 子が signal で死んだら、同じ signal で自分も死ぬ（呼び手が理由を見分けられるように）。
  if (signal) { process.kill(process.pid, signal); return; }
  process.exit(code ?? 1);
});
child.on('error', (e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
