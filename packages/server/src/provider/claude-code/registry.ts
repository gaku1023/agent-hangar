import fs from 'node:fs';
import path from 'node:path';
import type { LiveStatus } from '@agent-hangar/shared';
import { isAlive } from '../../platform/proc.ts';
import type { LiveSession } from '../types.ts';
import { registryDrifts } from './compat/registry.ts';
import { isRec, NO_COMPAT, type CompatSink, type Drift } from './compat/types.ts';

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
 * onDrift を渡すと、形が契約と違う登録を知らせる（compat/registry.ts）。読み方はいまのまま変えない。
 * オブジェクトでない登録（配列や null）は読まない。1 件の形が崩れても、ほかのセッションの状態は出し続ける。
 */
export function readRegistry(claudeDir: string, isGone: (pid: number) => boolean = () => false, onDrift?: (d: Drift) => void): LiveSession[] {
  const dir = path.join(claudeDir, 'sessions');
  if (!fs.existsSync(dir)) return [];
  const out: LiveSession[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let raw: unknown;
    // 書きかけの登録は JSON として読めない。これはずれではないので、黙って次の周期に回す。
    try { raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (onDrift) for (const d of registryDrifts(raw)) onDrift(d);
    if (!isRec(raw)) continue;
    const rec = raw;
    if (typeof rec.sessionId !== 'string') continue;
    if (typeof rec.pid === 'number' && isGone(rec.pid)) continue;
    // shell は、本体が休みで裏の Bash だけが動いていること。作業中のまま、裏だけの印を付ける（LiveAsideDto）。
    // 知らない値は作業中と読む。止めてよいかを誤るより、待たせるほうが害が小さい。
    const status = STATUSES.has(rec.status as LiveStatus) ? (rec.status as LiveStatus) : 'busy';
    const l: LiveSession = { sessionId: rec.sessionId, status, name: typeof rec.name === 'string' ? rec.name : null, nameSource: typeof rec.nameSource === 'string' ? rec.nameSource : null, cwd: typeof rec.cwd === 'string' ? rec.cwd : '', pid: typeof rec.pid === 'number' ? rec.pid : 0 };
    if (rec.status === 'shell') l.aside = { shell: true, agents: 0 };
    if (typeof rec.statusUpdatedAt === 'number' && Number.isFinite(rec.statusUpdatedAt)) l.statusAt = rec.statusUpdatedAt;
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
  /** 足し付けの前の登録の読み取りとずれの一覧の鍵。ずれを数え直すかを決める。 */
  private lastRegKey = '';
  private listeners = new Set<(live: LiveSession[]) => void>();
  /**
   * enrich は、読んだ登録に裏だけの印などを足す関数（live/aside.ts）。読み直しのたびに通し、足した後の形で変化を見る。
   * 本文の索引が進んだだけでも印は変わるので、登録のファイルが変わらなくても次の周期で知らせられる。
   * compat は、形が契約と違う登録を受け取る口（provider/claude-code/compat/）。
   */
  constructor(private readonly claudeDir: string, private readonly intervalMs = 500, private readonly isGone: (pid: number) => boolean = goneOn(process.platform), private readonly enrich: (live: LiveSession[]) => LiveSession[] = (l) => l, private readonly compat: CompatSink = NO_COMPAT) {}

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
   * ずれは、足し付け（enrich）の前の登録の読み取りと、ずれの一覧が変わったときだけ数える。
   * 500 ミリ秒ごとに同じ登録を読み直すたびに数えると、回数が意味を失う。
   * 足し付けの後の形では見ない。読み飛ばした登録は live に載らず、印だけが変わるときは登録は変わっていないからである。
   */
  private poll(notify: boolean): void {
    let live: LiveSession[];
    const drifts: Drift[] = [];
    let regKey: string;
    try {
      const raw = readRegistry(this.claudeDir, this.isGone, (d) => drifts.push(d));
      regKey = JSON.stringify(raw) + JSON.stringify(drifts);
      live = this.enrich(raw);
    } catch { return; }
    if (regKey !== this.lastRegKey) {
      this.lastRegKey = regKey;
      for (const d of drifts) this.compat.note(d);
    }
    const key = JSON.stringify(live);
    if (key === this.lastKey) return;
    this.last = live; this.lastKey = key;
    if (notify) for (const cb of this.listeners) cb(live);
  }
}
