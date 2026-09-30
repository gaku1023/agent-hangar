// spikes/14-terminal-render/server.mjs
// 描画方式の見比べ用。記録した Claude Code の出力を流し込む表示と、tmux 経由で本物の claude / zsh につなぐ表示を出す。
import express from 'express';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const TMUX = '/opt/homebrew/bin/tmux';
const PORT = Number(process.env.PORT ?? 4191);
const app = express();
app.use(express.static(path.join(here, 'public')));
app.use('/nm', express.static(path.join(here, 'node_modules')));
app.use('/fs', express.static(path.join(here, '../../node_modules/@fontsource-variable/jetbrains-mono')));
const server = app.listen(PORT, '127.0.0.1', () => console.log(`http://127.0.0.1:${PORT}`));

let seq = 0;
const wss = new WebSocketServer({ server, path: '/pty' });
wss.on('connection', (ws, req) => {
  const u = new URL(req.url, 'http://x');
  const cmd = u.searchParams.get('cmd') === 'zsh' ? ['/bin/zsh', '-l'] : ['env', 'HANGAR_NO_WRAP=1', '/Users/satog/.local/bin/claude'];
  const name = `spike14-live-${process.pid}-${++seq}`;
  execFileSync(TMUX, ['new-session', '-d', '-s', name, '-x', '120', '-y', '40', '-c', '/Users/satog/workspace/agent-hangar', ...cmd]);
  execFileSync(TMUX, ['set-option', '-t', name, 'status', 'off']);
  const p = pty.spawn(TMUX, ['attach', '-t', name], { name: 'xterm-256color', cols: 120, rows: 40, cwd: process.env.HOME, env: { ...process.env, TERM: 'xterm-256color', LANG: 'ja_JP.UTF-8' } });
  console.log('open', name);
  p.onData((d) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'data', d })));
  p.onExit(() => ws.close());
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === 'resize') p.resize(m.cols, m.rows);
    else if (m.t === 'data') p.write(m.d);
  });
  ws.on('close', () => {
    console.log('close', name);
    try { p.kill(); } catch {}
    try { execFileSync(TMUX, ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {}
  });
});
