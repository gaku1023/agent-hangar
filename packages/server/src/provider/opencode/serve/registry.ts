import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { killGroup } from './spawn.ts';

/**
 * hangar が起こした serve の記録（pid、ポート、起こした時刻）。
 *
 * hangar が落ちても serve は残る（プロセスのまとまりを分けて起こすので、親が死んでも道連れにならない）。
 * 1 本あたり 160〜260MB を握るので、次に hangar が起きたときに、この記録から残った serve を探して止める。
 * パスワードは書かない。
 */

export type ServeRecord = { sessionId: string; pid: number; port: number; startedAt: number };

export function serveRegistryPath(home: string): string {
  return path.join(home, 'opencode', 'serves.json');
}

const isRecord = (v: unknown): v is ServeRecord => {
  const r = v as Partial<ServeRecord> | null;
  return typeof r === 'object' && r !== null && typeof r.sessionId === 'string' && Number.isInteger(r.pid) && Number.isInteger(r.port) && typeof r.startedAt === 'number';
};

export class ServeRegistry {
  constructor(readonly file: string) {}

  /** 記録を読む。無い、壊れている、形の違う行は、無いものとして読む。 */
  list(): ServeRecord[] {
    try {
      const v: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(v) ? v.filter(isRecord) : [];
    } catch {
      return [];
    }
  }

  add(r: ServeRecord): void {
    this.write([...this.list().filter((x) => x.pid !== r.pid), r]);
  }

  remove(pid: number): void {
    const now = this.list();
    const next = now.filter((x) => x.pid !== pid);
    if (next.length !== now.length) this.write(next);
  }

  /** 同じディレクトリに書いてから rename する。途中で落ちても元の記録が壊れない。 */
  private write(rows: ServeRecord[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(rows)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

/** プロセスがまだ居るか。信号 0 は届くかだけを見る。権限が無くて断られたときも、居るものとして扱う。 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** pid のいまのプロセスの、起きてからの時間とコマンド行。居なければ null。 */
export type ProcessProbe = (pid: number) => { elapsedMs: number; command: string } | null;

/**
 * ps で見る。`etime` は `[[dd-]hh:]mm:ss` の形で、macOS と Linux のどちらでも使える（`etimes` は macOS に無い）。
 */
export const psProbe: ProcessProbe = (pid) => {
  try {
    const out = execFileSync('ps', ['-o', 'etime=,command=', '-p', String(pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s+(.*)$/.exec(out);
    if (!m) return null;
    const [, d, h, mi, s, command] = m;
    const sec = Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(s);
    return { elapsedMs: sec * 1000, command: command ?? '' };
  } catch {
    return null;
  }
};

/** 起こした時刻と、ps から逆算した起動の時刻の、許すずれ。etime は秒の刻みなので、数秒の幅を持たせる。 */
const START_TOLERANCE_MS = 10_000;

/**
 * 記録の行のプロセスが、いまも hangar の起こした serve か。
 * pid は使い回されるので、コマンド行（serve と、記録したポート）と、起動の時刻の両方が合うときだけ真にする。
 */
export function isOurServe(r: ServeRecord, probe: ProcessProbe = psProbe, now: number = Date.now()): boolean {
  const p = probe(r.pid);
  if (!p) return false;
  const args = p.command.split(/\s+/);
  const portAt = args.indexOf('--port');
  if (!args.includes('serve') || portAt < 0 || args[portAt + 1] !== String(r.port)) return false;
  return Math.abs(now - p.elapsedMs - r.startedAt) <= START_TOLERANCE_MS;
}

export type SweepOptions = {
  probe?: ProcessProbe;
  /** SIGTERM から SIGKILL までの間。 */
  graceMs?: number;
  log?: (line: string) => void;
};

/**
 * 前の hangar が残した serve を止め、記録を空にする。
 * 合言葉を持っていないので interrupt は送れない。SIGTERM を送り、間をおいて残っていれば SIGKILL で止める。
 * hangar の起こした serve と見分けられないプロセスには触らず、記録から消すだけにする。
 */
export async function sweepLeftoverServes(reg: ServeRegistry, o: SweepOptions = {}): Promise<{ stopped: number[] }> {
  const rows = reg.list();
  const ours = rows.filter((r) => isOurServe(r, o.probe));
  for (const r of ours) killGroup(r.pid, 'SIGTERM');
  const graceMs = o.graceMs ?? 3000;
  const deadline = Date.now() + graceMs;
  while (ours.some((r) => isAlive(r.pid)) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  for (const r of ours) if (isAlive(r.pid)) killGroup(r.pid, 'SIGKILL');
  for (const r of rows) reg.remove(r.pid);
  if (ours.length > 0) o.log?.(`[opencode] stopped ${ours.length} serve process(es) left by the previous run`);
  return { stopped: ours.map((r) => r.pid) };
}
