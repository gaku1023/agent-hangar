import { describe, expect, it } from 'vitest';
import { createViewingReporter, VIEWING_HEARTBEAT_MS } from './viewing.ts';

const setup = () => {
  let cur: string | null = null;
  const sent: (string | null)[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const r = createViewingReporter({ current: () => cur, send: async (id) => { sent.push(id); }, setTimeout: (fn, ms) => { timers.push({ fn, ms }); } });
  const fire = () => { const now = timers.splice(0); for (const t of now) t.fn(); };
  return { r, sent, timers, fire, set: (v: string | null) => { cur = v; } };
};

describe('createViewingReporter', () => {
  it('見ている会話が変わったときだけ送り、見ている間は間を置いて送り直す', () => {
    const h = setup();
    h.r.report();
    expect(h.sent).toEqual([]);
    h.set('s1');
    h.r.report();
    h.r.report();
    expect(h.sent).toEqual(['s1']);
    expect(h.timers.map((t) => t.ms)).toEqual([VIEWING_HEARTBEAT_MS]);
    h.fire();
    expect(h.sent).toEqual(['s1', 's1']);
    h.set(null);
    h.r.report();
    expect(h.sent).toEqual(['s1', 's1', null]);
    // 見るのをやめた後の古い送り直しは何もしない。
    h.fire();
    expect(h.sent).toEqual(['s1', 's1', null]);
    expect(h.timers).toEqual([]);
  });

  it('止めたら、見ていた会話を外して以後は送らない', () => {
    const h = setup();
    h.set('s1');
    h.r.report();
    h.r.stop();
    h.fire();
    h.set('s2');
    h.r.report();
    expect(h.sent).toEqual(['s1', null]);
  });
});
