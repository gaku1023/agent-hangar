import { parseStartTime } from './proc.ts';

/** 同じと分かった pid を読み直すまでの長さ。その間にプロセスが終わり、pid が使い回されることがあるからである。 */
export const PID_REUSE_SAME_TTL_MS = 10 * 60_000;
/** 読めなかった pid を聞き直すまでの長さ。読めないたびに周期ごとに PowerShell を起こさないためである。 */
export const PID_REUSE_RETRY_MS = 60_000;
/** 起動時刻の差をこれまで同じと見る。procStart と読んだ値は、秒に切り下げると 1 秒ずれうる。 */
const SAME_SLACK_MS = 2000;
/** これより長く聞かれなかった答えは捨てる。消えた登録の答えをため続けないためである。 */
const FORGET_MS = 60 * 60_000;

type Verdict = { same: boolean | null; at: number; askedAt: number };

/**
 * pid がいまのプロセスと同じものかを、起動時刻を比べて確かめる（Windows で使う）。
 * 起動時刻を読むには外のプロセスを起こすので、登録を読み直すたびには読まない。
 * 答えが無いものだけを、まとめて裏で読み、答えを覚える。読み終わるまでは使い回しとは決めない（いままでの動き）。
 * 違うと分かったものは、それきり読まない。同じ pid に新しい claude が来れば、procStart が変わり、別のものとして読む。
 * read は pid ごとの起動時刻（parseStartTime で読める書式）を返す。答えに無い pid は、読めなかったものとして扱う。
 */
export class PidReuseCheck {
  private readonly verdicts = new Map<string, Verdict>();
  private readonly want = new Map<string, { pid: number; procStart: string }>();
  private running: Promise<void> | null = null;

  constructor(private readonly read: (pids: number[]) => Promise<Map<number, string>>, private readonly now: () => number = Date.now) {}

  /** pid が procStart の記録とは別のプロセスに使い回されていると分かっていれば true。分からなければ false を返し、要れば裏で読む。 */
  reused(pid: number, procStart: string): boolean {
    if (parseStartTime(procStart) === null) return false;
    const key = `${pid} ${procStart}`;
    const now = this.now();
    const v = this.verdicts.get(key);
    if (v) v.askedAt = now;
    const fresh = v && (v.same === false || now - v.at < (v.same === null ? PID_REUSE_RETRY_MS : PID_REUSE_SAME_TTL_MS));
    if (!fresh) { this.want.set(key, { pid, procStart }); this.pump(); }
    return v?.same === false;
  }

  /** 裏の読み取りが全部終わるのを待つ。試験で使う。 */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  private pump(): void {
    if (this.running || this.want.size === 0) return;
    const batch = [...this.want];
    this.want.clear();
    this.running = this.read([...new Set(batch.map(([, w]) => w.pid))])
      .catch(() => new Map<number, string>())
      .then((times) => {
        const at = this.now();
        for (const [key, w] of batch) {
          const t = times.get(w.pid);
          const a = t === undefined ? null : parseStartTime(t);
          const b = parseStartTime(w.procStart);
          const prev = this.verdicts.get(key);
          this.verdicts.set(key, { same: a === null || b === null ? null : Math.abs(a - b) <= SAME_SLACK_MS, at, askedAt: prev?.askedAt ?? at });
        }
        for (const [key, v] of this.verdicts) if (at - v.askedAt > FORGET_MS) this.verdicts.delete(key);
      })
      .finally(() => { this.running = null; this.pump(); });
  }
}
