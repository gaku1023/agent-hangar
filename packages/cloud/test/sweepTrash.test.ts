import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { META_TRASH_CURSOR, TRASH_KEEP_MS, TRASH_KEY_LIMIT, TRASH_SCAN_LIMIT, resetSweepThrottle, sweepOnce } from '../src/sweep.ts';
import { sha256Hex } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

const SECRET = 'join-secret-1';
const DAY = 86_400_000;

let cloud: CloudHarness;
/** 本文を置いた時刻。掃除はこれより十分あとに回す。 */
let base = 0;

const join = async (id: string): Promise<void> => {
  const r = await cloud.SELF.fetch('https://x/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, device: { id, name: id, platform: 'darwin' } }),
  });
  expect(r.status).toBe(201);
};

const insertRow = (k: string, table: string, rowId: string, op: 'upsert' | 'delete', payload: Record<string, unknown>): D1PreparedStatement =>
  cloud.env.DB.prepare('insert into rows (k, table_name, row_id, op, payload, updated_at, device_id) values (?, ?, ?, ?, ?, ?, ?) on conflict(k) do update set op = excluded.op, payload = excluded.payload')
    .bind(k, table, rowId, op, JSON.stringify(payload), 1, 'a');

/** 共有テーブルの session_states の行（D1 の rows の写し）を置く。 */
const mark = async (id: string, fields: { trashed_at: number | null; restored_at?: number | null; deleted_at?: number | null }, op: 'upsert' | 'delete' = 'upsert'): Promise<void> => {
  await insertRow(`session_states:${id}`, 'session_states', id, op, { session_id: id, status: null, restored_at: null, deleted_at: null, ...fields }).run();
};

/** 削除の印と一緒に論理削除された sessions の行（端末の softDeleteShared が送る形）を置く。 */
const sessionRow = async (id: string, uuid: string): Promise<void> => {
  await insertRow(`sessions:${id}`, 'sessions', id, 'delete', { id, provider: 'claude-code', provider_session_id: uuid, cwd: '/w', home_device: 'a', deleted_at: 1 }).run();
};

/** R2 の本体と D1 の索引を 1 組置く（PUT /files の着地の後の姿）。 */
const stored = async (key: string, uploadedAt = base): Promise<void> => {
  await cloud.env.BUCKET.put(key, 'honbun');
  const device = key.split('/')[1]!;
  await cloud.env.DB.prepare(
    'insert into files (key, path, kind, device_id, sha256, size, stored_size, mtime, encrypted, uploaded_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(key, `projects/-x/${key.split('/').slice(2).join('/')}`, 'transcript', device, 'a'.repeat(64), 6, 6, 1, 1, uploadedAt)
    .run();
};

const indexKeys = async (): Promise<string[]> =>
  (await cloud.env.DB.prepare('select key from files order by key').all<{ key: string }>()).results.map((r) => r.key);

const bucketKeys = async (): Promise<string[]> => (await cloud.env.BUCKET.list({ limit: 1000 })).objects.map((o) => o.key).sort();

/** 1 つのセッションの写しを、端末 a と b の両方に、主線とサブエージェント 1 本ずつ置く。 */
const copies = (uuid: string): string[] => [
  `transcripts/a/${uuid}.jsonl.gz`,
  `transcripts/a/${uuid}/subagents/agent-x1.jsonl.gz`,
  `transcripts/b/${uuid}.jsonl.gz`,
];

beforeEach(async () => {
  resetSchemaCache();
  resetSweepThrottle();
  cloud = await startCloud({ JOIN_SECRET_HASH: await sha256Hex(SECRET) });
  await ensureSchema(cloud.env);
  await join('a');
  await join('b');
  base = Date.now();
});

afterEach(async () => { await cloud.dispose(); resetSchemaCache(); });

describe('削除の印から 30 日たったセッションの写しを消す', () => {
  it('全端末の主線とサブエージェントを R2 と索引から消し、ほかのセッションの鍵は巻き込まない', async () => {
    await sessionRow('s1', 'u1');
    await mark('s1', { trashed_at: base });
    for (const k of copies('u1')) await stored(k);
    // 名前が u1 で始まる別のセッション、印の無いセッション、別の端末の同じ名前の設定は残る。
    const others = ['transcripts/a/u10.jsonl.gz', 'transcripts/a/u1-x.jsonl.gz', 'transcripts/b/u2.jsonl.gz', 'transcripts/a/u2/subagents/agent-x1.jsonl.gz'];
    for (const k of others) await stored(k);
    await sessionRow('s2', 'u2');
    await mark('s2', { trashed_at: null });

    const r = await sweepOnce(cloud.env, base + TRASH_KEEP_MS + DAY);
    expect(r.trashed.sort()).toEqual([...copies('u1')].sort());
    expect(await indexKeys()).toEqual([...others].sort());
    expect(await bucketKeys()).toEqual([...others].sort());
  });

  it('30 日の境：ちょうど 30 日で消し、1 ミリ秒足りなければ残す', async () => {
    const at = base;
    await sessionRow('s1', 'u1');
    await mark('s1', { trashed_at: at });
    await stored('transcripts/a/u1.jsonl.gz');

    const early = await sweepOnce(cloud.env, at + TRASH_KEEP_MS - 1);
    expect(early.trashed).toEqual([]);
    expect(await indexKeys()).toEqual(['transcripts/a/u1.jsonl.gz']);

    const due = await sweepOnce(cloud.env, at + TRASH_KEEP_MS);
    expect(due.trashed).toEqual(['transcripts/a/u1.jsonl.gz']);
    expect(await indexKeys()).toEqual([]);
    expect(await bucketKeys()).toEqual([]);
  });

  it('復元されたもの（restored_at が印より新しい）は消さない。消し直された（印の方が新しい）ものは消す', async () => {
    await sessionRow('s1', 'u1');
    await mark('s1', { trashed_at: base, restored_at: base + 1 });
    await sessionRow('s2', 'u2');
    await mark('s2', { trashed_at: base, restored_at: base - 1 });
    // 印が外れた行（復元のあと印は null になる）、論理削除された行も消さない。
    await sessionRow('s3', 'u3');
    await mark('s3', { trashed_at: null, restored_at: base });
    await sessionRow('s4', 'u4');
    await mark('s4', { trashed_at: base, deleted_at: base }, 'delete');
    for (const u of ['u1', 'u2', 'u3', 'u4']) await stored(`transcripts/a/${u}.jsonl.gz`);

    const r = await sweepOnce(cloud.env, base + TRASH_KEEP_MS + DAY);
    expect(r.trashed).toEqual(['transcripts/a/u2.jsonl.gz']);
    expect(await indexKeys()).toEqual(['transcripts/a/u1.jsonl.gz', 'transcripts/a/u3.jsonl.gz', 'transcripts/a/u4.jsonl.gz']);
  });

  it('sessions の行が無い、または uuid の形が不正なら何も消さない', async () => {
    await mark('s1', { trashed_at: base });
    await sessionRow('s2', '../a');
    await mark('s2', { trashed_at: base });
    await stored('transcripts/a/s1.jsonl.gz');

    const r = await sweepOnce(cloud.env, base + TRASH_KEEP_MS + DAY);
    expect(r.trashed).toEqual([]);
    expect(await indexKeys()).toEqual(['transcripts/a/s1.jsonl.gz']);
  });

  it('置いたばかりの写しには触らない（復元のあと上げ直した 1 本を消さない）', async () => {
    const now = base + TRASH_KEEP_MS + DAY;
    await sessionRow('s1', 'u1');
    await mark('s1', { trashed_at: base });
    await stored('transcripts/a/u1.jsonl.gz', now - 60_000);

    const r = await sweepOnce(cloud.env, now);
    expect(r.trashed).toEqual([]);
    expect(await bucketKeys()).toEqual(['transcripts/a/u1.jsonl.gz']);
  });
});

describe('1 回の量の上限', () => {
  it('1 回に消す鍵は TRASH_KEY_LIMIT までで、残りは次の回で消す', async () => {
    await sessionRow('s1', 'u1');
    await mark('s1', { trashed_at: base });
    await sessionRow('s2', 'u2');
    await mark('s2', { trashed_at: base });
    for (let i = 0; i < TRASH_KEY_LIMIT + 3; i++) await stored(`transcripts/a/u1/subagents/agent-${String(i).padStart(3, '0')}.jsonl.gz`);
    await stored('transcripts/a/u2.jsonl.gz');

    const now = base + TRASH_KEEP_MS + DAY;
    const first = await sweepOnce(cloud.env, now);
    expect(first.trashed).toHaveLength(TRASH_KEY_LIMIT);
    const second = await sweepOnce(cloud.env, now + 1);
    expect(second.trashed.sort()).toEqual([
      'transcripts/a/u1/subagents/agent-050.jsonl.gz',
      'transcripts/a/u1/subagents/agent-051.jsonl.gz',
      'transcripts/a/u1/subagents/agent-052.jsonl.gz',
      'transcripts/a/u2.jsonl.gz',
    ]);
    expect(await indexKeys()).toEqual([]);
    expect(await bucketKeys()).toEqual([]);
  });

  it('1 回に読む印の行は TRASH_SCAN_LIMIT までで、続きは次の回から読み、末尾で先頭へ戻る', async () => {
    // 印の無い行で 1 ページを埋め、印のある行をその後ろに置く。
    const fill: D1PreparedStatement[] = [];
    for (let i = 0; i < TRASH_SCAN_LIMIT; i++) {
      const id = `a${String(i).padStart(4, '0')}`;
      fill.push(insertRow(`session_states:${id}`, 'session_states', id, 'upsert', { session_id: id, trashed_at: null, restored_at: null, deleted_at: null }));
    }
    await cloud.env.DB.batch(fill);
    await sessionRow('z1', 'u1');
    await mark('z1', { trashed_at: base });
    await stored('transcripts/a/u1.jsonl.gz');

    const now = base + TRASH_KEEP_MS + DAY;
    const first = await sweepOnce(cloud.env, now);
    expect(first.trashed).toEqual([]);
    const cursor = await cloud.env.DB.prepare('select value from meta where key = ?').bind(META_TRASH_CURSOR).first<{ value: string }>();
    expect(cursor?.value).toBe(`session_states:a${String(TRASH_SCAN_LIMIT - 1).padStart(4, '0')}`);

    const second = await sweepOnce(cloud.env, now + 1);
    expect(second.trashed).toEqual(['transcripts/a/u1.jsonl.gz']);
    const back = await cloud.env.DB.prepare('select value from meta where key = ?').bind(META_TRASH_CURSOR).first<{ value: string }>();
    expect(back?.value).toBe('');
  });
});

describe('消す直前に印が外れたら消さない', () => {
  it('鍵を引いた後に復元が届いた筋', async () => {
    await sessionRow('s1', 'u1');
    await mark('s1', { trashed_at: base });
    await stored('transcripts/a/u1.jsonl.gz');
    const db = cloud.env.DB;
    let landed = false;
    // 鍵を引く問い合わせ（files と devices を結ぶ文）が終わった直後に、復元の行を着地させる。
    const wrapped = {
      prepare: (sql: string) => {
        const stmt = db.prepare(sql);
        if (!sql.includes('join devices')) return stmt;
        const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
          ({
            bind: (...a: unknown[]) => wrap(s.bind(...a)),
            all: async () => {
              const r = await s.all();
              if (!landed) { landed = true; await mark('s1', { trashed_at: null, restored_at: base + 5 }); }
              return r;
            },
          }) as unknown as D1PreparedStatement;
        return wrap(stmt);
      },
      batch: (s: D1PreparedStatement[]) => db.batch(s),
    } as unknown as D1Database;

    const r = await sweepOnce({ ...cloud.env, DB: wrapped }, base + TRASH_KEEP_MS + DAY);
    expect(landed).toBe(true);
    expect(r.trashed).toEqual([]);
    expect(await bucketKeys()).toEqual(['transcripts/a/u1.jsonl.gz']);
    expect(await indexKeys()).toEqual(['transcripts/a/u1.jsonl.gz']);
  });
});
