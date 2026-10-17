import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type CloudConfig, loadCloudConfig, readTranscriptsFrom, saveCloudConfig } from '@agent-hangar/server';
import {
  deriveEpochKeys,
  deriveJoinSecrets,
  deriveSas,
  encodeEpochList,
  generateKeyPair,
  joinCodeHash,
  openJoinRequest,
  randomEpochKey,
  sealKeybox,
  sealRoster,
  setJoinKdfIterationsForTests,
  toBase64Url,
  type DeviceOut,
  type Roster,
} from '@agent-hangar/shared';
import { FakeWorker } from '../test/fakeWorker.ts';
import { expectMode } from '../../server/test/platform.ts';
import {
  cloudDevicesText,
  joinCheck,
  joinCheckCommand,
  joinPoll,
  joinPollCommand,
  joinRequest,
  joinRequestCommand,
  leaveCloud,
  leaveCommand,
  MembershipError,
  pendingJoinPath,
  revokeCloudDevice,
  revokeCommand,
} from './membership.ts';

const device = { id: 'pc-b', name: 'pc-b', platform: 'darwin' };
const URL_ = 'https://h.workers.dev';
const CODE = 'K7QM-2XFD';
/** 偽の Worker が /health で名乗るクラウドの ID。新しい PC はこれを参加コードの重い KDF の salt に使う。 */
const CLOUD = 'cloud-test-1';

// 参加コードの重い KDF（本番は 1 回 0.3 秒前後）は、試験では回数を減らす。
beforeAll(() => setJoinKdfIterationsForTests(1000));
afterAll(() => setJoinKdfIterationsForTests(null));

const temps: string[] = [];
afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

function home(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-membership-'));
  temps.push(root);
  return root;
}

const K = (n: number): string => Buffer.alloc(32, n).toString('base64url');

/** 版 2 の cloud.json。鍵は形だけ合わせた作り物である。 */
const conf = (over: Partial<CloudConfig> = {}): CloudConfig => ({
  v: 2,
  url: URL_,
  cloudId: 'cloud-1',
  deviceToken: 'dt',
  keyPair: { pub: K(1), priv: K(2) },
  epochs: { '1': K(3) },
  currentEpoch: 1,
  phoneKey: null,
  rosterVersion: 1,
  workerName: null,
  accountId: null,
  dbName: null,
  bucketName: null,
  joinedAt: 1,
  ...over,
});

const row = (id: string, over: Partial<DeviceOut> = {}): DeviceOut => ({
  id, kind: 'pc', joinedAt: 1, lastSeenAt: 2, revokedAt: null, expiresAt: null, ...over,
});

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(MembershipError);
  return (e as MembershipError).code;
};

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** 参加済みの PC（pc-a）がいて、世代 1 の世代鍵を持つクラウド。 */
async function cloudWithIssuer() {
  const w = new FakeWorker();
  w.devices.set('pc-a', { tokenHash: sha('tok-a'), revoked: false });
  const pcA = await generateKeyPair();
  const recovery = await generateKeyPair();
  return { w, epochKey: randomEpochKey(), pcA, recovery, phoneKey: K(9) };
}

/**
 * 発行した PC の承認の代わり。
 * 参加リクエストを参加コードで開き、名簿に新しい PC を足し、世代鍵の keybox を新しい PC の公開鍵に封じて置き、承認する。
 * keybox を置かない承認も作れる（承認と keybox の間に問い合わせが来た場面）。
 */
async function issuerApproves(c: Awaited<ReturnType<typeof cloudWithIssuer>>, code: string, o: { keybox?: boolean } = {}) {
  const secrets = await deriveJoinSecrets(code, CLOUD);
  const hash = secrets.codeHash;
  const entry = c.w.codes.get(hash)!;
  const req = await openJoinRequest(secrets, entry.sealed!);
  const keys = await deriveEpochKeys(1, c.epochKey);
  const roster: Roster = {
    v: 1,
    entries: [
      { id: 'pc-a', kind: 'pc', name: 'pc-a', os: 'darwin', pub: c.pcA.pub, joinedAt: 1 },
      { id: entry.deviceId!, kind: 'pc', name: req.name, os: req.os, pub: req.pub, joinedAt: 2 },
    ],
    recoveryPub: c.recovery.pub,
    phoneKey: { epoch: 1, key: c.phoneKey },
  };
  c.w.roster = { version: 2, sealed: toBase64Url(await sealRoster(keys.roster, 2, roster)) };
  if (o.keybox !== false) await putBoxFor(c, entry.deviceId!, req.pub);
  c.w.approve(hash);
  return req;
}

async function putBoxFor(c: Awaited<ReturnType<typeof cloudWithIssuer>>, deviceId: string, pub: string): Promise<void> {
  const sealed = await sealKeybox(pub, { epoch: 1, recipient: deviceId }, encodeEpochList({ epochs: { '1': c.epochKey } }));
  c.w.putBox({ epoch: 1, recipient: deviceId, sealed: toBase64Url(sealed) });
}

const readPending = (h: string): Record<string, unknown> => JSON.parse(fs.readFileSync(pendingJoinPath(h), 'utf8')) as Record<string, unknown>;

describe('joinCheck（接続先の確認）', () => {
  it('health の版と hello を見て、URL とホストと参加済みの PC の数を返す', async () => {
    const c = await cloudWithIssuer();
    const h = home();
    expect(await joinCheck({ home: h, url: `${URL_}/`, fetch: c.w.fetch })).toEqual({ url: URL_, host: 'h.workers.dev', pcCount: 1, current: null });
    expect(c.w.calls).toEqual(['GET /health', 'GET /join/hello']);
  });

  it('形の違う URL は Worker に問い合わせずに invalid-url', async () => {
    const c = await cloudWithIssuer();
    for (const url of ['http://h.workers.dev', 'https://h.workers.dev/path', 'h.workers.dev', 'https://user:pw@h.workers.dev']) {
      expect(await codeOf(joinCheck({ home: home(), url, fetch: c.w.fetch })), url).toBe('invalid-url');
    }
    expect(c.w.calls).toEqual([]);
  });

  it('参加コードの口を持たない古い Worker は outdated', async () => {
    const f = (async () => new Response(JSON.stringify({ ok: true, version: 'x', compat: 8 }), { status: 200 })) as typeof fetch;
    expect(await codeOf(joinCheck({ home: home(), url: URL_, fetch: f }))).toBe('outdated');
  });

  it('別のクラウドに参加済みなら、今の接続先を添える', async () => {
    const c = await cloudWithIssuer();
    const h = home();
    saveCloudConfig(h, conf({ url: 'https://old.workers.dev' }));
    expect((await joinCheck({ home: h, url: URL_, fetch: c.w.fetch })).current).toEqual({ url: 'https://old.workers.dev' });
  });
});

describe('joinRequest（参加リクエストを置く）', () => {
  it('形の違うコードは Worker に送らない', async () => {
    const c = await cloudWithIssuer();
    const h = home();
    for (const code of ['', 'K7QM', 'K7QM-2XF0', 'K7QM-2XFD-X', 'ＫＯ１Ｉ-2XFD']) {
      expect(await codeOf(joinRequest({ home: h, url: URL_, code, device, fetch: c.w.fetch })), code).toBe('invalid-code');
    }
    expect(c.w.calls).toEqual([]);
    expect(fs.existsSync(pendingJoinPath(h))).toBe(false);
  });

  it('join-request は下書きを 0600 で書き、確認コードは deriveSas と同じ', async () => {
    const c = await cloudWithIssuer();
    const h = home();
    c.w.issue(await joinCodeHash(CODE, CLOUD));
    // 小文字と空白と全角のハイフンでも、同じコードとして読む。
    const r = await joinRequest({ home: h, url: URL_, code: ' k7qm－2xfd\n', device, fetch: c.w.fetch, now: () => 1000 });
    const d = readPending(h);
    expectMode(pendingJoinPath(h), 0o600);
    const pub = (d.keyPair as { pub: string }).pub;
    expect(r.sas).toBe(await deriveSas(await deriveJoinSecrets(CODE, CLOUD),pub));
    expect(r.sas).toMatch(/^[0-9]{6}$/);
    expect(r.expiresAt).toBe(1000 + 5 * 60_000);
    // 下書きに参加コードの平文は置かない。
    expect(JSON.stringify(d)).not.toContain('K7QM');
    expect(d).toMatchObject({ url: URL_, codeHash: await joinCodeHash(CODE, CLOUD), deviceId: 'pc-b', deviceToken: null });
    // Worker に置いたリクエストは、参加コードで開くと、この PC の公開鍵と名前と OS である。
    const entry = c.w.codes.get(await joinCodeHash(CODE, CLOUD))!;
    expect(entry.deviceId).toBe('pc-b');
    expect(await openJoinRequest(await deriveJoinSecrets(CODE, CLOUD), entry.sealed!)).toEqual({ pub, name: 'pc-b', os: 'darwin' });
    expect(loadCloudConfig(h)).toBeNull();
  });

  it('期限切れか使用済みのコード（404）は code-not-found で、下書きを消す', async () => {
    const c = await cloudWithIssuer();
    const h = home();
    expect(await codeOf(joinRequest({ home: h, url: URL_, code: CODE, device, fetch: c.w.fetch }))).toBe('code-not-found');
    expect(fs.existsSync(pendingJoinPath(h))).toBe(false);
  });

  it('別のクラウドに参加済みなら、overwrite が無い限り overwrite-required で断り、何も送らない', async () => {
    const c = await cloudWithIssuer();
    const h = home();
    saveCloudConfig(h, conf({ url: 'https://old.workers.dev' }));
    c.w.issue(await joinCodeHash(CODE, CLOUD));
    expect(await codeOf(joinRequest({ home: h, url: URL_, code: CODE, device, fetch: c.w.fetch }))).toBe('overwrite-required');
    expect(c.w.calls).toEqual([]);
    await joinRequest({ home: h, url: URL_, code: CODE, device, fetch: c.w.fetch, overwrite: true });
    expect(c.w.calls).toEqual(['GET /health', 'POST /join/requests']);
  });

  it('参加コードのハッシュと封は /health のクラウドの ID から導き、ID を返さない Worker には何も置かない', async () => {
    const c = await cloudWithIssuer();
    const h = home();
    c.w.issue(await joinCodeHash(CODE, CLOUD));
    // 接続先が別のクラウドを名乗ると、同じコードでもハッシュが一致しない。
    c.w.cloudId = 'cloud-test-2';
    expect(await codeOf(joinRequest({ home: h, url: URL_, code: CODE, device, fetch: c.w.fetch }))).toBe('code-not-found');
    expect(c.w.codes.get(await joinCodeHash(CODE, CLOUD))!.sealed).toBeFalsy();
    // cloudId を返さない Worker（版 9 より前）には、参加リクエストを送らない。
    c.w.calls.length = 0;
    const old = (async (input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).pathname === '/health' ? new Response(JSON.stringify({ ok: true, version: 'x', compat: 9 }), { status: 200 }) : c.w.fetch(input, init)) as typeof fetch;
    expect(await codeOf(joinRequest({ home: h, url: URL_, code: CODE, device, fetch: old }))).toBe('outdated');
    expect(c.w.calls).toEqual([]);
    expect(fs.existsSync(pendingJoinPath(h))).toBe(false);
  });

  it('壊れた cloud.json は上書きせずに broken-config', async () => {
    const c = await cloudWithIssuer();
    const h = home();
    fs.writeFileSync(path.join(h, 'cloud.json'), '{ こわれている');
    expect(await codeOf(joinRequest({ home: h, url: URL_, code: CODE, device, fetch: c.w.fetch, overwrite: true }))).toBe('broken-config');
    expect(c.w.calls).toEqual([]);
  });

  it('古い形式で Worker を作成した PC（workerName あり）は、上書きの指定があっても legacy-config で断り、teardown を案内する', async () => {
    const c = await cloudWithIssuer();
    const h = home();
    const before = JSON.stringify(legacy({ workerName: 'hangar-old', accountId: 'acc', dbName: 'hangar-old', bucketName: 'hangar-old-files' }));
    fs.writeFileSync(path.join(h, 'cloud.json'), before);
    c.w.issue(await joinCodeHash(CODE, CLOUD));
    for (const run of [() => joinCheck({ home: h, url: URL_, fetch: c.w.fetch }), () => joinRequest({ home: h, url: URL_, code: CODE, device, fetch: c.w.fetch, overwrite: true })]) {
      const e = await run().then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(MembershipError);
      expect((e as MembershipError).code).toBe('legacy-config');
      expect((e as MembershipError).message).toContain('npm run hangar -- cloud teardown');
      expect((e as MembershipError).message).toContain('hangar-old');
    }
    expect(c.w.calls).toEqual([]);
    expect(fs.existsSync(pendingJoinPath(h))).toBe(false);
    expect(fs.readFileSync(path.join(h, 'cloud.json'), 'utf8')).toBe(before);
  });

  it('古い形式で参加しただけの PC は、上書きの指定で参加でき、接続先の確認は今の接続先を添える', async () => {
    const c = await cloudWithIssuer();
    const h = home();
    fs.writeFileSync(path.join(h, 'cloud.json'), JSON.stringify(legacy()));
    expect((await joinCheck({ home: h, url: URL_, fetch: c.w.fetch })).current).toEqual({ url: 'https://old.workers.dev' });
    c.w.issue(await joinCodeHash(CODE, CLOUD));
    expect(await codeOf(joinRequest({ home: h, url: URL_, code: CODE, device, fetch: c.w.fetch }))).toBe('overwrite-required');
    await joinRequest({ home: h, url: URL_, code: CODE, device, fetch: c.w.fetch, overwrite: true });
    expect(c.w.calls.at(-1)).toBe('POST /join/requests');
  });
});

/** 0.8.x までの古い形式（版 1）の cloud.json。 */
const legacy = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ url: 'https://old.workers.dev', joinSecret: 's', deviceToken: 'dt-old', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 1, ...over });

describe('joinPoll（1 回だけ問い合わせる）', () => {
  async function requested() {
    const c = await cloudWithIssuer();
    const h = home();
    c.w.issue(await joinCodeHash(CODE, CLOUD));
    await joinRequest({ home: h, url: URL_, code: CODE, device, fetch: c.w.fetch });
    return { c, h };
  }

  it('下書きが無ければ none で、Worker に問い合わせない', async () => {
    const w = new FakeWorker();
    expect(await joinPoll({ home: home(), fetch: w.fetch })).toEqual({ status: 'none' });
    expect(w.calls).toEqual([]);
  });

  it('waiting は何も書かない', async () => {
    const { c, h } = await requested();
    const before = fs.readFileSync(pendingJoinPath(h), 'utf8');
    expect(await joinPoll({ home: h, fetch: c.w.fetch })).toEqual({ status: 'waiting' });
    expect(loadCloudConfig(h)).toBeNull();
    expect(fs.readFileSync(pendingJoinPath(h), 'utf8')).toBe(before);
  });

  it('approved で cloud.json 版 2 を書き、世代鍵を持つ', async () => {
    const { c, h } = await requested();
    const draft = readPending(h);
    await issuerApproves(c, CODE);
    expect(await joinPoll({ home: h, fetch: c.w.fetch })).toEqual({ status: 'approved' });
    const saved = loadCloudConfig(h)!;
    expect(saved).toMatchObject({
      v: 2,
      url: URL_,
      cloudId: c.w.cloudId,
      keyPair: draft.keyPair,
      epochs: { '1': c.epochKey },
      currentEpoch: 1,
      rosterVersion: 2,
      phoneKey: { epoch: 1, key: c.phoneKey },
      workerName: null,
      accountId: null,
      dbName: null,
      bucketName: null,
    });
    // Worker が登録した端末トークンが cloud.json にある。
    expect(c.w.devices.get('pc-b')!.tokenHash).toBe(sha(saved.deviceToken));
    expectMode(path.join(h, 'cloud.json'), 0o600);
    expect(fs.existsSync(pendingJoinPath(h))).toBe(false);
    // 本文をどこから上げるかの床を、cloud.json を書くのと同じ時点で刻む。
    expect(readTranscriptsFrom(h)).toBe(saved.joinedAt);
  });

  it('古い形式で参加しただけの cloud.json は、上書きの前に backups/ へ時刻つきの名前で控える', async () => {
    const c = await cloudWithIssuer();
    const h = home();
    const before = JSON.stringify(legacy());
    fs.writeFileSync(path.join(h, 'cloud.json'), before, { mode: 0o600 });
    c.w.issue(await joinCodeHash(CODE, CLOUD));
    await joinRequest({ home: h, url: URL_, code: CODE, device, fetch: c.w.fetch, overwrite: true });
    // 承認の前は控えない（cloud.json はまだ書き換えない）。
    expect(fs.existsSync(path.join(h, 'backups'))).toBe(false);
    await issuerApproves(c, CODE);
    expect(await joinPoll({ home: h, fetch: c.w.fetch })).toEqual({ status: 'approved' });
    expect(loadCloudConfig(h)).toMatchObject({ v: 2, url: URL_ });
    const files = fs.readdirSync(path.join(h, 'backups')).filter((f) => f.startsWith('cloud.json.'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^cloud\.json\.legacy-\d{8}-\d{6}(-\d+)?$/);
    const copy = path.join(h, 'backups', files[0]!);
    expect(fs.readFileSync(copy, 'utf8')).toBe(before);
    expectMode(copy, 0o600);
  });

  it('参加を完了する前に cloud.json が Worker を作成した古い形式に変わっていたら、上書きせずに legacy-config で止まり、下書きを保つ', async () => {
    const { c, h } = await requested();
    await issuerApproves(c, CODE);
    const before = JSON.stringify(legacy({ workerName: 'hangar-old', accountId: 'acc', dbName: 'hangar-old', bucketName: 'hangar-old-files' }));
    fs.writeFileSync(path.join(h, 'cloud.json'), before);
    expect(await codeOf(joinPoll({ home: h, fetch: c.w.fetch }))).toBe('legacy-config');
    expect(fs.readFileSync(path.join(h, 'cloud.json'), 'utf8')).toBe(before);
    expect(readPending(h).deviceToken).toEqual(expect.any(String));
  });

  it('承認の直後で keybox がまだ無ければ、受け取った端末トークンを下書きに持って waiting、次の問い合わせで完了する', async () => {
    const { c, h } = await requested();
    const req = await issuerApproves(c, CODE, { keybox: false });
    expect(await joinPoll({ home: h, fetch: c.w.fetch })).toEqual({ status: 'waiting' });
    expect(loadCloudConfig(h)).toBeNull();
    expect(readPending(h).deviceToken).toEqual(expect.any(String));
    await putBoxFor(c, 'pc-b', req.pub);
    c.w.calls.length = 0;
    expect(await joinPoll({ home: h, fetch: c.w.fetch })).toEqual({ status: 'approved' });
    // 端末トークンは 1 回しか受け取れないので、2 回目は /join/status に問い合わせない。
    expect(c.w.calls).not.toContain('GET /join/status');
    expect(loadCloudConfig(h)!.epochs).toEqual({ '1': c.epochKey });
  });

  it('承認済みで端末トークンを受信した下書きは、新しい参加リクエストで上書きせず join-pending で断る', async () => {
    const { c, h } = await requested();
    await issuerApproves(c, CODE, { keybox: false });
    expect(await joinPoll({ home: h, fetch: c.w.fetch })).toEqual({ status: 'waiting' });
    const before = fs.readFileSync(pendingJoinPath(h), 'utf8');
    const next = 'M8RN-3YGE';
    c.w.issue(await joinCodeHash(next, CLOUD));
    c.w.calls.length = 0;
    expect(await codeOf(joinRequest({ home: h, url: URL_, code: next, device, fetch: c.w.fetch }))).toBe('join-pending');
    // Worker に送らず、下書き（端末トークン）はそのまま。
    expect(c.w.calls).toEqual([]);
    expect(fs.readFileSync(pendingJoinPath(h), 'utf8')).toBe(before);
    const o: string[] = [];
    expect(await joinRequestCommand({ home: h, url: URL_, code: next, device, overwrite: true, json: true, log: (l) => o.push(l), fetch: c.w.fetch })).toBe(1);
    expect(JSON.parse(o.at(-1)!)).toMatchObject({ ok: false, code: 'join-pending', message: expect.stringContaining('hangar cloud join-poll') });
    expect(fs.readFileSync(pendingJoinPath(h), 'utf8')).toBe(before);
  });

  it('承認前の下書きは、新しい参加リクエストで置き換えられる', async () => {
    const { c, h } = await requested();
    const first = readPending(h).codeHash;
    const next = 'M8RN-3YGE';
    c.w.issue(await joinCodeHash(next, CLOUD));
    await joinRequest({ home: h, url: URL_, code: next, device, fetch: c.w.fetch });
    expect(readPending(h).codeHash).not.toBe(first);
    expect(readPending(h).codeHash).toBe(await joinCodeHash(next, CLOUD));
  });

  it('expired で下書きを消す', async () => {
    const { c, h } = await requested();
    c.w.now = () => Date.now() + 6 * 60_000;
    expect(await joinPoll({ home: h, fetch: c.w.fetch })).toEqual({ status: 'expired' });
    expect(fs.existsSync(pendingJoinPath(h))).toBe(false);
    expect(loadCloudConfig(h)).toBeNull();
  });

  it('rejected でも下書きを消し、cloud.json を書かない', async () => {
    const { c, h } = await requested();
    c.w.reject(await joinCodeHash(CODE, CLOUD));
    expect(await joinPoll({ home: h, fetch: c.w.fetch })).toEqual({ status: 'rejected' });
    expect(fs.existsSync(pendingJoinPath(h))).toBe(false);
    expect(loadCloudConfig(h)).toBeNull();
  });
});

describe('PC の一覧と解除', () => {
  it('一覧を表にして出す。この PC にマークを付け、解除した PC は解除日を添える', async () => {
    const h = home();
    saveCloudConfig(h, conf());
    const f = (async () => new Response(JSON.stringify({ devices: [row('dev-a'), row('dev-b', { revokedAt: Date.UTC(2026, 9, 12) })] }), { status: 200, headers: { 'x-hangar-compat': '9' } })) as typeof fetch;
    const text = await cloudDevicesText({ home: h, deviceId: 'dev-a', fetch: f });
    expect(text).toContain('dev-a');
    expect(text).toContain('この PC');
    expect(text).toContain('解除');
  });

  it('日付は手元の時刻の日付で出す（画面の参加日とそろえる）', async () => {
    const h = home();
    saveCloudConfig(h, conf());
    // 手元の 0 時 30 分と 23 時 30 分。UTC の日付で出すと、東の時間帯では前の日、西の時間帯では次の日にずれる。
    const early = new Date(2026, 9, 12, 0, 30).getTime();
    const late = new Date(2026, 9, 12, 23, 30).getTime();
    const f = (async () => new Response(JSON.stringify({ devices: [row('dev-a', { joinedAt: early, lastSeenAt: late }), row('dev-b', { joinedAt: late, revokedAt: early })] }), { status: 200, headers: { 'x-hangar-compat': '9' } })) as typeof fetch;
    const lines = (await cloudDevicesText({ home: h, deviceId: 'dev-a', fetch: f })).split('\n');
    expect(lines[0]).toContain('参加 2026-10-12');
    expect(lines[0]).toContain('最終同期 2026-10-12');
    expect(lines[1]).toContain('参加 2026-10-12');
    expect(lines[1]).toContain('2026-10-12 に解除');
  });

  it('他の PC の解除は、動いているサーバーの経路に頼む（世代を回すため）。自分自身は leave へ案内して断る', async () => {
    const h = home();
    saveCloudConfig(h, conf());
    fs.writeFileSync(path.join(h, 'token'), 'server-token');
    const seen: { url: string; method: string; auth: string | null }[] = [];
    const f = (async (u: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(u), method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify({ device: row('dev-b', { revokedAt: 5 }) }), { status: 200 });
    }) as typeof fetch;
    expect((await revokeCloudDevice({ home: h, deviceId: 'dev-a', id: 'dev-b', port: 4999, fetch: f })).revokedAt).toBe(5);
    expect(seen).toEqual([{ url: 'http://127.0.0.1:4999/api/sync/cloud-devices/dev-b/revoke', method: 'POST', auth: 'Bearer server-token' }]);
    expect(await codeOf(revokeCloudDevice({ home: h, deviceId: 'dev-a', id: 'dev-a', fetch: f }))).toBe('self');
  });

  it('サーバーの断りの符号をそのまま返す', async () => {
    const h = home();
    saveCloudConfig(h, conf());
    for (const [status, code] of [[409, 'self'], [409, 'revoked'], [404, 'not-found'], [502, 'unreachable']] as const) {
      const f = (async () => new Response(JSON.stringify({ error: 'm', code }), { status })) as typeof fetch;
      expect(await codeOf(revokeCloudDevice({ home: h, deviceId: 'dev-a', id: 'dev-b', fetch: f }))).toBe(code);
    }
  });

  it('サーバーが止まっていれば、スマホは Worker で直に解除し、PC は起動を求めて断る', async () => {
    const h = home();
    saveCloudConfig(h, conf());
    const urls: string[] = [];
    const f = (async (u: string | URL | Request) => {
      const url = String(u);
      urls.push(url);
      if (url.startsWith('http://127.0.0.1')) throw new TypeError('fetch failed');
      if (url.endsWith('/devices')) return new Response(JSON.stringify({ devices: [row('dev-a'), row('dev-b'), row('phone-1', { kind: 'mobile' })] }), { status: 200, headers: { 'x-hangar-compat': '9' } });
      return new Response(JSON.stringify({ device: row('phone-1', { kind: 'mobile', revokedAt: 7 }) }), { status: 200, headers: { 'x-hangar-compat': '9' } });
    }) as typeof fetch;
    expect((await revokeCloudDevice({ home: h, deviceId: 'dev-a', id: 'phone-1', fetch: f })).revokedAt).toBe(7);
    expect(urls.filter((u) => u.startsWith('https://'))).toEqual(['https://h.workers.dev/devices', 'https://h.workers.dev/devices/phone-1/revoke']);
    urls.length = 0;
    expect(await codeOf(revokeCloudDevice({ home: h, deviceId: 'dev-a', id: 'dev-b', fetch: f }))).toBe('server-down');
    expect(urls.some((u) => u.endsWith('/revoke') && u.startsWith('https://'))).toBe(false);
    expect(await codeOf(revokeCloudDevice({ home: h, deviceId: 'dev-a', id: 'dev-z', fetch: f }))).toBe('not-found');
  });

  it('同期していなければ not-joined、古い形式の cloud.json は legacy-config', async () => {
    const h = home();
    const f = (async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'x-hangar-compat': '9' } })) as typeof fetch;
    expect(await codeOf(revokeCloudDevice({ home: h, deviceId: 'dev-a', id: 'dev-b', fetch: f }))).toBe('not-joined');
    fs.writeFileSync(path.join(h, 'cloud.json'), JSON.stringify({ url: URL_, joinSecret: 's', deviceToken: 'dt', workerName: null, accountId: null, dbName: null, bucketName: null, joinedAt: 1 }));
    expect(await codeOf(revokeCloudDevice({ home: h, deviceId: 'dev-a', id: 'dev-b', fetch: f }))).toBe('legacy-config');
  });
});

describe('leaveCloud（この PC の参加を解除）', () => {
  it('クラウドでもこの PC を解除してから cloud.json を消す', async () => {
    const h = home();
    saveCloudConfig(h, conf());
    const urls: string[] = [];
    const f = (async (u: string | URL | Request) => { urls.push(String(u)); return new Response(JSON.stringify({ device: row('dev-a', { revokedAt: 5 }) }), { status: 200, headers: { 'x-hangar-compat': '9' } }); }) as typeof fetch;
    const r = await leaveCloud({ home: h, deviceId: 'dev-a', revoke: true, fetch: f });
    expect(r).toEqual({ revoked: true, revokeError: null, creator: false });
    expect(urls).toEqual(['https://h.workers.dev/devices/dev-a/revoke']);
    expect(fs.existsSync(path.join(h, 'cloud.json'))).toBe(false);
  });

  it('クラウドに接続できなくても cloud.json は消し、解除できなかったことを返す', async () => {
    const h = home();
    saveCloudConfig(h, conf({ workerName: 'hangar' }));
    const f = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const r = await leaveCloud({ home: h, deviceId: 'dev-a', revoke: true, fetch: f });
    expect(r.revoked).toBe(false);
    expect(r.revokeError).not.toBeNull();
    expect(r.creator).toBe(true);
    expect(fs.existsSync(path.join(h, 'cloud.json'))).toBe(false);
  });

  it('revoke を外せばクラウドには触らない', async () => {
    const h = home();
    saveCloudConfig(h, conf());
    const f = (async () => { throw new Error('触ってはいけない'); }) as typeof fetch;
    expect(await leaveCloud({ home: h, deviceId: 'dev-a', revoke: false, fetch: f })).toEqual({ revoked: false, revokeError: null, creator: false });
    expect(fs.existsSync(path.join(h, 'cloud.json'))).toBe(false);
  });

  it('参加していなければ not-joined、壊れた cloud.json は消さずに broken-config', async () => {
    const h = home();
    expect(await codeOf(leaveCloud({ home: h, deviceId: 'dev-a', revoke: true }))).toBe('not-joined');
    fs.writeFileSync(path.join(h, 'cloud.json'), '{ こわれている');
    expect(await codeOf(leaveCloud({ home: h, deviceId: 'dev-a', revoke: true }))).toBe('broken-config');
    expect(fs.existsSync(path.join(h, 'cloud.json'))).toBe(true);
  });
});

describe('殻から呼ぶ形（--json の 1 行）', () => {
  const lines = (): { out: string[]; log: (l: string) => void } => { const out: string[] = []; return { out, log: (l) => out.push(l) }; };
  const last = (out: string[]) => JSON.parse(out.at(-1)!) as Record<string, unknown>;

  it('join-check、join-request、join-poll は結果を 1 行の JSON で返す', async () => {
    const c = await cloudWithIssuer();
    const h = home();
    c.w.issue(await joinCodeHash(CODE, CLOUD));

    const chk = lines();
    expect(await joinCheckCommand({ home: h, url: URL_, json: true, log: chk.log, fetch: c.w.fetch })).toBe(0);
    expect(last(chk.out)).toEqual({ ok: true, check: { url: URL_, host: 'h.workers.dev', pcCount: 1, current: null } });

    const req = lines();
    expect(await joinRequestCommand({ home: h, url: URL_, code: CODE, device, overwrite: false, json: true, log: req.log, fetch: c.w.fetch })).toBe(0);
    const request = last(req.out).request as { sas: string; expiresAt: number };
    expect(last(req.out)).toEqual({ ok: true, request: { sas: expect.stringMatching(/^[0-9]{6}$/), expiresAt: expect.any(Number) } });

    const p1 = lines();
    expect(await joinPollCommand({ home: h, json: true, log: p1.log, fetch: c.w.fetch })).toBe(0);
    expect(last(p1.out)).toEqual({ ok: true, poll: { status: 'waiting' } });
    await issuerApproves(c, CODE);
    const p2 = lines();
    expect(await joinPollCommand({ home: h, json: true, log: p2.log, fetch: c.w.fetch })).toBe(0);
    expect(last(p2.out)).toEqual({ ok: true, poll: { status: 'approved' } });

    // 秘密鍵、世代鍵、端末トークン、参加コードは、どの出力にも載せない。
    const saved = loadCloudConfig(h)!;
    const all = [...chk.out, ...req.out, ...p1.out, ...p2.out].join('\n');
    for (const s of [saved.keyPair.priv, saved.epochs['1']!, saved.deviceToken, CODE, 'K7QM2XFD']) expect(all).not.toContain(s);
    expect(request.sas).toBe(await deriveSas(await deriveJoinSecrets(CODE, CLOUD),saved.keyPair.pub));
  });

  it('失敗は code と message の 1 行で返す', async () => {
    const o = lines();
    expect(await joinRequestCommand({ home: home(), url: URL_, code: 'nope', device, overwrite: false, json: true, log: o.log, fetch: new FakeWorker().fetch })).toBe(1);
    expect(last(o.out)).toMatchObject({ ok: false, code: 'invalid-code', message: expect.stringContaining('参加コード') });
  });

  it('cloud leave --yes --json は結果を返す', async () => {
    const h = home();
    saveCloudConfig(h, conf());
    const o = lines();
    expect(await leaveCommand({ home: h, deviceId: 'dev-a', revoke: false, yes: true, json: true, log: o.log })).toBe(0);
    expect(last(o.out)).toEqual({ ok: true, result: { revoked: false, revokeError: null, creator: false } });
  });

  it('cloud revoke --yes --json は解除した PC を返す', async () => {
    const h = home();
    saveCloudConfig(h, conf());
    const o = lines();
    const f = (async () => new Response(JSON.stringify({ device: row('dev-b', { revokedAt: 5 }) }), { status: 200, headers: { 'x-hangar-compat': '9' } })) as typeof fetch;
    expect(await revokeCommand({ home: h, deviceId: 'dev-a', id: 'dev-b', yes: true, json: true, log: o.log, fetch: f })).toBe(0);
    expect(last(o.out)).toMatchObject({ ok: true, result: { id: 'dev-b', revokedAt: 5 } });
  });

  it('端末トークンは leave の出力に載せない', async () => {
    const h = home();
    saveCloudConfig(h, conf({ deviceToken: 'TOKEN-xyz' }));
    const o = lines();
    await leaveCommand({ home: h, deviceId: 'dev-a', revoke: false, yes: true, json: true, log: o.log });
    expect(o.out.join('\n')).not.toContain('TOKEN-xyz');
  });
});
