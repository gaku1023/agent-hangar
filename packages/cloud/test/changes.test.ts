import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeIn, ChangeOut } from '@agent-hangar/shared';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

const SECRET = 'join-secret-1';
const DAY = 86_400_000;

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

const pullRaw = (tok: string, since: number, limit = 500): Promise<Response> =>
  cloud.SELF.fetch(`https://x/changes?since=${since}&limit=${limit}`, { headers: { authorization: `Bearer ${tok}` } });

const pull = async (tok: string, since: number, limit = 500): Promise<{ changes: ChangeOut[]; nextSeq: number; more: boolean }> =>
  (await (await pullRaw(tok, since, limit)).json()) as { changes: ChangeOut[]; nextSeq: number; more: boolean };

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

const payloadOf = async (k: string): Promise<Record<string, unknown>> =>
  JSON.parse((await cloud.env.DB.prepare('select payload from rows where k = ?').bind(k).first<{ payload: string }>())!.payload) as Record<string, unknown>;

const seqs = async (): Promise<number[]> =>
  (await cloud.env.DB.prepare('select seq from changes order by seq').all<{ seq: number }>()).results.map((r) => r.seq);

const meta = async (key: string): Promise<string | null> =>
  (await cloud.env.DB.prepare('select value from meta where key = ?').bind(key).first<{ value: string }>())?.value ?? null;

/** 圧縮が「古い」とみなすところまで受信時刻を巻き戻す。 */
const ageChanges = (): Promise<unknown> => cloud.env.DB.prepare('update changes set received_at = 0').run();

/** 次に振られる連番を狙った値にする。1 回の push で最大 40 飛ぶ実物の粗さを、テストから作るための細工である。 */
const setNextSeq = (n: number): Promise<unknown> => cloud.env.DB.prepare("update sqlite_sequence set seq = ? where name = 'changes'").bind(n).run();

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: await sha256Hex(SECRET) });
  tokA = await join('dev-a');
  tokB = await join('dev-b');
});

afterEach(async () => {
  await cloud.dispose();
});

describe('POST /changes', () => {
  it('新しい行を受け取り連番を付け、古い行は skipped にする', async () => {
    expect(await pushed(tokA, [ch('p1', 100), ch('p2', 100)])).toEqual({ seq: 2, accepted: 2, skipped: 0 });
    expect(await pushed(tokB, [ch('p1', 50, 'old'), ch('p2', 200, 'new')])).toEqual({ seq: 3, accepted: 1, skipped: 1 });
    const row = await cloud.env.DB.prepare('select payload, device_id from rows where k = ?').bind('projects:p2').first<{ payload: string; device_id: string }>();
    expect(JSON.parse(row!.payload).name).toBe('new');
    expect(row!.device_id).toBe('dev-b');
    expect((await payloadOf('projects:p1')).name).toBe('p1');
  });

  it('同じ鍵の重複は updatedAt の大きい方だけを採る', async () => {
    expect(await pushed(tokA, [ch('p1', 100, 'a'), ch('p1', 300, 'c'), ch('p1', 200, 'b')])).toEqual({ seq: 1, accepted: 1, skipped: 2 });
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
    expect(a.changes.map((c) => [c.rowId, c.seq, c.deviceId])).toEqual([['p2', 2, 'dev-b']]);
    expect(a.nextSeq).toBe(3);
    expect(a.more).toBe(false);
    const b = await pull(tokB, 0);
    expect(b.changes.map((c) => c.rowId)).toEqual(['p1', 'p3']);
    expect(await pull(tokB, 3)).toEqual({ changes: [], nextSeq: 3, more: false });
    const dev = await cloud.env.DB.prepare('select last_pulled_seq from devices where id = ?').bind('dev-b').first<{ last_pulled_seq: number }>();
    expect(dev?.last_pulled_seq).toBe(3);
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

describe('圧縮', () => {
  it('全端末が読み終えた古い変更を消し、rows は残す', async () => {
    await push(tokA, [ch('p1', 1)]);
    await pull(tokB, 0);
    await pull(tokA, 0);
    await ageChanges();
    await setNextSeq(199);
    await push(tokB, [ch('p2', 1)]); // 連番 200 で圧縮が走る
    expect(await seqs()).toEqual([200]);
    expect((await cloud.env.DB.prepare('select count(*) c from rows').first<{ c: number }>())!.c).toBe(2);
    expect(await meta('changes_floor')).toBe('1');
    expect(await meta('last_compact_seq')).toBe('200');
  });

  it('連番が 200 の倍数を飛び越しても、前回の圧縮からの差で走る', async () => {
    await push(tokA, [ch('p1', 1)]);
    await pull(tokB, 0);
    await pull(tokA, 0);
    await ageChanges();
    await setNextSeq(205); // 次の連番は 206 で、200 の倍数には当たらない
    await push(tokB, [ch('p2', 1)]);
    expect(await seqs()).toEqual([206]);
    expect(await meta('last_compact_seq')).toBe('206');
    expect(await meta('changes_floor')).toBe('1');
  });

  it('前回の圧縮から 200 に満たなければ走らない', async () => {
    await push(tokA, [ch('p1', 1)]);
    await pull(tokB, 0);
    await pull(tokA, 0);
    await ageChanges();
    await push(tokB, [ch('p2', 1)]);
    expect(await seqs()).toEqual([1, 2]);
    expect(await meta('last_compact_seq')).toBeNull();
    expect(await meta('changes_floor')).toBeNull();
  });

  it('圧縮で changes が空になっても連番は巻き戻らない', async () => {
    await push(tokA, [ch('p1', 1)]);
    await pull(tokB, 0);
    await pull(tokA, 0);
    await ageChanges();
    await setNextSeq(205);
    await push(tokB, [ch('p2', 1)]); // 連番 206 で圧縮が走る
    expect(await seqs()).toEqual([206]);
    // 圧縮は押し込まれたばかりの 1 件だけは残すので、要求 1 回では空にならない。
    // ここでは、その 1 件も 14 日を過ぎて次の周の圧縮に消された後を作る。
    // 条件は compact() の delete と同じものである。
    await ageChanges();
    await cloud.env.DB.prepare('delete from changes where seq <= ? and received_at < ?').bind(206, Date.now() - 14 * DAY).run();
    expect(await seqs()).toEqual([]);

    expect((await rows(tokA)).seq).toBe(206);
    expect(await pull(tokB, 1)).toEqual({ changes: [], nextSeq: 206, more: false });
    const dev = await cloud.env.DB.prepare('select last_pulled_seq from devices where id = ?').bind('dev-b').first<{ last_pulled_seq: number }>();
    expect(dev?.last_pulled_seq).toBe(206);
    // 次の push も連番を振り直さない。
    expect((await pushed(tokA, [ch('p9', 1)])).seq).toBe(207);
  });

  it('でたらめに大きい since は読み位置を水増ししない', async () => {
    await push(tokA, [ch('p1', 1)]);
    expect(await pull(tokB, 999_999)).toEqual({ changes: [], nextSeq: 1, more: false });
    const dev = await cloud.env.DB.prepare('select last_pulled_seq from devices where id = ?').bind('dev-b').first<{ last_pulled_seq: number }>();
    expect(dev?.last_pulled_seq).toBe(1); // ここが水増しされると、圧縮が未読の変更まで消しにいく
  });

  it('圧縮で消えた区間を指す since は 410 と floor を返し、未読の変更を黙って落とさない', async () => {
    const tokC = await join('dev-c');
    await push(tokA, [ch('p1', 1)]);
    await pull(tokC, 0); // dev-c は連番 1 まで読んで、ここから離脱する
    await push(tokA, [ch('p2', 1)]); // dev-c が読まないまま置き去りになる変更
    await pull(tokB, 0);
    await pull(tokA, 0);
    await cloud.env.DB.prepare('update devices set last_seen_at = ? where id = ?').bind(Date.now() - 40 * DAY, 'dev-c').run();
    await ageChanges();
    await setNextSeq(205);
    await push(tokB, [ch('p3', 1)]);
    expect(await seqs()).toEqual([206]);
    expect(await meta('changes_floor')).toBe('2');

    const gone = await pullRaw(tokC, 1);
    expect(gone.status).toBe(410);
    expect(await gone.json()).toEqual({ error: 'gone', floor: 2 });
    // 410 は端末の読み位置を進めない。進めると取りこぼしが確定してしまう。
    const dev = await cloud.env.DB.prepare('select last_pulled_seq from devices where id = ?').bind('dev-c').first<{ last_pulled_seq: number }>();
    expect(dev?.last_pulled_seq).toBe(1);
    // 落ちた区間は GET /rows から取り直せる。
    const snap = await rows(tokC);
    expect(snap.changes.map((c) => c.rowId).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(snap.seq).toBe(206);
    // floor 以降を指す端末は今までどおり通る。
    expect((await pullRaw(tokB, 2)).status).toBe(200);
  });
});
