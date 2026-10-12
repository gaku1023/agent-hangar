import { describe, expect, it, vi } from 'vitest';
import type { GitDto } from '@agent-hangar/shared';
import { createGitWatch, GIT_BATCH_MS, GIT_POLL_MS } from './gitWatch.ts';

/** 予約を手で進める時計。 */
function clock() {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => { timers.push({ at: now + ms, fn }); },
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > until) break;
        timers.shift();
        now = next.at;
        next.fn();
        await Promise.resolve();
      }
      now = until;
      await Promise.resolve();
    },
  };
}

const empty: GitDto = { sessions: {}, trees: {} };

describe('git の取得', () => {
  it('見えている行をまとめて 1 回で取り、答えを当てる', async () => {
    const c = clock();
    const fetch = vi.fn(async () => empty);
    const apply = vi.fn();
    const w = createGitWatch({ fetch, apply, live: () => ['live1'], visible: () => true, setTimeout: c.setTimeout, now: c.now });
    w.watch('list', ['a', 'b']);
    w.watch('session', ['b', 'c']);
    await c.advance(GIT_BATCH_MS);
    expect(fetch.mock.calls).toEqual([[['a', 'b', 'c', 'live1']]]);
    expect(apply).toHaveBeenCalledWith(empty);
  });
  it('窓が前にある間は周期で取り直し、裏にある間は取らない', async () => {
    const c = clock();
    const fetch = vi.fn(async () => empty);
    let visible = true;
    const w = createGitWatch({ fetch, apply: () => {}, live: () => [], visible: () => visible, setTimeout: c.setTimeout, now: c.now });
    w.start();
    w.watch('list', ['a']);
    await c.advance(GIT_BATCH_MS);
    expect(fetch).toHaveBeenCalledTimes(1);
    await c.advance(GIT_POLL_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    visible = false;
    await c.advance(GIT_POLL_MS * 2);
    expect(fetch).toHaveBeenCalledTimes(2);
    // 前に戻ったら、すぐ取り直す。
    visible = true;
    w.wake();
    await c.advance(GIT_BATCH_MS);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('取り下げた場所の行は、次から取らない。直前に取った行は同じ並びで取り直さない', async () => {
    const c = clock();
    const fetch = vi.fn(async () => empty);
    const w = createGitWatch({ fetch, apply: () => {}, live: () => [], visible: () => true, setTimeout: c.setTimeout, now: c.now });
    w.watch('list', ['a']);
    await c.advance(GIT_BATCH_MS);
    w.watch('list', ['a']);
    await c.advance(GIT_BATCH_MS);
    expect(fetch).toHaveBeenCalledTimes(1);
    w.watch('list', []);
    w.watch('other', ['b']);
    await c.advance(GIT_BATCH_MS);
    expect(fetch.mock.calls.at(-1)).toEqual([['b']]);
  });
  it('多いときは 200 件ずつに分ける。失敗しても次の周期で取り直す', async () => {
    const c = clock();
    const fetch = vi.fn(async (ids: string[]) => { if (ids.length > 200) throw new Error('too many'); return empty; });
    const w = createGitWatch({ fetch, apply: () => {}, live: () => [], visible: () => true, setTimeout: c.setTimeout, now: c.now });
    w.watch('list', Array.from({ length: 250 }, (_, i) => `s${i}`));
    await c.advance(GIT_BATCH_MS);
    expect(fetch.mock.calls.map((x) => x[0].length)).toEqual([200, 50]);
  });
});
