import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { stdio: 'ignore' });
const pid = child.pid;
const variants = {
  getProcess: ['-NoProfile', '-NonInteractive', '-Command', `try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc() } catch { exit 1 }`],
  dotnet: ['-NoProfile', '-NonInteractive', '-Command', `try { [System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToFileTimeUtc() } catch { exit 1 }`],
  noop: ['-NoProfile', '-NonInteractive', '-Command', '1'],
};
function time(label, file, args, opts = {}) {
  const t = Date.now();
  const r = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 30000, ...opts });
  const ms = Date.now() - t;
  console.log(`${label}: ${ms}ms status=${r.status} out=${(r.stdout ?? '').trim().slice(0, 30)} err=${(r.stderr ?? '').trim().slice(0, 80)}`);
  return ms;
}
console.log('cpus', os.cpus().length, os.cpus()[0].model, 'node', process.version, os.release());
time('node -e 1 (baseline)', process.execPath, ['-e', '1']);
time('cmd /c ver', 'cmd.exe', ['/c', 'ver']);
for (let i = 0; i < 6; i++) for (const [k, a] of Object.entries(variants)) time(`idle ${k} #${i}`, 'powershell.exe', a);
for (let i = 0; i < 3; i++) time(`idle noop stdin=ignore #${i}`, 'powershell.exe', variants.noop, { stdio: ['ignore', 'pipe', 'pipe'] });
time('idle noop pwsh', 'pwsh.exe', variants.noop);
time('wmic', 'wmic.exe', ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value']);
// load: 4 busy node processes (as many as vitest workers on a 4-core runner)
const busy = [];
for (let i = 0; i < Math.max(4, os.cpus().length); i++) busy.push(spawn(process.execPath, ['-e', 'const e=Date.now()+90000;while(Date.now()<e){}'], { stdio: 'ignore' }));
await new Promise((r) => setTimeout(r, 1500));
for (let i = 0; i < 6; i++) for (const [k, a] of Object.entries(variants)) time(`loaded ${k} #${i}`, 'powershell.exe', a);
for (const b of busy) b.kill();
// fsync
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsync-'));
const buf = Buffer.alloc(200_000, 1);
const lat = [];
for (let i = 0; i < 30; i++) {
  const f = path.join(dir, `f${i}`);
  fs.writeFileSync(f, buf);
  const t = Date.now();
  const fd = fs.openSync(f, 'r+');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(f, f + '.x');
  lat.push(Date.now() - t);
}
console.log('fsync+rename ms', lat.join(','));
child.kill();
process.exit(0);
