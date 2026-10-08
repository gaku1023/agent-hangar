import { spawnSync } from 'node:child_process';

// hangar の外で動くプロセスの見分け方と止め方。
// Claude Code は ~/.claude/sessions/<pid>.json に procStart を書く。PID は使い回されるので、起動時刻が合うことで同じプロセスだと確かめる。
// macOS と Linux の procStart は UTC の ps の lstart（Thu Oct  2 02:30:05 2026）、
// Windows は 1601 年からの 100 ナノ秒単位の整数（134354040350009738）である。

/**
 * 外のコマンドを 1 回打った結果。status は締め切りで止められたときと、起こせなかったときに null になる。
 * timedOut は締め切りで止められたこと。stderr は読めなかった理由を残すためだけに使う。
 */
export type ProcRunResult = { status: number | null; stdout: string; stderr?: string; timedOut?: boolean };
export type ProcRun = (file: string, args: string[], env?: NodeJS.ProcessEnv) => ProcRunResult;

/** timeoutMs を過ぎたら止める本物の実行。締め切りで止めたかは、spawnSync の ETIMEDOUT で見分ける。 */
export function spawnRun(timeoutMs: number): ProcRun {
  return (file, args, env) => {
    const r = spawnSync(file, args, { encoding: 'utf8', env: env ?? process.env, windowsHide: true, timeout: timeoutMs });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' };
  };
}

const realRun = spawnRun(10_000);

const validPid = (pid: number): boolean => Number.isInteger(pid) && pid > 0;

/** 起動時刻を読んだ 1 回の記録。読めなかったときに、なぜ読めなかったかを後から見られるようにする。 */
export type StartTimeTry = { status: number | null; timedOut: boolean; stdout: string; stderr: string; ms: number };
export type StartTimeProbe = { value: string | null; tries: StartTimeTry[] };

/** 締め切りで止められたときに、最初の 1 回を含めて何回まで聞くか。 */
const START_TIME_TRIES = 2;

/**
 * pid の起動時刻を読み、読んだ経過も返す。value は startTimeOf と同じ。
 * 締め切りで止められたときだけ、同じ問いでもう 1 度だけ聞く。
 * CI の Windows では、PowerShell が 10 秒の締め切りを越えて止められ、生きているプロセスが居ないことになった（2026-10-07、08）。
 * 同じ時に並んで走った別の読み取りが数秒で終わっていた回もあったので、止められた 1 回は外れ値と見て、締め切りを延ばすより聞き直す。
 * 居ない（終了コード 1）、読めない答えが返った、起こせなかった、は聞き直しても変わらないので、そのまま null にする。
 */
export function probeStartTime(pid: number, platform: NodeJS.Platform = process.platform, run: ProcRun = realRun): StartTimeProbe {
  const tries: StartTimeTry[] = [];
  // pid はコマンドの文に埋めるので、整数であることを先に確かめる。
  if (!validPid(pid)) return { value: null, tries };
  for (let i = 0; i < START_TIME_TRIES; i++) {
    const at = Date.now();
    const r = platform === 'win32'
      ? run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc() } catch { exit 1 }`])
      // Claude は procStart を UTC で書く。手元の時刻帯で読むと、同じプロセスでも時刻がずれる。
      : run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { ...process.env, TZ: 'UTC', LC_ALL: 'C' });
    const out = r.stdout.trim();
    tries.push({ status: r.status, timedOut: r.timedOut === true, stdout: out.slice(0, 200), stderr: (r.stderr ?? '').trim().slice(0, 500), ms: Date.now() - at });
    if (r.status === 0 && (platform === 'win32' ? /^\d+$/.test(out) : out !== '')) return { value: out, tries };
    if (r.timedOut !== true) break;
  }
  return { value: null, tries };
}

/** pid の起動時刻を、Claude の procStart と同じ書式で返す。居なければ null。 */
export function startTimeOf(pid: number, platform: NodeJS.Platform = process.platform, run: ProcRun = realRun): string | null {
  const { value, tries } = probeStartTime(pid, platform, run);
  // 1 回で読めたときと、居ないと静かに答えたときのほかは、次に読めなかったときに理由が分かるよう経過を残す。
  const usual = value !== null ? tries.length === 1 : tries.every((t) => t.status === 1 && t.stderr === '');
  if (!usual) console.warn(`[proc] pid ${pid} の起動時刻を${value === null ? '読めませんでした' : '聞き直して読めました'}`, JSON.stringify(tries));
  return value;
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
