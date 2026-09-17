// spikes/03-registry/watch.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = path.join(os.homedir(), '.claude', 'sessions');
let prev = new Map();
function snapshot() {
  const now = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try { now.set(f, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch {}
  }
  return now;
}
setInterval(() => {
  const now = snapshot();
  const t = new Date().toISOString();
  for (const [f, d] of now) {
    const p = prev.get(f);
    if (!p) console.log(t, 'APPEAR', f, d.sessionId, d.cwd, d.status, d.name, d.nameSource);
    else if (p.status !== d.status) console.log(t, 'STATUS', f, d.name, p.status, '->', d.status);
    else if (p.name !== d.name) console.log(t, 'NAME', f, p.name, '->', d.name, d.nameSource);
  }
  for (const f of prev.keys()) if (!now.has(f)) console.log(t, 'GONE', f);
  prev = now;
}, 500);
