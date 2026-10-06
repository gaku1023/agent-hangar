import { spawnSync } from 'node:child_process';

// hangar の外で動くプロセスの見分け方と止め方。
// Claude Code は ~/.claude/sessions/<pid>.json に procStart を書く。PID は使い回されるので、起動時刻が合うことで同じプロセスだと確かめる。
// macOS と Linux の procStart は UTC の ps の lstart（Thu Oct  2 02:30:05 2026）、
// Windows は 1601 年からの 100 ナノ秒単位の整数（134354040350009738）である。

export type ProcRun = (file: string, args: string[], env?: NodeJS.ProcessEnv) => { status: number | null; stdout: string };

const realRun: ProcRun = (file, args, env) => {
  const r = spawnSync(file, args, { encoding: 'utf8', env: env ?? process.env, windowsHide: true, timeout: 10_000 });
  return { status: r.status, stdout: r.stdout ?? '' };
};

const validPid = (pid: number): boolean => Number.isInteger(pid) && pid > 0;

/** pid の起動時刻を、Claude の procStart と同じ書式で返す。居なければ null。 */
export function startTimeOf(pid: number, platform: NodeJS.Platform = process.platform, run: ProcRun = realRun): string | null {
  // pid はコマンドの文に埋めるので、整数であることを先に確かめる。
  if (!validPid(pid)) return null;
  if (platform === 'win32') {
    const script = `try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc() } catch { exit 1 }`;
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const out = r.stdout.trim();
    return r.status === 0 && /^\d+$/.test(out) ? out : null;
  }
  // Claude は procStart を UTC で書く。手元の時刻帯で読むと、同じプロセスでも時刻がずれる。
  const r = run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { ...process.env, TZ: 'UTC', LC_ALL: 'C' });
  const out = r.stdout.trim();
  return r.status === 0 && out !== '' ? out : null;
}

/** 書式の揺れを吸う。ps は 1 桁の日を空白で埋めるので、空白の並びを 1 つにまとめて比べる。 */
export function sameStartTime(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
  return norm(a) === norm(b);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 1601-01-01 から 1970-01-01 までのミリ秒。 */
const FILETIME_EPOCH_MS = 11_644_473_600_000n;

/** 起動時刻を epoch のミリ秒に読む。読めなければ null。秒より細かい精度は持たない。 */
export function parseStartTime(s: string): number | null {
  const t = s.trim();
  // 17 桁から 19 桁の整数は Windows の書式。1970 年より後なら 17 桁以上になる。
  if (/^\d{17,19}$/.test(t)) {
    const ms = BigInt(t) / 10_000n - FILETIME_EPOCH_MS;
    return Number(ms - (ms % 1000n));
  }
  const m = /^\w{3} (\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(t);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!);
  const [day, h, min, sec, year] = [m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number];
  if (month < 0 || h > 23 || min > 59 || sec > 59) return null;
  const at = Date.UTC(year, month, day, h, min, sec);
  // 2 月 30 日のような暦に無い日は、Date.UTC が翌月へ繰り越すので見分けられる。
  return new Date(at).getUTCDate() === day ? at : null;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM は「居るが触れない」。居ないのは ESRCH だけである。
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 止めて、終わるまで待つ。timeoutMs のうちに終われば true。
 * macOS と Linux は SIGTERM を送る。Windows には SIGTERM が無いので、taskkill でプロセスの木ごと止める。
 */
export async function terminate(pid: number, timeoutMs: number, platform: NodeJS.Platform = process.platform, run: ProcRun = realRun): Promise<boolean> {
  if (!validPid(pid)) return false;
  if (platform === 'win32') {
    run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return !isAlive(pid);
    }
  }
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }
  return !isAlive(pid);
}
