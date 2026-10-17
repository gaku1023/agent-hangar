import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROSTER_MARKER_K, type SealedChangeIn, type SealedChangeOut, type SealedPullChangesResponse, type SealedSnapshotResponse } from '@agent-hangar/shared';
import { MAX_PAGE_SEALED_CHARS, MAX_ROW_BYTES } from '../src/changes.ts';
import { TOUCH_EVERY_MS } from '../src/seen.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { addPcDevice, startCloud, type CloudHarness } from './harness.ts';

let cloud: CloudHarness;
let tokA = '';
let tokB = '';

/** 行の k。本物は HMAC の base64url（43 字）なので、同じ長さと文字種の作り物にする。 */
const K = (name: string): string => `k${name}`.padEnd(43, '_');

const push = (tok: string, changes: unknown): Promise<Response> =>
  cloud.SELF.fetch('https://x/changes', {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ changes }),
  });

const pushed = async (tok: string, changes: unknown): Promise<{ seq: number; accepted: number; skipped: number }> =>
  (await (await push(tok, changes)).json()) as { seq: number; accepted: number; skipped: number };

/** pull の応答のうち、変更の頁の部分。生存の知らせ（peers と now）は別の試験で見る。 */
const pageOf = (o: SealedPullChangesResponse) => ({ changes: o.changes, nextSeq: o.nextSeq, more: o.more });

const pullRaw = (tok: string, since: number, limit = 500): Promise<Response> =>
  cloud.SELF.fetch(`https://x/changes?since=${since}&limit=${limit}`, { headers: { authorization: `Bearer ${tok}` } });

const pull = async (tok: string, since: number, limit = 500): Promise<SealedPullChangesResponse> =>
  (await (await pullRaw(tok, since, limit)).json()) as SealedPullChangesResponse;

const rows = async (tok: string, after = '', limit = 500): Promise<SealedSnapshotResponse> =>
  (await (
    await cloud.SELF.fetch(`https://x/rows?after=${encodeURIComponent(after)}&limit=${limit}`, { headers: { authorization: `Bearer ${tok}` } })
  ).json()) as SealedSnapshotResponse;

/** 封じた 1 行。sealed は中身の代わりに名前を base64url にしたもので、Worker は開かない。 */
const ch = (name: string, updatedAt: number, body = name, o: Partial<SealedChangeIn> = {}): SealedChangeIn => ({
  k: K(name),
  op: 'upsert',
  updatedAt,
  epoch: 1,
  sealed: Buffer.from(body).toString('base64url'),
  ...o,
});

const bodyOfSealed = (c: { sealed: string }): string => Buffer.from(c.sealed, 'base64url').toString();

/** sealed がちょうど `bytes` 字になる 1 件を作る。 */
const sized = (name: string, bytes: number): SealedChangeIn => ({ ...ch(name, 1), sealed: 'A'.repeat(bytes) });

const bodyOf = async (r: Response): Promise<Record<string, unknown>> => (await r.json()) as Record<string, unknown>;

/** D1 に置かれた封じた中身（BLOB のバイト列）を、ch() に渡した中身の文字列に戻す。 */
const sealedOf = async (k: string): Promise<string> => {
  const r = await cloud.env.DB.prepare('select hex(sealed) h from rows where k = ?').bind(k).first<{ h: string }>();
  return Buffer.from(r!.h, 'hex').toString();
};

/** rows の連番を、連番の順で返す。 */
const seqs = async (): Promise<number[]> =>
  (await cloud.env.DB.prepare('select seq from rows order by seq').all<{ seq: number }>()).results.map((r) => r.seq);

const seqOf = async (k: string): Promise<number | undefined> =>
  (await cloud.env.DB.prepare('select seq from rows where k = ?').bind(k).first<{ seq: number }>())?.seq;

const lastSeen = async (id: string): Promise<number | null> =>
  (await cloud.env.DB.prepare('select last_seen_at from devices where id = ?').bind(id).first<{ last_seen_at: number | null }>())!.last_seen_at;

const setLastSeen = (id: string, at: number): Promise<unknown> => cloud.env.DB.prepare('update devices set last_seen_at = ? where id = ?').bind(at, id).run();

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema(cloud.env);
  tokA = await addPcDevice(cloud.env, 'dev-a');
  tokB = await addPcDevice(cloud.env, 'dev-b');
});

afterEach(async () => {
  await cloud.dispose();
});

describe('POST /changes（封じた行）', () => {
  it('封じた行の push と pull が往復する', async () => {
    const sent = ch('p1', 100, 'naka-1', { epoch: 3, op: 'delete' });
    expect(await pushed(tokA, [sent])).toEqual({ seq: 1, accepted: 1, skipped: 0 });
    const got = await pull(tokB, 0);
    expect(got.changes).toEqual([{ ...sent, seq: 1, deviceId: 'dev-a' }]);
    // D1 には k と時刻と世代と封じた中身だけが残り、表名と行 ID の列は無い。
    const row = await cloud.env.DB.prepare('select * from rows').first<Record<string, unknown>>();
    expect(Object.keys(row!).sort()).toEqual(['device_id', 'epoch', 'k', 'op', 'sealed', 'seq', 'updated_at']);
    // 封じた中身は base64url の文字ではなく、バイト列の BLOB で持つ（大きさが約 3/4 になる）。
    expect(await cloud.env.DB.prepare('select typeof(sealed) t, length(sealed) n from rows').first()).toEqual({ t: 'blob', n: 'naka-1'.length });
  });

  it('k が同じ行は上書きし、updatedAt の新しい方を採る。古い行は skipped', async () => {
    expect(await pushed(tokA, [ch('p1', 100), ch('p2', 100)])).toEqual({ seq: 2, accepted: 2, skipped: 0 });
    expect(await pushed(tokB, [ch('p1', 50, 'old'), ch('p2', 200, 'new')])).toEqual({ seq: 3, accepted: 1, skipped: 1 });
    expect(await sealedOf(K('p2'))).toBe('new');
    expect(await sealedOf(K('p1'))).toBe('p1');
    const row = await cloud.env.DB.prepare('select device_id from rows where k = ?').bind(K('p2')).first<{ device_id: string }>();
    expect(row!.device_id).toBe('dev-b');
    expect((await cloud.env.DB.prepare('select count(*) n from rows').first<{ n: number }>())?.n).toBe(2);
  });

  it('同じ k の重複は updatedAt の大きい方だけを採る', async () => {
    expect(await pushed(tokA, [ch('p1', 100, 'a'), ch('p1', 300, 'c'), ch('p1', 200, 'b')])).toEqual({ seq: 1, accepted: 1, skipped: 2 });
    expect(await sealedOf(K('p1'))).toBe('c');
  });

  it('形の違う本文と 40 行超は 400', async () => {
    expect((await push(tokA, 'x')).status).toBe(400);
    // 平文の行（表名と行 ID と payload）は受けない。
    expect((await push(tokA, [{ tableName: 'projects', rowId: 'a', op: 'upsert', payload: {}, updatedAt: 1 }])).status).toBe(400);
    expect((await push(tokA, [{ ...ch('a', 1), op: 'drop' }])).status).toBe(400);
    expect((await push(tokA, [{ ...ch('a', 1), k: 'short' }])).status).toBe(400);
    expect((await push(tokA, [{ ...ch('a', 1), k: `${K('a').slice(0, 42)}/` }])).status).toBe(400);
    // 名簿の印の行は PC が push できない（Worker が書く）。
    expect((await push(tokA, [{ ...ch('a', 1), k: ROSTER_MARKER_K }])).status).toBe(400);
    expect((await push(tokA, [{ ...ch('a', 1), epoch: 0 }])).status).toBe(400);
    expect((await push(tokA, [{ ...ch('a', 1), epoch: 1.5 }])).status).toBe(400);
    expect((await push(tokA, [{ ...ch('a', 1), sealed: '' }])).status).toBe(400);
    expect((await push(tokA, [{ ...ch('a', 1), sealed: 12 }])).status).toBe(400);
    expect((await push(tokA, [{ ...ch('a', 1), updatedAt: 'x' }])).status).toBe(400);
    expect((await push(tokA, Array.from({ length: 41 }, (_, i) => ch(`p${i}`, 1)))).status).toBe(400);
    expect((await push(tokA, [])).status).toBe(200);
    expect(await seqs()).toEqual([]);
  });

  it('push は自端末の last_seen_at を進める', async () => {
    await cloud.env.DB.prepare('update devices set last_seen_at = 0').run();
    await push(tokA, []);
    const d = await cloud.env.DB.prepare('select id, last_seen_at from devices order by id').all<{ id: string; last_seen_at: number | null }>();
    expect(d.results[0]!.last_seen_at).toBeGreaterThan(Date.now() - 60_000);
    expect(d.results[1]!.last_seen_at).toBe(0); // 他の端末は触らない
  });
});

describe('GET /changes と GET /rows', () => {
  it('自端末の変更を除き、nextSeq は表の最大連番まで進む', async () => {
    await push(tokA, [ch('p1', 100)]);
    await push(tokB, [ch('p2', 100)]);
    await push(tokA, [ch('p3', 100)]);
    const a = await pull(tokA, 0);
    expect(a.changes.map((c) => [c.k, c.seq, c.deviceId])).toEqual([[K('p2'), 2, 'dev-b']]);
    expect(a.nextSeq).toBe(3);
    expect(a.more).toBe(false);
    const b = await pull(tokB, 0);
    expect(b.changes.map((c) => c.k)).toEqual([K('p1'), K('p3')]);
    expect(pageOf(await pull(tokB, 3))).toEqual({ changes: [], nextSeq: 3, more: false });
  });

  it('limit を超えると more が立ち、nextSeq は返した最後の連番', async () => {
    await push(tokA, Array.from({ length: 5 }, (_, i) => ch(`p${i}`, 1)));
    const r = await pull(tokB, 0, 2);
    expect(r.changes.map((c) => c.seq)).toEqual([1, 2]);
    expect(r).toMatchObject({ nextSeq: 2, more: true });
    const r2 = await pull(tokB, r.nextSeq, 2);
    expect(r2.changes.map((c) => c.seq)).toEqual([3, 4]);
    const r3 = await pull(tokB, r2.nextSeq, 2);
    expect(r3).toMatchObject({ more: false, nextSeq: 5 });
  });

  it('GET /rows は自端末の行も含めて k 順に返す', async () => {
    await push(tokA, [ch('p2', 1), ch('p1', 1)]);
    await push(tokB, [ch('p3', 1)]);
    const r = await rows(tokA, '', 2);
    expect(r.changes.map((c) => c.k)).toEqual([K('p1'), K('p2')]);
    expect(r.changes.map(bodyOfSealed)).toEqual(['p1', 'p2']);
    expect(r.changes[0]).toMatchObject({ op: 'upsert', updatedAt: 1, epoch: 1, deviceId: 'dev-a' });
    expect(r.nextAfter).toBe(K('p2'));
    expect(r.seq).toBe(3);
    const r2 = await rows(tokA, r.nextAfter!, 2);
    expect(r2.changes.map((c) => c.k)).toEqual([K('p3')]);
    expect(r2.nextAfter).toBeNull();
  });
});

describe('名簿の印の行（~roster）', () => {
  const putRoster = (tok: string, ifVersion: number) =>
    cloud.SELF.fetch('https://x/roster', {
      method: 'PUT',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ifVersion, epoch: 2, sealed: 'cm9zdGVy' }),
    });

  it('PUT /roster の後、ほかの PC の pull に ~roster の行がちょうど 1 回出る', async () => {
    await push(tokA, [ch('p1', 1)]);
    expect((await putRoster(tokA, 0)).status).toBe(200);
    expect((await putRoster(tokA, 1)).status).toBe(200);
    const got = await pull(tokB, 0);
    const markers = got.changes.filter((c) => c.k === ROSTER_MARKER_K);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ k: ROSTER_MARKER_K, op: 'upsert', epoch: 2, sealed: '', deviceId: 'dev-a' });
    expect(got.changes.map((c) => c.k)).toEqual([K('p1'), ROSTER_MARKER_K]);
    // 書いた PC には自分の行なので出ない。
    expect((await pull(tokA, 0)).changes).toEqual([]);
    // 読み終えた後は、名簿をもう 1 度書き換えるまで出ない。
    expect((await pull(tokB, got.nextSeq)).changes).toEqual([]);
    // 取り直し（GET /rows）にも 1 行だけ載る。
    expect((await rows(tokB)).changes.filter((c) => c.k === ROSTER_MARKER_K)).toHaveLength(1);
  });
});

describe('1 行の大きさ', () => {
  it('上限を超える sealed は 413 で断り、その行を k で名指しする', async () => {
    const r = await push(tokA, [sized('p1', MAX_ROW_BYTES + 1)]);
    expect(r.status).toBe(413);
    expect(await bodyOf(r)).toEqual({ error: 'payload too large', limit: MAX_ROW_BYTES, count: 1, row: { k: K('p1'), bytes: MAX_ROW_BYTES + 1 } });
    // 何も書かないので、同じ要求を投げ直しても結果は変わらない。
    expect(await seqs()).toEqual([]);
  });

  it('上限は平文の 128 KiB を封じて base64url にした大きさが収まる値である', () => {
    // 封は 1 + 12 + 1 + 本文 + 16 バイトで、gzip で縮まないときがいちばん大きい。
    const worst = Math.ceil(((128 * 1024 + 30) * 4) / 3);
    expect(MAX_ROW_BYTES).toBeGreaterThanOrEqual(worst);
  });

  it('413 の本文は、端末が切り詰めた後も JSON として読める 200 字に収まる', async () => {
    const r = await push(tokA, Array.from({ length: 40 }, (_, i) => sized(`p${i}`, MAX_ROW_BYTES + 1)));
    expect(r.status).toBe(413);
    const text = await r.text();
    expect(text.length).toBeLessThanOrEqual(200);
    expect((JSON.parse(text) as { count: number }).count).toBe(40);
  });

  it('上限ちょうどは通る', async () => {
    expect(await pushed(tokA, [sized('p1', MAX_ROW_BYTES)])).toEqual({ seq: 1, accepted: 1, skipped: 0 });
  });

  it('名指しされた行を落として送り直せば通るので、端末は永久再送に入らない', async () => {
    const batch = [ch('p1', 1), sized('p2', MAX_ROW_BYTES + 100), ch('p3', 1), sized('p4', MAX_ROW_BYTES + 200)];
    const r1 = await push(tokA, batch);
    expect(r1.status).toBe(413);
    expect(await bodyOf(r1)).toMatchObject({ count: 2, row: { k: K('p2') } });
    expect(await seqs()).toEqual([]);
    expect(await pushed(tokA, [batch[0]!, batch[2]!])).toEqual({ seq: 2, accepted: 2, skipped: 0 });
  });
});

describe('1 頁の大きさ', () => {
  /** 上限いっぱいの行を 50 行置く。合わせて約 9 MiB で、1 頁の上限（8 MiB）を超える。 */
  const fill = async (): Promise<string[]> => {
    const names = Array.from({ length: 50 }, (_, i) => `big${String(i).padStart(2, '0')}`);
    for (let i = 0; i < names.length; i += 25) expect((await push(tokA, names.slice(i, i + 25).map((n) => sized(n, MAX_ROW_BYTES)))).status).toBe(200);
    return names;
  };
  const charsOf = (cs: { sealed: string }[]): number => cs.reduce((a, c) => a + c.sealed.length, 0);

  it('pull の頁は sealed の合計が上限を超えたところで切り、続きは nextSeq から読める', async () => {
    const names = await fill();
    const p1 = await pull(tokB, 0);
    expect(p1.more).toBe(true);
    expect(p1.changes.length).toBeGreaterThanOrEqual(1);
    expect(p1.changes.length).toBeLessThan(names.length);
    // 上限を超えた行を入れたところで止めるので、はみ出すのは最後の 1 行の分までである。
    expect(charsOf(p1.changes.slice(0, -1))).toBeLessThanOrEqual(MAX_PAGE_SEALED_CHARS);
    expect(charsOf(p1.changes)).toBeGreaterThan(MAX_PAGE_SEALED_CHARS);
    expect(charsOf(p1.changes)).toBeLessThanOrEqual(MAX_PAGE_SEALED_CHARS + MAX_ROW_BYTES);
    expect(p1.nextSeq).toBe(p1.changes.at(-1)!.seq);
    expect(p1.changes.every((c) => c.sealed === 'A'.repeat(MAX_ROW_BYTES))).toBe(true);
    const p2 = await pull(tokB, p1.nextSeq);
    expect(p2.more).toBe(false);
    expect([...p1.changes, ...p2.changes].map((c) => c.k)).toEqual(names.map(K));
    expect(p2.nextSeq).toBe(names.length);
  });

  it('GET /rows の頁も同じ上限で切り、続きは nextAfter から読める', async () => {
    const names = await fill();
    const r1 = await rows(tokB);
    expect(r1.nextAfter).toBe(r1.changes.at(-1)!.k);
    expect(r1.changes.length).toBeLessThan(names.length);
    expect(charsOf(r1.changes.slice(0, -1))).toBeLessThanOrEqual(MAX_PAGE_SEALED_CHARS);
    const r2 = await rows(tokB, r1.nextAfter!);
    expect(r2.nextAfter).toBeNull();
    expect([...r1.changes, ...r2.changes].map((c) => c.k)).toEqual(names.map(K));
  });

  it('小さい行と大きい行が混ざっても、中身はそのまま往復する（大きい行が 100 を超えても）', async () => {
    // 16 KiB を超える行は、頁に入ると決まってから主キーで読み直す。1 つの文に並べる数を超える数を置く。
    const big = Array.from({ length: 110 }, (_, i) => ({ ...ch(`m${String(i).padStart(3, '0')}`, 1), sealed: Buffer.alloc(17 * 1024, i).toString('base64url') }));
    const small = Array.from({ length: 30 }, (_, i) => ch(`s${String(i).padStart(3, '0')}`, 1));
    const all = [...big, ...small];
    for (let i = 0; i < all.length; i += 40) expect((await push(tokA, all.slice(i, i + 40))).status).toBe(200);
    const p = await pull(tokB, 0);
    expect(p.more).toBe(false);
    expect(p.changes.map((c) => [c.k, c.sealed])).toEqual(all.map((c) => [c.k, c.sealed]));
    const r = await rows(tokB);
    expect(r.nextAfter).toBeNull();
    expect(new Map(r.changes.map((c) => [c.k, c.sealed]))).toEqual(new Map(all.map((c) => [c.k, c.sealed])));
  });

  it('頁の上限は 8 MiB で、1 行の上限より大きい（頁には必ず 1 行以上が載る）', () => {
    expect(MAX_ROW_BYTES).toBeLessThan(MAX_PAGE_SEALED_CHARS);
    expect(MAX_PAGE_SEALED_CHARS).toBe(8 * 1024 * 1024);
  });
});

describe('行の書き込み（rows）', () => {
  it('古い書き込みが後から届いても、新しい方が残り、連番も動かない', async () => {
    await pushed(tokA, [ch('p1', 200, 'new')]);
    const before = await seqOf(K('p1'));
    expect(await pushed(tokB, [ch('p1', 100, 'old')])).toEqual({ seq: before!, accepted: 0, skipped: 1 });
    const row = await cloud.env.DB.prepare('select updated_at, device_id from rows where k = ?').bind(K('p1')).first<{ updated_at: number; device_id: string }>();
    expect(await sealedOf(K('p1'))).toBe('new');
    expect(row).toEqual({ updated_at: 200, device_id: 'dev-a' });
    expect(await seqOf(K('p1'))).toBe(before);
  });

  it('同着（updated_at が等しい）は書き換えず、先に着いた方を残す', async () => {
    await pushed(tokA, [ch('p1', 200, 'first')]);
    expect(await pushed(tokB, [ch('p1', 200, 'second')])).toEqual({ seq: 1, accepted: 0, skipped: 1 });
    expect(await sealedOf(K('p1'))).toBe('first');
    expect(await seqOf(K('p1'))).toBe(1);
  });

  it('新しい書き込みは行を書き換え、表の末尾の新しい連番を振り直す。世代も書き換える', async () => {
    await pushed(tokA, [ch('p1', 100, 'old'), ch('p2', 100)]);
    expect(await pushed(tokB, [ch('p1', 300, 'new', { epoch: 2 })])).toEqual({ seq: 3, accepted: 1, skipped: 0 });
    expect(await sealedOf(K('p1'))).toBe('new');
    expect(await seqOf(K('p1'))).toBe(3);
    expect((await cloud.env.DB.prepare('select epoch from rows where k = ?').bind(K('p1')).first<{ epoch: number }>())?.epoch).toBe(2);
    // 1 つの鍵は 1 行だけで、古い連番の行は残らない。
    expect(await seqs()).toEqual([2, 3]);
  });
});

describe('差分の取り出し（GET /changes）', () => {
  it('頁を送っている間に書き換えられた行は、後ろの頁で降りてくる', async () => {
    await push(tokA, Array.from({ length: 5 }, (_, i) => ch(`p${i}`, 1)));
    const r1 = await pull(tokB, 0, 2);
    expect(r1.changes.map((c) => c.k)).toEqual([K('p0'), K('p1')]);
    await push(tokA, [ch('p0', 2, 'p0-new'), ch('p2', 2, 'p2-new')]);
    const seen: SealedChangeOut[] = [...r1.changes];
    let since = r1.nextSeq;
    for (;;) {
      const r = await pull(tokB, since, 2);
      seen.push(...r.changes);
      since = r.nextSeq;
      if (!r.more) break;
    }
    const last = new Map(seen.map((c) => [c.k, bodyOfSealed(c)]));
    expect(Object.fromEntries(last)).toEqual({ [K('p0')]: 'p0-new', [K('p1')]: 'p1', [K('p2')]: 'p2-new', [K('p3')]: 'p3', [K('p4')]: 'p4' });
    expect(since).toBe(7);
  });

  it('他の端末が書き換えた行は、元が自分の行でも返す', async () => {
    await push(tokA, [ch('p1', 1)]);
    await push(tokB, [ch('p2', 1)]);
    expect((await pull(tokA, 0)).changes.map((c) => c.k)).toEqual([K('p2')]);
    await push(tokB, [ch('p1', 2, 'by-b')]);
    expect((await pull(tokA, 0)).changes.map((c) => [c.k, bodyOfSealed(c)])).toEqual([[K('p2'), 'p2'], [K('p1'), 'by-b']]);
  });

  it('でたらめに大きい since でも、nextSeq は表の末尾を返す', async () => {
    await push(tokA, [ch('p1', 1)]);
    expect(pageOf(await pull(tokB, 999_999))).toEqual({ changes: [], nextSeq: 1, more: false });
  });

  it('解除していない PC の最終確認と、Worker の時刻を添える', async () => {
    await addPcDevice(cloud.env, 'dev-c');
    await setLastSeen('dev-a', 1000);
    await setLastSeen('dev-c', 2000);
    await cloud.env.DB.prepare('update devices set revoked_at = 1 where id = ?').bind('dev-c').run();
    const before = Date.now();
    const r = await pull(tokB, 0);
    const after = Date.now();
    expect(r.now).toBeGreaterThanOrEqual(before);
    expect(r.now).toBeLessThanOrEqual(after);
    const peers = new Map(r.peers.map((p) => [p.id, p.lastSeenAt]));
    expect([...peers.keys()].sort()).toEqual(['dev-a', 'dev-b']);
    expect(peers.get('dev-a')).toBe(1000);
    expect(peers.get('dev-b')).toBeGreaterThanOrEqual(before - TOUCH_EVERY_MS);
  });
});

describe('最終確認の書き込みの間引き', () => {
  it('前回から 1 分たっていなければ、push でも pull でも last_seen_at を書かない', async () => {
    const recent = Date.now() - 30_000;
    await setLastSeen('dev-a', recent);
    await push(tokA, [ch('p1', 1)]);
    await pull(tokA, 0);
    expect(await lastSeen('dev-a')).toBe(recent);
  });

  it('1 分を過ぎていれば書く', async () => {
    const old = Date.now() - TOUCH_EVERY_MS - 1000;
    await setLastSeen('dev-a', old);
    await pull(tokA, 0);
    expect(await lastSeen('dev-a')).toBeGreaterThan(old);
    await setLastSeen('dev-b', old);
    await push(tokB, []);
    expect(await lastSeen('dev-b')).toBeGreaterThan(old);
  });
});
