import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generateJoinCode,
  JOIN_CODE_RATE,
  JOIN_CODE_TTL_MS,
  JOIN_GUESS_LIMIT,
  joinCodeHash,
  openJoinRequest,
  sealJoinRequest,
  type JoinCodeCreate,
  type JoinCodeHello,
  type JoinCodeMine,
  type JoinStatusOut,
} from '@agent-hangar/shared';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { addPcDevice, startCloud, type CloudHarness } from './harness.ts';

const BOOT = 'bootstrap-token-0123456789abcdef';
const BOOT_B = 'bootstrap-token-bbbbbbbbbbbbbbbb';
const PUB = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

let cloud: CloudHarness;

const send = (path: string, init: RequestInit = {}) => cloud.SELF.fetch(`https://x${path}`, init);
const auth = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const json = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }): RequestInit => ({ method: 'POST', headers, body: JSON.stringify(body) });

const bootstrap = (deviceId: string, token: string) => send('/bootstrap', json({ deviceId, token }));
const issue = (token: string, codeHash: string) => send('/join-codes', json({ codeHash }, auth(token)));
const request = (codeHash: string, deviceId: string, sealed = 'c2VhbGVkLXJlcXVlc3Q') => send('/join/requests', json({ codeHash, deviceId, sealed }));
const status = async (codeHash: string, deviceId: string): Promise<JoinStatusOut> => {
  const r = await send(`/join/status?code=${codeHash}&device=${deviceId}`);
  expect(r.status).toBe(200);
  return (await r.json()) as JoinStatusOut;
};
const mine = (token: string) => send('/join-codes/mine', { headers: auth(token) });
const approve = (token: string, codeHash: string, deviceId: string) => send(`/join-codes/${codeHash}/approve`, json({ deviceId }, auth(token)));
const reject = (token: string, codeHash: string) => send(`/join-codes/${codeHash}/reject`, json({}, auth(token)));
const row = (codeHash: string) => cloud.env.DB.prepare('select * from join_codes where code_hash = ?').bind(codeHash).first<{ status: string; request: string | null; used_at: number | null; device_id: string | null }>();
const pcIds = async () => (await cloud.env.DB.prepare("select id from devices where kind = 'pc' order by id").all<{ id: string }>()).results.map((r) => r.id);
const canAuth = async (token: string) => (await send('/devices', { headers: { authorization: `Bearer ${token}` } })).status === 200;

/** 新しいコードを発行し、平文とハッシュを返す。 */
const newCode = async (token: string): Promise<{ code: string; hash: string }> => {
  const code = generateJoinCode();
  const hash = await joinCodeHash(code);
  const r = await issue(token, hash);
  expect(r.status).toBe(201);
  return { code, hash };
};

const start = async (bootHash?: string) => {
  resetSchemaCache();
  cloud = await startCloud(bootHash === undefined ? {} : { BOOTSTRAP_TOKEN_HASH: bootHash });
  resetSchemaCache();
  await ensureSchema(cloud.env);
};

afterEach(async () => {
  await cloud.dispose();
});

describe('POST /bootstrap（最初の端末トークン）', () => {
  beforeEach(async () => start(await sha256Hex(BOOT)));

  it('bootstrap は 1 回だけ通り、同じハッシュの 2 回目は 401', async () => {
    const r = await bootstrap('pc-a', BOOT);
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ deviceId: 'pc-a' });
    expect(await canAuth(BOOT)).toBe(true);
    expect((await bootstrap('pc-b', BOOT)).status).toBe(401);
    expect(await pcIds()).toEqual(['pc-a']);
    // D1 には平文のトークンが無い。
    const dev = await cloud.env.DB.prepare('select token_hash from devices where id = ?').bind('pc-a').first<{ token_hash: string }>();
    expect(dev?.token_hash).toBe(await sha256Hex(BOOT));
  });

  it('違うトークンと形の違う本文は断る', async () => {
    expect((await bootstrap('pc-a', BOOT_B)).status).toBe(401);
    expect((await send('/bootstrap', json({ deviceId: 'pc-a' }))).status).toBe(400);
    expect((await bootstrap('pc/a', BOOT)).status).toBe(400);
    expect(await pcIds()).toEqual([]);
  });

  it('secret を入れ替えると、もう 1 度通る', async () => {
    await cloud.dispose();
    await start(await sha256Hex(BOOT_B));
    // 前の secret（BOOT）はもう使った。
    await cloud.env.DB.prepare("insert into meta (key, value) values ('bootstrap_used', ?)").bind(await sha256Hex(BOOT)).run();
    expect((await bootstrap('pc-a', BOOT)).status).toBe(401);
    expect((await bootstrap('pc-r', BOOT_B)).status).toBe(201);
    expect((await bootstrap('pc-s', BOOT_B)).status).toBe(401);
    expect(await pcIds()).toEqual(['pc-r']);
  });

  it('端末 ID recovery は予約済みなので 400 で、secret も使ったことにしない', async () => {
    expect((await bootstrap('recovery', BOOT)).status).toBe(400);
    expect(await pcIds()).toEqual([]);
    expect((await bootstrap('pc-a', BOOT)).status).toBe(201);
  });

  it('既にある端末 ID には入れず、secret も使ったことにしない', async () => {
    await addPcDevice(cloud.env, 'pc-a');
    expect((await bootstrap('pc-a', BOOT)).status).toBe(401);
    expect((await bootstrap('pc-b', BOOT)).status).toBe(201);
  });
});

describe('POST /bootstrap（secret が無い Worker）', () => {
  beforeEach(async () => start());

  it('BOOTSTRAP_TOKEN_HASH が空なら 401', async () => {
    expect((await bootstrap('pc-a', BOOT)).status).toBe(401);
    expect((await bootstrap('pc-a', '')).status).toBe(400);
    expect(await pcIds()).toEqual([]);
  });
});

describe('参加コード', () => {
  let pcA: string;

  beforeEach(async () => {
    await start();
    pcA = await addPcDevice(cloud.env, 'pc-a');
  });

  it('発行、リクエスト、承認のあと、新しい PC の問い合わせでトークンを 1 回だけ受け取る', async () => {
    const code = generateJoinCode();
    const hash = await joinCodeHash(code);
    const before = Date.now();
    const r = await issue(pcA, hash);
    expect(r.status).toBe(201);
    const created = (await r.json()) as JoinCodeCreate;
    expect(created.codeHash).toBe(hash);
    expect(created.expiresAt).toBeGreaterThanOrEqual(before + JOIN_CODE_TTL_MS);
    expect(created.expiresAt).toBeLessThanOrEqual(Date.now() + JOIN_CODE_TTL_MS);

    const m0 = (await (await mine(pcA)).json()) as JoinCodeMine;
    expect(m0).toEqual({ codeHash: hash, status: 'open', sealed: null, deviceId: null });

    const sealed = await sealJoinRequest(code, hash, { pub: PUB, name: 'pc-b', os: 'darwin' });
    expect((await request(hash, 'pc-b', sealed)).status).toBe(202);
    expect(await status(hash, 'pc-b')).toEqual({ status: 'waiting' });
    // 封じたリクエストは base64url の文字ではなく、バイト列の BLOB で持つ。
    expect(await cloud.env.DB.prepare('select typeof(request) t, hex(request) h from join_codes where code_hash = ?').bind(hash).first()).toEqual({
      t: 'blob',
      h: Buffer.from(sealed, 'base64url').toString('hex').toUpperCase(),
    });

    const m1 =(await (await mine(pcA)).json()) as JoinCodeMine;
    expect(m1.status).toBe('requested');
    expect(m1.deviceId).toBe('pc-b');
    expect(await openJoinRequest(code, hash, m1.sealed!)).toEqual({ pub: PUB, name: 'pc-b', os: 'darwin' });

    const a = await approve(pcA, hash, 'pc-b');
    expect(a.status).toBe(200);
    // 承認の応答にトークンは載らない。
    expect(JSON.stringify(await a.json())).not.toMatch(/token/i);
    expect((await row(hash))?.request).toBeNull();
    expect(await pcIds()).toEqual(['pc-a']);

    const first = await status(hash, 'pc-b');
    expect(first.status).toBe('approved');
    expect(typeof first.deviceToken).toBe('string');
    expect(await canAuth(first.deviceToken!)).toBe(true);
    expect(await pcIds()).toEqual(['pc-a', 'pc-b']);
    const dev = await cloud.env.DB.prepare('select kind, token_hash from devices where id = ?').bind('pc-b').first<{ kind: string; token_hash: string }>();
    expect(dev).toEqual({ kind: 'pc', token_hash: await sha256Hex(first.deviceToken!) });

    const second = await status(hash, 'pc-b');
    expect(second).toEqual({ status: 'approved' });
    expect(((await (await mine(pcA)).json()) as JoinCodeMine).status).toBe('approved');
  });

  it('承認なしでは参加できない（リクエストを置いただけの PC はずっと waiting）', async () => {
    const { hash } = await newCode(pcA);
    expect((await request(hash, 'pc-b')).status).toBe(202);
    for (let i = 0; i < 5; i++) expect(await status(hash, 'pc-b')).toEqual({ status: 'waiting' });
    expect(await pcIds()).toEqual(['pc-a']);
  });

  it('問い合わせの端末 ID が違えば、承認の後でもトークンを渡さない', async () => {
    const { hash } = await newCode(pcA);
    await request(hash, 'pc-b');
    expect((await approve(pcA, hash, 'pc-b')).status).toBe(200);
    expect(await status(hash, 'pc-x')).toEqual({ status: 'expired' });
    expect((await status(hash, 'pc-b')).deviceToken).toBeTruthy();
  });

  it('承認の後、その端末 ID が既に devices にあれば、トークンを渡さずに rejected で終わる', async () => {
    const { hash } = await newCode(pcA);
    await request(hash, 'pc-b');
    expect((await approve(pcA, hash, 'pc-b')).status).toBe(200);
    // リクエストの後に、同じ ID の端末が別の道で入った。
    const existing = await addPcDevice(cloud.env, 'pc-b');
    expect(await status(hash, 'pc-b')).toEqual({ status: 'rejected' });
    expect(await status(hash, 'pc-b')).toEqual({ status: 'rejected' });
    const r = await row(hash);
    expect(r?.status).toBe('rejected');
    expect(r?.used_at).toBeNull();
    // 前からある端末のトークンはそのまま使える。
    expect(await canAuth(existing)).toBe(true);
    const dev = await cloud.env.DB.prepare('select token_hash from devices where id = ?').bind('pc-b').first<{ token_hash: string }>();
    expect(dev?.token_hash).toBe(await sha256Hex(existing));
  });

  it('認証のない口は、長さを名乗らない本文でも上限を超えたら 413', async () => {
    const { hash } = await newCode(pcA);
    const big = JSON.stringify({ codeHash: hash, deviceId: 'pc-b', sealed: 'A'.repeat(20_000) });
    const chunked = (text: string): RequestInit =>
      ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: new ReadableStream({
          start(ctl) {
            const b = new TextEncoder().encode(text);
            for (let i = 0; i < b.length; i += 1024) ctl.enqueue(b.slice(i, i + 1024));
            ctl.close();
          },
        }),
        duplex: 'half',
      }) as RequestInit;
    const r1 = await send('/join/requests', chunked(big));
    expect(r1.status).toBe(413);
    expect((await send('/join/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: big })).status).toBe(413);
    expect((await send('/bootstrap', chunked(JSON.stringify({ deviceId: 'pc-z', token: 'A'.repeat(20_000) })))).status).toBe(413);
    // 上限の内なら、長さを名乗らない本文でも通る。
    expect((await send('/join/requests', chunked(JSON.stringify({ codeHash: hash, deviceId: 'pc-b', sealed: 'c2VhbGVk' })))).status).toBe(202);
  });

  it('拒否で rejected になり、request が null になる', async () => {
    const { hash } = await newCode(pcA);
    await request(hash, 'pc-b');
    expect((await reject(pcA, hash)).status).toBe(200);
    expect(await status(hash, 'pc-b')).toEqual({ status: 'rejected' });
    expect((await row(hash))?.request).toBeNull();
    expect((await approve(pcA, hash, 'pc-b')).status).toBe(409);
    expect(await pcIds()).toEqual(['pc-a']);
  });

  it('5 分を過ぎると expired で、request が null になる', async () => {
    const { hash } = await newCode(pcA);
    await request(hash, 'pc-b');
    await cloud.env.DB.prepare('update join_codes set expires_at = ? where code_hash = ?').bind(Date.now() - 1, hash).run();
    expect(await status(hash, 'pc-b')).toEqual({ status: 'expired' });
    const r = await row(hash);
    expect(r?.status).toBe('expired');
    expect(r?.request).toBeNull();
    expect((await (await mine(pcA)).json()) as JoinCodeMine).toEqual({ codeHash: hash, status: 'expired', sealed: null, deviceId: 'pc-b' });
    expect((await approve(pcA, hash, 'pc-b')).status).toBe(409);
    expect(await pcIds()).toEqual(['pc-a']);
  });

  it('発行した PC の画面だけが期限切れを見ても、request は null になる', async () => {
    const { hash } = await newCode(pcA);
    await request(hash, 'pc-b');
    await cloud.env.DB.prepare('update join_codes set expires_at = ? where code_hash = ?').bind(Date.now() - 1, hash).run();
    expect(((await (await mine(pcA)).json()) as JoinCodeMine).status).toBe('expired');
    expect((await row(hash))?.request).toBeNull();
  });

  it('承認の後は、期限を少し過ぎても受け取れるが、さらに 5 分たつと expired', async () => {
    const { hash } = await newCode(pcA);
    await request(hash, 'pc-b');
    await approve(pcA, hash, 'pc-b');
    await cloud.env.DB.prepare('update join_codes set expires_at = ? where code_hash = ?').bind(Date.now() - JOIN_CODE_TTL_MS - 1, hash).run();
    expect(await status(hash, 'pc-b')).toEqual({ status: 'expired' });
    await cloud.env.DB.prepare('update join_codes set expires_at = ? where code_hash = ?').bind(Date.now() - 1, hash).run();
    expect((await status(hash, 'pc-b')).deviceToken).toBeTruthy();
  });

  it('使用済み、期限切れ、無いコードへのリクエストは、区別せずに 404', async () => {
    const { hash } = await newCode(pcA);
    expect((await request(hash, 'pc-b')).status).toBe(202);
    // request が埋まっているコードには置けない。
    expect((await request(hash, 'pc-c')).status).toBe(404);
    await approve(pcA, hash, 'pc-b');
    await status(hash, 'pc-b');
    expect((await request(hash, 'pc-c')).status).toBe(404);

    const { hash: old } = await newCode(pcA);
    await cloud.env.DB.prepare('update join_codes set expires_at = ? where code_hash = ?').bind(Date.now() - 1, old).run();
    expect((await request(old, 'pc-c')).status).toBe(404);
    const unknown = await joinCodeHash(generateJoinCode());
    const bodies = new Set<string>();
    for (const h of [hash, old, unknown]) bodies.add(await (await request(h, 'pc-c')).text());
    expect(bodies.size).toBe(1);
  });

  it('端末 ID recovery ではリクエストを置けない（400）', async () => {
    const { hash } = await newCode(pcA);
    expect((await request(hash, 'recovery')).status).toBe(400);
    // 予約の ID は総当たりの回数に数えず、コードはまだ使える。
    expect((await request(hash, 'pc-b')).status).toBe(202);
  });

  it('既にある端末の ID でリクエストを置くことはできない', async () => {
    const { hash } = await newCode(pcA);
    expect((await request(hash, 'pc-a')).status).toBe(404);
  });

  it('解除されていない同じ ID の端末があれば、リクエストは 404 のままで、行に触らない', async () => {
    const live = await addPcDevice(cloud.env, 'pc-b');
    const { hash } = await newCode(pcA);
    expect((await request(hash, 'pc-b')).status).toBe(404);
    expect((await row(hash))?.status).toBe('open');
    expect(await canAuth(live)).toBe(true);
  });

  it('解除した PC は、同じ ID のまま参加コードで再参加でき、解除済みの行が新しいトークンで置き換わる', async () => {
    const old = await addPcDevice(cloud.env, 'pc-b', { joinedAt: 1 });
    expect((await send('/devices/pc-b/revoke', { method: 'POST', headers: auth(pcA) })).status).toBe(200);
    expect(await canAuth(old)).toBe(false);
    const { hash } = await newCode(pcA);
    expect((await request(hash, 'pc-b')).status).toBe(202);
    // 承認の前は解除済みのまま。
    expect(await status(hash, 'pc-b')).toEqual({ status: 'waiting' });
    expect(await canAuth(old)).toBe(false);
    expect((await approve(pcA, hash, 'pc-b')).status).toBe(200);
    const before = Date.now();
    const got = await status(hash, 'pc-b');
    expect(got.status).toBe('approved');
    expect(await canAuth(got.deviceToken!)).toBe(true);
    expect(await canAuth(old)).toBe(false);
    const rows = await cloud.env.DB.prepare('select kind, token_hash, joined_at, revoked_at, expires_at, last_pulled_seq from devices where id = ?').bind('pc-b').all<{ kind: string; token_hash: string; joined_at: number; revoked_at: number | null; expires_at: number | null; last_pulled_seq: number }>();
    expect(rows.results).toHaveLength(1);
    const dev = rows.results[0]!;
    expect(dev).toMatchObject({ kind: 'pc', token_hash: await sha256Hex(got.deviceToken!), revoked_at: null, expires_at: null, last_pulled_seq: 0 });
    expect(dev.joined_at).toBeGreaterThanOrEqual(before);
    expect((await row(hash))?.used_at).not.toBeNull();
    expect(await status(hash, 'pc-b')).toEqual({ status: 'approved' });
  });

  it('解除済みの ID のリクエストでも、トークンを渡す前に同じ ID が生き返っていれば rejected で閉じる', async () => {
    await addPcDevice(cloud.env, 'pc-b');
    await cloud.env.DB.prepare('update devices set revoked_at = ? where id = ?').bind(Date.now(), 'pc-b').run();
    const { hash } = await newCode(pcA);
    expect((await request(hash, 'pc-b')).status).toBe(202);
    expect((await approve(pcA, hash, 'pc-b')).status).toBe(200);
    await cloud.env.DB.prepare('update devices set revoked_at = null where id = ?').bind('pc-b').run();
    expect(await status(hash, 'pc-b')).toEqual({ status: 'rejected' });
  });

  it('発行した PC は、自分のコードにリクエストを置いた PC 宛ての keybox を、承認の前から置ける', async () => {
    const box = (recipient: string) => ({ method: 'PUT', headers: auth(pcA), body: JSON.stringify({ boxes: [{ epoch: 1, recipient, sealed: Buffer.alloc(80, 7).toString('base64url') }] }) });
    const { hash } = await newCode(pcA);
    // リクエストの前は、まだ誰でもない。
    expect((await send('/keyboxes', box('pc-b'))).status).toBe(400);
    expect((await request(hash, 'pc-b')).status).toBe(202);
    expect((await send('/keyboxes', box('pc-b'))).status).toBe(200);
    // ほかの PC は、人のコードのリクエストを受け手にできない。
    const pcC = await addPcDevice(cloud.env, 'pc-c');
    expect((await send('/keyboxes', { ...box('pc-b'), headers: auth(pcC) })).status).toBe(400);
    // 承認の後、トークンを渡すまでは置き直せる。
    expect((await approve(pcA, hash, 'pc-b')).status).toBe(200);
    expect((await send('/keyboxes', box('pc-b'))).status).toBe(200);
    // 拒否したコードと期限切れのコードのリクエストは受け手にできない。
    const second = await newCode(pcA);
    expect((await request(second.hash, 'pc-d')).status).toBe(202);
    expect((await reject(pcA, second.hash)).status).toBe(200);
    expect((await send('/keyboxes', box('pc-d'))).status).toBe(400);
    const third = await newCode(pcA);
    expect((await request(third.hash, 'pc-e')).status).toBe(202);
    await cloud.env.DB.prepare('update join_codes set expires_at = ? where code_hash = ?').bind(Date.now() - 1, third.hash).run();
    expect((await send('/keyboxes', box('pc-e'))).status).toBe(400);
  });

  it('解除した PC の再参加でも、リクエストの間は keybox を置ける', async () => {
    await addPcDevice(cloud.env, 'pc-b');
    await cloud.env.DB.prepare('update devices set revoked_at = ? where id = ?').bind(Date.now(), 'pc-b').run();
    const { hash } = await newCode(pcA);
    expect((await request(hash, 'pc-b')).status).toBe(202);
    const r = await send('/keyboxes', { method: 'PUT', headers: auth(pcA), body: JSON.stringify({ boxes: [{ epoch: 1, recipient: 'pc-b', sealed: Buffer.alloc(80, 7).toString('base64url') }] }) });
    expect(r.status).toBe(200);
  });

  it('承認と拒否ができるのは発行した PC だけ（ほかの PC は 403）', async () => {
    const pcB = await addPcDevice(cloud.env, 'pc-b');
    const { hash } = await newCode(pcA);
    await request(hash, 'pc-c');
    expect((await approve(pcB, hash, 'pc-c')).status).toBe(403);
    expect((await reject(pcB, hash)).status).toBe(403);
    expect(await status(hash, 'pc-c')).toEqual({ status: 'waiting' });
    // 他人の開いたコードは自分の mine に出ない。
    expect((await mine(pcB)).status).toBe(404);
    expect((await approve(pcA, hash, 'pc-c')).status).toBe(200);
  });

  it('リクエストを置いた端末と違う ID を承認しようとすると 409', async () => {
    const { hash } = await newCode(pcA);
    await request(hash, 'pc-b');
    expect((await approve(pcA, hash, 'pc-z')).status).toBe(409);
    expect(await status(hash, 'pc-b')).toEqual({ status: 'waiting' });
  });

  it('リクエストの前に承認はできない', async () => {
    const { hash } = await newCode(pcA);
    expect((await approve(pcA, hash, 'pc-b')).status).toBe(409);
    expect((await approve(pcA, await joinCodeHash(generateJoinCode()), 'pc-b')).status).toBe(404);
  });

  it('スマホのトークンと、トークンなしでは発行も承認もできない', async () => {
    const phone = 'phone-token-0123456789abcdef';
    // 接続した時刻は今にする。古い時刻だと、30 日使わなかったスマホとして 401 expired になる（互換の版 9）。
    await cloud.env.DB.prepare("insert into devices (id, kind, token_hash, joined_at) values ('m1', 'mobile', ?, ?)").bind(await sha256Hex(phone), Date.now()).run();
    const hash = await joinCodeHash(generateJoinCode());
    expect((await issue(phone, hash)).status).toBe(403);
    expect((await send('/join-codes', json({ codeHash: hash }))).status).toBe(401);
    expect((await send('/join-codes/mine')).status).toBe(401);
  });

  it('発行は 1 台の PC につき 10 分に 5 回まで（6 回目は 429）', async () => {
    for (let i = 0; i < JOIN_CODE_RATE.max; i++) await newCode(pcA);
    expect((await issue(pcA, await joinCodeHash(generateJoinCode()))).status).toBe(429);
    // ほかの PC は数えない。
    const pcB = await addPcDevice(cloud.env, 'pc-b');
    expect((await issue(pcB, await joinCodeHash(generateJoinCode()))).status).toBe(201);
    await cloud.env.DB.prepare('update join_codes set created_at = created_at - ?').bind(JOIN_CODE_RATE.windowMs).run();
    expect((await issue(pcA, await joinCodeHash(generateJoinCode()))).status).toBe(201);
  });

  it('発行し直すと、前の開いたコードは expired になり、mine は新しいコードを返す', async () => {
    const first = await newCode(pcA);
    await request(first.hash, 'pc-b');
    const second = await newCode(pcA);
    const r = await row(first.hash);
    expect(r?.status).toBe('expired');
    expect(r?.request).toBeNull();
    expect(((await (await mine(pcA)).json()) as JoinCodeMine).codeHash).toBe(second.hash);
    expect(await status(first.hash, 'pc-b')).toEqual({ status: 'expired' });
  });

  it('1 日を過ぎた行は次の発行で消える', async () => {
    const { hash } = await newCode(pcA);
    await cloud.env.DB.prepare('update join_codes set created_at = created_at - ? where code_hash = ?').bind(86_400_000 + 1, hash).run();
    expect(await row(hash)).not.toBeNull();
    await newCode(pcA);
    expect(await row(hash)).toBeNull();
  });

  it('同じハッシュの発行は 409', async () => {
    const { hash } = await newCode(pcA);
    expect((await issue(pcA, hash)).status).toBe(409);
  });

  it('知らないコードへのリクエストは Worker 全体で 10 分に 30 回までで、その後は正しいコードも 429', async () => {
    const { hash } = await newCode(pcA);
    for (let i = 0; i < JOIN_GUESS_LIMIT.max; i++) expect((await request(await joinCodeHash(generateJoinCode()), `pc-${i}`)).status).toBe(404);
    expect((await request(await joinCodeHash(generateJoinCode()), 'pc-x')).status).toBe(429);
    expect((await request(hash, 'pc-b')).status).toBe(429);
    // 窓を過ぎれば戻る。
    await cloud.env.DB.prepare("update meta set value = json_set(value, '$.start', json_extract(value, '$.start') - ?) where key = 'join_guess'").bind(JOIN_GUESS_LIMIT.windowMs).run();
    expect((await request(hash, 'pc-b')).status).toBe(202);
  });

  it('形の違う本文は 400', async () => {
    expect((await issue(pcA, 'not-a-hash')).status).toBe(400);
    const { hash } = await newCode(pcA);
    expect((await request(hash, 'pc/b')).status).toBe(400);
    expect((await request(hash, 'pc-b', '')).status).toBe(400);
    expect((await request(hash, 'pc-b', 'x'.repeat(8193))).status).toBe(400);
    expect((await request('zz', 'pc-b')).status).toBe(400);
    expect((await send('/join/status?code=zz&device=pc-b')).status).toBe(400);
    // 形の違う本文は総当たりの回数に数えない。
    expect((await request(hash, 'pc-b')).status).toBe(202);
  });

  it('GET /join/hello はホスト名と、解除されていない PC の数を返す（トークンは要らない）', async () => {
    await addPcDevice(cloud.env, 'pc-b');
    await cloud.env.DB.prepare('update devices set revoked_at = 1 where id = ?').bind('pc-b').run();
    await addPcDevice(cloud.env, 'pc-c');
    await cloud.env.DB.prepare("insert into devices (id, kind, token_hash, joined_at) values ('m1', 'mobile', 'h', 1)").run();
    const r = await send('/join/hello');
    expect(r.status).toBe(200);
    expect((await r.json()) as JoinCodeHello).toEqual({ hostLabel: 'x', pcCount: 2 });
  });
});
