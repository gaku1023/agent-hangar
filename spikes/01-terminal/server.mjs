// spikes/01-terminal/server.mjs
import express from 'express';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.static(path.join(here, 'public')));
app.use('/xterm', express.static(path.join(here, 'node_modules/@xterm/xterm')));
app.use('/fit', express.static(path.join(here, 'node_modules/@xterm/addon-fit')));
const server = app.listen(4190, '127.0.0.1', () => console.log('http://127.0.0.1:4190'));

const wss = new WebSocketServer({ server, path: '/pty' });
wss.on('connection', (ws, req) => {
  const name = new URL(req.url, 'http://x').searchParams.get('session');
  if (!/^spike-[ab]$/.test(name)) return ws.close();
  let p;
  try {
    p = pty.spawn(process.env.HANGAR_TMUX_BIN || 'tmux', ['attach', '-t', name], {
    name: 'xterm-256color', cols: 120, rows: 40,
    env: { ...process.env, TERM: 'xterm-256color', LANG: 'ja_JP.UTF-8' },
  });
  } catch (e) { console.error('spawn failed', e.message); return ws.close(); }
  console.log('attach', name, 'pid', p.pid);
  p.onData((d) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'data', d })));
  p.onExit(() => ws.close());
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === 'resize') p.resize(m.cols, m.rows);
    else if (m.t === 'data') p.write(m.d);
  });
  ws.on('close', () => { console.log('detach', name); p.kill(); });
});
