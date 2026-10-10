import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupStage1, META_STAGE1_CLEANUP } from '../src/cleanup.ts';
import type { Env } from '../src/env.ts';
import { ensureSchema, resetSchemaCache, SCHEMA_STATEMENTS } from '../src/schema.ts';
import { resetSweepThrottle, sweepIfDue } from '../src/sweep.ts';
import { startCloud, type CloudHarness } from './harness.ts';

const HOUR = 3_600_000;
let cloud: CloudHarness;

/** 表だけを作る。後始末を走らせずに、残っていた行を置くためである。 */
const makeTables = async (): Promise<void> => {
  await cloud.env.DB.batch(SCHEMA_STATEMENTS.map((s) => cloud.env.DB.prepare(s)));
};

/** 段 1 より前の Worker が残した姿を作る。設定の同期の索引と本文の索引、台帳と圧縮の印である。 */
const seedLeftovers = async (): Promise<void> => {
  const file = (key: string, kind: string) =>
    cloud.env.DB.prepare('insert into files (key, path, kind, device_id, sha256, size, stored_size, mtime, encrypted, uploaded_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(key, 'x', kind, 'dev-a', 'a'.repeat(64), 1, 1, 1, 1, 1);
  const meta = (key: string, value: string) => cloud.env.DB.prepare('insert into meta (key, value) values (?, ?)').bind(key, value);
  await cloud.env.DB.batch([
    file('config/dev-a/skills/x/SKILL.md', 'config'),
    file('config/dev-a/CLAUDE.md', 'config'),
    file('transcripts/dev-a/u1.jsonl.gz', 'transcript'),
    meta('d1_rows:2026-10-01', '120'),
    meta('d1_rows:2026-10-02', '80'),
    meta('changes_floor', '3'),
  ]);
};

const ALL_FILES = ['config/dev-a/CLAUDE.md', 'config/dev-a/skills/x/SKILL.md', 'transcripts/dev-a/u1.jsonl.gz'];
const fileKeys = async (): Promise<string[]> => (await cloud.env.DB.prepare('select key from files order by key').all<{ key: string }>()).results.map((r) => r.key);
const metaKeys = async (): Promise<string[]> => (await cloud.env.DB.prepare('select key from meta order by key').all<{ key: string }>()).results.map((r) => r.key);

beforeEach(async () => {
  resetSchemaCache();
  resetSweepThrottle();
  cloud = await startCloud();
});

afterEach(async () => {
  await cloud.dispose();
  resetSchemaCache();
});

describe('段 1 の後始末', () => {
  it('台帳の行を消し、設定の同期の索引とほかの行は残して、済んだ印を置く', async () => {
    await makeTables();
    await seedLeftovers();
    await ensureSchema(cloud.env);
    expect(await fileKeys()).toEqual(ALL_FILES);
    expect(await metaKeys()).toEqual(['changes_floor', META_STAGE1_CLEANUP]);
  });

  it('印があれば、2 度目の cold start では消しにいかない', async () => {
    await makeTables();
    await ensureSchema(cloud.env);
    // 印を置いた後に入った行は、後始末の相手ではない（試験のための目印である）。
    await cloud.env.DB.prepare('insert into meta (key, value) values (?, ?)').bind('d1_rows:2026-10-03', '1').run();
    resetSchemaCache();
    await ensureSchema(cloud.env);
    expect(await metaKeys()).toContain('d1_rows:2026-10-03');
  });

  it('台帳の行が 1 行も無い箱でも印を置く', async () => {
    await ensureSchema(cloud.env);
    expect(await metaKeys()).toEqual([META_STAGE1_CLEANUP]);
    expect(await cleanupStage1(cloud.env, Date.now())).toBe(false);
  });

  it('配備の後の最初の要求（/health でも）で走り、その要求は普段どおり答える', async () => {
    await makeTables();
    await seedLeftovers();
    const r = await cloud.SELF.fetch('https://x/health');
    expect(r.status).toBe(200);
    expect(await metaKeys()).toContain(META_STAGE1_CLEANUP);
    expect((await metaKeys()).filter((k) => k.startsWith('d1_rows:'))).toEqual([]);
    expect(await fileKeys()).toEqual(ALL_FILES);
  });

  it('落ちても例外を投げず、何も消さずに印も置かない。次の回でまた試す', async () => {
    await makeTables();
    await seedLeftovers();
    const failing: Env = {
      ...cloud.env,
      DB: {
        prepare: (q: string) => cloud.env.DB.prepare(q),
        batch: async () => { throw new Error('D1_ERROR: boom'); },
      } as unknown as D1Database,
    };
    expect(await cleanupStage1(failing, Date.now())).toBe(false);
    expect(await metaKeys()).toEqual(['changes_floor', 'd1_rows:2026-10-01', 'd1_rows:2026-10-02']);
    expect(await cleanupStage1(cloud.env, Date.now())).toBe(true);
    expect(await metaKeys()).toEqual(['changes_floor', META_STAGE1_CLEANUP]);
  });

  it('設定の同期の R2 の本体は、後始末の後も孤児の掃除に拾われない', async () => {
    await makeTables();
    await seedLeftovers();
    await cloud.env.BUCKET.put('config/dev-a/skills/x/SKILL.md', 'x');
    await cloud.env.BUCKET.put('transcripts/dev-a/u1.jsonl.gz', 'y');
    await ensureSchema(cloud.env);
    const r = await sweepIfDue(cloud.env, Date.now() + 2 * HOUR);
    expect(r?.bodies).toEqual([]);
    expect((await cloud.env.BUCKET.list()).objects.map((o) => o.key)).toEqual(['config/dev-a/skills/x/SKILL.md', 'transcripts/dev-a/u1.jsonl.gz']);
  });
});
