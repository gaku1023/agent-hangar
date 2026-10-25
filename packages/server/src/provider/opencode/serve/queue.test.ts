import { describe, expect, it } from 'vitest';
import { LaunchQueue, retryOnLock } from './queue.ts';
import { ServeStartError } from './spawn.ts';

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('LaunchQueue', () => {
  it('5 本を同時に頼んでも 1 本ずつ走らせる', async () => {
    const q = new LaunchQueue();
    let running = 0;
    let max = 0;
    const order: number[] = [];
    const jobs = [0, 1, 2, 3, 4].map((i) => q.run(async () => {
      running++;
      max = Math.max(max, running);
      await tick(10);
      order.push(i);
      running--;
      return i;
    }));
    expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3, 4]);
    expect(max).toBe(1);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('前の 1 本が転んでも、次の 1 本は走る', async () => {
    const q = new LaunchQueue();
    const a = q.run(async () => { throw new Error('boom'); });
    const b = q.run(async () => 'ok');
    await expect(a).rejects.toThrow('boom');
    await expect(b).resolves.toBe('ok');
  });
});

describe('retryOnLock', () => {
  const locked = (): ServeStartError => new ServeStartError('locked', 'SQLiteError: database is locked');

  it('database is locked で落ちたら、間をあけて起こし直す', async () => {
    const waits: number[] = [];
    let n = 0;
    const r = await retryOnLock(async () => {
      n++;
      if (n <= 2) throw locked();
      return 'up';
    }, { delaysMs: [10, 20, 30], sleep: async (ms) => { waits.push(ms); } });
    expect(r).toBe('up');
    expect(n).toBe(3);
    expect(waits).toEqual([10, 20]);
  });

  it('起こし直しは 3 回まで。4 回目の失敗はそのまま投げる', async () => {
    let n = 0;
    await expect(retryOnLock(async () => { n++; throw locked(); }, { delaysMs: [1, 1, 1], sleep: async () => {} })).rejects.toMatchObject({ reason: 'locked' });
    expect(n).toBe(4);
  });

  it('ロックでない失敗は起こし直さない', async () => {
    let n = 0;
    await expect(retryOnLock(async () => { n++; throw new ServeStartError('exited', 'boom'); }, { delaysMs: [1, 1, 1], sleep: async () => {} })).rejects.toMatchObject({ reason: 'exited' });
    expect(n).toBe(1);
  });
});
