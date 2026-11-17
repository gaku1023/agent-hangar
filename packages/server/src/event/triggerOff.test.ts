import { generateInboxKeyPair, eventTriggerOf } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { migrateEventTrigger } from './migrateTrigger.ts';
import { EventPuller } from './puller.ts';
import { EventBindingService } from './service.ts';
import { createBinding } from './store.ts';

// 外のできごと（#563）は既定で切。入れた人（結び付けがある PC）だけが、そのまま動く。
let db: Db;
beforeEach(() => { db = openDb(':memory:'); });
afterEach(() => { db.close(); });

const addBinding = async (): Promise<void> => {
  const kp = await generateInboxKeyPair();
  createBinding(db, { inboxId: 'i-1', inboxPublicKey: kp.publicKey, inboxPrivateKey: kp.privateKey, source: { kind: 'hook' }, action: { kind: 'send', sessionId: 's' }, prompt: 'p', state: 'active' }, Date.now());
};

describe('eventTriggerOf', () => {
  it('無いときと入り以外は切として読む', () => {
    expect(eventTriggerOf({})).toBe(false);
    expect(eventTriggerOf({ eventTrigger: false })).toBe(false);
    expect(eventTriggerOf({ eventTrigger: true })).toBe(true);
  });
});

describe('migrateEventTrigger', () => {
  it('結び付けが無い PC は切のまま、項目も足さない', () => {
    const s: { eventTrigger?: boolean } = {};
    expect(migrateEventTrigger(db, s)).toBe(false);
    expect('eventTrigger' in s).toBe(false);
  });
  it('承認済みの結び付けが 1 件ある PC は入りに移す', async () => {
    await addBinding();
    const s: { eventTrigger?: boolean } = {};
    expect(migrateEventTrigger(db, s)).toBe(true);
    expect(s.eventTrigger).toBe(true);
  });
  it('利用者が決めた値（切を含む）は書き替えない', async () => {
    await addBinding();
    const s = { eventTrigger: false };
    expect(migrateEventTrigger(db, s)).toBe(false);
    expect(s.eventTrigger).toBe(false);
  });
});

describe('切の間', () => {
  it('puller は受け箱を見に行かず、結び付けも無いものとして答える', async () => {
    await addBinding();
    const api = vi.fn(() => null);
    let on = false;
    const p = new EventPuller({ db, api, enabled: () => on });
    expect(p.hasBindings()).toBe(false);
    expect(await p.pull('bell')).toEqual([]);
    expect(api).not.toHaveBeenCalled();
    on = true;
    expect(p.hasBindings()).toBe(true);
    await p.pull('bell');
    expect(api).toHaveBeenCalled();
  });
  it('結び付けを作らせない', async () => {
    const svc = new EventBindingService({ db, deviceId: 'pc', hooks: {} as never, changed: () => undefined, language: () => 'ja', enabled: () => false });
    await expect(svc.create({ source: { kind: 'hook' }, action: { kind: 'send', sessionId: 's' }, prompt: 'p', passBody: false, allowAuthors: [] })).rejects.toThrow();
    expect(await svc.createWake('s', { repo: 'a/b', pr: 1, when: 'merged' } as never)).toMatchObject({ status: 'failed' });
  });
});
