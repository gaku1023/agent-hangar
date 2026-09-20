import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeIn } from '@agent-hangar/shared';
import { FLUSH_ROWS, META_ROWS_PER_FLUSH, d1RowsKey, d1RowsToday, meteredBatch, resetMeter } from '../src/meter.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

const SECRET = 'join-secret-1';

let cloud: CloudHarness;

const join = async (id: string): Promise<string> => {
  const r = await cloud.SELF.fetch('https://x/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, device: { id, name: id, platform: 'darwin' } }),
  });
  return ((await r.json()) as { deviceToken: string }).deviceToken;
};

const ch = (rowId: string, updatedAt: number): ChangeIn => ({
  tableName: 'projects',
  rowId,
  op: 'upsert',
  payload: { id: rowId, name: rowId, status: 'active', is_scratch: 0, updated_at: updatedAt, deleted_at: null, origin_device: 'x' },
  updatedAt,
});

const push = async (tok: string, changes: ChangeIn[]): Promise<{ accepted: number; d1RowsToday?: number }> => {
  const r = await cloud.SELF.fetch('https://x/changes', {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ changes }),
  });
  return (await r.json()) as { accepted: number; d1RowsToday?: number };
};

/** 台帳の行を Node 側から直に読む。Worker が持ち越している分は入らない。 */
const ledger = async (now: number): Promise<number | null> => {
  const r = await cloud.env.DB.prepare('select value from meta where key = ?').bind(d1RowsKey(now)).first<{ value: string }>();
  return r ? Number(r.value) : null;
};

/**
 * D1 の代わりに、渡された文と申告する行数を覚えるだけの立て替えである。
 * 台帳の 1 文がいつ混ざるかという規則だけを見たいので、SQL は実行しない。
 */
function stubDb(rowsPerStatement: number): { db: D1Database; batches: unknown[][]; bound: unknown[][] } {
  const batches: unknown[][] = [];
  const bound: unknown[][] = [];
  // 台帳の行はまだ無い（書き出しの前）という顔をする。持ち越しの側だけを見たいからである。
  const stmt = { bind: (...a: unknown[]) => { bound.push(a); return stmt; }, first: async () => null } as unknown as D1PreparedStatement;
  const db = {
    prepare: () => stmt,
    batch: async (s: D1PreparedStatement[]) => {
      batches.push([...s]);
      return s.map(() => ({ meta: { rows_written: rowsPerStatement } })) as unknown as D1Result[];
    },
  } as unknown as D1Database;
  return { db, batches, bound };
}

describe('台帳の持ち越しと書き出し', () => {
  beforeEach(() => { resetMeter(); });
  afterEach(() => { resetMeter(); });

  it('たまるまでは台帳へ書きに行かない（書き込みの回数を増やさない）', async () => {
    const now = Date.UTC(2026, 8, 20, 1, 0, 0);
    const { db, batches } = stubDb(1);
    // 1 文 1 行の batch を、閾値に届かないだけ繰り返す。
    for (let i = 0; i < FLUSH_ROWS - 1; i++) await meteredBatch(db, [db.prepare('x')], now);
    expect(batches.every((b) => b.length === 1)).toBe(true);
    // 数え自体は持ち越しに載っているので、その日の合計として読める（台帳は空でも 0 にならない）。
    expect(await d1RowsToday(db, now)).toBe(FLUSH_ROWS - 1);
  });

  it('たまったら次の batch に台帳の 1 文を混ぜ、その 1 文ぶんも数える', async () => {
    const now = Date.UTC(2026, 8, 20, 1, 0, 0);
    const { db, batches, bound } = stubDb(FLUSH_ROWS);
    await meteredBatch(db, [db.prepare('x')], now);          // 持ち越し 64
    await meteredBatch(db, [db.prepare('x')], now);          // ここで書き出す
    expect(batches[0]!.length).toBe(1);
    expect(batches[1]!.length).toBe(2);
    // 書き出した額は持ち越していた 64 で、その 1 文ぶん（META_ROWS_PER_FLUSH）は次へ持ち越す。
    expect(bound.at(-1)).toEqual([d1RowsKey(now), String(FLUSH_ROWS), FLUSH_ROWS]);
  });

  it('日をまたいだ持ち越しは、たまっていなくても前の日の鍵へ書き出す', async () => {
    const day1 = Date.UTC(2026, 8, 20, 23, 59, 0);
    const day2 = Date.UTC(2026, 8, 21, 0, 1, 0);
    const { db, batches, bound } = stubDb(3);
    await meteredBatch(db, [db.prepare('x')], day1);
    await meteredBatch(db, [db.prepare('x')], day2);
    expect(batches[1]!.length).toBe(2);
    expect(bound.at(-1)).toEqual([d1RowsKey(day1), '3', 3]);
    // 新しい日の数えは、前の日の分を引きずらない。
    expect(await d1RowsToday(db, day2)).toBe(3 + META_ROWS_PER_FLUSH);
  });

  it('batch が落ちたら、書き出そうとした分を持ち越しに戻す', async () => {
    const now = Date.UTC(2026, 8, 20, 1, 0, 0);
    const { db } = stubDb(FLUSH_ROWS);
    await meteredBatch(db, [db.prepare('x')], now);
    const broken = {
      prepare: db.prepare.bind(db),
      batch: async () => { throw new Error('D1_ERROR'); },
    } as unknown as D1Database;
    await expect(meteredBatch(broken, [broken.prepare('x')], now)).rejects.toThrow('D1_ERROR');
    // 書けていないのだから、数えも減らない。
    expect(await d1RowsToday(db, now)).toBe(FLUSH_ROWS);
  });
});

describe('実物の Worker が数える行数', () => {
  beforeEach(async () => {
    resetSchemaCache();
    cloud = await startCloud({ JOIN_SECRET_HASH: await sha256Hex(SECRET) });
    await ensureSchema(cloud.env);
  });
  afterEach(async () => { await cloud.dispose(); resetSchemaCache(); });

  it('push の応答に、その日に D1 へ書いた行数が載る', async () => {
    const tok = await join('a');
    const first = await push(tok, [ch('p1', 1), ch('p2', 1)]);
    expect(first.accepted).toBe(2);
    expect(typeof first.d1RowsToday).toBe('number');
    // 2 度目の push の差は、その push が実際に書いた行数そのものである。
    // 採った 1 行につき changes（本体 + changes_device + autoincrement の連番）で 3 行、
    // 鏡（本体 + k の主キーの索引）で 2 行、末尾の devices の更新で 1 行である。
    const second = await push(tok, [ch('p3', 1), ch('p4', 1)]);
    expect(second.d1RowsToday! - first.d1RowsToday!).toBe(2 * (3 + 2) + 1);
    // 同着で弾かれた行は 1 行も書かないので、devices の 1 行しか増えない。
    const third = await push(tok, [ch('p3', 1)]);
    expect(third.accepted).toBe(0);
    expect(third.d1RowsToday! - second.d1RowsToday!).toBe(1);
  });

  it('数えは D1 の台帳に残るので、要求をまたいで積み上がる', async () => {
    const now = Date.now();
    const tok = await join('a');
    expect(await ledger(now)).toBeNull();
    // 閾値を越えるまで押し込むと、台帳の行が現れる。
    let reported = 0;
    for (let i = 0; i < 20; i++) reported = (await push(tok, [ch(`p${i}`, 1)])).d1RowsToday!;
    const onDisk = await ledger(now);
    expect(onDisk).not.toBeNull();
    // 台帳に出ているのは書き出した分までで、応答はそれに持ち越しを足した値である。
    expect(reported).toBeGreaterThanOrEqual(onDisk!);
    expect(reported - onDisk!).toBeLessThan(FLUSH_ROWS + META_ROWS_PER_FLUSH);
  });

  it('端末の参加とスキーマの用意も数に入る', async () => {
    const tok = await join('a');
    const before = (await push(tok, [ch('p1', 1)])).d1RowsToday!;
    // 押した行が書いた分（5 + devices の 1）を引いても、参加とスキーマの分が残る。
    expect(before - 6).toBeGreaterThan(20);
    // 2 台目の参加は devices への insert（本体 + id の主キー + token_hash の unique）で 3 行である。
    const tokB = await join('b');
    const after = (await push(tokB, [ch('p2', 1)])).d1RowsToday!;
    expect(after - before).toBe(3 + 6);
  });
});
