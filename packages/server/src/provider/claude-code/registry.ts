import fs from 'node:fs';
import path from 'node:path';
import type { LiveStatus } from '@agent-hangar/shared';
import type { LiveSession } from '../types.ts';

const STATUSES = new Set<LiveStatus>(['busy', 'idle', 'waiting']);

/** ~/.claude/sessions/<pid>.json を読む。ファイルの出現と消失が起動と終了に対応する。 */
export function readRegistry(claudeDir: string): LiveSession[] {
  const dir = path.join(claudeDir, 'sessions');
  if (!fs.existsSync(dir)) return [];
  const out: LiveSession[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (typeof rec.sessionId !== 'string') continue;
    const status = STATUSES.has(rec.status as LiveStatus) ? (rec.status as LiveStatus) : 'busy';
    out.push({ sessionId: rec.sessionId, status, name: typeof rec.name === 'string' ? rec.name : null, nameSource: typeof rec.nameSource === 'string' ? rec.nameSource : null, cwd: typeof rec.cwd === 'string' ? rec.cwd : '', pid: typeof rec.pid === 'number' ? rec.pid : 0 });
  }
  return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

export class RegistryWatcher {
  private timer: NodeJS.Timeout | null = null;
  private last: LiveSession[] = [];
  private lastKey = '';
  private listeners = new Set<(live: LiveSession[]) => void>();
  constructor(private readonly claudeDir: string, private readonly intervalMs = 500) {}

  start(): void {
    this.poll(false);
    this.timer = setInterval(() => this.poll(true), this.intervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  current(): LiveSession[] { return this.last; }
  onChange(cb: (live: LiveSession[]) => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }

  private poll(notify: boolean): void {
    const live = readRegistry(this.claudeDir);
    const key = JSON.stringify(live);
    if (key === this.lastKey) return;
    this.last = live; this.lastKey = key;
    if (notify) for (const cb of this.listeners) cb(live);
  }
}
