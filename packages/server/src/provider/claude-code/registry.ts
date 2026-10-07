import fs from 'node:fs';
import path from 'node:path';
import type { LiveStatus } from '@agent-hangar/shared';
import { isAlive } from '../../platform/proc.ts';
import type { LiveSession } from '../types.ts';

const STATUSES = new Set<LiveStatus>(['busy', 'idle', 'waiting']);

/**
 * その OS で、pid の登録を「消えたプロセスの残り」と見るかを返す。
 * macOS と Linux の claude は、止められると自分の登録を消すので、残りは見ない（いまの動きを変えない）。
 * Windows には穏やかに止める手段が無く、止められた claude は登録を消せない。動いていない pid の登録は残りと見る。
 * pid が別のプロセスに使い回されると残りを見逃すが、そのときは「動いている」と読むだけで、何も止めない。
 */
export function goneOn(platform: NodeJS.Platform): (pid: number) => boolean {
  return (pid) => platform === 'win32' && pid > 0 && !isAlive(pid);
}

/**
 * ~/.claude/sessions/<pid>.json を読む。ファイルの出現と消失が起動と終了に対応する。
 * isGone が真を返す pid の項目は、消えたプロセスの残りとして読まない。hangar は ~/.claude のファイルを消さないので、読まないことで扱う。
 */
export function readRegistry(claudeDir: string, isGone: (pid: number) => boolean = () => false): LiveSession[] {
  const dir = path.join(claudeDir, 'sessions');
  if (!fs.existsSync(dir)) return [];
  const out: LiveSession[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (typeof rec.sessionId !== 'string') continue;
    if (typeof rec.pid === 'number' && isGone(rec.pid)) continue;
    // shell は、本体が休みで裏の Bash だけが動いていること。作業中のまま、裏だけの印を付ける（LiveAsideDto）。
    // 知らない値は作業中と読む。止めてよいかを誤るより、待たせるほうが害が小さい。
    const status = STATUSES.has(rec.status as LiveStatus) ? (rec.status as LiveStatus) : 'busy';
    const l: LiveSession = { sessionId: rec.sessionId, status, name: typeof rec.name === 'string' ? rec.name : null, nameSource: typeof rec.nameSource === 'string' ? rec.nameSource : null, cwd: typeof rec.cwd === 'string' ? rec.cwd : '', pid: typeof rec.pid === 'number' ? rec.pid : 0 };
    if (rec.status === 'shell') l.aside = { shell: true, agents: 0 };
    // jobId が無いと `claude attach` に渡すものが無いので、bg と書いてあってもバックグラウンドとは扱わない。
    if (rec.kind === 'bg' && typeof rec.jobId === 'string' && rec.jobId !== '') l.background = { jobId: rec.jobId };
    if (typeof rec.procStart === 'string' && rec.procStart !== '') l.procStart = rec.procStart;
    if (typeof rec.entrypoint === 'string' && rec.entrypoint !== '') l.entrypoint = rec.entrypoint;
    out.push(l);
  }
  return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

export class RegistryWatcher {
  private timer: NodeJS.Timeout | null = null;
  private last: LiveSession[] = [];
  private lastKey = '';
  private listeners = new Set<(live: LiveSession[]) => void>();
  constructor(private readonly claudeDir: string, private readonly intervalMs = 500, private readonly isGone: (pid: number) => boolean = goneOn(process.platform)) {}

  start(): void {
    this.poll(false);
    this.timer = setInterval(() => this.poll(true), this.intervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  current(): LiveSession[] { return this.last; }
  onChange(cb: (live: LiveSession[]) => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }

  /**
   * 登録ディレクトリを読み直し、変わっていたら知らせる。
   * 読み取りが失敗しても投げない。setInterval の中なので、投げるとプロセスごと落ちる。
   * 次の周期でやり直せばよい。
   */
  private poll(notify: boolean): void {
    let live: LiveSession[];
    try { live = readRegistry(this.claudeDir, this.isGone); } catch { return; }
    const key = JSON.stringify(live);
    if (key === this.lastKey) return;
    this.last = live; this.lastKey = key;
    if (notify) for (const cb of this.listeners) cb(live);
  }
}
