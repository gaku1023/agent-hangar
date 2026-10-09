import { describe, expect, it } from 'vitest';
import { CLOSE_DEADLINE_MS } from './budget.ts';
import { stopAfterIdle, stopUploader, waitForSummaryIdle } from './stopping.ts';

describe('close の要約待ち', () => {
  it('走っている要約が終わるまで待つ', async () => {
    // 終了の途中で要約が書き込みに来ると、閉じた DB に触れてしまう。
    let finish = () => {};
    const job = { idle: () => new Promise<void>((r) => { finish = r; }) };
    let settled: boolean | null = null;
    const waiting = waitForSummaryIdle(job, 2000).then((v) => { settled = v; return v; });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBeNull();
    finish();
    expect(await waiting).toBe(true);
  });
  it('上限を超えたら諦めて閉じる', async () => {
    // 終わらない要約に終了が引きずられないよう、待ち時間には上限を置く。
    const job = { idle: () => new Promise<void>(() => {}) };
    const t = Date.now();
    expect(await waitForSummaryIdle(job, 50)).toBe(false);
    expect(Date.now() - t).toBeLessThan(2000);
  });
  it('待ち行列が空ならすぐ返る', async () => {
    const t = Date.now();
    expect(await waitForSummaryIdle({ idle: () => Promise.resolve() }, CLOSE_DEADLINE_MS)).toBe(true);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(CLOSE_DEADLINE_MS).toBeGreaterThanOrEqual(1000);
  });
});

describe('close の本文の上げ待ち', () => {
  /** TranscriptUploader と同じ形の立て替え。idle が返るまで stop を呼んではいけない。 */
  const fakeUploader = () => {
    const calls: string[] = [];
    let finish = () => {};
    return {
      calls,
      finish: () => finish(),
      idle: () => new Promise<void>((r) => { finish = () => { calls.push('idle'); r(); }; }),
      stop: () => { calls.push('stop'); },
    };
  };

  it('走っている上げが終わってから止める', async () => {
    // デバウンスのタイマーが始めた上げは誰も約束を持たない。
    // 待たずに stop すると putFile が途中で切れ、その本文は次の起動までやり直しになる。
    const up = fakeUploader();
    let settled: boolean | null = null;
    const waiting = stopUploader(up, 2000).then((v) => { settled = v; return v; });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBeNull();
    expect(up.calls).toEqual([]);
    up.finish();
    expect(await waiting).toBe(true);
    // 上げ終わってから止める、という順でなければならない。
    expect(up.calls).toEqual(['idle', 'stop']);
  });

  it('上限を超えたら諦めて止める', async () => {
    // 大きな本文 1 件で hangar stop が固まらないようにする。
    const up = fakeUploader();
    const t = Date.now();
    expect(await stopUploader(up, 50)).toBe(false);
    expect(Date.now() - t).toBeLessThan(2000);
    // 諦めたときも必ず止める。
    expect(up.calls).toEqual(['stop']);
  });

  it('上げ手が無ければ何もしない', async () => {
    expect(await stopUploader(null)).toBe(true);
    // 上限は数秒に収める。終了が転送に引きずられない長さである。
    expect(CLOSE_DEADLINE_MS).toBeGreaterThanOrEqual(1000);
    expect(CLOSE_DEADLINE_MS).toBeLessThanOrEqual(5000);
  });
});

describe('close の同期の押し出し待ち', () => {
  /** SyncEngine と ClaudeConfigSync と同じ形の立て替え。idle が返るまで stop を呼んではいけない。 */
  const fakeJob = () => {
    const calls: string[] = [];
    let finish = () => {};
    return {
      calls,
      finish: () => finish(),
      idle: () => new Promise<void>((r) => { finish = () => { calls.push('idle'); r(); }; }),
      stop: () => { calls.push('stop'); },
    };
  };

  it('走っている押し出しが終わってから止める', async () => {
    const job = fakeJob();
    let settled: boolean | null = null;
    const waiting = stopAfterIdle(job, 'sync', 2000).then((v) => { settled = v; return v; });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBeNull();
    expect(job.calls).toEqual([]);
    job.finish();
    expect(await waiting).toBe(true);
    expect(job.calls).toEqual(['idle', 'stop']);
  });

  it('上限を超えたら警告して止める', async () => {
    // クラウドへ届かないときは毎回この道を通る。滅多に起きない保険ではない。
    const job = { ...fakeJob(), idle: () => new Promise<void>(() => {}) };
    const warned: string[] = [];
    const real = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(' ')); };
    try {
      const t = Date.now();
      expect(await stopAfterIdle(job, 'sync', 50)).toBe(false);
      expect(Date.now() - t).toBeLessThan(2000);
    } finally {
      console.warn = real;
    }
    // 諦めたときも必ず止める。止めないと、止めたはずの同期が要求を出し続ける。
    expect(job.calls).toEqual(['stop']);
    // 黙って諦めない。どの仕事を待ち切れなかったかがログに残る。
    expect(warned.length).toBe(1);
    expect(warned[0]).toContain('[sync]');
    expect(warned[0]).toContain('50');
  });

  it('相手が無ければ何もしない', async () => {
    expect(await stopAfterIdle(null, 'config')).toBe(true);
  });
});
