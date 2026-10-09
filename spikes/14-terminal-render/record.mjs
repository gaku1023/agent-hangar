// tmux の中で Claude Code を起動し、hangar と同じ経路（tmux attach を node-pty で中継）で出力を記録する。
import pty from 'node-pty';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const TMUX = '/opt/homebrew/bin/tmux', NAME = 'spike14-rec', COLS = 100, ROWS = 32;
// リポジトリの根と、手元の claude の置き場。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLAUDE = path.join(os.homedir(), '.local/bin/claude');
const out = process.argv[2] ?? 'capture.json';
try { execFileSync(TMUX, ['kill-session', '-t', NAME], { stdio: 'ignore' }); } catch {}
execFileSync(TMUX, ['new-session', '-d', '-s', NAME, '-x', String(COLS), '-y', String(ROWS), '-c', ROOT,
  'env', 'HANGAR_NO_WRAP=1', CLAUDE]);
execFileSync(TMUX, ['set-option', '-t', NAME, 'status', 'off']);
const p = pty.spawn(TMUX, ['attach', '-t', NAME], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: process.env.HOME, env: { ...process.env, TERM: 'xterm-256color', LANG: 'ja_JP.UTF-8' } });
const t0 = Date.now(); const chunks = [];
p.onData((d) => chunks.push([Date.now() - t0, d]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(7000);
for (const ch of 'こんにちは、端末の描画テスト ─│█▛▜ 🙂 done') { p.write(ch); await sleep(15); }
await sleep(2000);
p.kill();
try { execFileSync(TMUX, ['kill-session', '-t', NAME], { stdio: 'ignore' }); } catch {}
fs.writeFileSync(out, JSON.stringify({ cols: COLS, rows: ROWS, chunks }));
console.log('chunks', chunks.length, 'bytes', chunks.reduce((n, c) => n + c[1].length, 0));
