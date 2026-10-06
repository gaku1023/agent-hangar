import { describe, expect, it } from 'vitest';
import { PausedPass } from './pausedPass.ts';

/** 外から終わらせられる約束。 */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((res) => { open = res; });
  return { promise, open };
}

describe('PausedPass', () => {
  it('メタデータが済んだ時点で戻り、残りが終わるまで active のままでいる', async () => {
    const log: string[] = [];
    const rest = gate();
    const pass = new PausedPass({
      metadata: async () => { log.push('metadata'); },
      rest: () => { log.push('rest'); return rest.promise; },
      done: () => { log.push(`done:${pass.active()}`); },
    });
    expect(pass.active()).toBe(false);
    await pass.run();
    expect(pass.active()).toBe(true);
    rest.open();
    await pass.idle();
    // done が呼ばれる時点で、判定はもう一時停止に戻っている。
    expect(log).toEqual(['metadata', 'rest', 'done:false']);
    expect(pass.active()).toBe(false);
  });

  it('巡っている最中に押されたら、その回に相乗りする', async () => {
    let metadata = 0;
    const rest = gate();
    const pass = new PausedPass({ metadata: async () => { metadata++; }, rest: () => rest.promise, done: () => {} });
    await pass.run();
    await pass.run();
    expect(metadata).toBe(1);
    rest.open();
    await pass.idle();
    await pass.run();
    await pass.idle();
    expect(metadata).toBe(2);
  });

  it('途中の段が転んでも reject せず、必ず降りる', async () => {
    let done = 0;
    const pass = new PausedPass({
      metadata: () => Promise.reject(new Error('offline')),
      rest: () => Promise.reject(new Error('offline')),
      done: () => { done++; throw new Error('toast'); },
    });
    await expect(pass.run()).resolves.toBeUndefined();
    await pass.idle();
    expect(pass.active()).toBe(false);
    expect(done).toBe(1);
  });
});
