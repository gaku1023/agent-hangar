import { describe, expect, it } from 'vitest';
import { PID_REUSE_RETRY_MS, PID_REUSE_SAME_TTL_MS, PidReuseCheck } from './pidReuse.ts';

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
