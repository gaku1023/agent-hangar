import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COMPAT_HEADER,
  COMPAT_VERSION,
  type JoinCodeHello,
  type JoinCodeMine,
  type JoinStatusOut,
  type KeyboxesOut,
  type RosterOut,
  type SealedChangeIn,
  type SealedPullChangesResponse,
} from '@agent-hangar/shared';
import { createApp } from '../src/app.ts';
import type { Env } from '../src/env.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { addPcDevice, startCloud, type CloudHarness } from './harness.ts';

/**
 * D1 の読み取りの予算（同期の版 6 から、互換の版 9 の封じた行まで）。
 *
 * 2026-10-16 に、D1 の読み取りがアカウントの無料枠（1 日 500 万行）を超えた。
 * 97% は変更ログの圧縮が、消すものの無い回にも表を全部読んでいたことだった。
 * ここでは古い行の多い表を用意して、要求 1 本が読む行（D1 の meta.rows_read の合計）が、
 * 返した行数と書いた行数に定数を足した分に収まり、表の大きさに比例しないことを縛る。
 *
 * 互換の版 9 では、参加の問い合わせ（新しい PC は 2 秒ごと、発行した PC は 3 秒ごと）と、名簿と keybox の口も縛る。
 * 名簿の変化は rows の印の行（`~roster`）で知らせるので、読み終えた端末の pull は版 7 と同じ定数に収まる。
 */

/** 古い行の数。予算の定数より十分に大きくし、表を走査したら必ず超えるようにする。 */
const OLD_ROWS = 400;
/** 認証、生存の知らせ、末尾の連番などの決まった分。版 7 から変えていない。 */
const CONST = 12;
/** 名簿を回した世代の数。keybox は受け手ごとに世代の数だけ溜まる。 */
const EPOCHS = 6;
/** 種まきで置く PC の数（pc-a、pc-b）。 */
const PCS = 2;

let cloud: CloudHarness;
let tokA = '';
let tokB = '';
let end = 0;

/** 行の k。本物は HMAC の base64url（43 字）なので、同じ長さと文字種の作り物にする。 */
const K = (name: string): string => `k${name}`.padEnd(43, '_');

const ch = (name: string, updatedAt: number): SealedChangeIn => ({
  k: K(name),
  op: 'upsert',
  updatedAt,
  epoch: 1,
  sealed: Buffer.from(`sealed-${name}`).toString('base64url'),
});

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

/**
 * 要求 1 本を Worker の組み立てに直に通し、読んだ行の数と応答を返す。
 * `tok` が null なら認証の見出しを付けない（参加の口は認証が無い）。
 */
async function measure(tok: string | null, path: string, init: RequestInit = {}): Promise<{ read: number; res: Response }> {
  const box = { read: 0 };
  const env: Env = { ...cloud.env, DB: counting(cloud.env.DB, box) };
  const headers: Record<string, string> = { ...((init.headers as Record<string, string> | undefined) ?? {}), [COMPAT_HEADER]: String(COMPAT_VERSION) };
  if (tok !== null) headers.authorization = `Bearer ${tok}`;
  const res = await createApp({ minDeviceCompat: 0 }).request(path, { ...init, headers }, env);
  return { read: box.read, res };
}

const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const pushInit = (changes: SealedChangeIn[]): RequestInit => jsonInit('POST', { changes });

const send = async (tok: string, path: string, init: RequestInit = {}): Promise<Response> => {
  const res = await cloud.SELF.fetch(`https://x${path}`, { ...init, headers: { ...((init.headers as Record<string, string> | undefined) ?? {}), authorization: `Bearer ${tok}` } });
  expect(res.status).toBeLessThan(300);
  return res;
};

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema(cloud.env);
  tokA = await addPcDevice(cloud.env, 'pc-a');
  tokB = await addPcDevice(cloud.env, 'pc-b');
  for (let i = 0; i < OLD_ROWS; i += 40) {
    const r = await send(tokA, '/changes', pushInit(Array.from({ length: 40 }, (_, j) => ch(`old${String(i + j).padStart(4, '0')}`, 1))));
    end = ((await r.json()) as { seq: number }).seq;
  }
  expect(end).toBe(OLD_ROWS);
  // 名簿を EPOCHS 回書き換え、世代ごとに PC と recovery 宛ての keybox を置く。
  // どれも印の行（~roster）を進めるので、pull の表にも名簿の変化が載った状態になる。
  for (let epoch = 1; epoch <= EPOCHS; epoch++) {
    await send(tokA, '/roster', jsonInit('PUT', { ifVersion: epoch - 1, epoch, sealed: Buffer.from(`roster-${epoch}`).toString('base64url') }));
    const boxes = ['pc-a', 'pc-b', 'recovery'].map((recipient) => ({ epoch, recipient, sealed: Buffer.from(`box-${recipient}-${epoch}`).toString('base64url') }));
    await send(tokA, '/keyboxes', jsonInit('PUT', { boxes }));
  }
  end = Number((await cloud.env.DB.prepare('select max(seq) s from rows').first<{ s: number }>())?.s);
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

  it('読み終えた端末の pull は版 7 の定数のまま（名簿の版を見るために行を増やしていない）', async () => {
    const { read, res } = await measure(tokB, `/changes?since=${end}`);
    const body = (await res.json()) as SealedPullChangesResponse;
    expect(body.changes).toEqual([]);
    expect(body.nextSeq).toBe(end);
    expect(read).toBeLessThanOrEqual(CONST);
  });

  it('少しだけ遅れた端末の pull', async () => {
    // 印の行は名簿と keybox の書き換えのたびに末尾へ入り直すので、末尾の 1 行である。古い行を 4 つ書き換えて、その後ろに並べる。
    await send(tokA, '/changes', pushInit([0, 1, 2, 3].map((j) => ch(`old${String(j).padStart(4, '0')}`, 9))));
    const { read, res } = await measure(tokB, `/changes?since=${end - 1}`);
    const body = (await res.json()) as SealedPullChangesResponse;
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
    expect(((await res.json()) as { devices: unknown[] }).devices).toHaveLength(PCS);
    expect(read).toBeLessThanOrEqual(PCS + CONST);
  });
});

describe('名簿と keybox の口', () => {
  it('GET /roster は 2 行以内', async () => {
    const { read, res } = await measure(tokB, '/roster');
    expect(((await res.json()) as RosterOut).version).toBe(EPOCHS);
    expect(read).toBeGreaterThanOrEqual(1);
    expect(read).toBeLessThanOrEqual(2);
  });

  it('GET /keyboxes は PC の数＋1 行以内（世代が増えても増えない）', async () => {
    const { read, res } = await measure(tokB, '/keyboxes');
    const body = (await res.json()) as KeyboxesOut;
    // keybox の中身は世代 1 から n までの鍵の一覧なので、いちばん新しい 1 つだけを返す。
    expect(body.boxes).toEqual([{ epoch: EPOCHS, sealed: Buffer.from(`box-pc-b-${EPOCHS}`).toString('base64url') }]);
    expect(read).toBeGreaterThanOrEqual(1);
    expect(read).toBeLessThanOrEqual(PCS + 1);
  });
});

describe('参加の問い合わせ', () => {
  const CODE_HASH = 'c'.repeat(64);
  const NEW_PC = 'pc-new';

  /** pc-a が参加コードを発行し、新しい PC がリクエストを置いた状態にする。 */
  const requested = async () => {
    await send(tokA, '/join-codes', jsonInit('POST', { codeHash: CODE_HASH }));
    const r = await cloud.SELF.fetch('https://x/join/requests', jsonInit('POST', { codeHash: CODE_HASH, deviceId: NEW_PC, sealed: 'c2VhbGVkLXJlcXVlc3Q' }));
    expect(r.status).toBe(202);
  };

  it('GET /join/hello は devices の PC の数＋1 行以内', async () => {
    const { read, res } = await measure(null, '/join/hello');
    expect(((await res.json()) as JoinCodeHello).pcCount).toBe(PCS);
    expect(read).toBeLessThanOrEqual(PCS + 1);
  });

  it('新しい PC の承認待ちの問い合わせ 1 回は 2 行以内', async () => {
    await requested();
    const { read, res } = await measure(null, `/join/status?code=${CODE_HASH}&device=${NEW_PC}`);
    expect((await res.json()) as JoinStatusOut).toEqual({ status: 'waiting' });
    expect(read).toBeGreaterThanOrEqual(1);
    expect(read).toBeLessThanOrEqual(2);
  });

  it('発行した PC の GET /join-codes/mine 1 回は 2 行以内', async () => {
    await requested();
    const { read, res } = await measure(tokA, '/join-codes/mine');
    expect((await res.json()) as JoinCodeMine).toMatchObject({ codeHash: CODE_HASH, status: 'requested', sealed: 'c2VhbGVkLXJlcXVlc3Q', deviceId: NEW_PC });
    expect(read).toBeGreaterThanOrEqual(1);
    expect(read).toBeLessThanOrEqual(2);
  });

  it('1 回の参加（新しい PC 150 回＋発行した PC 100 回）は 500 行以内', async () => {
    let total = 0;
    const step = async (tok: string | null, path: string, init: RequestInit = {}) => {
      const m = await measure(tok, path, init);
      total += m.read;
      return m.res;
    };
    expect((await step(null, '/join/hello')).status).toBe(200);
    expect((await step(tokA, '/join-codes', jsonInit('POST', { codeHash: CODE_HASH }))).status).toBe(201);
    expect((await step(null, '/join/requests', jsonInit('POST', { codeHash: CODE_HASH, deviceId: NEW_PC, sealed: 'c2VhbGVkLXJlcXVlc3Q' }))).status).toBe(202);
    // 新しい PC は 2 秒ごと（5 分で 150 回）、発行した PC は 3 秒ごと（5 分で 100 回）に問い合わせる。
    for (let i = 0; i < 149; i++) expect(((await (await step(null, `/join/status?code=${CODE_HASH}&device=${NEW_PC}`)).json()) as JoinStatusOut).status).toBe('waiting');
    for (let i = 0; i < 100; i++) expect((await step(tokA, '/join-codes/mine')).status).toBe(200);
    expect((await step(tokA, `/join-codes/${CODE_HASH}/approve`, jsonInit('POST', { deviceId: NEW_PC }))).status).toBe(200);
    // 承認の後の 150 回目で端末トークンを受け取る。
    const last = (await (await step(null, `/join/status?code=${CODE_HASH}&device=${NEW_PC}`)).json()) as JoinStatusOut;
    expect(last.status).toBe('approved');
    expect(last.deviceToken).toBeTruthy();
    expect(await cloud.env.DB.prepare('select token_hash from devices where id = ?').bind(NEW_PC).first<{ token_hash: string }>()).toEqual({ token_hash: await sha256Hex(last.deviceToken!) });
    expect(total).toBeGreaterThanOrEqual(250);
    expect(total).toBeLessThanOrEqual(500);
  });
});
