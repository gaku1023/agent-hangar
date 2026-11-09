import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_BODY_MAX_BYTES,
  EVENT_INBOX_KEEP_MS,
  EVENT_INBOX_PENDING_MAX,
  EVENT_INBOX_RATE_PER_MIN,
  generateInboxKeyPair,
  openFromInbox,
  type EventInboxPending,
  type PeerBellMessage,
} from '@agent-hangar/shared';
import { createApp, redactedPath } from '../src/app.ts';
import type { Env } from '../src/env.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sweepOnce } from '../src/sweep.ts';
import { addPcDevice, joinPhoneDevice, startCloud, type CloudHarness } from './harness.ts';

let cloud: CloudHarness;

const send = (path: string, init: RequestInit = {}) => cloud.SELF.fetch(`https://x${path}`, init);
const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const post = (token: string, path: string, body?: unknown) =>
  send(path, { method: 'POST', headers: auth(token, { 'content-type': 'application/json' }), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const get = (token: string, path: string) => send(path, { headers: auth(token) });
const del = (token: string, path: string) => send(path, { method: 'DELETE', headers: auth(token) });

/**
 * 受け箱を作る。
 * 鍵の対は PC 側で作り、公開鍵だけを Worker に渡す。
 */
async function createInbox(token: string): Promise<{ inboxId: string; privateKey: string }> {
  const { publicKey, privateKey } = await generateInboxKeyPair();
  const r = await post(token, '/inboxes', { publicKey });
  expect(r.status).toBe(201);
  const { inboxId } = (await r.json()) as { inboxId: string };
  return { inboxId, privateKey };
}

/**
 * 外から届く webhook の真似。
 * 認証も互換の版の見出しも付けない（GitHub は付けられない）。
 */
const hook = (inboxId: string, body: string, headers: Record<string, string> = {}) =>
  cloud.RAW.fetch(`https://x/hooks/${inboxId}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

const pending = async (token: string): Promise<EventInboxPending> => {
  const r = await get(token, '/inboxes/pending');
  expect(r.status).toBe(200);
  return (await r.json()) as EventInboxPending;
};

const parcelCount = async (inboxId: string): Promise<number> =>
  (await cloud.env.DB.prepare('select count(*) as n from event_parcels where inbox_id = ?').bind(inboxId).first<{ n: number }>())?.n ?? 0;

type MfSocket = {
  accept(): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
};
const openBell = async (token: string) => {
  const r = await send('/m/bell', { headers: { ...auth(token), upgrade: 'websocket' } });
  expect(r.status).toBe(101);
  const ws = (r as unknown as { webSocket: MfSocket }).webSocket;
  ws.accept();
  const queue: string[] = [];
  const waiters: ((m: string) => void)[] = [];
  ws.addEventListener('message', (e) => {
    const m = String(e.data);
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const next = (ms = 3000) =>
    new Promise<PeerBellMessage | { t: string }>((resolve, reject) => {
      const m = queue.shift();
      if (m !== undefined) return resolve(JSON.parse(m));
      const t = setTimeout(() => reject(new Error('呼び鈴に何も届きませんでした')), ms);
      waiters.push((v) => {
        clearTimeout(t);
        resolve(JSON.parse(v));
      });
    });
  return { next, close: () => ws.close(1000, 'bye') };
};

let a: string;
let b: string;

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema(cloud.env);
  a = await addPcDevice(cloud.env, 'pc-a');
  b = await addPcDevice(cloud.env, 'pc-b');
});

afterEach(async () => {
  await cloud.dispose();
});

describe('受け箱を作る（POST /inboxes）', () => {
  it('creates an inbox only for a pc token', async () => {
    const phone = await joinPhoneDevice(cloud, a);
    const { publicKey } = await generateInboxKeyPair();
    expect((await post(phone.token, '/inboxes', { publicKey })).status).toBe(403);
    expect((await send('/inboxes', { method: 'POST', body: JSON.stringify({ publicKey }) })).status).toBe(401);
    const ok = await post(a, '/inboxes', { publicKey });
    expect(ok.status).toBe(201);
    const { inboxId } = (await ok.json()) as { inboxId: string };
    expect(inboxId).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // 宛先はトークンの端末になる。
    const row = await cloud.env.DB.prepare('select device_id, public_key, dropped from event_inboxes where id = ?').bind(inboxId).first();
    expect(row).toEqual({ device_id: 'pc-a', public_key: publicKey, dropped: 0 });
  });

  it('rejects a body that is not a 32 byte public key', async () => {
    for (const body of [{}, { publicKey: 1 }, { publicKey: 'short' }, { publicKey: 'A'.repeat(44) }]) {
      expect((await post(a, '/inboxes', body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('webhook を受ける（POST /hooks/:inboxId）', () => {
  it('stores a sealed parcel and lists it for the owner', async () => {
    const { inboxId, privateKey } = await createInbox(a);
    const plain = JSON.stringify({ action: 'opened', secretWord: 'plaintext-marker-xyz' });
    const r = await hook(inboxId, plain, { 'x-github-event': 'issues', 'x-github-delivery': 'd-1', 'x-hub-signature-256': 'sha256=abc', authorization: 'Bearer leak', 'user-agent': 'GitHub-Hookshot' });
    expect(r.status).toBe(202);
    // 返り値に中身は入れない。
    expect(await r.text()).not.toContain('plaintext-marker-xyz');
    const list = await pending(a);
    expect(list.dropped).toEqual([]);
    expect(list.items).toHaveLength(1);
    const item = list.items[0]!;
    expect(item.inboxId).toBe(inboxId);
    expect(item.sealed).not.toContain('plaintext-marker-xyz');
    expect(item.sealed).not.toContain(btoa('plaintext-marker-xyz'));
    expect(item.receivedAt).toBeGreaterThan(Date.now() - 60_000);
    // Worker（workerd）で封じた荷物が、Node で開ける（実行環境をまたぐ確認）。
    const parcel = await openFromInbox(privateKey, inboxId, item.sealed);
    expect(parcel.body).toBe(plain);
    expect(parcel.receivedAt).toBe(item.receivedAt);
    expect(parcel.headers).toEqual({ 'x-github-event': 'issues', 'x-github-delivery': 'd-1', 'x-hub-signature-256': 'sha256=abc', 'content-type': 'application/json' });
    // 別の受け箱の ID では開けない。
    await expect(openFromInbox(privateKey, 'other-inbox', item.sealed)).rejects.toThrow();
  });

  it('works without any device token or compat header', async () => {
    const { inboxId } = await createInbox(a);
    const r = await cloud.RAW.fetch(`https://x/hooks/${inboxId}`, { method: 'POST', body: 'plain text, not json' });
    expect(r.status).toBe(202);
    expect((await pending(a)).items).toHaveLength(1);
  });

  it("does not list another device's parcels", async () => {
    const mine = await createInbox(a);
    const theirs = await createInbox(b);
    await hook(mine.inboxId, 'for-a');
    await hook(theirs.inboxId, 'for-b');
    const listA = await pending(a);
    const listB = await pending(b);
    expect(listA.items.map((i) => i.inboxId)).toEqual([mine.inboxId]);
    expect(listB.items.map((i) => i.inboxId)).toEqual([theirs.inboxId]);
    expect((await openFromInbox(theirs.privateKey, theirs.inboxId, listB.items[0]!.sealed)).body).toBe('for-b');
  });

  it('rejects unknown inbox with 404', async () => {
    expect((await hook('no-such-inbox', '{}')).status).toBe(404);
    // 形の悪い ID も、中身には触れず 404 で返す。
    expect((await hook('a%20b', '{}')).status).toBe(404);
  });

  it('404s for an inbox whose device was revoked', async () => {
    const { inboxId } = await createInbox(b);
    await cloud.env.DB.prepare("update devices set revoked_at = ? where id = 'pc-b'").bind(Date.now()).run();
    expect((await hook(inboxId, '{}')).status).toBe(404);
    expect(await parcelCount(inboxId)).toBe(0);
  });

  it('rejects body over 64 KiB with 413', async () => {
    const { inboxId } = await createInbox(a);
    const big = 'x'.repeat(EVENT_BODY_MAX_BYTES + 1);
    expect((await hook(inboxId, big)).status).toBe(413);
    // 文字数は上限以下でも、バイト数が上限を超えれば断る。
    expect((await hook(inboxId, 'あ'.repeat(Math.ceil(EVENT_BODY_MAX_BYTES / 3) + 1))).status).toBe(413);
    expect(await parcelCount(inboxId)).toBe(0);
    // ちょうど上限は通る。
    expect((await hook(inboxId, 'x'.repeat(EVENT_BODY_MAX_BYTES))).status).toBe(202);
  });

  it('rate limits 31st request in a minute with 429', async () => {
    const { inboxId } = await createInbox(a);
    for (let i = 0; i < EVENT_INBOX_RATE_PER_MIN; i++) expect((await hook(inboxId, `n${i}`)).status, `request ${i + 1}`).toBe(202);
    expect((await hook(inboxId, 'over')).status).toBe(429);
    // 別の受け箱の枠には響かない。
    const other = await createInbox(b);
    expect((await hook(other.inboxId, 'ok')).status).toBe(202);
  });

  it('drops the 101st parcel and counts it', async () => {
    const { inboxId } = await createInbox(a);
    // 1 分 30 回の枠があるので、先の 99 通は D1 へ直に置く。
    const db = cloud.env.DB;
    const stmts = Array.from({ length: EVENT_INBOX_PENDING_MAX - 1 }, (_, i) =>
      db.prepare('insert into event_parcels (id, inbox_id, sealed, received_at) values (?, ?, ?, ?)').bind(`seed-${i}`, inboxId, '1.c2VlZA', Date.now() - 1000 + i),
    );
    await db.batch(stmts);
    expect((await hook(inboxId, 'hundredth')).status).toBe(202);
    expect(await parcelCount(inboxId)).toBe(EVENT_INBOX_PENDING_MAX);
    // 101 通目は 202 で返して捨て、数だけ残す。
    // 返り値は同じ形で、捨てたことを外へ教えない。
    const r = await hook(inboxId, 'dropped-one');
    expect(r.status).toBe(202);
    expect(await parcelCount(inboxId)).toBe(EVENT_INBOX_PENDING_MAX);
    expect((await hook(inboxId, 'dropped-two')).status).toBe(202);
    const list = await pending(a);
    expect(list.dropped).toEqual([{ inboxId, count: 2 }]);
    expect(list.items.length).toBeLessThanOrEqual(EVENT_INBOX_PENDING_MAX);
  });
});

describe('受け箱を消す（DELETE /inboxes/:id）', () => {
  it('deleting an inbox removes its parcels and 404s the url', async () => {
    const mine = await createInbox(a);
    const other = await createInbox(b);
    await hook(mine.inboxId, 'one');
    await hook(mine.inboxId, 'two');
    await hook(other.inboxId, 'keep');
    // ほかの PC の受け箱は消せない。
    expect((await del(b, `/inboxes/${mine.inboxId}`)).status).toBe(404);
    expect(await parcelCount(mine.inboxId)).toBe(2);
    const r = await del(a, `/inboxes/${mine.inboxId}`);
    expect(r.status).toBe(200);
    expect(await parcelCount(mine.inboxId)).toBe(0);
    expect((await hook(mine.inboxId, 'late')).status).toBe(404);
    expect((await pending(a)).items).toEqual([]);
    // 消した後の再送は 404 で、ほかの受け箱の荷物は残る。
    expect((await del(a, `/inboxes/${mine.inboxId}`)).status).toBe(404);
    expect(await parcelCount(other.inboxId)).toBe(1);
  });
});

describe('引き取り（GET /inboxes/pending と POST /inboxes/ack）', () => {
  it('ack removes parcels and resets dropped', async () => {
    const { inboxId } = await createInbox(a);
    await hook(inboxId, 'one');
    await hook(inboxId, 'two');
    const stuffed = Array.from({ length: EVENT_INBOX_PENDING_MAX }, (_, i) =>
      cloud.env.DB.prepare('insert into event_parcels (id, inbox_id, sealed, received_at) values (?, ?, ?, ?)').bind(`fill-${i}`, inboxId, '1.ZmlsbA', Date.now() + i),
    );
    await cloud.env.DB.batch(stuffed.slice(0, EVENT_INBOX_PENDING_MAX - 2));
    await hook(inboxId, 'dropped');
    const before = await pending(a);
    expect(before.dropped).toEqual([{ inboxId, count: 1 }]);
    const ids = before.items.map((i) => i.id);
    expect(ids.length).toBeGreaterThan(0);
    const r = await post(a, '/inboxes/ack', { ids });
    expect(r.status).toBe(200);
    expect((await pending(a)).dropped).toEqual([]);
    expect(await parcelCount(inboxId)).toBe(EVENT_INBOX_PENDING_MAX - ids.length);
  });

  it('ack only removes own parcels and rejects a malformed body', async () => {
    const mine = await createInbox(a);
    const theirs = await createInbox(b);
    await hook(mine.inboxId, 'mine');
    await hook(theirs.inboxId, 'theirs');
    const theirIds = (await pending(b)).items.map((i) => i.id);
    expect((await post(a, '/inboxes/ack', { ids: theirIds })).status).toBe(200);
    expect(await parcelCount(theirs.inboxId)).toBe(1);
    for (const body of [{}, { ids: 'x' }, { ids: [1] }, { ids: Array.from({ length: 101 }, (_, i) => `i${i}`) }]) {
      expect((await post(a, '/inboxes/ack', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await parcelCount(mine.inboxId)).toBe(1);
  });

  it('pages the pending list oldest first and needs a pc token', async () => {
    const { inboxId } = await createInbox(a);
    const rows = Array.from({ length: 25 }, (_, i) =>
      cloud.env.DB.prepare('insert into event_parcels (id, inbox_id, sealed, received_at) values (?, ?, ?, ?)').bind(`p-${String(i).padStart(2, '0')}`, inboxId, '1.cGFnZQ', 1000 + i),
    );
    await cloud.env.DB.batch(rows);
    const first = await pending(a);
    expect(first.items.map((i) => i.id)).toEqual(Array.from({ length: 20 }, (_, i) => `p-${String(i).padStart(2, '0')}`));
    await post(a, '/inboxes/ack', { ids: first.items.map((i) => i.id) });
    expect((await pending(a)).items.map((i) => i.id)).toEqual(['p-20', 'p-21', 'p-22', 'p-23', 'p-24']);
    const phone = await joinPhoneDevice(cloud, a);
    expect((await get(phone.token, '/inboxes/pending')).status).toBe(403);
    expect((await send('/inboxes/pending')).status).toBe(401);
  });
});

describe('掃除', () => {
  it('sweep deletes parcels older than 7 days', async () => {
    const { inboxId } = await createInbox(a);
    const now = Date.now();
    const db = cloud.env.DB;
    await db.batch([
      db.prepare('insert into event_parcels (id, inbox_id, sealed, received_at) values (?, ?, ?, ?)').bind('old', inboxId, '1.b2xk', now - EVENT_INBOX_KEEP_MS - 1000),
      db.prepare('insert into event_parcels (id, inbox_id, sealed, received_at) values (?, ?, ?, ?)').bind('fresh', inboxId, '1.ZnJlc2g', now - EVENT_INBOX_KEEP_MS + 60_000),
    ]);
    await sweepOnce(cloud.env, now);
    const left = (await db.prepare('select id from event_parcels order by id').all<{ id: string }>()).results.map((r) => r.id);
    expect(left).toEqual(['fresh']);
    // 受け箱そのものは消さない。
    expect((await hook(inboxId, 'still-works')).status).toBe(202);
  });
});

describe('呼び鈴', () => {
  it("rings the owner's bell with kind event", async () => {
    const { inboxId } = await createInbox(a);
    const bellA = await openBell(a);
    const bellB = await openBell(b);
    expect((await hook(inboxId, 'ping')).status).toBe(202);
    expect(await bellA.next()).toEqual({ t: 'peer', kind: 'event', id: inboxId });
    // 持ち主ではない PC の呼び鈴は鳴らない。
    await expect(bellB.next(300)).rejects.toThrow();
    bellA.close();
    bellB.close();
  });

  it('still accepts the parcel when the bell cannot ring', async () => {
    await cloud.dispose();
    cloud = await startCloud({ bell: false });
    resetSchemaCache();
    await ensureSchema(cloud.env);
    a = await addPcDevice(cloud.env, 'pc-a');
    const { inboxId } = await createInbox(a);
    expect((await hook(inboxId, 'quiet')).status).toBe(202);
    expect((await pending(a)).items).toHaveLength(1);
  });
});

describe('記録に受け箱の ID を残さない', () => {
  it('redacts the inbox id in logged paths but keeps fixed routes', () => {
    expect(redactedPath('/hooks/secretid123')).toBe('/hooks/:id');
    expect(redactedPath('/inboxes/secretid123')).toBe('/inboxes/:id');
    expect(redactedPath('/inboxes/pending')).toBe('/inboxes/pending');
    expect(redactedPath('/inboxes/ack')).toBe('/inboxes/ack');
    expect(redactedPath('/inboxes')).toBe('/inboxes');
    expect(redactedPath('/launches/l-1')).toBe('/launches/l-1');
  });

  it('does not write the inbox id to the log when a hook request throws', async () => {
    const id = 'SecretInboxId0123456789abcdef';
    // D1 が必ず投げる束縛で、/hooks/<id> に例外を起こさせる。
    const boom = (): never => {
      throw new Error('D1 is down');
    };
    const env = { DB: { prepare: boom, batch: boom } } as unknown as Env;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      resetSchemaCache();
      const app = createApp({ minDeviceCompat: 9 });
      const hookRes = await app.fetch(new Request(`https://x/hooks/${id}`, { method: 'POST', body: '{}' }), env);
      expect(hookRes.status).toBe(500);
      const delRes = await app.fetch(new Request(`https://x/inboxes/${id}`, { method: 'DELETE', headers: { authorization: 'Bearer t', 'x-hangar-compat': '12' } }), env);
      expect(delRes.status).toBe(500);
      const lines = spy.mock.calls.map((a) => a.join(' '));
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines.some((l) => l.includes('/hooks/:id'))).toBe(true);
      for (const l of lines) expect(l).not.toContain(id);
    } finally {
      spy.mockRestore();
      resetSchemaCache();
    }
  });
});
