import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PEER_CHAT_REPLY_SEALED_MAX, PEER_CHAT_SEALED_MAX, PEER_CHAT_WAIT_MAX_MS } from '@agent-hangar/shared';
import { MAX_PHONE_CHAT_BODY_BYTES, PHONE_CHAT_RATE } from '../src/phoneChat.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { addPcDevice, joinPhoneDevice, startCloud, type CloudHarness } from './harness.ts';

/**
 * スマホから PC の会話への問い合わせの口（POST /m/chat、互換の版 13）。
 * /peer/ask の写しで、スマホのトークンだけを通す。封はスマホ用の鍵で、Worker は開かない。
 */

/** 試験では、waitMs に足す余裕の 5 秒を短くする。 */
const GRACE_MS = 300;
/** 封は不透明な base64url の文字列。Worker は開かない。 */
const SEALED = 'c2VhbGVkLXBob25lLWNoYXQ';

let cloud: CloudHarness;

const send = (path: string, init: RequestInit = {}) => cloud.SELF.fetch(`https://x${path}`, init);
const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const post = (token: string, path: string, body?: unknown) =>
  send(path, { method: 'POST', headers: auth(token, { 'content-type': 'application/json' }), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

type MfSocket = {
  accept(): void;
  send(m: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
};
type Bell = { send: (m: string) => void; next: (ms?: number) => Promise<string>; silent: (ms: number) => Promise<void>; close: () => void };

const openBell = async (token: string): Promise<Bell> => {
  const r = await send('/m/bell', { headers: { ...auth(token), upgrade: 'websocket' } });
  expect(r.status).toBe(101);
  const ws = (r as unknown as { webSocket: MfSocket | null }).webSocket!;
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
    new Promise<string>((resolve, reject) => {
      const m = queue.shift();
      if (m !== undefined) return resolve(m);
      const t = setTimeout(() => reject(new Error('呼び鈴に何も届きませんでした')), ms);
      waiters.push((v) => {
        clearTimeout(t);
        resolve(v);
      });
    });
  const silent = async (ms: number) => {
    await new Promise((r) => setTimeout(r, ms));
    expect(queue).toEqual([]);
  };
  return { send: (m) => ws.send(m), next, silent, close: () => ws.close(1000, 'bye') };
};

const body = (o: Record<string, unknown> = {}) => ({ askId: 'c-1', to: 'pc-b', sealed: SEALED, epoch: 1, waitMs: 0, ...o });
const chat = (token: string, b: unknown) => post(token, '/m/chat', b);

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud({ bindings: { BELL_ASK_TIMEOUT_MS: String(GRACE_MS) } });
  resetSchemaCache();
  await ensureSchema(cloud.env);
});

afterEach(async () => {
  await cloud.dispose();
});

describe('POST /m/chat（スマホから PC の会話への問い合わせ）', () => {
  it('宛先の呼び鈴に phone-chat の枠が届き、宛先の phone-chat-reply がスマホの応答になる', async () => {
    const a = await addPcDevice(cloud.env, 'pc-a');
    const b = await addPcDevice(cloud.env, 'pc-b');
    const phone = await joinPhoneDevice(cloud, a, { deviceId: 'phone-1' });
    const bell = await openBell(b);
    const pending = chat(phone.token, body({ epoch: 3 }));
    expect(JSON.parse(await bell.next())).toEqual({ t: 'phone-chat', id: 'c-1', from: 'phone-1', epoch: 3, sealed: SEALED });
    bell.send(JSON.stringify({ t: 'phone-chat-reply', id: 'c-1', from: 'phone-1', sealed: 'cmVwbHk' }));
    const r = await pending;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ sealed: 'cmVwbHk' });
  });

  it('PC のトークンは 403、トークン無しは 401', async () => {
    const a = await addPcDevice(cloud.env, 'pc-a');
    await addPcDevice(cloud.env, 'pc-b');
    expect((await send('/m/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()) })).status).toBe(401);
    expect((await chat(a, body())).status).toBe(403);
  });

  it('宛先が解除された PC や無い PC、スマホは 404', async () => {
    const a = await addPcDevice(cloud.env, 'pc-a');
    await addPcDevice(cloud.env, 'pc-b');
    const phone = await joinPhoneDevice(cloud, a, { deviceId: 'phone-1' });
    await cloud.env.DB.prepare('update devices set revoked_at = ? where id = ?').bind(Date.now(), 'pc-b').run();
    expect((await chat(phone.token, body())).status).toBe(404);
    expect((await chat(phone.token, body({ to: 'pc-none' }))).status).toBe(404);
    expect((await chat(phone.token, body({ to: 'phone-1' }))).status).toBe(404);
  });

  it('宛先がつないでいなければ、待たずにすぐ 409 offline', async () => {
    const a = await addPcDevice(cloud.env, 'pc-a');
    await addPcDevice(cloud.env, 'pc-b');
    const phone = await joinPhoneDevice(cloud, a);
    const started = Date.now();
    const r = await chat(phone.token, body({ waitMs: 20_000 }));
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ reason: 'offline' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('形の違う本文は 400（waitMs の範囲、封の形、世代、ID の形）', async () => {
    const a = await addPcDevice(cloud.env, 'pc-a');
    await addPcDevice(cloud.env, 'pc-b');
    const phone = await joinPhoneDevice(cloud, a);
    const bad: Record<string, unknown>[] = [
      { waitMs: PEER_CHAT_WAIT_MAX_MS + 1 },
      { waitMs: -1 },
      { waitMs: 1.5 },
      { sealed: 'not sealed' },
      { sealed: '' },
      { epoch: 0 },
      { epoch: 1.5 },
      { epoch: '1' },
      { askId: '' },
      { askId: 'x'.repeat(65) },
      { askId: 'a/b' },
      { to: '' },
    ];
    for (const o of bad) expect((await chat(phone.token, body(o))).status, JSON.stringify(o)).toBe(400);
    expect((await send('/m/chat', { method: 'POST', headers: auth(phone.token, { 'content-type': 'application/json' }), body: '{' })).status).toBe(400);
  });

  it('本文が 96 KiB を超えたら 413、封が PEER_CHAT_SEALED_MAX を超えたら 400', async () => {
    const a = await addPcDevice(cloud.env, 'pc-a');
    await addPcDevice(cloud.env, 'pc-b');
    const phone = await joinPhoneDevice(cloud, a);
    expect(MAX_PHONE_CHAT_BODY_BYTES).toBe(96 * 1024);
    expect((await chat(phone.token, body({ sealed: 'A'.repeat(MAX_PHONE_CHAT_BODY_BYTES) }))).status).toBe(413);
    expect((await chat(phone.token, body({ sealed: 'A'.repeat(PEER_CHAT_SEALED_MAX + 1) }))).status).toBe(400);
  });

  it('スマホ 1 台あたり 1 分に 120 回まで。121 回目は 429 rate で、別のスマホは数えない', async () => {
    const a = await addPcDevice(cloud.env, 'pc-a');
    await addPcDevice(cloud.env, 'pc-b');
    const p1 = await joinPhoneDevice(cloud, a);
    const p2 = await joinPhoneDevice(cloud, a);
    expect(PHONE_CHAT_RATE).toEqual({ max: 120, windowMs: 60_000 });
    for (let i = 0; i < PHONE_CHAT_RATE.max; i++) expect((await chat(p1.token, body({ askId: `c-${i}` }))).status, `${i}`).toBe(409);
    const r = await chat(p1.token, body({ askId: 'c-over' }));
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ reason: 'rate' });
    expect((await chat(p2.token, body({ askId: 'c-x' }))).status).toBe(409);
  });

  it('答えが無ければ waitMs + 余裕で 504', async () => {
    const a = await addPcDevice(cloud.env, 'pc-a');
    const b = await addPcDevice(cloud.env, 'pc-b');
    const phone = await joinPhoneDevice(cloud, a);
    const bell = await openBell(b);
    const started = Date.now();
    const pending = chat(phone.token, body({ waitMs: 400 }));
    await bell.next();
    const r = await pending;
    expect(r.status).toBe(504);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400 + GRACE_MS - 50);
  });

  it('答えが PEER_CHAT_REPLY_SEALED_MAX を超えたら 502', async () => {
    const a = await addPcDevice(cloud.env, 'pc-a');
    const b = await addPcDevice(cloud.env, 'pc-b');
    const phone = await joinPhoneDevice(cloud, a, { deviceId: 'phone-1' });
    const bell = await openBell(b);
    const pending = chat(phone.token, body());
    await bell.next();
    bell.send(JSON.stringify({ t: 'phone-chat-reply', id: 'c-1', from: 'phone-1', sealed: 'A'.repeat(PEER_CHAT_REPLY_SEALED_MAX + 1) }));
    expect((await pending).status).toBe(502);
  });

  it('ほかの PC の答え、別のスマホを名乗る答え、PC どうしの chat-reply は答えにならない', async () => {
    const a = await addPcDevice(cloud.env, 'pc-a');
    const b = await addPcDevice(cloud.env, 'pc-b');
    const x = await addPcDevice(cloud.env, 'pc-x');
    const phone = await joinPhoneDevice(cloud, a, { deviceId: 'phone-1' });
    const bellB = await openBell(b);
    const bellX = await openBell(x);
    const pending = chat(phone.token, body());
    await bellB.next();
    await bellX.silent(50);
    bellX.send(JSON.stringify({ t: 'phone-chat-reply', id: 'c-1', from: 'phone-1', sealed: 'Zm9yZ2Vk' }));
    bellB.send(JSON.stringify({ t: 'phone-chat-reply', id: 'c-1', from: 'phone-2', sealed: 'Zm9yZ2Vk' }));
    bellB.send(JSON.stringify({ t: 'chat-reply', id: 'c-1', from: 'phone-1', sealed: 'Zm9yZ2Vk' }));
    bellB.send(JSON.stringify({ t: 'reply', id: 'c-1', sealed: 'Zm9yZ2Vk' }));
    expect((await pending).status).toBe(504);
  });

  it('飛行中の同じ askId は 409 duplicate、待つ間に宛先が切れたら 409 offline', async () => {
    const a = await addPcDevice(cloud.env, 'pc-a');
    const b = await addPcDevice(cloud.env, 'pc-b');
    const phone = await joinPhoneDevice(cloud, a);
    const bell = await openBell(b);
    const first = chat(phone.token, body({ waitMs: 2_000 }));
    await bell.next();
    const dup = await chat(phone.token, body({ waitMs: 2_000 }));
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ reason: 'duplicate' });
    bell.close();
    const r = await first;
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ reason: 'offline' });
  });
});
