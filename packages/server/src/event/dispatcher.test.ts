import { EVENT_HOURLY_MAX, type EventFacts, type EventSource, type ScheduleTarget } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import type { ScheduleOutcome } from '../schedule/runner.ts';
import { getSessionState, setSessionState } from '../sessions/states.ts';
import { EventDispatcher, type DispatcherDeps } from './dispatcher.ts';
import type { PulledEvent } from './puller.ts';
import { claimPr, createBinding, getBinding, getBindingRow, listBindings, updateBinding, type BindingInput } from './store.ts';

let db: Db;
let now: number;
const T0 = new Date(2026, 10, 10, 9, 0).getTime();
const HOUR = 60 * 60_000;
const gh = (over: Partial<Extract<EventSource, { kind: 'github' }>> = {}): EventSource => ({ kind: 'github', repo: 'octo/demo', when: ['ci_done'], pr: 7, ...over });

let seq = 0;
const bind = (over: Partial<BindingInput> = {}) => createBinding(db, {
  inboxId: `inbox-${seq++}`, inboxPublicKey: 'PUB', inboxPrivateKey: 'PRIV', source: gh(), action: { kind: 'wake', sessionId: 's-1' }, prompt: 'look at it', state: 'active', ...over,
}, now);
const facts = (over: Partial<EventFacts> = {}): EventFacts => ({ source: 'github', event: 'ci_done', repo: 'octo/demo', number: 7, outcome: 'success', receivedAt: now, ...over });
const ev = (bindingId: string, over: Partial<EventFacts> = {}, atStart = false): PulledEvent => ({ bindingId, facts: facts(over), atStart });
const pause = (id = 's-1') => { db.prepare("insert or ignore into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values (?, 'claude-code', ?, '/w', 'dev', 1, 'dev')").run(id, `u-${id}`); return setSessionState(db, 'dev', id, { status: 'paused', note: 'wait for CI', setBy: 'user' }); };
const sendTo = (id: string, when: Extract<EventSource, { kind: 'github' }>['when'] = ['comment'], over: Partial<Extract<EventSource, { kind: 'github' }>> = {}) =>
  bind({ action: { kind: 'send', sessionId: id }, source: gh({ when, ...over }) });

type Launched = { prompt: string; target: ScheduleTarget };
function make(over: Partial<DispatcherDeps> = {}) {
  const launched: Launched[] = [];
  const waits: ((o: ScheduleOutcome) => void)[] = [];
  const notices: string[] = [];
  const deps: DispatcherDeps = {
    db, deviceId: 'dev', now: () => now, language: () => 'en', me: async () => 'alice',
    launch: async (s) => { launched.push({ prompt: s.prompt, target: s.target }); return { sessionId: s.target.kind === 'session' ? s.target.sessionId : `new-${launched.length}` }; },
    wait: () => new Promise((res) => { waits.push(res); }),
    notify: (m) => { notices.push(m); },
    ...over,
  };
  const d = new EventDispatcher(deps);
  return { d, launched, waits, notices };
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const runs = (id: string) => getBinding(db, id)!.runs;

beforeEach(() => { db = openDb(':memory:'); now = T0; });
afterEach(() => { db.close(); });

describe('wake', () => {
  it('wakes a paused session once and removes the binding', async () => {
    const b = bind();
    pause();
    const { d, launched } = make();
    await d.handle([ev(b.id)]);
    await d.idle();
    expect(launched).toHaveLength(1);
    expect(launched[0]!.target).toEqual({ kind: 'session', sessionId: 's-1' });
    expect(launched[0]!.prompt).toContain('look at it');
    expect(launched[0]!.prompt).toContain('ci_done octo/demo#7');
    expect(getSessionState(db, 's-1')?.status ?? null).toBeNull();
    expect(getBinding(db, b.id)).toBeNull();
    // もう一度届いても、結び付けが無いので何も起きない。
    await d.handle([ev(b.id)]);
    await d.idle();
    expect(launched).toHaveLength(1);
  });

  it('reports the woken session once, and not for a session the user already resumed or a busy one', async () => {
    const woken: string[] = [];
    const b = bind();
    pause();
    const { d } = make({ onWoken: (id) => { woken.push(id); } });
    await d.handle([ev(b.id)]);
    await d.idle();
    expect(woken).toEqual(['s-1']);
    const b2 = bind({ action: { kind: 'wake', sessionId: 's-9' } });
    await d.handle([ev(b2.id)]);
    await d.idle();
    expect(woken).toEqual(['s-1']);
    const b3 = bind({ action: { kind: 'wake', sessionId: 's-2' } });
    pause('s-2');
    const busy = make({ onWoken: (id) => { woken.push(id); }, launch: async () => 'busy' });
    await busy.d.handle([ev(b3.id)]);
    await busy.d.idle();
    expect(woken).toEqual(['s-1']);
  });

  it('does not wake a session the user already resumed', async () => {
    const b = bind();
    const { d, launched } = make();
    await d.handle([ev(b.id)]);
    await d.idle();
    expect(launched).toEqual([]);
    expect(getBinding(db, b.id)).toBeNull();
  });

  it('wakes once with the latest of three events at start', async () => {
    const b = bind({ source: gh({ when: ['ci_done', 'review'] }) });
    pause();
    const { d, launched } = make();
    await d.handle([ev(b.id, { event: 'review', actor: 'x' }, true), ev(b.id, { event: 'ci_done', outcome: 'failure' }, true), ev(b.id, { event: 'ci_done', outcome: 'success', url: 'https://example.test/latest' }, true)]);
    await d.idle();
    expect(launched).toHaveLength(1);
    expect(launched[0]!.prompt).toContain('url=https://example.test/latest');
    expect(launched[0]!.prompt).not.toContain('outcome=failure');
    expect(launched[0]!.prompt).not.toContain('review');
    expect(getBinding(db, b.id)).toBeNull();
  });

  it('keeps the binding and the pause when the session is busy', async () => {
    const b = bind();
    pause();
    const { d } = make({ launch: async () => 'busy' });
    await d.handle([ev(b.id)]);
    await d.idle();
    expect(getSessionState(db, 's-1')?.status).toBe('paused');
    expect(getBinding(db, b.id)).not.toBeNull();
    expect(runs(b.id)[0]).toMatchObject({ result: 'skipped' });
  });

  it('keeps the binding and records a failure when the delivery throws', async () => {
    const b = bind();
    pause();
    const { d } = make({ launch: async () => { throw new Error('cannot resume'); } });
    await d.handle([ev(b.id)]);
    await d.idle();
    expect(getSessionState(db, 's-1')?.status).toBe('paused');
    expect(runs(b.id)[0]).toMatchObject({ result: 'failed', error: 'cannot resume' });
  });

  it('closing a pr removes its wake bindings', async () => {
    const closing = bind();
    const other = bind({ source: gh({ pr: 8 }) });
    const merged = bind({ source: gh({ when: ['merged'] }), action: { kind: 'wake', sessionId: 's-2' } });
    const reviewOnly = bind({ source: gh({ when: ['review'] }), action: { kind: 'wake', sessionId: 's-3' } });
    const sender = sendTo('s-9', ['ci_done'], { pr: 7 });
    pause('s-2');
    pause('s-3');
    const { d, launched } = make();
    // 閉じられた PR（マージなし）は、起こさずに消す。
    await d.handle([{ bindingId: closing.id, atStart: false, facts: { source: 'github', event: 'closed', repo: 'octo/demo', number: 7, receivedAt: now } }]);
    await d.idle();
    expect(launched).toEqual([]);
    expect(getBinding(db, closing.id)).toBeNull();
    expect(getBinding(db, merged.id)).toBeNull();
    expect(getBinding(db, reviewOnly.id)).toBeNull();
    expect(getBinding(db, other.id)).not.toBeNull();
    expect(getBinding(db, sender.id)).not.toBeNull();
  });

  it('wakes first when the condition is merged, then removes the other bindings of the pr', async () => {
    const merged = bind({ source: gh({ when: ['merged'] }), action: { kind: 'wake', sessionId: 's-2' } });
    bind({ source: gh({ when: ['review'] }), action: { kind: 'wake', sessionId: 's-3' } });
    pause('s-2');
    pause('s-3');
    const { d, launched } = make();
    await d.handle([ev(merged.id, { event: 'merged' })]);
    await d.idle();
    expect(launched.map((l) => l.target)).toEqual([{ kind: 'session', sessionId: 's-2' }]);
    expect(getSessionState(db, 's-2')?.status ?? null).toBeNull();
    expect(getSessionState(db, 's-3')?.status).toBe('paused');
    expect(listBindings(db)).toEqual([]);
  });
});

describe('merged wake that fails', () => {
  const slowLaunch = (result: () => Promise<'busy' | { sessionId: string }>) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    return { release, launch: async () => { await gate; return result(); } };
  };

  it('does not delete a wake binding that is still waking, and removes it once the wake ends busy', async () => {
    const b = bind({ source: gh({ when: ['merged'] }) });
    pause();
    db.prepare('insert or ignore into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values (?, ?, ?, ?, ?, 1, ?)').run('s-1', 'claude-code', 'u-s-1', '/w', 'dev', 'dev');
    db.prepare('update sessions set custom_title = ? where id = ?').run('Retry work', 's-1');
    const slow = slowLaunch(async () => 'busy');
    const { d, notices } = make({ launch: slow.launch });
    await d.handle([ev(b.id, { event: 'merged' })]);
    await flush();
    // 起こしている最中は、後始末で消されない。
    expect(getBindingRow(db, b.id)).not.toBeNull();
    slow.release();
    await d.idle();
    expect(getSessionState(db, 's-1')?.status).toBe('paused');
    // 起こせなかったことを、会話の名前を添えて知らせる。
    expect(notices).toEqual([`Couldn't wake "Retry work"`]);
    // 閉じた PR にはもう事実が来ないので、知らせたあとで消える。
    expect(getBindingRow(db, b.id)).toBeNull();
  });

  it('removes the binding after a merged wake that throws, without reporting a dispatcher error', async () => {
    const b = bind({ source: gh({ when: ['merged'] }) });
    pause();
    const errors: unknown[] = [];
    const slow = slowLaunch(async () => { throw new Error('cannot resume'); });
    const { d, notices } = make({ launch: slow.launch, onError: (e) => { errors.push(e); } });
    await d.handle([ev(b.id, { event: 'merged' })]);
    slow.release();
    await d.idle();
    expect(errors).toEqual([]);
    // 会話に名前が無いときは ID で知らせる。
    expect(notices).toEqual([`Couldn't wake "s-1"`]);
    expect(getSessionState(db, 's-1')?.status).toBe('paused');
    expect(getBindingRow(db, b.id)).toBeNull();
  });

  it('keeps the binding for a busy wake while the pr is still open', async () => {
    const b = bind({ source: gh({ when: ['ci_done'] }) });
    pause();
    const { d, notices } = make({ launch: async () => 'busy' });
    await d.handle([ev(b.id)]);
    await d.idle();
    expect(getBinding(db, b.id)!.runs[0]).toMatchObject({ result: 'skipped' });
    // PR がまだ開いているので、次の事実を待つ。知らせない。
    expect(notices).toEqual([]);
  });
});

describe('matching', () => {
  it('acts only on active bindings and ignores rejected entries', async () => {
    const draft = bind({ state: 'draft' });
    const held = bind({ state: 'held' });
    pause();
    const { d, launched } = make();
    await d.handle([ev(draft.id), ev(held.id), { bindingId: draft.id, rejected: 'signature' }]);
    await d.idle();
    expect(launched).toEqual([]);
    expect(getBinding(db, draft.id)).not.toBeNull();
  });

  it('matches ci_failed only on a failure of the same pr', async () => {
    const b = sendTo('s-1', ['ci_failed']);
    const seen: ScheduleTarget[] = [];
    const { d } = make({ launch: async (s) => { seen.push(s.target); return 'busy'; } });
    await d.handle([ev(b.id, { outcome: 'success' }), ev(b.id, { outcome: 'cancelled' }), ev(b.id, { outcome: 'failure', number: 9 }), ev(b.id, { event: 'review' })]);
    await d.idle();
    expect(seen).toEqual([]);
    await d.handle([ev(b.id, { outcome: 'failure' })]);
    await d.idle();
    expect(seen).toEqual([{ kind: 'session', sessionId: 's-1' }]);
  });

  it('does not match a github fact that has no repo', async () => {
    const b = sendTo('s-1', ['ci_done']);
    const seen: ScheduleTarget[] = [];
    const { d } = make({ launch: async (s) => { seen.push(s.target); return 'busy'; } });
    await d.handle([ev(b.id, { repo: undefined })]);
    await d.idle();
    expect(seen).toEqual([]);
  });

  it('matches any ci_done outcome for ci_done', async () => {
    const b = sendTo('s-1', ['ci_done']);
    const seen: ScheduleTarget[] = [];
    const { d } = make({ launch: async (s) => { seen.push(s.target); return 'busy'; } });
    await d.handle([ev(b.id, { outcome: 'cancelled' })]);
    await d.idle();
    expect(seen).toHaveLength(1);
  });

  it('applies the label filter when the binding has one', async () => {
    const b = sendTo('s-2', ['issue_opened'], { pr: undefined, labels: ['bug'] });
    const seen: ScheduleTarget[] = [];
    const { d } = make({ launch: async (s) => { seen.push(s.target); return 'busy'; } });
    await d.handle([ev(b.id, { event: 'issue_opened', number: 3, labels: ['docs'] }), ev(b.id, { event: 'issue_opened', number: 4 })]);
    await d.idle();
    expect(seen).toEqual([]);
    await d.handle([ev(b.id, { event: 'issue_opened', number: 5, labels: ['docs', 'bug'] })]);
    await d.idle();
    expect(seen).toHaveLength(1);
    // 札の大文字小文字は区別しない。
    await d.handle([ev(b.id, { event: 'issue_opened', number: 6, labels: ['BUG'] })]);
    await d.idle();
    expect(seen).toHaveLength(2);
  });

  it('matches hook events without a repo', async () => {
    const b = bind({ source: { kind: 'hook' }, action: { kind: 'new', projectId: 'pj' } });
    const { d, launched, waits } = make();
    await d.handle([{ bindingId: b.id, atStart: false, facts: { source: 'hook', event: 'hook', body: '{"x":1}', receivedAt: now } }]);
    await flush();
    expect(launched[0]!.target).toMatchObject({ kind: 'new', projectId: 'pj' });
    waits[0]!({ result: 'finished' });
    await d.idle();
    expect(runs(b.id)[0]).toMatchObject({ result: 'finished' });
  });

  it('drops expired wake bindings on each handle', async () => {
    const b = bind();
    now = T0 + 31 * 24 * HOUR;
    const { d, launched } = make();
    pause();
    await d.handle([ev(b.id)]);
    await d.idle();
    expect(launched).toEqual([]);
    expect(getBindingRow(db, b.id)).toBeNull();
  });
});

describe('send and new', () => {
  it('coalesces events that arrive while a run is going', async () => {
    const b = sendTo('s-1');
    const { d, launched, waits } = make();
    await d.handle([ev(b.id, { event: 'comment', url: 'https://example.test/c1' })]);
    await flush();
    expect(launched).toHaveLength(1);
    await d.handle([ev(b.id, { event: 'comment', url: 'https://example.test/c2' })]);
    await d.handle([ev(b.id, { event: 'comment', url: 'https://example.test/c3' })]);
    await flush();
    expect(launched).toHaveLength(1);
    waits[0]!({ result: 'finished' });
    await flush();
    expect(launched).toHaveLength(2);
    expect(launched[1]!.prompt).toContain('c2');
    expect(launched[1]!.prompt).toContain('c3');
    waits[1]!({ result: 'finished' });
    await d.idle();
    expect(launched).toHaveLength(2);
    expect(runs(b.id).map((r) => r.result)).toEqual(['finished', 'finished']);
  });

  it('holds the binding after 12 runs in an hour', async () => {
    const b = sendTo('s-1');
    const { d, launched, waits, notices } = make();
    for (let i = 0; i < EVENT_HOURLY_MAX; i++) {
      await d.handle([ev(b.id, { event: 'comment' })]);
      await flush();
      waits[i]!({ result: 'finished' });
      await flush();
    }
    expect(launched).toHaveLength(EVENT_HOURLY_MAX);
    await d.handle([ev(b.id, { event: 'comment' })]);
    await d.idle();
    expect(launched).toHaveLength(EVENT_HOURLY_MAX);
    expect(getBinding(db, b.id)!.state).toBe('held');
    expect(runs(b.id)[0]).toMatchObject({ result: 'skipped', error: 'held:hourly' });
    expect(notices).toEqual([`Stopped after the hourly limit (${EVENT_HOURLY_MAX})`]);
    // 止まったあとは、届いても動かない。
    await d.handle([ev(b.id, { event: 'comment' })]);
    await d.idle();
    expect(launched).toHaveLength(EVENT_HOURLY_MAX);
  });

  it('counts again after an hour', async () => {
    const b = sendTo('s-1');
    const { d, launched, waits } = make();
    for (let i = 0; i < EVENT_HOURLY_MAX; i++) {
      await d.handle([ev(b.id, { event: 'comment' })]);
      await flush();
      waits[i]!({ result: 'finished' });
      await flush();
    }
    now += HOUR + 1;
    await d.handle([ev(b.id, { event: 'comment' })]);
    await flush();
    expect(launched).toHaveLength(EVENT_HOURLY_MAX + 1);
    expect(getBinding(db, b.id)!.state).toBe('active');
  });

  it('queues send and new events at start for the user', async () => {
    const send = sendTo('s-1');
    const mk = bind({ action: { kind: 'new', projectId: 'pj' }, source: { kind: 'hook' } });
    const heldCounts: number[] = [];
    const { d, launched, waits } = make({ onHeldForUser: (n) => { heldCounts.push(n); } });
    await d.handle([ev(send.id, { event: 'comment', url: 'https://example.test/1' }, true), ev(send.id, { event: 'comment', url: 'https://example.test/2' }, true),
      { bindingId: mk.id, atStart: true, facts: { source: 'hook', event: 'hook', body: 'a', receivedAt: now } }]);
    await flush();
    expect(launched).toEqual([]);
    expect(heldCounts).toEqual([3]);
    expect(d.heldForUser().map((h) => [h.bindingId, h.facts.length])).toEqual([[send.id, 2], [mk.id, 1]]);

    await d.runHeld([{ bindingId: send.id, mode: 'latest' }, { bindingId: mk.id, mode: 'skip' }]);
    await flush();
    expect(launched).toHaveLength(1);
    expect(launched[0]!.prompt).toContain('/2');
    expect(launched[0]!.prompt).not.toContain('/1');
    expect(d.heldForUser()).toEqual([]);
    waits[0]!({ result: 'finished' });
    await d.idle();
  });

  it('runs all held events as one coalesced run', async () => {
    const send = sendTo('s-1');
    const { d, launched, waits } = make();
    await d.handle([ev(send.id, { event: 'comment', url: 'https://example.test/1' }, true), ev(send.id, { event: 'comment', url: 'https://example.test/2' }, true)]);
    await d.runHeld([{ bindingId: send.id, mode: 'all' }]);
    await flush();
    expect(launched).toHaveLength(1);
    expect(launched[0]!.prompt).toContain('/1');
    expect(launched[0]!.prompt).toContain('/2');
    waits[0]!({ result: 'finished' });
    await d.idle();
  });

  it('drops held events whose binding is no longer active', async () => {
    const send = sendTo('s-1');
    const { d, launched } = make();
    await d.handle([ev(send.id, { event: 'comment' }, true)]);
    updateBinding(db, send.id, { state: 'draft' });
    expect(d.heldForUser()).toEqual([]);
    await d.runHeld([{ bindingId: send.id, mode: 'all' }]);
    await flush();
    expect(launched).toEqual([]);
  });

  it('routes send_pr_owner to the claimed session', async () => {
    const b = bind({ action: { kind: 'send_pr_owner' }, source: gh({ when: ['review'], pr: undefined }) });
    claimPr(db, { sessionId: 's-owner', repo: 'octo/demo', pr: 7, state: 'active', now });
    claimPr(db, { sessionId: 's-draft', repo: 'octo/demo', pr: 8, state: 'draft', now });
    const { d, launched, waits } = make();
    await d.handle([ev(b.id, { event: 'review', number: 7, actor: 'bob' })]);
    await flush();
    expect(launched.map((l) => l.target)).toEqual([{ kind: 'session', sessionId: 's-owner' }]);
    waits[0]!({ result: 'finished' });
    await d.idle();
    // 持ち主が見つからない PR は、履歴に宛先なしを残す。
    await d.handle([ev(b.id, { event: 'review', number: 8 }), ev(b.id, { event: 'review', number: 99 })]);
    await d.idle();
    expect(launched).toHaveLength(1);
    expect(runs(b.id).slice(0, 2).map((r) => [r.result, r.error])).toEqual([['skipped', 'no_destination'], ['skipped', 'no_destination']]);
  });

  it('records a failed run when the launch throws, and keeps the binding active', async () => {
    const b = sendTo('s-1');
    const { d } = make({ launch: async () => { throw new Error('boom'); } });
    await d.handle([ev(b.id, { event: 'comment' })]);
    await d.idle();
    expect(runs(b.id)[0]).toMatchObject({ result: 'failed', error: 'boom' });
    expect(getBinding(db, b.id)!.state).toBe('active');
  });
});

describe('webhook の後片付け', () => {
  it('does not ask to release hooks when a closed pr drops nothing', async () => {
    let n = 0;
    const { d } = make({ releaseHooks: () => { n++; } });
    await d.handle([{ bindingId: 'none', atStart: false, facts: { source: 'github', event: 'closed', repo: 'octo/demo', number: 7, receivedAt: now } }]);
    await d.idle();
    // handle の頭の 1 回だけ。
    expect(n).toBe(1);
  });

  it('asks to release hooks at start, on each handle, and after a binding is removed', async () => {
    let n = 0;
    const { d } = make({ releaseHooks: () => { n++; } });
    d.start();
    expect(n).toBe(1);
    const b = bind();
    pause();
    await d.handle([ev(b.id)]);
    await d.idle();
    // handle の頭の 1 回と、起こして結び付けを消した 1 回。
    expect(n).toBe(3);
  });

  it('asks to release hooks after a closed pr drops its wake bindings, and survives a throwing release', async () => {
    const closed = bind();
    let n = 0;
    const { d } = make({ releaseHooks: () => { n++; throw new Error('boom'); } });
    await d.handle([ev(closed.id, { event: 'closed' })]);
    await d.idle();
    expect(getBinding(db, closed.id)).toBeNull();
    expect(n).toBeGreaterThanOrEqual(2);
  });
});
