import { describe, expect, it } from 'vitest';
import { PID_REUSE_RETRY_MAX_MS, PID_REUSE_RETRY_MS, PID_REUSE_SAME_TTL_MS, PidReuseCheck } from './pidReuse.ts';

// 2026-11-09 に Windows で読んだ claude の起動時刻（1601 年からの 100 ナノ秒単位）。
const CLAUDE = '134386859555901477';
// CIM の CreationDate はマイクロ秒までなので、末尾の桁が違って返る。
const CLAUDE_CIM = '134386859555901470';
// 同じ pid を使い回した別のプロセス（svchost など）の起動時刻。
const OTHER = '134384380048831560';

/** 呼ばれた pid を記録し、answer の答えを返す偽の読み取り。 */
function fakeRead(answer: (pids: number[]) => Map<number, string> | Error) {
  const calls: number[][] = [];
  const read = async (pids: number[]) => {
    calls.push(pids);
    const a = answer(pids);
    if (a instanceof Error) throw a;
    return a;
  };
  return { calls, read };
}

describe('PidReuseCheck', () => {
  it('まだ読んでいなければ使い回しとは決めず、裏で読む。起動時刻が違えば、次からは使い回しと答える', async () => {
    const f = fakeRead(() => new Map([[12156, OTHER]]));
    const c = new PidReuseCheck(f.read);
    expect(c.reused(12156, CLAUDE)).toBe(false);
    await c.settled();
    expect(c.reused(12156, CLAUDE)).toBe(true);
    // 違うと分かったものは読み直さない。
    expect(f.calls).toEqual([[12156]]);
  });

  it('起動時刻が秒まで同じなら使い回しではない', async () => {
    const f = fakeRead(() => new Map([[12156, CLAUDE_CIM]]));
    const c = new PidReuseCheck(f.read);
    c.reused(12156, CLAUDE);
    await c.settled();
    expect(c.reused(12156, CLAUDE)).toBe(false);
  });

  it('同じ周期で聞かれた pid は、1 回の読み取りにまとめる', async () => {
    const f = fakeRead((pids) => new Map(pids.map((p) => [p, CLAUDE_CIM] as const)));
    const c = new PidReuseCheck(f.read);
    c.reused(1, CLAUDE);
    c.reused(2, CLAUDE);
    await c.settled();
    // 1 つ目の読み取りの間に聞かれた 2 つ目は、読み終わってから続けて読む。
    expect(f.calls.flat().sort()).toEqual([1, 2]);
    expect(c.reused(1, CLAUDE)).toBe(false);
    expect(c.reused(2, CLAUDE)).toBe(false);
  });

  it('同じと分かったものも、しばらくしたら読み直す。読み直しの間は前の答えのまま', async () => {
    let now = 1_000_000;
    let answer = CLAUDE_CIM;
    const f = fakeRead(() => new Map([[12156, answer]]));
    const c = new PidReuseCheck(f.read, () => now);
    c.reused(12156, CLAUDE);
    await c.settled();
    now += PID_REUSE_SAME_TTL_MS - 1;
    expect(c.reused(12156, CLAUDE)).toBe(false);
    expect(f.calls).toHaveLength(1);
    now += 1;
    answer = OTHER;
    expect(c.reused(12156, CLAUDE)).toBe(false);
    await c.settled();
    expect(c.reused(12156, CLAUDE)).toBe(true);
    expect(f.calls).toHaveLength(2);
  });

  it('読めなかったら決めず、しばらく聞き直さない', async () => {
    let now = 1_000_000;
    const f = fakeRead(() => new Error('powershell'));
    const c = new PidReuseCheck(f.read, () => now);
    expect(c.reused(12156, CLAUDE)).toBe(false);
    await c.settled();
    expect(c.reused(12156, CLAUDE)).toBe(false);
    await c.settled();
    expect(f.calls).toHaveLength(1);
    now += PID_REUSE_RETRY_MS;
    c.reused(12156, CLAUDE);
    await c.settled();
    expect(f.calls).toHaveLength(2);
  });

  it('読めないままなら、聞き直しの間を倍々に延ばし、上限で止める', async () => {
    let now = 1_000_000;
    const f = fakeRead(() => new Error('powershell'));
    const c = new PidReuseCheck(f.read, () => now);
    const step = async (ms: number) => { now += ms; c.reused(12156, CLAUDE); await c.settled(); return f.calls.length; };
    expect(await step(0)).toBe(1);
    expect(await step(PID_REUSE_RETRY_MS)).toBe(2);
    // 2 回目の後は 2 倍待つ。
    expect(await step(PID_REUSE_RETRY_MS)).toBe(2);
    expect(await step(PID_REUSE_RETRY_MS)).toBe(3);
    // 4 倍、8 倍と延び、上限を越えない。
    expect(await step(PID_REUSE_RETRY_MS * 4)).toBe(4);
    expect(await step(PID_REUSE_RETRY_MS * 8)).toBe(5);
    expect(await step(PID_REUSE_RETRY_MAX_MS)).toBe(6);
    expect(await step(PID_REUSE_RETRY_MAX_MS - 1)).toBe(6);
    expect(await step(1)).toBe(7);
  });

  it('読めたら、聞き直しの間を元に戻す', async () => {
    let now = 1_000_000;
    let fail = true;
    const f = fakeRead(() => (fail ? new Error('powershell') : new Map()));
    const c = new PidReuseCheck(f.read, () => now);
    const step = async (ms: number) => { now += ms; c.reused(12156, CLAUDE); await c.settled(); return f.calls.length; };
    await step(0);
    await step(PID_REUSE_RETRY_MS);
    fail = false;
    // 答えに無い（読めたが pid が居ない）ので不明のままだが、間は最初の長さに戻る。
    expect(await step(PID_REUSE_RETRY_MS * 2)).toBe(3);
    expect(await step(PID_REUSE_RETRY_MS)).toBe(4);
  });

  // 夏時間が戻る重複の 1 時間に始まったプロセスは、手元の時刻から UTC へ直すと 1 時間ずれうる。
  // 違うと決めると二度と読み直さないので、時刻帯のずれに見える差は不明として扱う。
  it('差が 30 分の倍数（±2 秒）なら、時刻帯のずれとみて決めない', async () => {
    let now = 1_000_000;
    const shift = (s: string, sec: number) => String(BigInt(s) + BigInt(sec) * 10_000_000n);
    for (const sec of [3600, -3600, 1800, 7201, -5399]) {
      const f = fakeRead(() => new Map([[12156, shift(CLAUDE, sec)]]));
      const c = new PidReuseCheck(f.read, () => now);
      c.reused(12156, CLAUDE);
      await c.settled();
      expect(c.reused(12156, CLAUDE), String(sec)).toBe(false);
      now += PID_REUSE_RETRY_MS;
      c.reused(12156, CLAUDE);
      await c.settled();
      expect(f.calls, String(sec)).toHaveLength(2);
    }
    // 30 分の倍数から外れた差は、使い回しと決める。
    const f = fakeRead(() => new Map([[12156, shift(CLAUDE, 3605)]]));
    const c = new PidReuseCheck(f.read, () => now);
    c.reused(12156, CLAUDE);
    await c.settled();
    expect(c.reused(12156, CLAUDE)).toBe(true);
  });

  it('答えに無い pid（読む前に終わった）も決めず、しばらく聞き直さない', async () => {
    const f = fakeRead(() => new Map());
    const c = new PidReuseCheck(f.read);
    c.reused(12156, CLAUDE);
    await c.settled();
    expect(c.reused(12156, CLAUDE)).toBe(false);
    await c.settled();
    expect(f.calls).toHaveLength(1);
  });

  it('読めない procStart は比べない', async () => {
    const f = fakeRead(() => new Map([[12156, OTHER]]));
    const c = new PidReuseCheck(f.read);
    expect(c.reused(12156, 'not a time')).toBe(false);
    await c.settled();
    expect(c.reused(12156, 'not a time')).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});
