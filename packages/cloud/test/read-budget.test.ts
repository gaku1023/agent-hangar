import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPAT_HEADER, COMPAT_VERSION, type ChangeIn, type PullChangesResponse } from '@agent-hangar/shared';
import { createApp } from '../src/app.ts';
import type { Env } from '../src/env.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

/**
 * D1 の読み取りの予算（同期の版 6）。
 *
 * 2026-10-16 に、D1 の読み取りがアカウントの無料枠（1 日 500 万行）を超えた。
 * 97% は変更ログの圧縮が、消すものの無い回にも表を全部読んでいたことだった。
 * ここでは古い行の多い表を用意して、要求 1 本が読む行（D1 の meta.rows_read の合計）が、
 * 返した行数と書いた行数に定数を足した分に収まり、表の大きさに比例しないことを縛る。
 */

const SECRET = 'join-secret-1';
/** 古い行の数。予算の定数より十分に大きくし、表を走査したら必ず超えるようにする。 */
const OLD_ROWS = 400;
/** 認証、生存の知らせ、末尾の連番などの決まった分。 */
const CONST = 12;

let cloud: CloudHarness;
let tokA = '';
let tokB = '';
let end = 0;

const ch = (rowId: string, updatedAt: number): ChangeIn => ({
  tableName: 'projects',
  rowId,
  op: 'upsert',
  payload: { id: rowId, name: rowId, status: 'active', is_scratch: 0, updated_at: updatedAt, deleted_at: null, origin_device: 'x' },
  updatedAt,
});

const join = async (id: string): Promise<string> => {
  const r = await cloud.SELF.fetch('https://x/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, device: { id, name: id, platform: 'darwin' } }),
  });
  return ((await r.json()) as { deviceToken: string }).deviceToken;
};

type Real = { __real: D1PreparedStatement };

/** 文ごとの meta.rows_read を足し上げる D1 の包み。first も all で引いて、読んだ行を数えられるようにする。 */
function counting(db: D1Database, box: { read: number }): D1Database {
  const add = (r: { meta?: { rows_read?: number } }) => {
    box.read += Number(r.meta?.rows_read ?? 0);
  };
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const w = {
      __real: s,
      bind: (...args: unknown[]) => wrap(s.bind(...args)),
      all: async () => {
        const r = await s.all();
        add(r);
        return r;
      },
      run: async () => {
        const r = await s.run();
        add(r);
        return r;
      },
      first: async (col?: string) => {
        const r = await s.all<Record<string, unknown>>();
        add(r);
        const row = r.results[0] ?? null;
        return col === undefined ? row : (row?.[col] ?? null);
      },
    };
    return w as unknown as D1PreparedStatement;
  };
  return {
    prepare: (q: string) => wrap(db.prepare(q)),
    batch: async (stmts: D1PreparedStatement[]) => {
      const rs = await db.batch(stmts.map((x) => (x as unknown as Real).__real));
      for (const r of rs) add(r);
      return rs;
    },
  } as unknown as D1Database;
}

/** 要求 1 本を Worker の組み立てに直に通し、読んだ行の数と応答を返す。 */
async function measure(tok: string, path: string, init: RequestInit = {}): Promise<{ read: number; res: Response }> {
  const box = { read: 0 };
  const env: Env = { ...cloud.env, DB: counting(cloud.env.DB, box) };
  const headers = { ...((init.headers as Record<string, string> | undefined) ?? {}), [COMPAT_HEADER]: String(COMPAT_VERSION), authorization: `Bearer ${tok}` };
  const res = await createApp({ minDeviceCompat: 0 }).request(path, { ...init, headers }, env);
  return { read: box.read, res };
}

const pushInit = (changes: ChangeIn[]): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes }) });

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: await sha256Hex(SECRET) });
  tokA = await join('dev-a');
  tokB = await join('dev-b');
  for (let i = 0; i < OLD_ROWS; i += 40) {
    const r = await cloud.SELF.fetch('https://x/changes', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ changes: Array.from({ length: 40 }, (_, j) => ch(`old${String(i + j).padStart(4, '0')}`, 1)) }),
    });
    end = ((await r.json()) as { seq: number }).seq;
  }
  expect(end).toBe(OLD_ROWS);
});

afterEach(async () => {
  await cloud.dispose();
});

describe('要求 1 本が読む行（古い行が多い表）', () => {
  it('1 行の push', async () => {
    const { read, res } = await measure(tokA, '/changes', pushInit([ch('new1', 2)]));
    expect(res.status).toBe(200);
    expect(read).toBeLessThanOrEqual(CONST);
  });

  it('40 行の push（古い行の書き換え）は、行ごとの定数に収まる', async () => {
    const { read, res } = await measure(tokA, '/changes', pushInit(Array.from({ length: 40 }, (_, j) => ch(`old${String(j).padStart(4, '0')}`, 5))));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: 40 });
    expect(read).toBeLessThanOrEqual(40 * 4 + CONST);
  });

  it('読み終えた端末の pull', async () => {
    const { read, res } = await measure(tokB, `/changes?since=${end}`);
    const body = (await res.json()) as PullChangesResponse;
    expect(body.changes).toEqual([]);
    expect(read).toBeLessThanOrEqual(CONST);
  });

  it('少しだけ遅れた端末の pull', async () => {
    const { read, res } = await measure(tokB, `/changes?since=${end - 5}`);
    const body = (await res.json()) as PullChangesResponse;
    expect(body.changes).toHaveLength(5);
    // 数えられていること自体を確かめる。meta.rows_read が来なければ、どの予算も素通りしてしまう。
    expect(read).toBeGreaterThanOrEqual(5);
    expect(read).toBeLessThanOrEqual(5 + CONST);
  });

  it('GET /rows の 1 頁', async () => {
    const { read, res } = await measure(tokB, '/rows?after=&limit=10');
    expect(((await res.json()) as { changes: unknown[] }).changes).toHaveLength(10);
    expect(read).toBeGreaterThanOrEqual(10);
    expect(read).toBeLessThanOrEqual(10 + CONST);
  });

  it('GET /devices', async () => {
    const { read, res } = await measure(tokB, '/devices');
    expect(((await res.json()) as { devices: unknown[] }).devices).toHaveLength(2);
    expect(read).toBeLessThanOrEqual(2 + CONST);
  });
});
