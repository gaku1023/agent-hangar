import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeIn } from '@agent-hangar/shared';
import { META_ROWS_PER_NOTE, d1RowsKey, d1RowsToday, meteredBatch } from '../src/meter.ts';
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

const pull = async (tok: string, since = 0): Promise<{ nextSeq: number; d1RowsToday?: number }> =>
  (await (await cloud.SELF.fetch(`https://x/changes?since=${since}`, { headers: { authorization: `Bearer ${tok}` } })).json()) as {
    nextSeq: number;
    d1RowsToday?: number;
  };

/** 台帳の行を Node 側から直に読む。Worker が持ち越している分は無いので、これが正本である。 */
const ledger = async (now: number): Promise<number | null> => {
  const r = await cloud.env.DB.prepare('select value from meta where key = ?').bind(d1RowsKey(now)).first<{ value: string }>();
  return r ? Number(r.value) : null;
};

/**
 * D1 の代わりに、渡された文と申告する行数を覚えるだけの立て替えである。
 * 台帳へいつ書きに行くかという規則だけを見たいので、SQL は実行しない。
 */
function stubDb(rowsPerStatement: number): { db: D1Database; batches: unknown[][]; runs: unknown[][] } {
  const batches: unknown[][] = [];
  const runs: unknown[][] = [];
  const mk = (): D1PreparedStatement => {
    let args: unknown[] = [];
    const stmt = {
      bind: (...a: unknown[]) => { args = a; return stmt; },
      run: async () => { runs.push(args); return { meta: { rows_written: 1 } }; },
      first: async () => null,
    };
    return stmt as unknown as D1PreparedStatement;
  };
  const db = {
    prepare: () => mk(),
    batch: async (s: D1PreparedStatement[]) => {
      batches.push([...s]);
      return s.map(() => ({ meta: { rows_written: rowsPerStatement } })) as unknown as D1Result[];
    },
  } as unknown as D1Database;
  return { db, batches, runs };
}

describe('台帳の書き出し', () => {
  const now = Date.UTC(2026, 8, 20, 1, 0, 0);

  it('書いた行数は、その要求の中で台帳へ書き出す', async () => {
    const { db, batches, runs } = stubDb(3);
    await meteredBatch(db, [db.prepare('x'), db.prepare('y')], now);
    // 仕事の batch には何も混ぜない。台帳は別の 1 文で、同じ要求の中で書き出す。
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(runs).toEqual([[d1RowsKey(now), String(6 + META_ROWS_PER_NOTE), 6 + META_ROWS_PER_NOTE]]);
  });

  it('書き込みの無い要求では台帳に触らない', async () => {
    const { db, runs } = stubDb(0);
    await meteredBatch(db, [db.prepare('x')], now);
    expect(runs).toEqual([]);
  });

  it('台帳の書き出しが落ちても、要求は落とさない', async () => {
    const { db } = stubDb(3);
    const broken = {
      prepare: () => ({ bind: () => ({ run: async () => { throw new Error('D1_ERROR'); } }) }),
      batch: db.batch.bind(db),
    } as unknown as D1Database;
    // 仕事はもう書けている。500 を返すと端末が同じ書き込みを送り直す。
    await expect(meteredBatch(broken, [broken.prepare('x')], now)).resolves.toHaveLength(1);
  });

  it('日ごとに別の鍵へ積む', async () => {
    const { db, runs } = stubDb(1);
    const day2 = now + 86_400_000;
    await meteredBatch(db, [db.prepare('x')], now);
    await meteredBatch(db, [db.prepare('x')], day2);
    expect(runs.map((r) => r[0])).toEqual([d1RowsKey(now), d1RowsKey(day2)]);
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
    // 2 度目の push の差は、その push が実際に書いた行数に台帳の 1 文ぶんを足した数である。
    // 採った 1 行につき、changes（本体 + changes_device + autoincrement の連番）で 3 行、
    // 鏡（本体 + k の主キーの索引）で 2 行、末尾の devices の更新で 1 行である。
    const second = await push(tok, [ch('p3', 1), ch('p4', 1)]);
    expect(second.d1RowsToday! - first.d1RowsToday!).toBe(2 * (3 + 2) + 1 + META_ROWS_PER_NOTE);
    // 同着で弾かれた行は 1 行も書かないので、devices の 1 行だけが増える。
    const third = await push(tok, [ch('p3', 1)]);
    expect(third.accepted).toBe(0);
    expect(third.d1RowsToday! - second.d1RowsToday!).toBe(1 + META_ROWS_PER_NOTE);
  });

  it('pull の応答にも載せる（押すものが無い日でも端末へ届く）', async () => {
    const tok = await join('a');
    const tokB = await join('b');
    await push(tok, [ch('p1', 1)]);
    const p1 = await pull(tokB);
    expect(typeof p1.d1RowsToday).toBe('number');
    const p2 = await pull(tokB, p1.nextSeq);
    // GET /changes は devices を 1 行書く。そこに台帳の 1 文ぶんが乗る。
    expect(p2.d1RowsToday! - p1.d1RowsToday!).toBe(1 + META_ROWS_PER_NOTE);
  });

  /**
   * isolate が要求ごとに入れ替わっても数えが消えないこと（レビューの致命 1）。
   * 台帳は要求の中で D1 へ書き出すので、Worker の記憶に持ち越しは 1 行も残らない。
   * Node 側から台帳を読むと、端末へ返した数とぴたり同じになる。
   */
  it('数えは要求ごとに D1 へ残るので、isolate が入れ替わっても消えない', async () => {
    const now = Date.now();
    const tok = await join('a');
    let reported = 0;
    for (let i = 0; i < 10; i++) {
      reported = (await push(tok, [ch(`p${i}`, 1)])).d1RowsToday!;
      // 返した数がそのまま D1 に載っている。isolate が死んでも次の要求はここから続けられる。
      expect(await ledger(now)).toBe(reported);
    }
    // 10 回ぶんが積み上がっている（1 回は 5 + 1 + 台帳の 1 文）。
    expect(reported).toBeGreaterThanOrEqual(10 * (5 + 1 + META_ROWS_PER_NOTE));
  });

  /**
   * ファイルの出し入れが D1 に書く行数である。
   * 偽のクラウド（`packages/server/test/fake-cloud.ts`）の表は、ここで測った数を写している。
   */
  it('ファイルの出し入れが D1 に書く行数', async () => {
    const tok = await join('a');
    const headers = {
      authorization: `Bearer ${tok}`,
      'x-hangar-path': 'projects/-x/u1.jsonl',
      'x-hangar-kind': 'transcript',
      'x-hangar-sha256': 'a'.repeat(64),
      'x-hangar-size': '3',
      'x-hangar-mtime': '1700000000000',
      'x-hangar-encrypted': '1',
    };
    const key = 'transcripts/a/u1.jsonl.gz';
    const rows = async (): Promise<number> => (await push(tok, [])).d1RowsToday!;
    // 押すものが無い push は devices の 1 行と台帳の 1 文だけを書く。その分を引けば PUT の実費が出る。
    const idle = 1 + META_ROWS_PER_NOTE;
    const before = await rows();
    expect((await cloud.SELF.fetch(`https://x/files/${key}`, { method: 'PUT', headers, body: 'abc' })).status).toBe(201);
    const afterNew = await rows();
    // 新しい鍵。当たらない delete が 0 行、insert が本体 + key の unique + files_kind + 連番で 4 行、devices が 1 行。
    expect(afterNew - before - idle).toBe(4 + 1 + META_ROWS_PER_NOTE);
    expect((await cloud.SELF.fetch(`https://x/files/${key}`, { method: 'PUT', headers, body: 'abc' })).status).toBe(201);
    const afterReplace = await rows();
    // 置き直し。古い行の delete が 1 行増える。
    expect(afterReplace - afterNew - idle).toBe(1 + 4 + 1 + META_ROWS_PER_NOTE);
    expect((await cloud.SELF.fetch(`https://x/files/${key}`, { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } })).status).toBe(204);
    const afterDelete = await rows();
    // DELETE は索引の 1 行だけである（索引への書き込みは D1 が数えない）。
    expect(afterDelete - afterReplace - idle).toBe(1 + META_ROWS_PER_NOTE);
  });

  it('端末の参加とスキーマの用意も数に入る', async () => {
    const tok = await join('a');
    const before = (await push(tok, [ch('p1', 1)])).d1RowsToday!;
    // 押した行が書いた分（5 + devices の 1 + 台帳の 1 文）を引いても、参加とスキーマの分が残る。
    expect(before - (6 + META_ROWS_PER_NOTE)).toBeGreaterThan(20);
    // 2 台目の参加は devices への insert（本体 + id の主キー + token_hash の unique）で 3 行である。
    const tokB = await join('b');
    const after = (await push(tokB, [ch('p2', 1)])).d1RowsToday!;
    expect(after - before).toBe(3 + META_ROWS_PER_NOTE + 6 + META_ROWS_PER_NOTE);
  });
});
