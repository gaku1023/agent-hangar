#!/usr/bin/env node
// 開発用のサーバを起こす。HANGAR_DEV=1 を立てて tsx watch に渡す（http/auth.ts の devMode が読む）。
import { spawn } from 'node:child_process';

const child = spawn('tsx', ['watch', 'src/main.ts'], { stdio: 'inherit', env: { ...process.env, HANGAR_DEV: '1' }, shell: process.platform === 'win32' });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (child.exitCode === null) child.kill(sig); });
