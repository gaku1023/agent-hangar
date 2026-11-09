import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_INBOX_ACK_MAX, EVENT_INBOX_PULL_PAGE, generateInboxKeyPair, sealToInbox, type EventAction, type EventSource } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import type { Db } from '../db/open.ts';
import { openDb } from '../db/open.ts';
import { inboxApiOf, type InboxApi } from './inboxClient.ts';
import { EventPuller, type PulledEvent } from './puller.ts';
import { createBinding, deleteBinding, getBinding } from './store.ts';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fx = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
const T0 = new Date(2026, 10, 10, 9, 0).getTime();
const SECRET = 'hook-secret-for-tests';
const gh: EventSource = { kind: 'github', repo: 'octo-org/demo-repo', when: ['ci_done'] };
const wake: EventAction = { kind: 'wake', sessionId: 's-1' };

let db: Db;
let client: FakeCloudClient;
let delivered: PulledEvent[][];
let n = 0;

beforeEach(() => {
  db = openDb(':memory:');
  client = new FakeCloudClient({ deviceId: 'pc-a' });
  delivered = [];
  n = 0;
});
afterEach(() => { db.close(); vi.restoreAllMocks(); });

const puller = (api: () => InboxApi | null = () => inboxApiOf(client), o: { onPulled?: (e: PulledEvent[]) => void } = {}) =>
  new EventPuller({ db, api, now: () => T0, me: () => 'alice-dev', onPulled: o.onPulled ?? ((e) => { delivered.push(e); }) });

type Inbox = { inboxId: string; kp: { publicKey: string; privateKey: string }; bindingId: string };

/** 受け箱を作り、結び付けを 1 つ置く。同じ受け箱に結び付けを足すときは inbox を渡す。 */
async function addBinding(o: { source?: EventSource; secret?: string | null; inbox?: Inbox } = {}): Promise<Inbox> {
  const kp = o.inbox?.kp ?? (await generateInboxKeyPair());
  const inboxId = o.inbox?.inboxId ?? (await client.createInbox(kp.publicKey)).inboxId;
  const secret = o.secret === null ? undefined : (o.secret ?? SECRET);
  const b = createBinding(db, {
    inboxId, inboxPublicKey: kp.publicKey, inboxPrivateKey: kp.privateKey, source: o.source ?? gh, action: wake, prompt: 'go', state: 'active',
    ...(secret !== undefined && (o.source ?? gh).kind === 'github' ? { hookSecret: secret } : {}),
  }, T0);
  return { inboxId, kp, bindingId: b.id };
}

const sign = (secret: string, body: string): string => `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

/** GitHub の荷物を封じて偽の Worker に置く。 */
async function post(inbox: Inbox, event: string, payload: unknown, o: { secret?: string; delivery?: string | null; rawBody?: string; sealKey?: string } = {}): Promise<void> {
  const body = o.rawBody ?? JSON.stringify(payload);
  const headers: Record<string, string> = { 'x-github-event': event, 'x-hub-signature-256': sign(o.secret ?? SECRET, body), 'content-type': 'application/json' };
  if (o.delivery !== null) headers['x-github-delivery'] = o.delivery ?? `d-${n++}`;
  const sealed = await sealToInbox(o.sealKey ?? inbox.kp.publicKey, inbox.inboxId, { receivedAt: T0 - 1000, headers, body });
  client.postParcel(inbox.inboxId, sealed);
}

const runsOf = (id: string) => getBinding(db, id)!.runs;
const calls = (m: string) => client.calls.filter((c) => c.method === m);

describe('EventPuller', () => {
  it('pulls on bell and on start and acks', async () => {
    const inbox = await addBinding();
    await post(inbox, 'issues', fx('issues.opened'));
    const p = puller();
    const a = await p.pull('bell');
    expect(a).toEqual([{ bindingId: inbox.bindingId, atStart: false, facts: expect.objectContaining({ source: 'github', event: 'issue_opened', number: 51, receivedAt: T0 - 1000 }) }]);
    expect(client.parcels).toHaveLength(0);
    expect(calls('ackParcels')).toHaveLength(1);
    await post(inbox, 'pull_request', fx('pull_request.merged'));
    const b = await p.pull('start');
    expect(b).toEqual([{ bindingId: inbox.bindingId, atStart: true, facts: expect.objectContaining({ event: 'merged', number: 42 }) }]);
    expect(client.parcels).toHaveLength(0);
    expect(delivered.map((d) => d.length)).toEqual([1, 1]);
  });

  it('drains every page and acks in batches within the limit', async () => {
    const inbox = await addBinding();
    const total = EVENT_INBOX_PULL_PAGE * 2 + 5;
    for (let i = 0; i < total; i++) await post(inbox, 'issues', fx('issues.opened'));
    const out = await puller().pull('bell');
    expect(out).toHaveLength(total);
    expect(client.parcels).toHaveLength(0);
    for (const c of calls('ackParcels')) expect((c.args[0] as string[]).length).toBeLessThanOrEqual(EVENT_INBOX_ACK_MAX);
    // 3 ページ分の荷物を読み、最後に空のページを 1 回読む。
    expect(calls('pendingParcels')).toHaveLength(4);
  });

  it('rejects a parcel with a bad signature and records it', async () => {
    const inbox = await addBinding();
    await post(inbox, 'issues', fx('issues.opened'), { secret: 'not-the-secret' });
    const out = await puller().pull('bell');
    expect(out).toEqual([{ bindingId: inbox.bindingId, rejected: 'signature' }]);
    expect(client.parcels).toHaveLength(0);
    const r = runsOf(inbox.bindingId);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ result: 'failed', error: 'rejected:signature' });
  });

  it('rejects a github binding that has no secret yet', async () => {
    const inbox = await addBinding({ secret: null });
    await post(inbox, 'issues', fx('issues.opened'));
    expect(await puller().pull('bell')).toEqual([{ bindingId: inbox.bindingId, rejected: 'signature' }]);
  });

  it('skips a redelivered parcel silently', async () => {
    const inbox = await addBinding();
    await post(inbox, 'issues', fx('issues.opened'), { delivery: 'same-delivery' });
    await post(inbox, 'issues', fx('issues.opened'), { delivery: 'same-delivery' });
    const out = await puller().pull('bell');
    expect(out).toHaveLength(1);
    expect(client.parcels).toHaveLength(0);
    expect(runsOf(inbox.bindingId)).toHaveLength(0);
    // あとから同じ ID が来ても出さない。
    await post(inbox, 'issues', fx('issues.opened'), { delivery: 'same-delivery' });
    expect(await puller().pull('bell')).toEqual([]);
  });

  it('gives each binding on a shared inbox its own verdict', async () => {
    const one = await addBinding();
    const two = await addBinding({ inbox: one });
    const bad = await addBinding({ inbox: one, secret: 'another-secret' });
    await post(one, 'issues', fx('issues.opened'));
    const out = await puller().pull('bell');
    expect(out).toHaveLength(3);
    expect(out).toContainEqual(expect.objectContaining({ bindingId: one.bindingId, facts: expect.objectContaining({ event: 'issue_opened' }) }));
    expect(out).toContainEqual(expect.objectContaining({ bindingId: two.bindingId, facts: expect.objectContaining({ event: 'issue_opened' }) }));
    expect(out).toContainEqual({ bindingId: bad.bindingId, rejected: 'signature' });
  });

  it('turns an external hook body into facts without a signature or delivery id', async () => {
    const kp = await generateInboxKeyPair();
    const { inboxId } = await client.createInbox(kp.publicKey);
    const b = createBinding(db, { inboxId, inboxPublicKey: kp.publicKey, inboxPrivateKey: kp.privateKey, source: { kind: 'hook' }, action: wake, prompt: 'go', state: 'active' }, T0);
    const sealed = await sealToInbox(kp.publicKey, inboxId, { receivedAt: T0 - 5, headers: { 'content-type': 'text/plain' }, body: 'deploy finished' });
    client.postParcel(inboxId, sealed);
    client.postParcel(inboxId, sealed);
    const out = await puller().pull('bell');
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ bindingId: b.id, atStart: false, facts: { source: 'hook', event: 'hook', body: 'deploy finished', receivedAt: T0 - 5 } });
  });

  it('ignores events it does not read, and still acks them', async () => {
    const inbox = await addBinding();
    await post(inbox, 'star', fx('star.created'));
    await post(inbox, 'ping', { zen: 'Keep it simple.' });
    expect(await puller().pull('bell')).toEqual([]);
    expect(client.parcels).toHaveLength(0);
    expect(runsOf(inbox.bindingId)).toHaveLength(0);
  });

  it('counts check suites across parcels and emits one ci_done', async () => {
    const inbox = await addBinding();
    await post(inbox, 'check_suite', fx('check_suite.requested'));
    await post(inbox, 'check_suite', fx('check_suite.requested.second'));
    await post(inbox, 'check_suite', fx('check_suite.completed.failure'));
    const p = puller();
    expect(await p.pull('bell')).toEqual([]);
    await post(inbox, 'check_suite', fx('check_suite.completed.success'));
    const out = await p.pull('bell');
    expect(out).toEqual([expect.objectContaining({ facts: expect.objectContaining({ event: 'ci_done', outcome: 'failure', number: 42 }) })]);
  });

  it('records unparsable parcels and acks them', async () => {
    const inbox = await addBinding();
    const other = await generateInboxKeyPair();
    // 別の鍵で封じた荷物は開けない。
    await post(inbox, 'issues', fx('issues.opened'), { sealKey: other.publicKey });
    // 署名は合っても本文が JSON でない荷物。
    await post(inbox, 'issues', null, { rawBody: 'not json' });
    // 配送の ID が無い荷物は、再送と見分けられないので受けない。
    await post(inbox, 'issues', fx('issues.opened'), { delivery: null });
    const out = await puller().pull('bell');
    expect(out).toEqual([
      { bindingId: inbox.bindingId, rejected: 'unparsable' },
      { bindingId: inbox.bindingId, rejected: 'unparsable' },
      { bindingId: inbox.bindingId, rejected: 'unparsable' },
    ]);
    expect(client.parcels).toHaveLength(0);
    expect(runsOf(inbox.bindingId).map((r) => r.error)).toEqual(['rejected:unparsable', 'rejected:unparsable', 'rejected:unparsable']);
  });

  it('acks a parcel whose inbox has no binding, without an event or a record', async () => {
    const orphan = await addBinding();
    const kept = await addBinding();
    await post(orphan, 'issues', fx('issues.opened'));
    deleteBinding(db, orphan.bindingId);
    expect(await puller().pull('bell')).toEqual([]);
    expect(client.parcels).toHaveLength(0);
    expect(runsOf(kept.bindingId)).toHaveLength(0);
  });

  it('records dropped counts in run history', async () => {
    const one = await addBinding();
    const two = await addBinding({ inbox: one });
    const lone = await addBinding();
    client.inboxes.get(one.inboxId)!.dropped = 7;
    await post(one, 'issues', fx('issues.opened'));
    await puller().pull('bell');
    for (const id of [one.bindingId, two.bindingId]) expect(runsOf(id).find((r) => r.error === 'dropped:7')).toMatchObject({ result: 'skipped' });
    expect(runsOf(lone.bindingId)).toHaveLength(0);
    // ack が数を戻したので、次の取得では数えない。
    expect(client.inboxes.get(one.inboxId)!.dropped).toBe(0);
    await puller().pull('bell');
    expect(runsOf(one.bindingId).filter((r) => r.error === 'dropped:7')).toHaveLength(1);
  });

  it('records dropped counts even when no parcel is left', async () => {
    const inbox = await addBinding();
    client.inboxes.get(inbox.inboxId)!.dropped = 3;
    expect(await puller().pull('bell')).toEqual([]);
    expect(runsOf(inbox.bindingId)[0]).toMatchObject({ result: 'skipped', error: 'dropped:3' });
    expect(client.inboxes.get(inbox.inboxId)!.dropped).toBe(0);
  });

  it('does not touch the network when there is no binding', async () => {
    expect(await puller().pull('start')).toEqual([]);
    expect(await puller(() => null).pull('bell')).toEqual([]);
    expect(calls('pendingParcels')).toHaveLength(0);
  });

  it('never runs two pulls at once and coalesces requests made meanwhile into one more pass', async () => {
    await addBinding();
    const real = inboxApiOf(client)!;
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let started = 0;
    let running = 0;
    let overlap = false;
    const api: InboxApi = {
      ...real,
      pendingParcels: async () => {
        started++;
        running++;
        if (running > 1) overlap = true;
        if (started === 1) await gate;
        const r = await real.pendingParcels();
        running--;
        return r;
      },
    };
    const p = puller(() => api);
    const first = p.pull('bell');
    await vi.waitFor(() => { expect(started).toBe(1); });
    const second = p.pull('bell');
    const third = p.pull('start');
    open();
    await Promise.all([first, second, third]);
    // 1 回目と、待たせた分をまとめた 2 回目の、2 巡だけ。巡ごとに空のページを 1 回読む。
    expect(started).toBe(2);
    expect(overlap).toBe(false);
  });

  it('marks the coalesced pass as the start pass when a start request joined it', async () => {
    const inbox = await addBinding();
    const real = inboxApiOf(client)!;
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let first = true;
    // 1 巡目は止めたまま空のページで終わらせ、置いた荷物は 2 巡目に残す。
    const api: InboxApi = { ...real, pendingParcels: async () => { if (first) { first = false; await gate; return { items: [], dropped: [] }; } return real.pendingParcels(); } };
    const p = puller(() => api);
    const a = p.pull('bell');
    await post(inbox, 'issues', fx('issues.opened'));
    const b = p.pull('start');
    open();
    await a;
    expect((await b)[0]).toMatchObject({ atStart: true });
  });

  it('hands events to the callback before it acks', async () => {
    const inbox = await addBinding();
    await post(inbox, 'issues', fx('issues.opened'));
    const left: number[] = [];
    await puller(undefined, { onPulled: () => { left.push(client.parcels.length); } }).pull('bell');
    expect(left).toEqual([1]);
    expect(client.parcels).toHaveLength(0);
  });

  it('survives a failing ack, keeps the parcel, and logs without ids or keys', async () => {
    const inbox = await addBinding();
    await post(inbox, 'issues', fx('issues.opened'));
    const real = inboxApiOf(client)!;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await new EventPuller({ db, api: () => ({ ...real, ackParcels: () => Promise.reject(new Error(`boom ${inbox.inboxId} ${inbox.kp.privateKey}`)) }), now: () => T0, onPulled: () => {} }).pull('bell');
    expect(out).toHaveLength(1);
    expect(client.parcels).toHaveLength(1);
    expect(log).toHaveBeenCalled();
    const text = JSON.stringify(log.mock.calls);
    expect(text).not.toContain(inbox.inboxId);
    expect(text).not.toContain(inbox.kp.privateKey);
    // 次の取得で拾い直しても、同じ配送は再び出さない。
    expect(await puller().pull('bell')).toEqual([]);
    expect(client.parcels).toHaveLength(0);
  });

  it('survives a failing callback', async () => {
    const inbox = await addBinding();
    await post(inbox, 'issues', fx('issues.opened'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await puller(undefined, { onPulled: () => { throw new Error('consumer broke'); } }).pull('bell');
    expect(out).toHaveLength(1);
    expect(client.parcels).toHaveLength(0);
  });

  it('stays quiet on an old Worker that has no inbox route', async () => {
    await addBinding();
    client.workerCompat = 11;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await puller().pull('start')).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });
});
