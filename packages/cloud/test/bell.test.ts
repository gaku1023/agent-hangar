import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MOBILE_ASK_MAX_BYTES, MOBILE_ASK_TIMEOUT_MS, MOBILE_REPLY_MAX_BYTES, type MobileAskIn, type MobileJoinResponse, type MobilePairingResponse } from '@agent-hangar/shared';
import { askTimeoutMs } from '../src/bellWire.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

const SECRET = 'join-secret-bell';
/** 試験では答えの待ちを短くする（実物は MOBILE_ASK_TIMEOUT_MS の 5 秒）。 */
const ASK_TIMEOUT_MS = 400;

let cloud: CloudHarness;

const send = (path: string, init: RequestInit = {}) => cloud.SELF.fetch(`https://x${path}`, init);
const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const post = (token: string, path: string, body?: unknown) =>
  send(path, { method: 'POST', headers: auth(token, { 'content-type': 'application/json' }), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const joinPc = async (id: string): Promise<string> => {
  const r = await send('/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: SECRET, device: { id, name: id, platform: 'darwin' } }) });
  expect(r.status).toBe(201);
  return ((await r.json()) as { deviceToken: string }).deviceToken;
};

const joinPhone = async (pcToken: string, id = 'phone'): Promise<MobileJoinResponse> => {
  const p = await post(pcToken, '/m/pairings');
  expect(p.status).toBe(201);
  const { code } = (await p.json()) as MobilePairingResponse;
  const r = await send('/m/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, device: { id, name: id } }) });
  expect(r.status).toBe(201);
  return (await r.json()) as MobileJoinResponse;
};

const revoke = (token: string, id: string) => send(`/devices/${encodeURIComponent(id)}/revoke`, { method: 'POST', headers: auth(token) });

type MfSocket = {
  accept(): void;
  send(m: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
  addEventListener(type: 'close', fn: (e: { code: number; reason: string }) => void): void;
};

/** PC の側の WebSocket。届いた文面を順に取り出せる。 */
type Bell = {
  send: (m: string) => void;
  next: (ms?: number) => Promise<string>;
  /** ms の間に何も届かないことを確かめる。 */
  silent: (ms: number) => Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
  close: () => void;
};

const connect = (token: string | null, extra: Record<string, string> = {}) =>
  send('/m/bell', { headers: { ...(token === null ? {} : auth(token)), upgrade: 'websocket', ...extra } });

const openBell = async (token: string): Promise<Bell> => {
  const r = await connect(token);
  expect(r.status).toBe(101);
  const ws = (r as unknown as { webSocket: MfSocket | null }).webSocket;
  expect(ws).toBeTruthy();
  ws!.accept();
  const queue: string[] = [];
  const waiters: ((m: string) => void)[] = [];
  ws!.addEventListener('message', (e) => {
    const m = String(e.data);
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws!.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })));
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
  return { send: (m) => ws!.send(m), next, silent, closed, close: () => ws!.close(1000, 'bye') };
};

const ask = (phone: string, body: MobileAskIn | Record<string, unknown>) => post(phone, '/m/ask', body);

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud({ bindings: { BELL_ASK_TIMEOUT_MS: String(ASK_TIMEOUT_MS) } });
  resetSchemaCache();
  await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: await sha256Hex(SECRET) });
});

afterEach(async () => {
  await cloud.dispose();
});

describe('呼び鈴につなぐ（GET /m/bell）', () => {
  it('PC のトークンでつなげ、ping に pong が返る', async () => {
    const pc = await joinPc('pc-a');
    const bell = await openBell(pc);
    bell.send('ping');
    expect(await bell.next()).toBe('pong');
    bell.close();
  });

  it('トークン無しとトークン違いは 401、スマホのトークンは 403、解除した PC は 401 で断る', async () => {
    const pc = await joinPc('pc-a');
    const gone = await joinPc('pc-gone');
    const phone = await joinPhone(pc);
    expect((await revoke(pc, 'pc-gone')).status).toBe(200);
    expect((await connect(null)).status).toBe(401);
    expect((await connect('nope')).status).toBe(401);
    expect((await connect(phone.token)).status).toBe(403);
    expect((await connect(gone)).status).toBe(401);
  });

  it('WebSocket でない要求は 426 で断る', async () => {
    const pc = await joinPc('pc-a');
    const r = await send('/m/bell', { headers: auth(pc) });
    expect(r.status).toBe(426);
  });

  it('同じ PC が 2 本目をつないだら 1 本目が閉じ、問い合わせは 2 本目に届く', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const first = await openBell(pc);
    const second = await openBell(pc);
    expect((await first.closed).code).toBe(4000);
    const pending = ask(phone.token, { id: 'q-1', targetDevice: 'pc-a', sealed: 'sealed-ask' });
    expect(JSON.parse(await second.next())).toEqual({ t: 'ask', id: 'q-1', sealed: 'sealed-ask' });
    second.send(JSON.stringify({ t: 'reply', id: 'q-1', sealed: 'sealed-reply' }));
    expect((await pending).status).toBe(200);
  });
});

describe('問い合わせ（POST /m/ask）', () => {
  it('宛先の PC の WebSocket に ask が届き、PC の reply がスマホの応答になる', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const bell = await openBell(pc);
    const pending = ask(phone.token, { id: 'q-1', targetDevice: 'pc-a', sealed: 'sealed-ask' });
    expect(JSON.parse(await bell.next())).toEqual({ t: 'ask', id: 'q-1', sealed: 'sealed-ask' });
    bell.send(JSON.stringify({ t: 'reply', id: 'q-1', sealed: 'sealed-reply' }));
    const r = await pending;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ sealed: 'sealed-reply' });
  });

  it('問い合わせは D1 に書かない', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const bell = await openBell(pc);
    const pending = ask(phone.token, { id: 'q-1', targetDevice: 'pc-a', sealed: 'sealed-secret-ask' });
    await bell.next();
    bell.send(JSON.stringify({ t: 'reply', id: 'q-1', sealed: 'sealed-secret-reply' }));
    expect((await pending).status).toBe(200);
    const tables = await cloud.env.DB.prepare("select name from sqlite_master where type = 'table'").all<{ name: string }>();
    for (const { name } of tables.results) {
      if (name.startsWith('_cf') || name.startsWith('sqlite')) continue;
      const rows = await cloud.env.DB.prepare(`select * from "${name}"`).all();
      expect(JSON.stringify(rows.results), name).not.toContain('sealed-secret');
    }
  });

  it('宛先がつないでいなければ 503 pc-offline', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const r = await ask(phone.token, { id: 'q-1', targetDevice: 'pc-a', sealed: 's' });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'pc-offline' });
  });

  it('答えが無ければ待ちの上限で 504 pc-timeout', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const bell = await openBell(pc);
    const started = Date.now();
    const pending = ask(phone.token, { id: 'q-1', targetDevice: 'pc-a', sealed: 's' });
    await bell.next();
    const r = await pending;
    expect(r.status).toBe(504);
    expect(await r.json()).toEqual({ error: 'pc-timeout' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(ASK_TIMEOUT_MS - 50);
  });

  it('ほかの PC の reply は、同じ ID でも答えにならない', async () => {
    const pcA = await joinPc('pc-a');
    const pcB = await joinPc('pc-b');
    const phone = await joinPhone(pcA);
    const a = await openBell(pcA);
    const b = await openBell(pcB);
    const pending = ask(phone.token, { id: 'q-1', targetDevice: 'pc-a', sealed: 's' });
    expect(JSON.parse(await a.next())).toMatchObject({ t: 'ask', id: 'q-1' });
    // 宛先でない PC には届かない。
    await b.silent(50);
    b.send(JSON.stringify({ t: 'reply', id: 'q-1', sealed: 'forged' }));
    const r = await pending;
    expect(r.status).toBe(504);
  });

  it('ほかの PC の reply の後に宛先の reply が来れば、宛先の答えを返す', async () => {
    const pcA = await joinPc('pc-a');
    const pcB = await joinPc('pc-b');
    const phone = await joinPhone(pcA);
    const a = await openBell(pcA);
    const b = await openBell(pcB);
    const pending = ask(phone.token, { id: 'q-1', targetDevice: 'pc-a', sealed: 's' });
    await a.next();
    b.send(JSON.stringify({ t: 'reply', id: 'q-1', sealed: 'forged' }));
    b.send('ping');
    expect(await b.next()).toBe('pong');
    a.send(JSON.stringify({ t: 'reply', id: 'q-1', sealed: 'real' }));
    const r = await pending;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ sealed: 'real' });
  });

  it('答えが上限を超えたら答えにせず 502 で返す', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const bell = await openBell(pc);
    const pending = ask(phone.token, { id: 'q-1', targetDevice: 'pc-a', sealed: 's' });
    await bell.next();
    bell.send(JSON.stringify({ t: 'reply', id: 'q-1', sealed: 'x'.repeat(MOBILE_REPLY_MAX_BYTES + 1) }));
    const r = await pending;
    expect(r.status).toBe(502);
    expect(JSON.stringify(await r.json())).not.toContain('xxxx');
  });

  it('本文が 4 KiB を超えたら 413', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const r = await ask(phone.token, { id: 'q-1', targetDevice: 'pc-a', sealed: 'x'.repeat(MOBILE_ASK_MAX_BYTES) });
    expect(r.status).toBe(413);
  });

  it('形の違う本文は 400', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    expect((await ask(phone.token, { id: 'q-1', targetDevice: 'pc-a' })).status).toBe(400);
    expect((await ask(phone.token, { id: '', targetDevice: 'pc-a', sealed: 's' })).status).toBe(400);
  });

  it('宛先が無い、スマホ、解除した PC は 404', async () => {
    const pc = await joinPc('pc-a');
    await joinPc('pc-gone');
    const phone = await joinPhone(pc);
    expect((await revoke(pc, 'pc-gone')).status).toBe(200);
    expect((await ask(phone.token, { id: 'q-1', targetDevice: 'nobody', sealed: 's' })).status).toBe(404);
    expect((await ask(phone.token, { id: 'q-2', targetDevice: phone.deviceId, sealed: 's' })).status).toBe(404);
    expect((await ask(phone.token, { id: 'q-3', targetDevice: 'pc-gone', sealed: 's' })).status).toBe(404);
  });

  it('PC のトークンでは問い合わせを出せない（403）、トークン無しは 401', async () => {
    const pc = await joinPc('pc-a');
    expect((await ask(pc, { id: 'q-1', targetDevice: 'pc-a', sealed: 's' })).status).toBe(403);
    const r = await send('/m/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'q', targetDevice: 'pc-a', sealed: 's' }) });
    expect(r.status).toBe(401);
  });

  it('スマホ 1 台から 10 秒に 21 回目は 429', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    for (let i = 0; i < 20; i++) {
      expect((await ask(phone.token, { id: `q-${i}`, targetDevice: 'pc-a', sealed: 's' })).status, `${i} 回目`).toBe(503);
    }
    expect((await ask(phone.token, { id: 'q-20', targetDevice: 'pc-a', sealed: 's' })).status).toBe(429);
    // ほかのスマホは数えない。
    const other = await joinPhone(pc, 'phone-2');
    expect((await ask(other.token, { id: 'q-x', targetDevice: 'pc-a', sealed: 's' })).status).toBe(503);
  });
});

describe('鳴らす（POST /m/launches）', () => {
  it('依頼の行が入ったら、宛先の PC の WebSocket に launch が届き、ほかの PC には届かない', async () => {
    const pcA = await joinPc('pc-a');
    const pcB = await joinPc('pc-b');
    const phone = await joinPhone(pcA);
    const a = await openBell(pcA);
    const b = await openBell(pcB);
    const r = await post(phone.token, '/m/launches', { id: 'l-1', targetDevice: 'pc-a', sealed: 'sealed-req' });
    expect(r.status).toBe(201);
    expect(JSON.parse(await a.next())).toEqual({ t: 'launch' });
    await b.silent(50);
  });

  it('宛先がつないでいなくても 201', async () => {
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const r = await post(phone.token, '/m/launches', { id: 'l-1', targetDevice: 'pc-a', sealed: 'sealed-req' });
    expect(r.status).toBe(201);
  });
});

describe('呼び鈴の無い Worker', () => {
  it('起動の依頼は 201 のまま、問い合わせは 503 pc-offline、つなぐのは 503', async () => {
    await cloud.dispose();
    resetSchemaCache();
    cloud = await startCloud({ bell: false });
    resetSchemaCache();
    await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: await sha256Hex(SECRET) });
    const pc = await joinPc('pc-a');
    const phone = await joinPhone(pc);
    const r = await post(phone.token, '/m/launches', { id: 'l-1', targetDevice: 'pc-a', sealed: 'sealed-req' });
    expect(r.status).toBe(201);
    const q = await ask(phone.token, { id: 'q-1', targetDevice: 'pc-a', sealed: 's' });
    expect(q.status).toBe(503);
    expect(await q.json()).toEqual({ error: 'pc-offline' });
    expect((await connect(pc)).status).toBe(503);
  });
});

describe('答えの待ちの長さ', () => {
  it('既定は MOBILE_ASK_TIMEOUT_MS で、試験の値は短くする向きにだけ効く', () => {
    expect(askTimeoutMs({})).toBe(MOBILE_ASK_TIMEOUT_MS);
    expect(askTimeoutMs({ BELL_ASK_TIMEOUT_MS: '300' })).toBe(300);
    expect(askTimeoutMs({ BELL_ASK_TIMEOUT_MS: String(MOBILE_ASK_TIMEOUT_MS * 10) })).toBe(MOBILE_ASK_TIMEOUT_MS);
    expect(askTimeoutMs({ BELL_ASK_TIMEOUT_MS: 'x' })).toBe(MOBILE_ASK_TIMEOUT_MS);
    expect(askTimeoutMs({ BELL_ASK_TIMEOUT_MS: '0' })).toBe(MOBILE_ASK_TIMEOUT_MS);
  });
});
