import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { COMPAT_HEADER, ROSTER_MARKER_K, type ChangeIn } from '@agent-hangar/shared';
import { testCloudConfig, testKey } from '../../test/cloudConfig.ts';
import { FakeWireClient } from '../../test/fake-cloud.ts';
import { CloudError, CompatError, HttpCloudClient, MIN_WORKER_COMPAT } from './client.ts';
import { Keyring } from './keyring.ts';
import { SealedCloudClient } from './sealedClient.ts';

const ring = (over: Parameters<typeof testCloudConfig>[0] = {}) => Keyring.fromConfig(testCloudConfig(over));

const TITLE = 'title-1 secret talk';
const session = (id: string, updatedAt: number, title = TITLE): ChangeIn => ({ tableName: 'sessions', rowId: id, op: 'upsert', payload: { id, title, cwd: '/w/project-x' }, updatedAt });

/** 同じ偽の Worker を分け合う 2 台の PC。鍵はどちらも同じ世代 1 を持つ。 */
async function twoPcs(o: { ringA?: Keyring; ringB?: Keyring; onRosterB?: () => Promise<void> } = {}) {
  const wireA = new FakeWireClient({ deviceId: 'pc-a' });
  const wireB = wireA.asDevice('pc-b');
  const a = new SealedCloudClient(wireA, o.ringA ?? (await ring()), 'pc-a');
  const b = new SealedCloudClient(wireB, o.ringB ?? (await ring()), 'pc-b', { onRoster: o.onRosterB });
  return { wireA, wireB, a, b };
}

describe('SealedCloudClient', () => {
  it('push した行を別の PC が pull すると元の ChangeOut になる', async () => {
    const { a, b } = await twoPcs();
    const rows = [session('s1', 100), { tableName: 'projects', rowId: 'p1', op: 'delete', payload: {}, updatedAt: 200 } satisfies ChangeIn];
    expect(await a.pushChanges(rows)).toEqual({ seq: 2, accepted: 2, skipped: 0 });
    const page = await b.pullChanges(0, 500);
    expect(page.unreadable).toEqual([]);
    expect(page.changes).toEqual([
      { ...rows[0], seq: 1, deviceId: 'pc-a' },
      { ...rows[1], seq: 2, deviceId: 'pc-a' },
    ]);
    expect(page).toMatchObject({ nextSeq: 2, more: false });
    const snap = await b.snapshot(null, 500);
    expect(snap.unreadable).toEqual([]);
    expect(snap.changes.map((c) => `${c.tableName}:${c.rowId}`).sort()).toEqual(['projects:p1', 'sessions:s1']);
  });

  it('偽のクラウドの保存した値を走査して、表名、行 ID、payload の中の題の文字列が無い', async () => {
    const { a, wireA } = await twoPcs();
    const big = 'x'.repeat(400);
    await a.pushChanges([session('session-id-123', 1), session('session-id-456', 2, `${TITLE} ${big}`), { tableName: 'todos', rowId: 'todo-id-789', op: 'upsert', payload: { id: 'todo-id-789', text: TITLE }, updatedAt: 3 }]);
    const stored = [...wireA.rows.values(), ...wireA.changes];
    expect(stored.length).toBeGreaterThan(0);
    const dump = stored.map((r) => [r.k, r.op, r.deviceId, String(r.updatedAt), String(r.epoch), Buffer.from(r.sealed).toString('latin1')].join('|')).join('\n');
    for (const plain of ['sessions', 'todos', 'session-id-123', 'session-id-456', 'todo-id-789', 'title-1', 'secret', 'project-x', 'xxxxxxxx']) expect(dump).not.toContain(plain);
    // 表名と行 ID は k（HMAC）にだけ形を変えて残る。
    for (const r of wireA.rows.values()) expect(r.k).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it.each([
    ['deviceId', (r: { deviceId: string }) => { r.deviceId = 'pc-c'; }],
    ['updatedAt', (r: { updatedAt: number }) => { r.updatedAt += 1; }],
    ['k', (r: { k: string }) => { r.k = `${r.k.slice(0, 42)}${r.k[42] === 'A' ? 'B' : 'A'}`; }],
    ['op', (r: { op: string }) => { r.op = 'delete'; }],
  ] as const)('偽のクラウドの rows の %s を書き換えると、その行は unreadable になる', async (_col, tamper) => {
    const { a, b, wireA } = await twoPcs();
    await a.pushChanges([session('s1', 1), session('s2', 2)]);
    const first = [...wireA.rows.values()].find((r) => r.seq === 1)!;
    tamper(first as never);
    const page = await b.pullChanges(0, 500);
    expect(page.changes.map((c) => c.rowId)).toEqual(['s2']);
    expect(page.unreadable).toEqual([{ seq: 1, epoch: 1 }]);
    // 区切りは読めない行も越えて進む。
    expect(page.nextSeq).toBe(2);
  });

  it('書くときは今の世代で封じ、読むときは行が名乗る世代の鍵で開く', async () => {
    const ringA = await ring({ epochs: { '1': testKey(3), '2': testKey(4) }, currentEpoch: 2 });
    const ringB = await ring({ epochs: { '1': testKey(3), '2': testKey(4) }, currentEpoch: 1 });
    const { a, b, wireA } = await twoPcs({ ringA, ringB });
    await a.pushChanges([session('s1', 1)]);
    expect([...wireA.rows.values()].map((r) => r.epoch)).toEqual([2]);
    expect((await b.pullChanges(0, 500)).changes.map((c) => c.rowId)).toEqual(['s1']);
  });

  it('知らない世代の行は unreadable で返し、refreshKeys は onRoster を走らせて読めるようになったかを答える', async () => {
    const ringA = await ring({ epochs: { '1': testKey(3), '2': testKey(4) }, currentEpoch: 2 });
    const ringB = await ring();
    const onRoster = vi.fn(async () => { await ringB.addEpochs({ epochs: { '2': testKey(4) } }); });
    const { a, b } = await twoPcs({ ringA, ringB, onRosterB: onRoster });
    await a.pushChanges([session('s1', 1)]);
    const page = await b.pullChanges(0, 500);
    expect(page.changes).toEqual([]);
    expect(page.unreadable).toEqual([{ seq: 1, epoch: 2 }]);
    expect(onRoster).not.toHaveBeenCalled();
    // 手元にある世代だけなら、読み直しても変わらないので走らせない。
    expect(await b.refreshKeys([1])).toBe('not-needed');
    expect(onRoster).not.toHaveBeenCalled();
    expect(await b.refreshKeys([2, 2])).toBe('gained');
    expect(onRoster).toHaveBeenCalledTimes(1);
    expect((await b.pullChanges(0, 500)).changes.map((c) => c.rowId)).toEqual(['s1']);
  });

  it('読み直しても鍵が届かなければ missing と答える', async () => {
    const ringA = await ring({ epochs: { '1': testKey(3), '2': testKey(4) }, currentEpoch: 2 });
    const onRoster = vi.fn(async () => {});
    const { b } = await twoPcs({ ringA, onRosterB: onRoster });
    expect(await b.refreshKeys([2])).toBe('missing');
    expect(onRoster).toHaveBeenCalledTimes(1);
  });

  it('名簿の印の行は開かずに onRoster に回し、同じ印では 2 度走らせない', async () => {
    const onRoster = vi.fn(async () => {});
    const { a, b, wireA } = await twoPcs({ onRosterB: onRoster });
    await a.pushChanges([session('s1', 1)]);
    wireA.touchRoster(1);
    const page = await b.pullChanges(0, 500);
    expect(page.changes.map((c) => c.rowId)).toEqual(['s1']);
    expect(page.unreadable).toEqual([]);
    expect(onRoster).toHaveBeenCalledTimes(1);
    // 写しにも印は載るが、もう見た印なので走らせない。
    const snap = await b.snapshot(null, 500);
    expect(snap.changes.map((c) => c.rowId)).toEqual(['s1']);
    expect(snap.unreadable).toEqual([]);
    expect(onRoster).toHaveBeenCalledTimes(1);
    // 名簿がまた書き換わったら、新しい印でもう 1 度走る。
    wireA.touchRoster(1);
    await b.pullChanges(0, 500);
    expect(onRoster).toHaveBeenCalledTimes(2);
  });

  it('印の行の世代が古くても（後戻りしても）、印として扱う', async () => {
    const onRoster = vi.fn(async () => {});
    const { b, wireA } = await twoPcs({ onRosterB: onRoster });
    wireA.touchRoster(5);
    wireA.touchRoster(1);
    const page = await b.pullChanges(0, 500);
    expect(page.changes).toEqual([]);
    expect(page.unreadable).toEqual([]);
    expect(onRoster).toHaveBeenCalledTimes(1);
    expect([...wireA.rows.values()].find((r) => r.k === ROSTER_MARKER_K)?.sealed.length).toBe(0);
  });

  it('onRoster が倒れたら pull も倒れ、次の pull でもう 1 度走らせる', async () => {
    let fail = true;
    const onRoster = vi.fn(async () => { if (fail) throw new CloudError(0, 'offline'); });
    const { b, wireA } = await twoPcs({ onRosterB: onRoster });
    wireA.touchRoster(1);
    await expect(b.pullChanges(0, 500)).rejects.toMatchObject({ status: 0 });
    fail = false;
    await b.pullChanges(0, 500);
    expect(onRoster).toHaveBeenCalledTimes(2);
  });

  it('Worker が k で名指しした 413 を、表名と行 ID の名指しに戻す', async () => {
    const { a } = await twoPcs();
    // gzip で縮まない中身にする。
    const noise = randomBytes(150 * 1024).toString('base64');
    const e = await a.pushChanges([session('s1', 1), { tableName: 'project_memos', rowId: 'p-big', op: 'upsert', payload: { body: noise }, updatedAt: 1 }]).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CloudError);
    const body = JSON.parse((e as CloudError).message) as { error: string; limit: number; row: { tableName: string; rowId: string; bytes: number } };
    expect(body).toMatchObject({ error: 'payload too large', limit: 180 * 1024, row: { tableName: 'project_memos', rowId: 'p-big' } });
    expect(body.row.bytes).toBeGreaterThan(180 * 1024);
  });

  it('形の違う行は封じずに 400 で断る', async () => {
    const { a, wireA } = await twoPcs();
    await expect(a.pushChanges([{ ...session('s1', 1), tableName: 'nope' } as never])).rejects.toMatchObject({ status: 400 });
    await expect(a.pushChanges([{ ...session('s1', 1), rowId: '' }])).rejects.toMatchObject({ status: 400 });
    await expect(a.pushChanges([{ ...session('s1', 1), payload: [1] } as never])).rejects.toMatchObject({ status: 400 });
    await expect(a.pushChanges([{ ...session('s1', 1), updatedAt: Number.NaN }])).rejects.toMatchObject({ status: 400 });
    expect(wireA.calls).toEqual([]);
  });

  it('本文、使用量、PC の一覧などは線の client にそのまま渡す', async () => {
    const { a, wireA } = await twoPcs();
    expect(await a.health()).toEqual({ ok: true, version: 'fake' });
    expect(await a.usage()).toEqual({ configured: false });
    expect((await a.listDevices!()).map((d) => d.id)).toEqual(['pc-a']);
    expect(a.lastWorkerCompat!()).toBe(wireA.lastWorkerCompat());
    expect(wireA.calls.map((c) => c.method)).toEqual(['health', 'usage', 'listDevices']);
  });

  it('この PC が Worker に求める下限は 9', () => {
    expect(MIN_WORKER_COMPAT).toBe(9);
  });

  it('版 8 の Worker には push しない（CompatError(worker)）', async () => {
    const sent: string[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      sent.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      return new Response(JSON.stringify({ ok: true, version: 'old' }), { status: 200, headers: { 'content-type': 'application/json', [COMPAT_HEADER]: '8' } });
    }) as typeof globalThis.fetch;
    const wire = new HttpCloudClient({ url: 'https://h', token: 't', fetch, checkWorkerBeforeWrite: true });
    const c = new SealedCloudClient(wire, await ring(), 'pc-a');
    const e = await c.pushChanges([session('s1', 1)]).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CompatError);
    expect(e).toMatchObject({ upgrade: 'worker', have: 8, need: 9 });
    expect(sent).toEqual(['GET /health']);
  });

  it('Keyring を待つ間に作れて、鍵が読めなければ push も pull も倒れる', async () => {
    const wire = new FakeWireClient({ deviceId: 'pc-a' });
    const broken = Promise.reject(new Error('the current epoch key is missing from cloud.json'));
    const c = new SealedCloudClient(wire, broken, 'pc-a');
    await expect(c.pushChanges([session('s1', 1)])).rejects.toThrow(/epoch key/);
    await expect(c.pullChanges(0, 10)).rejects.toThrow(/epoch key/);
    expect(wire.calls.filter((x) => x.method === 'pushChanges')).toEqual([]);
  });
});
