import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PEER_LAUNCH_RATE,
  PEER_LAUNCH_SEALED_MAX,
  PEER_LAUNCH_TTL_MS,
  PEER_RESULTS_MAX,
  PEER_RESULTS_PAGE,
  type PeerBellMessage,
  type PeerLaunchStatus,
  type PeerOutboxResponse,
  type PeerResultsResponse,
  type SealedPullChangesResponse,
} from '@agent-hangar/shared';
import { PEER_LAUNCH_KEEP_MS } from '../src/peerLaunch.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { addPcDevice, joinPhoneDevice, startCloud, type CloudHarness } from './harness.ts';

/** 封は不透明な文字列（`<世代>.<base64url>`）。Worker は開かない。 */
const SEALED = '1.c2VhbGVkLWxhdW5jaA';

let cloud: CloudHarness;

const send = (path: string, init: RequestInit = {}) => cloud.SELF.fetch(`https://x${path}`, init);
const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const post = (token: string, path: string, body?: unknown) =>
  send(path, { method: 'POST', headers: auth(token, { 'content-type': 'application/json' }), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const get = (token: string, path: string) => send(path, { headers: auth(token) });

const put = (token: string, body: Record<string, unknown>) => post(token, '/launches', body);
const claim = (token: string, id: string) => post(token, `/launches/${id}/claim`);
const answer = (token: string, id: string, body: unknown) => post(token, `/launches/${id}/answer`, body);
const result = (token: string, id: string, seq: number, sealed = `1.cmVzdWx0${seq}`) => post(token, `/launches/${id}/results`, { seq, sealed });
const results = (token: string, id: string, after = 0) => get(token, `/launches/${id}/results?after=${after}`);
const outbox = async (token: string, since = 0): Promise<PeerOutboxResponse> => {
  const r = await get(token, `/launches/mine?since=${since}`);
  expect(r.status).toBe(200);
  return (await r.json()) as PeerOutboxResponse;
};
const pull = async (token: string): Promise<SealedPullChangesResponse> => {
  const r = await get(token, '/changes?since=0');
  expect(r.status).toBe(200);
  return (await r.json()) as SealedPullChangesResponse;
};
const ageAll = (ms: number) => cloud.env.DB.prepare('update peer_launches set created_at = created_at - ?, updated_at = updated_at - ?').bind(ms, ms).run();

/** 起動して答えまで進める（pc-a が頼み、pc-b が受けて started にする）。 */
async function started(id: string, a: string, b: string): Promise<void> {
  expect((await put(a, { id, to: 'pc-b', sealed: SEALED })).status).toBe(201);
  expect((await claim(b, id)).status).toBe(200);
  expect((await answer(b, id, { ok: true, sealedAnswer: '1.YW5zd2Vy' })).status).toBe(200);
}

type MfSocket = {
  accept(): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
};
type Bell = { next: (ms?: number) => Promise<PeerBellMessage | { t: string }>; silent: (ms: number) => Promise<void>; close: () => void };
const openBell = async (token: string): Promise<Bell> => {
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
  const silent = async (ms: number) => {
    await new Promise((r) => setTimeout(r, ms));
    expect(queue).toEqual([]);
  };
  return { next, silent, close: () => ws.close(1000, 'bye') };
};

let a: string;
let b: string;
let c: string;

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema(cloud.env);
  a = await addPcDevice(cloud.env, 'pc-a');
  b = await addPcDevice(cloud.env, 'pc-b');
  c = await addPcDevice(cloud.env, 'pc-c');
});

afterEach(async () => {
  await cloud.dispose();
});

describe('頼みを置く（POST /launches）', () => {
  it('置くと 201 で pending を返し、宛先の pull の peerLaunches に from つきで出て、ほかの PC には出ない', async () => {
    const r = await put(a, { id: 'l-1', to: 'pc-b', sealed: SEALED });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ id: 'l-1', to: 'pc-b', status: 'pending', sealedAnswer: null, resultSeq: 0 } satisfies Partial<PeerLaunchStatus>);
    expect((await pull(b)).peerLaunches).toEqual([{ id: 'l-1', from: 'pc-a', createdAt: expect.any(Number), sealed: SEALED }]);
    expect((await pull(c)).peerLaunches).toEqual([]);
    expect((await pull(a)).peerLaunches).toEqual([]);
    // 平文で置くのは宛先と送り手と時刻と状態だけ。
    const row = await cloud.env.DB.prepare('select to_device, from_device, sealed, status from peer_launches where id = ?').bind('l-1').first();
    expect(row).toEqual({ to_device: 'pc-b', from_device: 'pc-a', sealed: SEALED, status: 'pending' });
  });

  it('本文の from が端末トークンの送り手と違えば 403 で、行は増えない', async () => {
    const r = await put(a, { id: 'l-spoof', from: 'pc-c', to: 'pc-b', sealed: SEALED });
    expect(r.status).toBe(403);
    expect((await put(a, { id: 'l-same', from: 'pc-a', to: 'pc-b', sealed: SEALED })).status).toBe(201);
    expect((await cloud.env.DB.prepare('select count(*) n from peer_launches').first<{ n: number }>())?.n).toBe(1);
  });

  it('宛先が自分自身、無い ID、解除した PC、スマホなら断る', async () => {
    expect((await put(a, { id: 'l-self', to: 'pc-a', sealed: SEALED })).status).toBe(400);
    expect((await put(a, { id: 'l-none', to: 'pc-none', sealed: SEALED })).status).toBe(404);
    const phone = await joinPhoneDevice(cloud, a);
    expect((await put(a, { id: 'l-phone', to: phone.deviceId, sealed: SEALED })).status).toBe(404);
    expect((await send('/devices/pc-c/revoke', { method: 'POST', headers: auth(a) })).status).toBe(200);
    expect((await put(a, { id: 'l-gone', to: 'pc-c', sealed: SEALED })).status).toBe(404);
  });

  it('スマホのトークンは 403、トークン無しは 401', async () => {
    const phone = await joinPhoneDevice(cloud, a);
    expect((await put(phone.token, { id: 'l-1', to: 'pc-b', sealed: SEALED })).status).toBe(403);
    expect((await send('/launches', { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('封の形が違う、大きすぎる、本文が壊れていれば断る', async () => {
    expect((await put(a, { id: 'l-1', to: 'pc-b', sealed: 'not-a-seal' })).status).toBe(400);
    expect((await put(a, { id: 'l-1', to: 'pc-b', sealed: '0.abc' })).status).toBe(400);
    expect((await put(a, { id: 'bad id!', to: 'pc-b', sealed: SEALED })).status).toBe(400);
    expect((await put(a, { id: 'l-1', to: 'pc-b' })).status).toBe(400);
    const big = `1.${'A'.repeat(PEER_LAUNCH_SEALED_MAX)}`;
    expect((await put(a, { id: 'l-big', to: 'pc-b', sealed: big })).status).toBe(400);
    const huge = await send('/launches', { method: 'POST', headers: auth(a, { 'content-type': 'application/json' }), body: JSON.stringify({ id: 'l-2', to: 'pc-b', sealed: `1.${'A'.repeat(200_000)}` }) });
    expect(huge.status).toBe(413);
    const broken = await send('/launches', { method: 'POST', headers: auth(a, { 'content-type': 'application/json' }), body: '{' });
    expect(broken.status).toBe(400);
  });

  it('同じ ID の再送は行を増やさず今の状態を返し、ほかの PC の ID と重なったら 409 で中身を返さない', async () => {
    expect((await put(a, { id: 'l-1', to: 'pc-b', sealed: SEALED })).status).toBe(201);
    const again = await put(a, { id: 'l-1', to: 'pc-b', sealed: SEALED });
    expect(again.status).toBe(201);
    expect(((await again.json()) as PeerLaunchStatus).status).toBe('pending');
    const other = await put(c, { id: 'l-1', to: 'pc-b', sealed: SEALED });
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ error: 'conflict' });
    expect((await cloud.env.DB.prepare('select count(*) n from peer_launches').first<{ n: number }>())?.n).toBe(1);
  });

  it(`1 台の PC が ${PEER_LAUNCH_RATE.max} 件を超えて置こうとすると 429`, async () => {
    for (let i = 0; i < PEER_LAUNCH_RATE.max; i++) expect((await put(a, { id: `l-${i}`, to: 'pc-b', sealed: SEALED })).status).toBe(201);
    expect((await put(a, { id: 'l-over', to: 'pc-b', sealed: SEALED })).status).toBe(429);
    // 別の PC の枠は食われない。
    expect((await put(c, { id: 'l-c', to: 'pc-b', sealed: SEALED })).status).toBe(201);
  });

  it('置いたついでに、残す期間を過ぎた頼みと結果の行を消す', async () => {
    await started('old', a, b);
    expect((await result(b, 'old', 1)).status).toBe(200);
    await ageAll(PEER_LAUNCH_KEEP_MS + 1000);
    expect((await put(a, { id: 'fresh', to: 'pc-b', sealed: SEALED })).status).toBe(201);
    expect((await cloud.env.DB.prepare('select id from peer_launches').all()).results.map((r) => r.id)).toEqual(['fresh']);
    expect((await cloud.env.DB.prepare('select count(*) n from peer_results').first<{ n: number }>())?.n).toBe(0);
  });
});

describe('受け取りと答え（claim、answer）', () => {
  it('宛先だけが claim でき、2 回目と宛先でない PC と送り手は 409', async () => {
    await put(a, { id: 'l-1', to: 'pc-b', sealed: SEALED });
    expect((await claim(c, 'l-1')).status).toBe(409);
    expect((await claim(a, 'l-1')).status).toBe(409);
    expect((await claim(b, 'l-1')).status).toBe(200);
    expect((await claim(b, 'l-1')).status).toBe(409);
    expect((await claim(b, 'nope')).status).toBe(409);
    // 受け取った頼みは pull に出ない。
    expect((await pull(b)).peerLaunches).toEqual([]);
  });

  it('期限（PEER_LAUNCH_TTL_MS）を過ぎた頼みは pull に出ず、claim も 409、呼ぶ側には expired が見える', async () => {
    await put(a, { id: 'l-1', to: 'pc-b', sealed: SEALED });
    await ageAll(PEER_LAUNCH_TTL_MS + 1000);
    expect((await pull(b)).peerLaunches).toEqual([]);
    expect((await claim(b, 'l-1')).status).toBe(409);
    const o = await outbox(a);
    expect(o.launches).toEqual([expect.objectContaining({ id: 'l-1', status: 'expired' })]);
    const one = await get(a, '/launches/l-1');
    expect(((await one.json()) as PeerLaunchStatus).status).toBe('expired');
  });

  it('宛先だけが答えられ、答えは claimed のときだけ。started と failed が付き、封は素通しで返る', async () => {
    await put(a, { id: 'l-1', to: 'pc-b', sealed: SEALED });
    expect((await answer(b, 'l-1', { ok: true, sealedAnswer: '1.YW5z' })).status).toBe(409);
    await claim(b, 'l-1');
    expect((await answer(c, 'l-1', { ok: true, sealedAnswer: '1.YW5z' })).status).toBe(409);
    expect((await answer(a, 'l-1', { ok: true, sealedAnswer: '1.YW5z' })).status).toBe(409);
    expect((await answer(b, 'l-1', { ok: true, sealedAnswer: 'bad' })).status).toBe(400);
    expect((await answer(b, 'l-1', { ok: 'yes', sealedAnswer: '1.YW5z' })).status).toBe(400);
    expect((await answer(b, 'l-1', { ok: true, sealedAnswer: '1.YW5z' })).status).toBe(200);
    expect((await answer(b, 'l-1', { ok: false, sealedAnswer: '1.YW5z' })).status).toBe(409);
    const o = await outbox(a);
    expect(o.launches).toEqual([{ id: 'l-1', to: 'pc-b', status: 'started', sealedAnswer: '1.YW5z', resultSeq: 0, updatedAt: expect.any(Number) }]);
    await put(a, { id: 'l-2', to: 'pc-b', sealed: SEALED });
    await claim(b, 'l-2');
    expect((await answer(b, 'l-2', { ok: false, sealedAnswer: '1.ZmFpbA' })).status).toBe(200);
    expect(((await (await get(a, '/launches/l-2')).json()) as PeerLaunchStatus).status).toBe('failed');
  });

  it('頼みの状態を読めるのは置いた PC だけ', async () => {
    await put(a, { id: 'l-1', to: 'pc-b', sealed: SEALED });
    expect((await get(a, '/launches/l-1')).status).toBe(200);
    expect((await get(b, '/launches/l-1')).status).toBe(404);
    expect((await get(c, '/launches/l-1')).status).toBe(404);
    expect((await outbox(b)).launches).toEqual([]);
  });
});

describe('結果の行（POST /launches/:id/results、GET /launches/:id/results）', () => {
  it('宛先だけが書け、送り手だけが読める。ほかの PC は書けず、読めば 404', async () => {
    await started('l-1', a, b);
    expect((await result(a, 'l-1', 1)).status).toBe(409);
    expect((await result(c, 'l-1', 1)).status).toBe(409);
    const w = await result(b, 'l-1', 1);
    expect(w.status).toBe(200);
    expect(await w.json()).toEqual({ ok: true, duplicate: false });
    expect((await results(b, 'l-1')).status).toBe(404);
    expect((await results(c, 'l-1')).status).toBe(404);
    const r = await results(a, 'l-1');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ results: [{ seq: 1, sealed: '1.cmVzdWx01', createdAt: expect.any(Number) }], more: false } satisfies PeerResultsResponse);
  });

  it('答えの付く前（pending、claimed）と failed の頼みには書けない', async () => {
    await put(a, { id: 'l-1', to: 'pc-b', sealed: SEALED });
    expect((await result(b, 'l-1', 1)).status).toBe(409);
    await claim(b, 'l-1');
    expect((await result(b, 'l-1', 1)).status).toBe(409);
    await answer(b, 'l-1', { ok: false, sealedAnswer: '1.ZmFpbA' });
    expect((await result(b, 'l-1', 1)).status).toBe(409);
  });

  it('同じ seq の再送は冪等で、行も増えず呼び鈴も鳴らさない', async () => {
    await started('l-1', a, b);
    expect(await (await result(b, 'l-1', 1)).json()).toEqual({ ok: true, duplicate: false });
    const bell = await openBell(a);
    expect(await (await result(b, 'l-1', 1)).json()).toEqual({ ok: true, duplicate: true });
    await bell.silent(300);
    bell.close();
    expect((await cloud.env.DB.prepare('select count(*) n from peer_results').first<{ n: number }>())?.n).toBe(1);
  });

  it('after の seq より後だけを昇順で返し、頁の上限を越えたら more を立てる。resultSeq が outbox に出る', async () => {
    await started('l-1', a, b);
    const n = PEER_RESULTS_PAGE + 5;
    for (let i = 1; i <= n; i++) expect((await result(b, 'l-1', i)).status).toBe(200);
    const first = (await (await results(a, 'l-1', 0)).json()) as PeerResultsResponse;
    expect(first.results.map((x) => x.seq)).toEqual(Array.from({ length: PEER_RESULTS_PAGE }, (_, i) => i + 1));
    expect(first.more).toBe(true);
    const rest = (await (await results(a, 'l-1', PEER_RESULTS_PAGE)).json()) as PeerResultsResponse;
    expect(rest.results.map((x) => x.seq)).toEqual([21, 22, 23, 24, 25]);
    expect(rest.more).toBe(false);
    expect((await outbox(a)).launches[0]?.resultSeq).toBe(n);
  });

  it('seq は 1 以上の整数、封の形が違えば 400。結果の行の数は PEER_RESULTS_MAX までで、超えたら 429', async () => {
    await started('l-1', a, b);
    expect((await result(b, 'l-1', 0)).status).toBe(400);
    expect((await result(b, 'l-1', 1.5)).status).toBe(400);
    expect((await post(b, '/launches/l-1/results', { seq: 1, sealed: 'bad' })).status).toBe(400);
    expect((await post(b, '/launches/l-1/results', { seq: 1, sealed: `1.${'A'.repeat(50_000)}` })).status).toBe(400);
    await cloud.env.DB.batch(
      Array.from({ length: PEER_RESULTS_MAX }, (_, i) => cloud.env.DB.prepare("insert into peer_results (request_id, seq, sealed, created_at) values ('l-1', ?, '1.eA', ?)").bind(i + 1, Date.now())),
    );
    expect((await result(b, 'l-1', PEER_RESULTS_MAX + 1)).status).toBe(429);
    // 既にある seq の再送は上限でも冪等で通る。
    expect((await post(b, '/launches/l-1/results', { seq: 1, sealed: '1.eA' })).status).toBe(200);
  });

  it('スマホのトークンは書けも読めもしない（403）', async () => {
    await started('l-1', a, b);
    const phone = await joinPhoneDevice(cloud, a);
    expect((await result(phone.token, 'l-1', 1)).status).toBe(403);
    expect((await results(phone.token, 'l-1')).status).toBe(403);
    expect((await get(phone.token, '/launches/mine')).status).toBe(403);
  });
});

describe('outbox（GET /launches/mine）', () => {
  it('since 以降に動いた自分の頼みだけを返し、now を添える', async () => {
    await put(a, { id: 'l-1', to: 'pc-b', sealed: SEALED });
    const first = await outbox(a);
    expect(first.launches.map((l) => l.id)).toEqual(['l-1']);
    await claim(b, 'l-1');
    await answer(b, 'l-1', { ok: true, sealedAnswer: '1.YW5z' });
    // 先に読んだ時点より後に動いたものだけが出る。
    const later = await outbox(a, first.now + 1);
    expect(later.launches.map((l) => l.status)).toEqual(['started']);
    expect((await outbox(a, later.now + 60_000)).launches).toEqual([]);
  });
});

describe('呼び鈴（{ t: "peer" }）', () => {
  it('頼みを置くと宛先、答えが付くと送り手、結果を書くと送り手の呼び鈴が鳴る', async () => {
    const bellA = await openBell(a);
    const bellB = await openBell(b);
    await put(a, { id: 'l-1', to: 'pc-b', sealed: SEALED });
    expect(await bellB.next()).toEqual({ t: 'peer', kind: 'launch', id: 'l-1' });
    await claim(b, 'l-1');
    await answer(b, 'l-1', { ok: true, sealedAnswer: '1.YW5z' });
    expect(await bellA.next()).toEqual({ t: 'peer', kind: 'answer', id: 'l-1' });
    await result(b, 'l-1', 1);
    expect(await bellA.next()).toEqual({ t: 'peer', kind: 'result', id: 'l-1' });
    await bellA.silent(200);
    await bellB.silent(100);
    bellA.close();
    bellB.close();
  });

  it('呼び鈴が切れていても頼みも結果も成功し、pull と outbox で届く', async () => {
    await started('l-1', a, b);
    expect((await result(b, 'l-1', 1)).status).toBe(200);
    expect((await outbox(a)).launches[0]).toMatchObject({ status: 'started', resultSeq: 1 });
  });
});

describe('呼び鈴を持たない Worker（BELL の束縛なし）', () => {
  it('鳴らせなくても頼みと結果は通る', async () => {
    await cloud.dispose();
    cloud = await startCloud({ bell: false });
    resetSchemaCache();
    await ensureSchema(cloud.env);
    a = await addPcDevice(cloud.env, 'pc-a');
    b = await addPcDevice(cloud.env, 'pc-b');
    await started('l-1', a, b);
    expect((await result(b, 'l-1', 1)).status).toBe(200);
  });
});
