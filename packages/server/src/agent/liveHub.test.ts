import { describe, expect, it } from 'vitest';
import type { LiveSessionDto } from '@agent-hangar/shared';
import { LiveHub } from './liveHub.ts';
import type { LiveSource } from './types.ts';

const entry = (sessionId: string, pid = 1): LiveSessionDto => ({ sessionId, status: 'busy', name: null, nameSource: null, cwd: '/w', pid });

/** 写しを手で差し替えられる偽の LiveSource。呼ばれた start、stop、kick を順に覚える。 */
function fakeSource(initial: LiveSessionDto[]) {
  let live = initial;
  const listeners = new Set<(l: LiveSessionDto[]) => void>();
  const calls: string[] = [];
  const source: LiveSource = {
    start: () => { calls.push('start'); },
    stop: () => { calls.push('stop'); },
    current: () => live,
    onChange: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    kick: (ms) => { calls.push(`kick:${ms}`); },
    isRunning: (id, pid) => live.some((l) => l.sessionId === id && l.pid === pid),
  };
  return { source, calls, set(next: LiveSessionDto[]) { live = next; for (const cb of listeners) cb(next); } };
}

describe('LiveHub', () => {
  it('複数の写しを合わせて 1 つの current() にする。並びはセッションの id の順', () => {
    const a = fakeSource([entry('s3'), entry('s1')].sort((x, y) => x.sessionId.localeCompare(y.sessionId)));
    const b = fakeSource([entry('s2')]);
    const hub = new LiveHub();
    hub.add(a.source);
    hub.add(b.source);
    expect(hub.current().map((l) => l.sessionId)).toEqual(['s1', 's2', 's3']);
    expect(hub.isLive('s2')).toBe(true);
    expect(hub.isLive('s9')).toBe(false);
  });

  it('写しが 1 つなら、その写しをそのまま返す', () => {
    const a = fakeSource([entry('s1')]);
    const hub = new LiveHub();
    hub.add(a.source);
    expect(hub.current()).toBe(a.source.current());
  });

  it('写しが 2 つでも、どちらも変わらなければ同じ配列を返す。変われば新しい配列にする', () => {
    const a = fakeSource([entry('s1')]);
    const b = fakeSource([entry('s2')]);
    const hub = new LiveHub();
    hub.add(a.source);
    hub.add(b.source);
    const first = hub.current();
    expect(hub.current()).toBe(first);
    b.set([entry('s2'), entry('s3')]);
    const second = hub.current();
    expect(second).not.toBe(first);
    expect(second.map((l) => l.sessionId)).toEqual(['s1', 's2', 's3']);
    expect(hub.current()).toBe(second);
  });

  it('写しが無ければ空を返す', () => {
    expect(new LiveHub().current()).toEqual([]);
  });

  it('どれかの写しが変わったら、合わせた一覧で 1 つの onChange を出す。外したら出さない', () => {
    const a = fakeSource([entry('s1')]);
    const b = fakeSource([entry('s2')]);
    const hub = new LiveHub();
    hub.add(a.source);
    hub.add(b.source);
    const seen: string[][] = [];
    const off = hub.onChange((live) => seen.push(live.map((l) => l.sessionId)));
    b.set([entry('s2'), entry('s4')]);
    a.set([]);
    expect(seen).toEqual([['s1', 's2', 's4'], ['s2', 's4']]);
    off();
    a.set([entry('s1')]);
    expect(seen).toHaveLength(2);
  });

  it('start、stop、kick はすべての写しへ渡す', () => {
    const a = fakeSource([]);
    const b = fakeSource([]);
    const hub = new LiveHub();
    hub.add(a.source);
    hub.add(b.source);
    hub.start();
    hub.kick(0);
    hub.stop();
    expect(a.calls).toEqual(['start', 'kick:0', 'stop']);
    expect(b.calls).toEqual(['start', 'kick:0', 'stop']);
  });

  it('足し付けの鎖を順に通す。どの段にも同じ時刻を渡す', () => {
    const times: number[] = [];
    const hub = new LiveHub({
      enrich: [
        (live, now) => { times.push(now); return live.map((l) => ({ ...l, name: 'a' })); },
        (live, now) => { times.push(now); return live.map((l) => ({ ...l, name: `${l.name}b` })); },
      ],
      now: () => 42,
    });
    expect(hub.enrich([entry('s1')]).map((l) => l.name)).toEqual(['ab']);
    expect(times).toEqual([42, 42]);
    expect(new LiveHub().enrich([entry('s1')])).toEqual([entry('s1')]);
  });
});
