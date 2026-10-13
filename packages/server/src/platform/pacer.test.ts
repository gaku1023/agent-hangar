import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pacer } from './pacer.ts';

describe('Pacer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('急ぐ理由が無い間は遅い間隔で、ある間は速い間隔で回す', () => {
    let fast = false;
    let runs = 0;
    const p = new Pacer({ run: () => { runs++; }, fastMs: 500, slowMs: 5000, fast: () => fast });
    p.start();
    vi.advanceTimersByTime(4999);
    expect(runs).toBe(0);
    vi.advanceTimersByTime(1);
    expect(runs).toBe(1);
    fast = true;
    vi.advanceTimersByTime(5000);
    expect(runs).toBe(2);
    vi.advanceTimersByTime(500);
    expect(runs).toBe(3);
    vi.advanceTimersByTime(1000);
    expect(runs).toBe(5);
    p.stop();
    vi.advanceTimersByTime(10_000);
    expect(runs).toBe(5);
  });

  it('kick は、遅い間隔で待っている次の回を、いまの間隔の先へ繰り上げる。先へは延ばさない', () => {
    let fast = false;
    let runs = 0;
    const p = new Pacer({ run: () => { runs++; }, fastMs: 500, slowMs: 5000, fast: () => fast });
    p.start();
    vi.advanceTimersByTime(1000);
    fast = true;
    p.kick();
    vi.advanceTimersByTime(499);
    expect(runs).toBe(0);
    vi.advanceTimersByTime(1);
    expect(runs).toBe(1);
    // 待ちより先の kick は何もしない。
    p.kick(10_000);
    vi.advanceTimersByTime(500);
    expect(runs).toBe(2);
    p.stop();
  });

  it('kick(0) はすぐ 1 回走らせ、そこから数え直す', () => {
    let runs = 0;
    const p = new Pacer({ run: () => { runs++; }, fastMs: 500, slowMs: 5000, fast: () => false });
    p.start();
    vi.advanceTimersByTime(3000);
    p.kick(0);
    vi.advanceTimersByTime(0);
    expect(runs).toBe(1);
    vi.advanceTimersByTime(4999);
    expect(runs).toBe(1);
    vi.advanceTimersByTime(1);
    expect(runs).toBe(2);
    p.stop();
  });

  it('止まっている間の kick は何もしない', () => {
    let runs = 0;
    const p = new Pacer({ run: () => { runs++; }, fastMs: 500, slowMs: 5000, fast: () => true });
    p.kick(0);
    vi.advanceTimersByTime(10_000);
    expect(runs).toBe(0);
  });

  it('run が投げても周期は止めず、投げたものは onError に渡す', () => {
    const errors: unknown[] = [];
    let runs = 0;
    const p = new Pacer({ run: () => { runs++; throw new Error('boom'); }, fastMs: 500, slowMs: 500, fast: () => true, onError: (e) => errors.push(e) });
    p.start();
    vi.advanceTimersByTime(1500);
    expect(runs).toBe(3);
    expect(errors).toHaveLength(3);
    p.stop();
  });
});
