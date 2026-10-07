import { execFile, spawnSync } from 'node:child_process';
import { parseStartTime, sameStartTime, startTimeOf, terminate } from '../platform/proc.ts';

/** hangar の外で動く claude のプロセスに触る口。テストでは差し替える。 */
export type ProcOps = {
  /** pid の起動時刻。Claude のレジストリの procStart と同じ書式で返す（macOS と Linux は UTC の ps の lstart、Windows は 100 ナノ秒単位の整数）。居なければ null。 */
  startTimeOf(pid: number): string | null;
  /** 止めて、終わるまで待つ。timeoutMs のうちに終われば true。 */
  terminate(pid: number, timeoutMs: number): Promise<boolean>;
  /** claude を cwd で走らせ、標準出力を返す。終了コードが 0 でなければ投げる。 */
  runClaude(bin: string, args: string[], cwd: string): Promise<string>;
  /**
   * Claude のバックグラウンドのサービスが知っているセッション。止まったものも含める（`claude agents --json --all`）。
   * 読めなかったときは null。バックグラウンドを使えない Claude Code でも null になる。
   */
  listJobs(bin: string): { id: string; sessionId: string }[] | null;
};

export { sameStartTime };
/** Claude の procStart を epoch のミリ秒に読む。読めなければ null。 */
export const parseProcStart = parseStartTime;

export const realProcOps: ProcOps = {
  startTimeOf: (pid) => startTimeOf(pid),
  terminate: (pid, timeoutMs) => terminate(pid, timeoutMs),
  listJobs(bin) {
    // 起こせない相手（Windows の .cmd など）で spawnSync が投げても、読めなかったことにして返す。
    try {
      const r = spawnSync(bin, ['agents', '--json', '--all'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (r.status !== 0) return null;
      return parseJobs(r.stdout ?? '');
    } catch {
      return null;
    }
  },
  runClaude(bin, args, cwd) {
    return new Promise((resolve, reject) => {
      execFile(bin, args, { cwd, encoding: 'utf8', timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
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
