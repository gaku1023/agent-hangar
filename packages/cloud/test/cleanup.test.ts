import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupLegacyConfig, cleanupStage1, LEGACY_CONFIG_BATCH, LEGACY_CONFIG_CLEANUP_ENABLED, META_LEGACY_CONFIG_CLEANUP, META_STAGE1_CLEANUP } from '../src/cleanup.ts';
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

describe('旧実装の設定（config/ の項目ごとの本体と索引）の後始末', () => {
  const BUNDLE = 'config/dev-a/.hangar/config-bundle.hgr';
  const LEGACY = ['config/dev-a/CLAUDE.md', 'config/dev-a/skills/x/SKILL.md', 'config/dev-b/settings.json'];
  const TRANSCRIPT = 'transcripts/dev-a/u1.jsonl.gz';

  const fileRow = (key: string, path: string, kind: string, dev: string): D1PreparedStatement =>
    cloud.env.DB.prepare('insert into files (key, path, kind, device_id, sha256, size, stored_size, mtime, encrypted, uploaded_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(key, path, kind, dev, 'a'.repeat(64), 1, 1, 1, 1, 1);

  /** 旧実装の項目ごとの索引と本体に、新実装の束と本文を足す。 */
  const seedConfig = async (): Promise<void> => {
    await cloud.env.DB.batch([
      fileRow(LEGACY[0]!, 'CLAUDE.md', 'config', 'dev-a'),
      fileRow(LEGACY[1]!, 'skills/x/SKILL.md', 'config', 'dev-a'),
      fileRow(LEGACY[2]!, 'settings.json', 'config', 'dev-b'),
      fileRow(BUNDLE, '.hangar/config-bundle.hgr', 'config', 'dev-a'),
      fileRow(TRANSCRIPT, 'u1.jsonl.gz', 'transcript', 'dev-a'),
    ]);
    for (const k of [...LEGACY, BUNDLE, TRANSCRIPT]) await cloud.env.BUCKET.put(k, 'x');
  };
  const r2Keys = async (): Promise<string[]> => (await cloud.env.BUCKET.list()).objects.map((o) => o.key).sort();

  it('旧実装が読むうちは（既定では）何も消さず、印も置かない', async () => {
    await makeTables();
    await seedConfig();
    expect(LEGACY_CONFIG_CLEANUP_ENABLED).toBe(false);
    expect(await cleanupLegacyConfig(cloud.env, Date.now())).toBe(false);
    await ensureSchema(cloud.env);
    expect(await fileKeys()).toEqual([...LEGACY, BUNDLE, TRANSCRIPT].sort());
    expect(await r2Keys()).toHaveLength(5);
    expect(await metaKeys()).not.toContain(META_LEGACY_CONFIG_CLEANUP);
  });

  it('関門を開けると、項目ごとの本体と索引を消し、束と本文は残して、済んだ印を置く', async () => {
    await makeTables();
    await seedConfig();
    expect(await cleanupLegacyConfig(cloud.env, Date.now(), true)).toBe(true);
    expect(await fileKeys()).toEqual([BUNDLE, TRANSCRIPT]);
    expect(await r2Keys()).toEqual([BUNDLE, TRANSCRIPT]);
    expect(await metaKeys()).toContain(META_LEGACY_CONFIG_CLEANUP);
    // 印のあとは何もしない。
    await cloud.env.DB.batch([fileRow(LEGACY[0]!, 'CLAUDE.md', 'config', 'dev-a')]);
    expect(await cleanupLegacyConfig(cloud.env, Date.now(), true)).toBe(false);
    expect(await fileKeys()).toContain(LEGACY[0]);
  });

  it('1 回に消すのは上限までで、残りは次の回に続け、全部消えたときだけ印を置く', async () => {
    await makeTables();
    const n = LEGACY_CONFIG_BATCH * 2 + 5;
    await cloud.env.DB.batch(Array.from({ length: n }, (_, i) => fileRow(`config/dev-a/f${i}`, `f${i}`, 'config', 'dev-a')));
    expect(await cleanupLegacyConfig(cloud.env, Date.now(), true, 1)).toBe(false);
    expect(await fileKeys()).toHaveLength(n - LEGACY_CONFIG_BATCH);
    expect(await metaKeys()).not.toContain(META_LEGACY_CONFIG_CLEANUP);
    expect(await cleanupLegacyConfig(cloud.env, Date.now(), true, 10)).toBe(true);
    expect(await fileKeys()).toEqual([]);
    expect(await metaKeys()).toContain(META_LEGACY_CONFIG_CLEANUP);
  });

  it('落ちても例外を投げず、印も置かない（次の cold start でまた試す）', async () => {
    await makeTables();
    await seedConfig();
    const failing: Env = {
      ...cloud.env,
      DB: {
        prepare: (q: string) => cloud.env.DB.prepare(q),
        batch: async () => { throw new Error('D1_ERROR: boom'); },
      } as unknown as D1Database,
    };
    expect(await cleanupLegacyConfig(failing, Date.now(), true)).toBe(false);
    expect(await metaKeys()).not.toContain(META_LEGACY_CONFIG_CLEANUP);
  });
});
