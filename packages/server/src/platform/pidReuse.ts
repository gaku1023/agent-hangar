import { parseStartTime } from './proc.ts';

/** 同じと分かった pid を読み直すまでの長さ。その間にプロセスが終わり、pid が使い回されることがあるからである。 */
export const PID_REUSE_SAME_TTL_MS = 10 * 60_000;
/** 分からなかった pid を聞き直すまでの最初の長さ。読めないたびに周期ごとに PowerShell を起こさないためである。 */
export const PID_REUSE_RETRY_MS = 60_000;
/** 読み取りが失敗し続けるときに、聞き直しの間を倍々に延ばす上限。 */
export const PID_REUSE_RETRY_MAX_MS = 15 * 60_000;
/** 起動時刻の差をこれまで同じと見る。procStart と読んだ値は、秒に切り下げると 1 秒ずれうる。 */
const SAME_SLACK_MS = 2000;
/** 時刻帯のずれ（夏時間の 1 時間、30 分の時刻帯）に見える差の刻み。 */
const ZONE_STEP_MS = 30 * 60_000;
/** これより長く聞かれなかった答えは捨てる。消えた登録の答えをため続けないためである。 */
const FORGET_MS = 60 * 60_000;

/** same は、同じなら true、違えば false、分からなければ null。fails は続けて読み取りが失敗した回数。 */
type Verdict = { same: boolean | null; at: number; askedAt: number; fails: number };

/**
 * 2 つの起動時刻を比べる。秒まで同じなら true、違えば false。
 * 差が 30 分の倍数に近いときは、時刻帯の読み違いかもしれないので null（分からない）を返す。
 * 違うと決めた答えはそれきり読み直さないので、誤りを固定しないためである。
 */
function compare(a: number, b: number): boolean | null {
  const diff = Math.abs(a - b);
  if (diff <= SAME_SLACK_MS) return true;
  const off = diff % ZONE_STEP_MS;
  return off <= SAME_SLACK_MS || ZONE_STEP_MS - off <= SAME_SLACK_MS ? null : false;
}

/**
 * pid がいまのプロセスと同じものかを、起動時刻を比べて確かめる（Windows で使う）。
 * 起動時刻を読むには外のプロセスを起こすので、登録を読み直すたびには読まない。
 * 答えが無いものだけを、まとめて裏で読み、答えを覚える。読み終わるまでは使い回しとは決めない（いままでの動き）。
 * 違うと分かったものは、それきり読まない。同じ pid に新しい claude が来れば、procStart が変わり、別のものとして読む。
 * 読み取りが失敗し続けるときは、聞き直しの間を PID_REUSE_RETRY_MS から倍々に延ばし、PID_REUSE_RETRY_MAX_MS で止める。
 * read は pid ごとの起動時刻（parseStartTime で読める書式）を返す。答えに無い pid は、分からなかったものとして扱う。
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
    if (!v || (v.same !== false && now - v.at >= this.wait(v))) { this.want.set(key, { pid, procStart }); this.pump(); }
    return v?.same === false;
  }

  /** 裏の読み取りが全部終わるのを待つ。試験で使う。 */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  /** 答えを読み直すまでの長さ。 */
  private wait(v: Verdict): number {
    if (v.same === true) return PID_REUSE_SAME_TTL_MS;
    return Math.min(PID_REUSE_RETRY_MS * 2 ** Math.max(0, v.fails - 1), PID_REUSE_RETRY_MAX_MS);
  }

  private pump(): void {
    if (this.running || this.want.size === 0) return;
    const batch = [...this.want];
    this.want.clear();
    this.running = this.read([...new Set(batch.map(([, w]) => w.pid))])
      .then((times) => ({ times, ok: true }), () => ({ times: new Map<number, string>(), ok: false }))
      .then(({ times, ok }) => {
        const at = this.now();
        for (const [key, w] of batch) {
          const t = times.get(w.pid);
          const a = t === undefined ? null : parseStartTime(t);
          const b = parseStartTime(w.procStart);
          const prev = this.verdicts.get(key);
          const same = a === null || b === null ? null : compare(a, b);
          this.verdicts.set(key, { same, at, askedAt: prev?.askedAt ?? at, fails: ok ? 0 : (prev?.fails ?? 0) + 1 });
        }
        for (const [key, v] of this.verdicts) if (at - v.askedAt > FORGET_MS) this.verdicts.delete(key);
      })
      .finally(() => { this.running = null; this.pump(); });
  }
}
