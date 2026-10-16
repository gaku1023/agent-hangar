import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeIn, ChangeOut, PullChangesResponse } from '@agent-hangar/shared';
import { MAX_ROW_BYTES, MAX_ROW_ID_CHARS } from '../src/changes.ts';
import { TOUCH_EVERY_MS } from '../src/seen.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

const SECRET = 'join-secret-1';

let cloud: CloudHarness;
let tokA = '';
let tokB = '';

const join = async (id: string): Promise<string> => {
  const r = await cloud.SELF.fetch('https://x/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, device: { id, name: id, platform: 'darwin' } }),
  });
  return ((await r.json()) as { deviceToken: string }).deviceToken;
};

const push = (tok: string, changes: unknown): Promise<Response> =>
  cloud.SELF.fetch('https://x/changes', {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ changes }),
  });

const pushed = async (tok: string, changes: unknown): Promise<{ seq: number; accepted: number; skipped: number }> =>
  (await (await push(tok, changes)).json()) as { seq: number; accepted: number; skipped: number };

/** push の応答の形。Worker は量を数えないので、連番と採った数と捨てた数だけを返す。 */
const pushResult = (o: { seq: number; accepted: number; skipped: number }) => o;

/** pull の応答のうち、変更の頁の部分。生存の知らせ（peers と now）は別の試験で見る。 */
const pageOf = (o: PullChangesResponse) => ({ changes: o.changes, nextSeq: o.nextSeq, more: o.more });

const pullRaw = (tok: string, since: number, limit = 500): Promise<Response> =>
  cloud.SELF.fetch(`https://x/changes?since=${since}&limit=${limit}`, { headers: { authorization: `Bearer ${tok}` } });

const pull = async (tok: string, since: number, limit = 500): Promise<PullChangesResponse> =>
  (await (await pullRaw(tok, since, limit)).json()) as PullChangesResponse;

const rows = async (tok: string, after = '', limit = 500): Promise<{ changes: ChangeOut[]; nextAfter: string | null; seq: number }> =>
  (await (
    await cloud.SELF.fetch(`https://x/rows?after=${encodeURIComponent(after)}&limit=${limit}`, { headers: { authorization: `Bearer ${tok}` } })
  ).json()) as { changes: ChangeOut[]; nextAfter: string | null; seq: number };

const ch = (rowId: string, updatedAt: number, name = rowId): ChangeIn => ({
  tableName: 'projects',
  rowId,
  op: 'upsert',
  payload: { id: rowId, name, status: 'active', is_scratch: 0, updated_at: updatedAt, deleted_at: null, origin_device: 'x' },
  updatedAt,
});

/** 直列化した payload がちょうど `bytes` バイトになる 1 件を作る。詰め物は ASCII なので文字数とバイト数が一致する。 */
const sized = (rowId: string, bytes: number): ChangeIn => {
  const base = ch(rowId, 1);
  const pad = bytes - JSON.stringify({ ...base.payload, note: '' }).length;
  if (pad < 0) throw new Error('小さすぎる');
  return { ...base, payload: { ...base.payload, note: 'x'.repeat(pad) } };
};

const bodyOf = async (r: Response): Promise<Record<string, unknown>> => (await r.json()) as Record<string, unknown>;

const payloadOf = async (k: string): Promise<Record<string, unknown>> =>
  JSON.parse((await cloud.env.DB.prepare('select payload from rows where k = ?').bind(k).first<{ payload: string }>())!.payload) as Record<string, unknown>;

/** rows の連番を、鍵ごとに連番の順で返す。 */
const seqs = async (): Promise<number[]> =>
  (await cloud.env.DB.prepare('select seq from rows order by seq').all<{ seq: number }>()).results.map((r) => r.seq);

const seqOf = async (k: string): Promise<number | undefined> =>
  (await cloud.env.DB.prepare('select seq from rows where k = ?').bind(k).first<{ seq: number }>())?.seq;

const meta = async (key: string): Promise<string | null> =>
  (await cloud.env.DB.prepare('select value from meta where key = ?').bind(key).first<{ value: string }>())?.value ?? null;

const lastSeen = async (id: string): Promise<number | null> =>
  (await cloud.env.DB.prepare('select last_seen_at from devices where id = ?').bind(id).first<{ last_seen_at: number | null }>())!.last_seen_at;

const setLastSeen = (id: string, at: number): Promise<unknown> => cloud.env.DB.prepare('update devices set last_seen_at = ? where id = ?').bind(at, id).run();

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema(cloud.env);
  tokA = await join('dev-a');
  tokB = await join('dev-b');
});

afterEach(async () => {
  await cloud.dispose();
});

describe('POST /changes', () => {
  it('新しい行を受け取り連番を付け、古い行は skipped にする', async () => {
    expect(await pushed(tokA, [ch('p1', 100), ch('p2', 100)])).toEqual(pushResult({ seq: 2, accepted: 2, skipped: 0 }));
    expect(await pushed(tokB, [ch('p1', 50, 'old'), ch('p2', 200, 'new')])).toEqual(pushResult({ seq: 3, accepted: 1, skipped: 1 }));
    const row = await cloud.env.DB.prepare('select payload, device_id from rows where k = ?').bind('projects:p2').first<{ payload: string; device_id: string }>();
    expect(JSON.parse(row!.payload).name).toBe('new');
    expect(row!.device_id).toBe('dev-b');
    expect((await payloadOf('projects:p1')).name).toBe('p1');
  });

  it('同じ鍵の重複は updatedAt の大きい方だけを採る', async () => {
    expect(await pushed(tokA, [ch('p1', 100, 'a'), ch('p1', 300, 'c'), ch('p1', 200, 'b')])).toEqual(pushResult({ seq: 1, accepted: 1, skipped: 2 }));
    expect((await payloadOf('projects:p1')).name).toBe('c');
  });

  it('形の違う本文と 40 行超は 400', async () => {
    expect((await push(tokA, 'x')).status).toBe(400);
    expect((await push(tokA, [{ tableName: 'nope', rowId: 'a', op: 'upsert', payload: {}, updatedAt: 1 }])).status).toBe(400);
    expect((await push(tokA, [{ ...ch('a', 1), op: 'drop' }])).status).toBe(400);
    expect((await push(tokA, Array.from({ length: 41 }, (_, i) => ch(`p${i}`, 1)))).status).toBe(400);
    expect((await push(tokA, [])).status).toBe(200);
    expect(await seqs()).toEqual([]);
  });

  it('セッションの状態の行を受け取り、ほかの端末へ渡す', async () => {
    const st: ChangeIn = { tableName: 'session_states', rowId: 's1', op: 'upsert', payload: { session_id: 's1', status: 'paused', return_on: '2026-10-02', updated_at: 100, deleted_at: null, origin_device: 'dev-a' }, updatedAt: 100 };
    expect(await pushed(tokA, [st])).toEqual(pushResult({ seq: 1, accepted: 1, skipped: 0 }));
    const got = await pull(tokB, 0);
    expect(got.changes.map((c) => [c.tableName, c.rowId, c.payload.status])).toEqual([['session_states', 's1', 'paused']]);
  });

  it('push は自端末の last_seen_at を進める', async () => {
    await cloud.env.DB.prepare('update devices set last_seen_at = 0').run();
    await push(tokA, []);
    const d = await cloud.env.DB.prepare('select id, last_seen_at from devices order by id').all<{ id: string; last_seen_at: number | null }>();
    expect(d.results[0]!.last_seen_at).toBeGreaterThan(Date.now() - 60_000);
    expect(d.results[1]!.last_seen_at).toBe(0); // 他の端末は触らない
  });

  it('量を数えるための行を D1 に書かない', async () => {
    await pushed(tokA, [ch('p1', 1)]);
    await pull(tokB, 0);
    const n = await cloud.env.DB.prepare("select count(*) as n from meta where substr(key, 1, 8) = 'd1_rows:'").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe('GET /changes と GET /rows', () => {
  it('自端末の変更を除き、nextSeq は表の最大連番まで進む', async () => {
    await push(tokA, [ch('p1', 100)]);
    await push(tokB, [ch('p2', 100)]);
    await push(tokA, [ch('p3', 100)]);
    const a = await pull(tokA, 0);
    expect(a.changes.map((c) => [c.rowId, c.seq, c.deviceId])).toEqual([['p2', 2, 'dev-b']]);
    expect(a.nextSeq).toBe(3);
    expect(a.more).toBe(false);
    const b = await pull(tokB, 0);
    expect(b.changes.map((c) => c.rowId)).toEqual(['p1', 'p3']);
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
    expect(r.changes.map((c) => c.rowId)).toEqual(['p1', 'p2']);
    expect(r.nextAfter).toBe('projects:p2');
    expect(r.seq).toBe(3);
    const r2 = await rows(tokA, r.nextAfter!, 2);
    expect(r2.changes.map((c) => c.rowId)).toEqual(['p3']);
    expect(r2.nextAfter).toBeNull();
  });
});

describe('1 行の大きさ', () => {
  it('上限を超える payload は 413 で断り、その行を名指しする', async () => {
    const r = await push(tokA, [sized('p1', MAX_ROW_BYTES + 1)]);
    expect(r.status).toBe(413);
    expect(await bodyOf(r)).toEqual({
      error: 'payload too large',
      limit: MAX_ROW_BYTES,
      count: 1,
      row: { tableName: 'projects', rowId: 'p1', bytes: MAX_ROW_BYTES + 1 },
    });
    // 何も書かないので、同じ要求を投げ直しても結果は変わらない。
    expect(await seqs()).toEqual([]);
  });

  it('413 の本文は、端末が切り詰めた後も JSON として読める 200 字に収まる', async () => {
    // CloudError は応答本文の先頭 200 字しか持たない。超えると goneFloor と同じ形の読み取りが全部こける。
    const long = { ...sized('x'.repeat(300), MAX_ROW_BYTES + 1), tableName: 'session_summaries' as const };
    const r = await push(tokA, Array.from({ length: 40 }, (_, i) => ({ ...long, rowId: `${'u'.repeat(120)}-${i}` })));
    expect(r.status).toBe(413);
    const text = await r.text();
    expect(text.length).toBeLessThanOrEqual(200);
    expect(() => JSON.parse(text.slice(0, 200))).not.toThrow();
    const body = JSON.parse(text) as { count: number; row: { rowId: string } };
    expect(body.count).toBe(40);
    expect(body.row.rowId.length).toBe(MAX_ROW_ID_CHARS);
  });

  it('上限ちょうどは通る', async () => {
    expect(await pushed(tokA, [sized('p1', MAX_ROW_BYTES)])).toEqual(pushResult({ seq: 1, accepted: 1, skipped: 0 }));
  });

  it('大きさは文字数ではなくバイト数で見る', async () => {
    const jp = ch('p1', 1);
    const wide = { ...jp, payload: { ...jp.payload, note: 'あ'.repeat(MAX_ROW_BYTES / 2) } }; // 文字数は上限の半分、バイト数は 1.5 倍
    const r = await push(tokA, [wide]);
    expect(r.status).toBe(413);
    expect(await bodyOf(r)).toMatchObject({ count: 1, row: { rowId: 'p1' } });
  });

  it('名指しされた行を落として送り直せば通るので、端末は永久再送に入らない', async () => {
    const batch = [ch('p1', 1), sized('p2', MAX_ROW_BYTES + 100), ch('p3', 1), sized('p4', MAX_ROW_BYTES + 200)];
    const r1 = await push(tokA, batch);
    expect(r1.status).toBe(413);
    expect(await bodyOf(r1)).toMatchObject({ count: 2, row: { rowId: 'p2' } });
    expect(await seqs()).toEqual([]);
    // 名指しの 1 件を落として送り直すと、次の 1 件が名指しされる。
    const r2 = await push(tokA, [batch[0]!, batch[2]!, batch[3]!]);
    expect(r2.status).toBe(413);
    expect(await bodyOf(r2)).toMatchObject({ count: 1, row: { rowId: 'p4' } });
    // 断られた 2 件を落とせば通る。40 行なら最大 40 往復で必ず抜ける。
    expect(await pushed(tokA, [batch[0]!, batch[2]!])).toEqual(pushResult({ seq: 2, accepted: 2, skipped: 0 }));
  });
});

describe('行の書き込み（rows）', () => {
  it('古い書き込みが後から届いても、新しい方が残り、連番も動かない', async () => {
    await pushed(tokA, [ch('p1', 200, 'new')]);
    const before = await seqOf('projects:p1');
    expect(await pushed(tokB, [ch('p1', 100, 'old')])).toEqual(pushResult({ seq: before!, accepted: 0, skipped: 1 }));
    const row = await cloud.env.DB.prepare('select payload, updated_at, device_id from rows where k = ?')
      .bind('projects:p1')
      .first<{ payload: string; updated_at: number; device_id: string }>();
    expect(JSON.parse(row!.payload).name).toBe('new');
    expect(row!.updated_at).toBe(200);
    expect(row!.device_id).toBe('dev-a');
    expect(await seqOf('projects:p1')).toBe(before);
  });

  it('同着（updated_at が等しい）は書き換えず、先に着いた方を残す', async () => {
    await pushed(tokA, [ch('p1', 200, 'first')]);
    expect(await pushed(tokB, [ch('p1', 200, 'second')])).toEqual(pushResult({ seq: 1, accepted: 0, skipped: 1 }));
    expect((await payloadOf('projects:p1')).name).toBe('first');
    expect(await seqOf('projects:p1')).toBe(1);
  });

  it('新しい書き込みは行を書き換え、表の末尾の新しい連番を振り直す', async () => {
    await pushed(tokA, [ch('p1', 100, 'old'), ch('p2', 100)]);
    expect(await pushed(tokB, [ch('p1', 300, 'new')])).toEqual(pushResult({ seq: 3, accepted: 1, skipped: 0 }));
    expect((await payloadOf('projects:p1')).name).toBe('new');
    expect(await seqOf('projects:p1')).toBe(3);
    // 1 つの鍵は 1 行だけで、古い連番の行は残らない。
    expect(await seqs()).toEqual([2, 3]);
  });

  it('変更ログの表（changes）を作らず、圧縮の meta も書かない', async () => {
    await pushed(tokA, Array.from({ length: 30 }, (_, i) => ch(`p${i}`, 1)));
    await pull(tokB, 0);
    const names = (await cloud.env.DB.prepare("select name from sqlite_master where type = 'table'").all<{ name: string }>()).results.map((r) => r.name);
    expect(names).not.toContain('changes');
    for (const k of ['changes_floor', 'last_compact_seq', 'seq_high']) expect(await meta(k)).toBeNull();
  });
});

describe('差分の取り出し（GET /changes）', () => {
  it('頁を送っている間に書き換えられた行は、後ろの頁で降りてくる', async () => {
    await push(tokA, Array.from({ length: 5 }, (_, i) => ch(`p${i}`, 1)));
    const r1 = await pull(tokB, 0, 2);
    expect(r1.changes.map((c) => c.rowId)).toEqual(['p0', 'p1']);
    // 読み終えた p0 と、まだ読んでいない p2 を、頁送りの途中で書き換える。
    await push(tokA, [ch('p0', 2, 'p0-new'), ch('p2', 2, 'p2-new')]);
    const seen: ChangeOut[] = [...r1.changes];
    let since = r1.nextSeq;
    for (;;) {
      const r = await pull(tokB, since, 2);
      seen.push(...r.changes);
      since = r.nextSeq;
      if (!r.more) break;
    }
    // 取り込みは updated_at の新しい方を採るので、最後に見た版がそれぞれの行の今の値になる。
    const last = new Map(seen.map((c) => [c.rowId, c.payload.name]));
    expect(Object.fromEntries(last)).toEqual({ p0: 'p0-new', p1: 'p1', p2: 'p2-new', p3: 'p3', p4: 'p4' });
    expect(since).toBe(7);
  });

  it('自分の端末が書いた行は返さない', async () => {
    await push(tokA, [ch('p1', 1)]);
    await push(tokB, [ch('p2', 1)]);
    expect((await pull(tokA, 0)).changes.map((c) => c.rowId)).toEqual(['p2']);
    expect((await pull(tokB, 0)).changes.map((c) => c.rowId)).toEqual(['p1']);
    // 他の端末が書き換えた行は、元が自分の行でも返す。
    await push(tokB, [ch('p1', 2, 'by-b')]);
    expect((await pull(tokA, 0)).changes.map((c) => [c.rowId, c.payload.name])).toEqual([['p2', 'p2'], ['p1', 'by-b']]);
  });

  it('でたらめに大きい since でも、nextSeq は表の末尾を返す', async () => {
    await push(tokA, [ch('p1', 1)]);
    expect(pageOf(await pull(tokB, 999_999))).toEqual({ changes: [], nextSeq: 1, more: false });
  });

  it('どれだけ古い since でも 410 にせず、残っている行を返す', async () => {
    await push(tokA, [ch('p1', 1)]);
    await push(tokA, [ch('p1', 2)]);
    const r = await pullRaw(tokB, 0);
    expect(r.status).toBe(200);
    expect(pageOf((await r.json()) as PullChangesResponse)).toMatchObject({ nextSeq: 2, more: false });
  });

  it('解除していない PC の最終確認と、Worker の時刻を添える', async () => {
    const tokC = await join('dev-c');
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
    expect(tokC).not.toBe('');
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
