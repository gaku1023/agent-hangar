import { EVENT_BINDINGS_MAX, SCHEDULE_RUNS_KEPT, WAKE_BINDING_TTL_MS, generateInboxKeyPair, type EventAction, type EventSource } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import type { Db } from '../db/open.ts';
import { addEventRun, bindingsForInbox, claimPr, createBinding, deleteBinding, expireBindings, finishEventRun, getBinding, listBindings, markDelivery, prOwner, updateBinding, type BindingInput } from './store.ts';

let db: Db;
const T0 = new Date(2026, 10, 10, 9, 0).getTime();
const DAY = 24 * 60 * 60_000;
const gh: EventSource = { kind: 'github', repo: 'octo/demo', when: ['ci_done'], pr: 7 };
const wake: EventAction = { kind: 'wake', sessionId: 's-1' };

beforeEach(() => { db = openDb(':memory:'); });
afterEach(() => { db.close(); });

let seq = 0;
const input = (over: Partial<BindingInput> = {}): BindingInput => ({
  inboxId: `inbox-${seq++}`, inboxPublicKey: 'PUBKEY', inboxPrivateKey: 'PRIVKEY-SECRET',
  source: gh, action: wake, prompt: 'check it', ...over,
});

describe('結び付けの保存', () => {
  it('creates, reads, updates and deletes a binding', () => {
    const b = createBinding(db, input({ passBody: true, allowAuthors: ['alice'] }), T0);
    expect(b.state).toBe('draft');
    expect(b.hookUrl).toBeNull();
    expect(b.passBody).toBe(true);
    expect(b.allowAuthors).toEqual(['alice']);
    expect(b.expiresAt).toBe(T0 + WAKE_BINDING_TTL_MS);
    expect(getBinding(db, b.id)).toEqual(b);
    expect(listBindings(db).map((x) => x.id)).toEqual([b.id]);
    const u = updateBinding(db, b.id, { state: 'active', prompt: 'next', allowAuthors: [] });
    expect(u.state).toBe('active');
    expect(u.prompt).toBe('next');
    expect(u.allowAuthors).toEqual([]);
    expect(deleteBinding(db, b.id)).toBe(true);
    expect(getBinding(db, b.id)).toBeNull();
    expect(deleteBinding(db, b.id)).toBe(false);
  });

  it('dto never contains secret columns', async () => {
    const kp = await generateInboxKeyPair();
    const b = createBinding(db, input({ inboxId: 'in-secret', inboxPublicKey: kp.publicKey, inboxPrivateKey: kp.privateKey, webhookId: 99, hookSecret: 'HOOK-SECRET-VALUE' }), T0);
    addEventRun(db, { bindingId: b.id, now: T0, result: 'finished' });
    const dumps = [JSON.stringify(b), JSON.stringify(getBinding(db, b.id)), JSON.stringify(listBindings(db)), JSON.stringify(updateBinding(db, b.id, { state: 'active' }))];
    for (const s of dumps) {
      expect(s).not.toContain(kp.privateKey);
      expect(s).not.toContain('HOOK-SECRET-VALUE');
      expect(s).not.toContain(kp.publicKey);
    }
    // 秘密は表には残っていて、引き取る側の行からは読める。
    const row = bindingsForInbox(db, 'in-secret')[0]!;
    expect(row.inboxPrivateKey).toBe(kp.privateKey);
    expect(row.hookSecret).toBe('HOOK-SECRET-VALUE');
    expect(row.webhookId).toBe(99);
  });

  it('refuses the 51st binding', () => {
    for (let i = 0; i < EVENT_BINDINGS_MAX; i++) createBinding(db, input(), T0);
    expect(() => createBinding(db, input(), T0)).toThrow();
    expect(listBindings(db)).toHaveLength(EVENT_BINDINGS_MAX);
  });

  it('finds bindings by inbox id', () => {
    const a = createBinding(db, input({ inboxId: 'in-a' }), T0);
    createBinding(db, input({ inboxId: 'in-b' }), T0);
    const rows = bindingsForInbox(db, 'in-a');
    expect(rows.map((r) => r.id)).toEqual([a.id]);
    expect(rows[0]!.inboxPrivateKey).toBe('PRIVKEY-SECRET');
    expect(rows[0]!.source).toEqual(gh);
  });

  it('sets no expiry for non-wake bindings', () => {
    const b = createBinding(db, input({ action: { kind: 'send', sessionId: 's-1' } }), T0);
    expect(b.expiresAt).toBeNull();
  });

  it('expireBindings removes wake bindings older than 30 days', () => {
    const old = createBinding(db, input(), T0);
    addEventRun(db, { bindingId: old.id, now: T0, result: 'finished' });
    const fresh = createBinding(db, input(), T0 + 10 * DAY);
    const send = createBinding(db, input({ action: { kind: 'send', sessionId: 's-1' } }), T0);
    expect(expireBindings(db, T0 + 29 * DAY)).toBe(0);
    expect(expireBindings(db, T0 + 31 * DAY)).toBe(1);
    expect(getBinding(db, old.id)).toBeNull();
    expect(getBinding(db, fresh.id)).not.toBeNull();
    expect(getBinding(db, send.id)).not.toBeNull();
    expect(db.prepare('select count(*) c from event_runs').get()).toEqual({ c: 0 });
  });
});

describe('実行の履歴', () => {
  it('keeps only 5 runs', () => {
    const b = createBinding(db, input(), T0);
    for (let i = 0; i < SCHEDULE_RUNS_KEPT + 3; i++) addEventRun(db, { bindingId: b.id, now: T0 + i, result: 'finished' });
    const runs = getBinding(db, b.id)!.runs;
    expect(runs).toHaveLength(SCHEDULE_RUNS_KEPT);
    expect(runs[0]!.startedAt).toBe(T0 + SCHEDULE_RUNS_KEPT + 2);
  });

  it('keeps a running run when trimming, and closing it makes it trimmable', () => {
    const b = createBinding(db, input(), T0);
    const running = addEventRun(db, { bindingId: b.id, now: T0, result: 'running' });
    for (let i = 1; i <= 6; i++) addEventRun(db, { bindingId: b.id, now: T0 + i, result: 'finished' });
    expect(getBinding(db, b.id)!.runs.some((r) => r.id === running)).toBe(true);
    finishEventRun(db, running, { now: T0 + 100, result: 'finished' });
    expect(getBinding(db, b.id)!.runs).toHaveLength(SCHEDULE_RUNS_KEPT);
    finishEventRun(db, 'missing', { now: T0, result: 'finished' });
  });

  it('records finished state, error and plannedAt', () => {
    const b = createBinding(db, input(), T0);
    const id = addEventRun(db, { bindingId: b.id, now: T0, result: 'running' });
    finishEventRun(db, id, { now: T0 + 5, result: 'failed', error: 'boom' });
    expect(getBinding(db, b.id)!.runs[0]).toMatchObject({ id, plannedAt: T0, startedAt: T0, endedAt: T0 + 5, result: 'failed', error: 'boom' });
  });
});

describe('届いた荷物の重複', () => {
  it('markDelivery is true once per binding and delivery id', () => {
    const a = createBinding(db, input(), T0);
    const b = createBinding(db, input(), T0);
    expect(markDelivery(db, a.id, 'd-1', T0)).toBe(true);
    expect(markDelivery(db, a.id, 'd-1', T0 + 1)).toBe(false);
    expect(markDelivery(db, b.id, 'd-1', T0)).toBe(true);
  });

  it('forgets old deliveries and those of a deleted binding', () => {
    const a = createBinding(db, input(), T0);
    markDelivery(db, a.id, 'd-1', T0);
    markDelivery(db, a.id, 'd-2', T0 + 8 * DAY);
    expect(db.prepare('select count(*) c from event_deliveries').get()).toEqual({ c: 1 });
    deleteBinding(db, a.id);
    expect(db.prepare('select count(*) c from event_deliveries').get()).toEqual({ c: 0 });
  });
});

describe('PR の持ち主', () => {
  it('prOwner ignores draft claims', () => {
    claimPr(db, { sessionId: 's-1', repo: 'octo/demo', pr: 7, state: 'draft' });
    expect(prOwner(db, 'octo/demo', 7)).toBeNull();
    claimPr(db, { sessionId: 's-1', repo: 'octo/demo', pr: 7, state: 'active' });
    expect(prOwner(db, 'octo/demo', 7)).toBe('s-1');
    expect(prOwner(db, 'octo/demo', 8)).toBeNull();
    expect(prOwner(db, 'octo/other', 7)).toBeNull();
  });

  it('claiming again by the same session does not duplicate, a later active claim wins', () => {
    claimPr(db, { sessionId: 's-1', repo: 'octo/demo', pr: 7, state: 'active', now: T0 });
    claimPr(db, { sessionId: 's-1', repo: 'octo/demo', pr: 7, state: 'active', now: T0 + 1 });
    expect(db.prepare('select count(*) c from session_prs').get()).toEqual({ c: 1 });
    claimPr(db, { sessionId: 's-2', repo: 'octo/demo', pr: 7, state: 'active', now: T0 + 2 });
    expect(prOwner(db, 'octo/demo', 7)).toBe('s-2');
  });

  it('a draft claim does not demote an active one', () => {
    claimPr(db, { sessionId: 's-1', repo: 'octo/demo', pr: 7, state: 'active' });
    claimPr(db, { sessionId: 's-1', repo: 'octo/demo', pr: 7, state: 'draft' });
    expect(prOwner(db, 'octo/demo', 7)).toBe('s-1');
  });
});
