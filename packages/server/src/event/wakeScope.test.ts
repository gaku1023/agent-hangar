import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventFacts, EventSource, ScheduleTarget } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { noteApplied } from '../db/notify.ts';
import { getSessionState, setSessionState, setSessionTrashed } from '../sessions/states.ts';
import { EventDispatcher } from './dispatcher.ts';
import type { PulledEvent } from './puller.ts';
import { createBinding, getBinding } from './store.ts';
import { dropStaleWakes, watchWakeScope } from './wakeScope.ts';

let db: Db;
let now: number;
let off: () => void;
let dropped: ReturnType<typeof vi.fn<() => void>>;
const T0 = new Date(2026, 10, 10, 9, 0).getTime();
const gh: EventSource = { kind: 'github', repo: 'octo/demo', when: ['ci_done'], pr: 5 };

const session = (id = 's-1') => { db.prepare("insert or ignore into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values (?, 'claude-code', ?, '/w', 'dev', 1, 'dev')").run(id, `u-${id}`); };
const pause = (id = 's-1') => { session(id); setSessionState(db, 'dev', id, { status: 'paused', note: 'wait', setBy: 'user', now }); };
const wakeBinding = (id = 's-1') => createBinding(db, { inboxId: `i-${id}`, inboxPublicKey: 'P', inboxPrivateKey: 'K', source: gh, action: { kind: 'wake', sessionId: id }, prompt: 'go', state: 'active' }, now);
const event = (bindingId: string): PulledEvent => ({ bindingId, atStart: false, facts: { source: 'github', event: 'ci_done', repo: 'octo/demo', number: 5, outcome: 'success', receivedAt: now } satisfies EventFacts });
function dispatcher() {
  const launched: ScheduleTarget[] = [];
  const d = new EventDispatcher({
    db, deviceId: 'dev', now: () => now, language: () => 'en', me: async () => 'alice',
    launch: async (s) => { launched.push(s.target); return { sessionId: 's-1' }; },
    wait: () => new Promise(() => undefined),
  });
  return { d, launched };
}

beforeEach(() => { db = openDb(':memory:'); now = T0; dropped = vi.fn(); off = watchWakeScope(db, dropped); });
afterEach(() => { off(); db.close(); });

describe('a wake binding lives only while its session stays Paused', () => {
  it('is deleted when the session leaves Paused, and asks for the hook cleanup', () => {
    pause();
    const b = wakeBinding();
    setSessionState(db, 'dev', 's-1', { status: null, setBy: 'user', now: now + 1 });
    expect(getBinding(db, b.id)).toBeNull();
    expect(dropped).toHaveBeenCalledTimes(1);
  });

  it('is deleted when the session becomes Done', () => {
    pause();
    const b = wakeBinding();
    setSessionState(db, 'dev', 's-1', { status: 'done', note: 'finished', setBy: 'user', now: now + 1 });
    expect(getBinding(db, b.id)).toBeNull();
  });

  it('does not wake a later Paused with the condition made for an earlier one', async () => {
    pause();
    const b = wakeBinding();
    now += 60_000;
    setSessionState(db, 'dev', 's-1', { status: null, setBy: 'user', now });
    now += 60_000;
    pause();
    const { d, launched } = dispatcher();
    await d.handle([event(b.id)]);
    await d.idle();
    expect(launched).toEqual([]);
    expect(getSessionState(db, 's-1')?.status).toBe('paused');
    expect(getBinding(db, b.id)).toBeNull();
  });

  it('keeps the binding when a Paused session is rewritten, and the next matching event wakes it', async () => {
    pause();
    const b = wakeBinding();
    now += 60_000;
    // 画面のダイアログで理由と日付を直す。wakeOn は null で来るが、状態は Paused のまま。
    setSessionState(db, 'dev', 's-1', { status: 'paused', note: 'edited note', returnOn: '2026-11-12', setBy: 'user', now });
    expect(getBinding(db, b.id)).not.toBeNull();
    expect(dropped).not.toHaveBeenCalled();
    const { d, launched } = dispatcher();
    await d.handle([event(b.id)]);
    await d.idle();
    expect(launched).toEqual([{ kind: 'session', sessionId: 's-1' }]);
  });

  it('is deleted when the other PC syncs a state that is no longer Paused', () => {
    pause();
    const b = wakeBinding();
    // 同期は行を直接書き、apply として知らせる。
    db.prepare("update session_states set status = null, note = null, set_by = null, set_at = null where session_id = 's-1'").run();
    noteApplied(db, 'session_states', 's-1', 'upsert');
    expect(getBinding(db, b.id)).toBeNull();
    expect(dropped).toHaveBeenCalledTimes(1);
  });

  it('leaves no binding behind after the wake itself', async () => {
    pause();
    const b = wakeBinding();
    const { d, launched } = dispatcher();
    await d.handle([event(b.id)]);
    await d.idle();
    expect(launched).toHaveLength(1);
    expect(getSessionState(db, 's-1')?.status ?? null).toBeNull();
    expect(getBinding(db, b.id)).toBeNull();
  });

  it('is deleted when the Paused session is trashed, and a new one survives its restore', () => {
    pause();
    const b = wakeBinding();
    setSessionTrashed(db, 'dev', 's-1', now + 1, now + 1);
    expect(getBinding(db, b.id)).toBeNull();
    pause('s-2');
    const kept = wakeBinding('s-2');
    setSessionTrashed(db, 'dev', 's-2', now + 1, now + 1);
    setSessionTrashed(db, 'dev', 's-2', null, now + 5);
    expect(getBinding(db, kept.id)).toBeNull();
    // 戻したあとに付けた結び付けは残る。
    const fresh = wakeBinding('s-2');
    setSessionState(db, 'dev', 's-2', { status: 'paused', note: 'again', setBy: 'user', now: now + 6 });
    expect(getBinding(db, fresh.id)).not.toBeNull();
    expect(dropStaleWakes(db)).toBe(0);
  });

  it('does not wake a binding that was deleted while the wake was being prepared, and writes no run for it', async () => {
    pause();
    const b = wakeBinding();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const launched: ScheduleTarget[] = [];
    const d = new EventDispatcher({
      db, deviceId: 'dev', now: () => now, language: () => 'en', me: async () => { await gate; return 'alice'; },
      launch: async (s) => { launched.push(s.target); return { sessionId: 's-1' }; },
      wait: () => new Promise(() => undefined),
    });
    await d.handle([event(b.id)]);
    // 準備の途中で利用者が再開し、別の理由でまた Paused にした（起こす条件は無い）。
    setSessionState(db, 'dev', 's-1', { status: null, setBy: 'user', now: now + 1 });
    pause();
    release();
    await d.idle();
    expect(launched).toEqual([]);
    expect(getSessionState(db, 's-1')?.status).toBe('paused');
    expect((db.prepare('select count(*) c from event_runs').get() as { c: number }).c).toBe(0);
  });

  it('does not replay a deferred wake whose binding was deleted before the pass ended', async () => {
    pause();
    const b = wakeBinding();
    const { d, launched } = dispatcher();
    await d.handle([event(b.id)], { more: true });
    setSessionState(db, 'dev', 's-1', { status: null, setBy: 'user', now: now + 1 });
    pause();
    d.flushWakes();
    await d.idle();
    expect(launched).toEqual([]);
    expect(getSessionState(db, 's-1')?.status).toBe('paused');
  });

  it('only touches the wake bindings of the session that changed', () => {
    pause('s-1');
    pause('s-2');
    const mine = wakeBinding('s-1');
    const other = wakeBinding('s-2');
    setSessionState(db, 'dev', 's-1', { status: null, setBy: 'user', now: now + 1 });
    expect(getBinding(db, mine.id)).toBeNull();
    expect(getBinding(db, other.id)).not.toBeNull();
  });

  it('sweeps stale wake bindings of sessions that are not Paused, all at once', () => {
    session('s-1');
    session('s-2');
    pause('s-3');
    const stale = wakeBinding('s-1');
    const stale2 = wakeBinding('s-2');
    const live = wakeBinding('s-3');
    expect(dropStaleWakes(db)).toBe(2);
    expect([getBinding(db, stale.id), getBinding(db, stale2.id)]).toEqual([null, null]);
    expect(getBinding(db, live.id)).not.toBeNull();
  });
});
