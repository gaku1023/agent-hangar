import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type CloudConfig, loadCloudConfig, saveCloudConfig } from '@agent-hangar/server';
import { encodeJoinToken, type CloudDeviceOut } from '@agent-hangar/shared';
import { cloudDevicesText, joinCommand, joinPlan, leaveCloud, leaveCommand, MembershipError, revokeCloudDevice, revokeCommand, runJoinQuiet } from './membership.ts';

const device = { id: 'dev-a', name: 'mac', platform: 'darwin' };

const temps: string[] = [];
afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

function home(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-membership-'));
  temps.push(root);
  return root;
}

const conf = (over: Partial<CloudConfig> = {}): CloudConfig => ({
  url: 'https://h.workers.dev',
  joinSecret: 'sec',
  deviceToken: 'dt',
  workerName: null,
  accountId: null,
  dbName: null,
  bucketName: null,
  joinedAt: 1,
  ...over,
});

const row = (id: string, over: Partial<CloudDeviceOut> = {}): CloudDeviceOut => ({
  id, name: id, platform: 'darwin', joinedAt: 1, lastSeenAt: 2, revokedAt: null, lastIp: null, lastCity: null, lastRegion: null, lastCountry: null, ...over,
});

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(MembershipError);
  return (e as MembershipError).code;
};

describe('joinPlan（参加の前の見立て。宛先と、いまの参加との違い）', () => {
  it('参加していなければ new で、宛先の URL とホストを返す', () => {
    const h = home();
    expect(joinPlan({ home: h, token: encodeJoinToken({ url: 'https://h.workers.dev/', secret: 's' }) })).toEqual({ url: 'https://h.workers.dev', host: 'h.workers.dev', current: null, change: 'new' });
  });

  it('同じ宛先と同じ秘密なら same、別の宛先なら other-cloud、同じ宛先で秘密が違えば new-secret', () => {
    const h = home();
    saveCloudConfig(h, conf());
    expect(joinPlan({ home: h, token: encodeJoinToken({ url: 'https://h.workers.dev', secret: 'sec' }) }).change).toBe('same');
    const other = joinPlan({ home: h, token: encodeJoinToken({ url: 'https://other.workers.dev', secret: 'sec' }) });
    expect(other.change).toBe('other-cloud');
    expect(other.current).toEqual({ url: 'https://h.workers.dev' });
    expect(joinPlan({ home: h, token: encodeJoinToken({ url: 'https://h.workers.dev', secret: 'x' }) }).change).toBe('new-secret');
  });

  it('見立ての返事に、参加用の秘密を載せない', () => {
    const h = home();
    saveCloudConfig(h, conf());
    const text = JSON.stringify(joinPlan({ home: h, token: encodeJoinToken({ url: 'https://other.workers.dev', secret: 'very-secret-value' }) }));
    expect(text).not.toContain('very-secret-value');
    expect(text).not.toContain('"sec"');
  });

  it('読めない参加トークンは invalid-token、壊れた cloud.json は broken-config', async () => {
    const h = home();
    expect(await codeOf(Promise.resolve().then(() => joinPlan({ home: h, token: 'not-a-token' })))).toBe('invalid-token');
    fs.writeFileSync(path.join(h, 'cloud.json'), '{ こわれている');
    expect(await codeOf(Promise.resolve().then(() => joinPlan({ home: h, token: encodeJoinToken({ url: 'https://h.workers.dev', secret: 's' }) })))).toBe('broken-config');
  });
});

describe('runJoinQuiet（殻から呼ぶ参加。確認は画面で済ませてある）', () => {
  const ok = (async () => new Response(JSON.stringify({ deviceToken: 'dt2', deviceId: device.id }), { status: 201 })) as typeof fetch;

  it('参加して cloud.json を書き、宛先を返す', async () => {
    const h = home();
    const r = await runJoinQuiet({ home: h, token: encodeJoinToken({ url: 'https://h.workers.dev', secret: 'sec' }), device, overwrite: false, fetch: ok, sleep: async () => {} });
    expect(r).toEqual({ url: 'https://h.workers.dev', host: 'h.workers.dev' });
    expect(loadCloudConfig(h)!.deviceToken).toBe('dt2');
  });

  it('別のクラウドに参加済みなら、overwrite が無い限り overwrite-required で断り、何も変えない', async () => {
    const h = home();
    saveCloudConfig(h, conf());
    let called = 0;
    const f = (async () => { called++; return new Response('', { status: 201 }); }) as typeof fetch;
    expect(await codeOf(runJoinQuiet({ home: h, token: encodeJoinToken({ url: 'https://other.workers.dev', secret: 'x' }), device, overwrite: false, fetch: f, sleep: async () => {} }))).toBe('overwrite-required');
    expect(called).toBe(0);
    expect(loadCloudConfig(h)).toEqual(conf());
    const r = await runJoinQuiet({ home: h, token: encodeJoinToken({ url: 'https://other.workers.dev', secret: 'x' }), device, overwrite: true, fetch: ok, sleep: async () => {} });
    expect(r.host).toBe('other.workers.dev');
    expect(loadCloudConfig(h)!.url).toBe('https://other.workers.dev');
  });

  it('解除された PC が同じクラウドへ参加し直すのは、上書きの確認なしで通す', async () => {
    const h = home();
    saveCloudConfig(h, conf());
    await runJoinQuiet({ home: h, token: encodeJoinToken({ url: 'https://h.workers.dev', secret: 'sec' }), device, overwrite: false, fetch: ok, sleep: async () => {} });
    expect(loadCloudConfig(h)!.deviceToken).toBe('dt2');
  });

  it('失敗を種類の符号で返す（秘密が違う、版が古い、繋がらない）', async () => {
    const h = home();
    const token = encodeJoinToken({ url: 'https://h.workers.dev', secret: 'sec' });
    const run = (f: typeof fetch) => runJoinQuiet({ home: h, token, device, overwrite: false, fetch: f, sleep: async () => {} });
    expect(await codeOf(run((async () => new Response('', { status: 403 })) as typeof fetch))).toBe('forbidden');
    expect(await codeOf(run((async () => new Response(JSON.stringify({ error: 'upgrade required', minCompat: 99, compat: 99 }), { status: 426 })) as typeof fetch))).toBe('compat');
    expect(await codeOf(run((async () => { throw new TypeError('fetch failed'); }) as typeof fetch))).toBe('network');
    expect(loadCloudConfig(h)).toBeNull();
  });
});

describe('PC の一覧と解除', () => {
  it('一覧を表にして出す。この PC に印を付け、解除した PC は解除日を添える', async () => {
    const h = home();
    saveCloudConfig(h, conf());
    const f = (async () => new Response(JSON.stringify({ devices: [row('dev-a'), row('dev-b', { revokedAt: Date.UTC(2026, 9, 12) })] }), { status: 200, headers: { 'x-hangar-compat': '6' } })) as typeof fetch;
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
    const f = (async () => new Response(JSON.stringify({ devices: [row('dev-a', { joinedAt: early, lastSeenAt: late }), row('dev-b', { joinedAt: late, revokedAt: early })] }), { status: 200, headers: { 'x-hangar-compat': '6' } })) as typeof fetch;
    const lines = (await cloudDevicesText({ home: h, deviceId: 'dev-a', fetch: f })).split('\n');
    expect(lines[0]).toContain('参加 2026-10-12');
    expect(lines[0]).toContain('最終同期 2026-10-12');
    expect(lines[1]).toContain('参加 2026-10-12');
    expect(lines[1]).toContain('2026-10-12 に解除');
  });

  it('ほかの PC を解除する。自分自身は leave へ案内して断る', async () => {
    const h = home();
    saveCloudConfig(h, conf());
    const urls: string[] = [];
    const f = (async (u: string | URL | Request) => { urls.push(String(u)); return new Response(JSON.stringify({ device: row('dev-b', { revokedAt: 5 }) }), { status: 200, headers: { 'x-hangar-compat': '6' } }); }) as typeof fetch;
    expect((await revokeCloudDevice({ home: h, deviceId: 'dev-a', id: 'dev-b', fetch: f })).revokedAt).toBe(5);
    expect(urls).toEqual(['https://h.workers.dev/devices/dev-b/revoke']);
    expect(await codeOf(revokeCloudDevice({ home: h, deviceId: 'dev-a', id: 'dev-a', fetch: f }))).toBe('self');
  });

  it('同期していなければ not-joined、Worker が古ければ outdated', async () => {
    const h = home();
    const f = (async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'x-hangar-compat': '4' } })) as typeof fetch;
    expect(await codeOf(revokeCloudDevice({ home: h, deviceId: 'dev-a', id: 'dev-b', fetch: f }))).toBe('not-joined');
    saveCloudConfig(h, conf());
    expect(await codeOf(revokeCloudDevice({ home: h, deviceId: 'dev-a', id: 'dev-b', fetch: f }))).toBe('outdated');
  });
});

describe('leaveCloud（この PC の参加を解除）', () => {
  it('クラウドでもこの PC を解除してから cloud.json を消す', async () => {
    const h = home();
    saveCloudConfig(h, conf());
    const urls: string[] = [];
    const f = (async (u: string | URL | Request) => { urls.push(String(u)); return new Response(JSON.stringify({ device: row('dev-a', { revokedAt: 5 }) }), { status: 200, headers: { 'x-hangar-compat': '6' } }); }) as typeof fetch;
    const r = await leaveCloud({ home: h, deviceId: 'dev-a', revoke: true, fetch: f });
    expect(r).toEqual({ revoked: true, revokeError: null, creator: false });
    expect(urls).toEqual(['https://h.workers.dev/devices/dev-a/revoke']);
    expect(fs.existsSync(path.join(h, 'cloud.json'))).toBe(false);
  });

  it('クラウドに繋がらなくても cloud.json は消し、解除できなかったことを返す', async () => {
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

  it('join --plan --json は見立てを 1 行で返し、参加しない', async () => {
    const h = home();
    const o = lines();
    const code = await joinCommand({ home: h, token: encodeJoinToken({ url: 'https://h.workers.dev', secret: 's' }), device, plan: true, yes: false, overwrite: false, json: true, log: o.log });
    expect(code).toBe(0);
    expect(last(o.out)).toEqual({ ok: true, plan: { url: 'https://h.workers.dev', host: 'h.workers.dev', current: null, change: 'new' } });
    expect(loadCloudConfig(h)).toBeNull();
  });

  it('join --yes --json は参加して result を返し、失敗は code と message で返す', async () => {
    const h = home();
    const o = lines();
    const ok = (async () => new Response(JSON.stringify({ deviceToken: 'dt', deviceId: device.id }), { status: 201 })) as typeof fetch;
    expect(await joinCommand({ home: h, token: encodeJoinToken({ url: 'https://h.workers.dev', secret: 's' }), device, plan: false, yes: true, overwrite: false, json: true, log: o.log, fetch: ok, sleep: async () => {} })).toBe(0);
    expect(last(o.out)).toEqual({ ok: true, result: { url: 'https://h.workers.dev', host: 'h.workers.dev' } });
    const bad = lines();
    expect(await joinCommand({ home: h, token: 'nope', device, plan: false, yes: true, overwrite: false, json: true, log: bad.log })).toBe(1);
    expect(last(bad.out)).toMatchObject({ ok: false, code: 'invalid-token' });
  });

  it('--json で --yes も --plan も無ければ、聞けないので断る', async () => {
    const o = lines();
    expect(await joinCommand({ home: home(), token: 'x', device, plan: false, yes: false, overwrite: false, json: true, log: o.log })).toBe(1);
    expect(last(o.out)).toMatchObject({ ok: false, code: 'confirm-required' });
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
    const f = (async () => new Response(JSON.stringify({ device: row('dev-b', { revokedAt: 5 }) }), { status: 200, headers: { 'x-hangar-compat': '6' } })) as typeof fetch;
    expect(await revokeCommand({ home: h, deviceId: 'dev-a', id: 'dev-b', yes: true, json: true, log: o.log, fetch: f })).toBe(0);
    expect(last(o.out)).toMatchObject({ ok: true, result: { id: 'dev-b', revokedAt: 5 } });
  });

  it('秘密と端末トークンは、どの出力にも載せない', async () => {
    const h = home();
    saveCloudConfig(h, conf({ joinSecret: 'SECRET-xyz', deviceToken: 'TOKEN-xyz' }));
    const o = lines();
    await joinCommand({ home: h, token: encodeJoinToken({ url: 'https://o.workers.dev', secret: 'SECRET-new' }), device, plan: true, yes: false, overwrite: false, json: true, log: o.log });
    await leaveCommand({ home: h, deviceId: 'dev-a', revoke: false, yes: true, json: true, log: o.log });
    const all = o.out.join('\n');
    for (const s of ['SECRET-xyz', 'TOKEN-xyz', 'SECRET-new']) expect(all).not.toContain(s);
  });
});
