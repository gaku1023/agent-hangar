import { execFile, spawnSync } from 'node:child_process';

/** hangar の外で動く claude のプロセスに触る口。テストでは差し替える。 */
export type ProcOps = {
  /** pid の起動時刻。Claude のレジストリの procStart と同じ書式（UTC の ps の lstart）で返す。居なければ null。 */
  startTimeOf(pid: number): string | null;
  /** SIGTERM を送り、終わるまで待つ。timeoutMs のうちに終われば true。 */
  terminate(pid: number, timeoutMs: number): Promise<boolean>;
  /** claude を cwd で走らせ、標準出力を返す。終了コードが 0 でなければ投げる。 */
  runClaude(bin: string, args: string[], cwd: string): Promise<string>;
  /**
   * Claude のバックグラウンドのサービスが知っているセッション。止まったものも含める（`claude agents --json --all`）。
   * 読めなかったときは null。バックグラウンドを使えない Claude Code でも null になる。
   */
  listJobs(bin: string): { id: string; sessionId: string }[] | null;
};

/** 書式の揺れを吸う。ps は 1 桁の日を空白で埋めるので、空白の並びを 1 つにまとめて比べる。 */
export function sameStartTime(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
  return norm(a) === norm(b);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * UTC の ps の lstart（`Thu Oct  2 02:30:05 2026`）を epoch のミリ秒に読む。読めなければ null。
 * Date.parse に任せると、手元の時刻帯で読まれる。秒より細かい精度は持たない。
 */
export function parseProcStart(s: string): number | null {
  const m = /^\w{3} (\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(s.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!);
  const [day, h, min, sec, year] = [m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number];
  if (month < 0 || h > 23 || min > 59 || sec > 59) return null;
  const t = Date.UTC(year, month, day, h, min, sec);
  // 2 月 30 日のような暦に無い日は、Date.UTC が翌月へ繰り越すので見分けられる。
  return new Date(t).getUTCDate() === day ? t : null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM は「居るが触れない」。居ないのは ESRCH だけである。
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const realProcOps: ProcOps = {
  startTimeOf(pid) {
    // Claude は procStart を UTC で書く。手元の時刻帯で読むと、同じプロセスでも時刻がずれる。
    const r = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } });
    const out = (r.stdout ?? '').trim();
    return r.status === 0 && out !== '' ? out : null;
  },
  async terminate(pid, timeoutMs) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return !alive(pid);
    }
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (!alive(pid)) return true;
      await sleep(100);
    }
    return !alive(pid);
  },
  listJobs(bin) {
    const r = spawnSync(bin, ['agents', '--json', '--all'], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) return null;
    return parseJobs(r.stdout ?? '');
  },
  runClaude(bin, args, cwd) {
    return new Promise((resolve, reject) => {
      execFile(bin, args, { cwd, encoding: 'utf8', timeout: 30_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim()));
        else resolve(stdout);
      });
    });
  },
};

/** `claude agents --json` の出力から、バックグラウンドのセッションだけを拾う。対話のセッションも並ぶので kind で分ける。 */
export function parseJobs(out: string): { id: string; sessionId: string }[] | null {
  let rows: unknown;
  try { rows = JSON.parse(out); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  return rows.flatMap((r) => {
    const o = r as Record<string, unknown>;
    return o.kind === 'background' && typeof o.id === 'string' && typeof o.sessionId === 'string' ? [{ id: o.id, sessionId: o.sessionId }] : [];
  });
}

/**
 * `claude --bg` の出力からバックグラウンドの id を拾う。
 * 1 行目が `backgrounded · <id>` または `backgrounded · <id> · <名前>` の形で出る。
 */
export function parseBackgroundedId(out: string): string | null {
  const m = /backgrounded\s*·\s*([0-9a-f]{6,})/.exec(out);
  return m ? m[1]! : null;
}
