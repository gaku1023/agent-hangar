import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NOTICE_RATE, importMobileKey, openPhoneNotice, sealPhoneNotice, type NoticeOut, type PhoneNotice, type PushKeyOut, type PushSubscriptionPut } from '@agent-hangar/shared';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { addPcDevice, joinPhoneDevice, startCloud, type CloudHarness } from './harness.ts';
import { newPeer, openPush, unb64u, verifyVapid, type PushPeer } from './pushPeer.ts';

/**
 * スマホのプッシュ通知の口（0.9.1）。
 * Worker から外への要求（push サービスへの送信）は、miniflare の outboundService で偽の push サービスが受ける。
 * 受けた本文を、試験の中のブラウザ（pushPeer）が RFC 8291 の手順で開き、PC が封じた通知に戻ることを確かめる。
 */

type Sent = { url: string; headers: Headers; body: Uint8Array };

let cloud: CloudHarness;
let sent: Sent[] = [];
/** endpoint ごとに偽の push サービスが返す状態。無ければ 201。 */
let statusFor: Map<string, number> = new Map();
let pc = '';

const M = new Uint8Array(32).fill(7);
const notice: PhoneNotice = { title: '会話 1', pcName: 'pc-a', sessionId: 'sess-1', count: 1 };

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const json = (method: string, token: string, body: unknown): RequestInit => ({ method, headers: { ...auth(token), 'content-type': 'application/json' }, body: JSON.stringify(body) });
const call = (path: string, init: RequestInit = {}) => cloud.SELF.fetch(`https://x${path}`, init);

const endpointOf = (n: number | string) => `https://fcm.googleapis.com/fcm/send/test-${n}`;

/** 夜の時間帯を、今の UTC の時刻の前後 30 分にする（tzOffset は 0）。 */
const quietAroundNow = () => {
  const m = Math.floor(Date.now() / 60_000) % 1440;
  return { start: (m + 1440 - 30) % 1440, end: (m + 30) % 1440 };
};
/** 夜の時間帯を、今から 1 時間後からの 1 時間にする（今は鳴らす）。 */
const quietLater = () => {
  const m = Math.floor(Date.now() / 60_000) % 1440;
  return { start: (m + 60) % 1440, end: (m + 120) % 1440 };
};

const subscribe = async (token: string, peer: PushPeer, o: Partial<PushSubscriptionPut> = {}) =>
  call('/m/push/subscription', json('PUT', token, { endpoint: endpointOf(1), keys: { p256dh: peer.p256dh, auth: peer.authText }, quiet: quietLater(), tzOffset: 0, ...o }));

const sendNotice = async (body: unknown = undefined, token = pc) => {
  const sealed = await sealPhoneNotice(M, 1, notice);
  return call('/notices', json('POST', token, body ?? { sealed, epoch: 1 }));
};

const subRows = async () => (await cloud.env.DB.prepare('select * from push_subscriptions order by device_id').all<Record<string, unknown>>()).results;

beforeEach(async () => {
  resetSchemaCache();
  sent = [];
  statusFor = new Map();
  cloud = await startCloud({
    outbound: async (req) => {
      sent.push({ url: req.url, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) });
      return new Response(null, { status: statusFor.get(req.url) ?? 201 });
    },
  });
  resetSchemaCache();
  await ensureSchema(cloud.env);
  pc = await addPcDevice(cloud.env, 'pc-a');
});

afterEach(async () => {
  await cloud.dispose();
});

describe('GET /m/push/key', () => {
  it('スマホに VAPID の公開鍵を返す。最初に要るときに作って meta に置き、2 回目からは同じ鍵', async () => {
    const phone = await joinPhoneDevice(cloud, pc);
    const r1 = await call('/m/push/key', { headers: auth(phone.token) });
    expect(r1.status).toBe(200);
    const k1 = ((await r1.json()) as PushKeyOut).publicKey;
    expect(unb64u(k1)).toHaveLength(65);
    expect(unb64u(k1)[0]).toBe(4);
    const r2 = await call('/m/push/key', { headers: auth(phone.token) });
    expect(((await r2.json()) as PushKeyOut).publicKey).toBe(k1);
    const meta = await cloud.env.DB.prepare("select value from meta where key = 'vapid'").first<{ value: string }>();
    expect(JSON.parse(meta!.value).publicKey).toBe(k1);
  });

  it('PC のトークンは 403、トークンなしは 401', async () => {
    expect((await call('/m/push/key', { headers: auth(pc) })).status).toBe(403);
    expect((await call('/m/push/key')).status).toBe(401);
  });
});

describe('PUT と DELETE /m/push/subscription', () => {
  it('スマホ 1 台に 1 つで、2 回目は上書きする。quiet を省けば既定の 23:00〜7:00、null なら時間帯なし', async () => {
    const phone = await joinPhoneDevice(cloud, pc);
    const peer = await newPeer();
    expect((await subscribe(phone.token, peer, { quiet: undefined, tzOffset: -540 })).status).toBe(200);
    expect(await subRows()).toEqual([expect.objectContaining({ device_id: phone.deviceId, endpoint: endpointOf(1), p256dh: peer.p256dh, auth: peer.authText, quiet_start: 1380, quiet_end: 420, tz_offset: -540 })]);
    expect((await subscribe(phone.token, peer, { endpoint: endpointOf(2), quiet: null })).status).toBe(200);
    expect(await subRows()).toEqual([expect.objectContaining({ device_id: phone.deviceId, endpoint: endpointOf(2), quiet_start: null, quiet_end: null, tz_offset: 0 })]);
    expect((await call('/m/push/subscription', { method: 'DELETE', headers: auth(phone.token) })).status).toBe(200);
    expect(await subRows()).toEqual([]);
  });

  it('endpoint は既知の push サービスの https だけ。鍵と時間帯の形が違えば 400', async () => {
    const phone = await joinPhoneDevice(cloud, pc);
    const peer = await newPeer();
    for (const endpoint of ['https://evil.example/push', 'http://fcm.googleapis.com/fcm/send/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com:444/x']) {
      expect((await subscribe(phone.token, peer, { endpoint })).status, endpoint).toBe(400);
    }
    const bad: Partial<PushSubscriptionPut>[] = [
      { keys: { p256dh: 'AAAA', auth: peer.authText } },
      // y を書き換えた点。P-256 の上に無い。
      { keys: { p256dh: `${peer.p256dh.slice(0, -2)}${peer.p256dh.endsWith('AA') ? 'BA' : 'AA'}`, auth: peer.authText } },
      { keys: { p256dh: `A${peer.p256dh.slice(1)}`, auth: peer.authText } },
      { keys: { p256dh: peer.p256dh, auth: 'AAAA' } },
      { quiet: { start: 1440, end: 0 } },
      { quiet: { start: 1.5, end: 0 } },
      { tzOffset: 5000 },
      { tzOffset: undefined },
    ];
    for (const b of bad) expect((await subscribe(phone.token, peer, b)).status, JSON.stringify(b)).toBe(400);
    expect(await subRows()).toEqual([]);
  });

  it('PC のトークンは 403', async () => {
    const peer = await newPeer();
    expect((await subscribe(pc, peer)).status).toBe(403);
    expect((await call('/m/push/subscription', { method: 'DELETE', headers: auth(pc) })).status).toBe(403);
  });
});

describe('POST /notices', () => {
  it('購読に RFC 8291 で封じて送り、開くと PC が封じた通知に戻る。VAPID の JWT は GET /m/push/key の公開鍵で確かめられる', async () => {
    const phone = await joinPhoneDevice(cloud, pc);
    const peer = await newPeer();
    await subscribe(phone.token, peer);
    const publicKey = ((await (await call('/m/push/key', { headers: auth(phone.token) })).json()) as PushKeyOut).publicKey;
    const sealed = await sealPhoneNotice(M, 1, notice);
    const r = await call('/notices', json('POST', pc, { sealed, epoch: 1 }));
    expect(r.status).toBe(200);
    expect((await r.json()) as NoticeOut).toEqual({ sent: 1, quiet: 0, removed: 0, failed: 0 });
    expect(sent).toHaveLength(1);
    const got = sent[0]!;
    expect(got.url).toBe(endpointOf(1));
    expect(got.headers.get('content-encoding')).toBe('aes128gcm');
    expect(got.headers.get('ttl')).toBe('3600');
    expect(got.headers.get('urgency')).toBe('normal');
    const v = await verifyVapid(got.headers.get('authorization'));
    expect(v.k).toBe(publicKey);
    expect(v.claims.aud).toBe('https://fcm.googleapis.com');
    expect(v.claims.sub).toBe('https://x');
    expect(v.claims.exp as number).toBeLessThanOrEqual(Date.now() / 1000 + 12 * 3600 + 1);
    const payload = new TextDecoder().decode(await openPush(got.body, peer));
    expect(payload).toBe(sealed);
    expect(await openPhoneNotice(await importMobileKey(M), payload)).toEqual(notice);
  });

  it('夜の時間帯のスマホには送らない', async () => {
    const a = await joinPhoneDevice(cloud, pc);
    const b = await joinPhoneDevice(cloud, pc);
    await subscribe(a.token, await newPeer(), { endpoint: endpointOf('a'), quiet: quietAroundNow() });
    await subscribe(b.token, await newPeer(), { endpoint: endpointOf('b') });
    const r = await sendNotice();
    expect((await r.json()) as NoticeOut).toEqual({ sent: 1, quiet: 1, removed: 0, failed: 0 });
    expect(sent.map((s) => s.url)).toEqual([endpointOf('b')]);
  });

  it('push サービスが 410 か 404 を返した購読は消し、それ以外の失敗では残す', async () => {
    const phones = [await joinPhoneDevice(cloud, pc), await joinPhoneDevice(cloud, pc), await joinPhoneDevice(cloud, pc)];
    for (const [i, p] of phones.entries()) await subscribe(p.token, await newPeer(), { endpoint: endpointOf(i) });
    statusFor.set(endpointOf(0), 410);
    statusFor.set(endpointOf(1), 404);
    statusFor.set(endpointOf(2), 500);
    const r = await sendNotice();
    expect((await r.json()) as NoticeOut).toEqual({ sent: 0, quiet: 0, removed: 2, failed: 1 });
    expect((await subRows()).map((s) => s.device_id)).toEqual([phones[2]!.deviceId]);
  });

  it('解除したスマホと期限の切れたスマホには送らない。スマホの解除で購読も消える', async () => {
    const a = await joinPhoneDevice(cloud, pc);
    const b = await joinPhoneDevice(cloud, pc);
    const c = await joinPhoneDevice(cloud, pc);
    await subscribe(a.token, await newPeer(), { endpoint: endpointOf('a') });
    await subscribe(b.token, await newPeer(), { endpoint: endpointOf('b') });
    await subscribe(c.token, await newPeer(), { endpoint: endpointOf('c') });
    expect((await call(`/devices/${a.deviceId}/revoke`, { method: 'POST', headers: auth(pc) })).status).toBe(200);
    expect((await subRows()).map((s) => s.device_id).sort()).toEqual([b.deviceId, c.deviceId].sort());
    await cloud.env.DB.prepare('update devices set expires_at = ? where id = ?').bind(Date.now() - 1, b.deviceId).run();
    const r = await sendNotice();
    expect((await r.json()) as NoticeOut).toEqual({ sent: 1, quiet: 0, removed: 0, failed: 0 });
    expect(sent.map((s) => s.url)).toEqual([endpointOf('c')]);
  });

  it('購読が無ければ何も送らない', async () => {
    const r = await sendNotice();
    expect(r.status).toBe(200);
    expect((await r.json()) as NoticeOut).toEqual({ sent: 0, quiet: 0, removed: 0, failed: 0 });
    expect(sent).toEqual([]);
  });

  it('1 台の PC から 1 分に 10 回まで。超えたら 429 で、他の PC は送れる', async () => {
    const phone = await joinPhoneDevice(cloud, pc);
    await subscribe(phone.token, await newPeer());
    for (let i = 0; i < NOTICE_RATE.max; i++) expect((await sendNotice()).status).toBe(200);
    expect((await sendNotice()).status).toBe(429);
    const other = await addPcDevice(cloud.env, 'pc-b');
    expect((await sendNotice(undefined, other)).status).toBe(200);
    expect(sent).toHaveLength(NOTICE_RATE.max + 1);
  });

  it('スマホのトークンは 403。世代の合わない本文、長すぎる本文、形の違う本文は 400', async () => {
    const phone = await joinPhoneDevice(cloud, pc);
    expect((await sendNotice(undefined, phone.token)).status).toBe(403);
    const sealed = await sealPhoneNotice(M, 1, notice);
    for (const body of [{ sealed, epoch: 2 }, { sealed: `1.${'A'.repeat(4000)}`, epoch: 1 }, { sealed: 'not sealed', epoch: 1 }, { epoch: 1 }, { sealed }]) {
      expect((await call('/notices', json('POST', pc, body))).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
  });
});
