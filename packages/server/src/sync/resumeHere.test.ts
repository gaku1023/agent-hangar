import type { LaunchResultDto } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { RunError } from '../runs/manager.ts';
import type { CopyResult } from './copy.ts';
import { ensureSession } from '../indexer/write.ts';
import { resumeHere, resumeHereFor } from './resumeHere.ts';

describe('この PC で再開', () => {
  let db: Db;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db.close(); });

  const launched = { sessionId: 's1' } as unknown as LaunchResultDto;
  const setup = (copied?: CopyResult) => {
    const calls: string[] = [];
    const run = (overwrite = false) => resumeHere({
      db, home: '/nope/home', claudeDir: '/nope/claude',
      resume: (id) => { calls.push(`resume ${id}`); return launched; },
      pruneTranscripts: () => { calls.push('prune'); },
      ...(copied ? { copy: () => copied } : {}),
    }, 's1', overwrite);
    return { run, calls };
  };

  it('本文が無ければ 400 で理由を返す', () => {
    // 写しの本体（copyTranscriptForResume）まで繋がっていることを、~/.claude を書き換えない側から確かめる。
    const t = setup();
    let thrown: unknown;
    try { t.run(); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(RunError);
    expect((thrown as RunError).status).toBe(400);
    expect((thrown as RunError).message).toBe('このセッションのトランスクリプトがありません');
    expect(t.calls).toEqual([]);
  });

  it('写しより手元が小さいときは、再開せずに大きさを返して尋ねる', () => {
    const t = setup({ kind: 'ask', localSize: 10, remoteSize: 99 });
    expect(t.run()).toEqual({ error: 'local_smaller', localSize: 10, remoteSize: 99 });
    expect(t.calls).toEqual([]);
  });

  it('控えを取って写した回だけ、控えの世代を刈ってから再開する', () => {
    const backed = setup({ kind: 'copied', target: '/t', from: '/f', bytes: 1, backedUp: '/b' });
    expect(backed.run(true)).toBe(launched);
    expect(backed.calls).toEqual(['prune', 'resume s1']);
    const fresh = setup({ kind: 'copied', target: '/t', from: '/f', bytes: 1, backedUp: null });
    fresh.run();
    expect(fresh.calls).toEqual(['resume s1']);
    const kept = setup({ kind: 'kept', target: '/t' });
    kept.run();
    expect(kept.calls).toEqual(['resume s1']);
  });

  it('この PC で起こせない会話は、本文を写す前に断る', () => {
    const calls: string[] = [];
    const run = () => resumeHere({
      db, home: '/nope/home', claudeDir: '/nope/claude',
      check: (id) => { calls.push(`check ${id}`); throw new RunError(400, 'no root'); },
      resume: (id) => { calls.push(`resume ${id}`); return launched; },
      pruneTranscripts: () => { calls.push('prune'); },
      copy: () => { calls.push('copy'); return { kind: 'kept', target: '/t' }; },
    }, 's1', false);
    expect(run).toThrow('no root');
    expect(calls).toEqual(['check s1']);
  });
});

describe('この PC で再開の振り分け（resumeHereFor）', () => {
  let db: Db;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db.close(); });
  const launched = { sessionId: 's1' } as unknown as LaunchResultDto;

  it('Claude の会話は今までどおり本文を写して再開し、opencode の口には触らない', () => {
    const id = ensureSession(db, '11111111-1111-4111-8111-111111111111', '/w', 'dev-b');
    const calls: string[] = [];
    const r = resumeHereFor({
      db,
      claude: { db, home: '/nope/home', claudeDir: '/nope/claude', resume: (x) => { calls.push(`resume ${x}`); return launched; }, pruneTranscripts: () => undefined, copy: () => ({ kind: 'kept', target: '/t' }) },
      opencode: () => { calls.push('opencode'); throw new Error('must not be called'); },
    }, id, false);
    // Claude の道は同期のまま返す（待たせない）。
    expect(r).toBe(launched);
    expect(calls).toEqual([`resume ${id}`]);
  });

  it('opencode の会話は取り込みの道（resumeOpencodeHere）へ回す', async () => {
    const id = ensureSession(db, 'ses_e8e86939cffewIeT7kgc690PVE', '/w', 'dev-b', 'opencode');
    const calls: string[] = [];
    const r = resumeHereFor({
      db,
      claude: { db, home: '/nope/home', claudeDir: '/nope/claude', resume: () => { calls.push('claude'); return launched; }, pruneTranscripts: () => undefined, copy: () => { calls.push('copy'); return { kind: 'kept', target: '/t' }; } },
      opencode: () => ({
        db, home: '/nope/home', deviceId: 'dev-a',
        prepare: (x) => { calls.push(`prepare ${x}`); return '/w'; },
        exportLocal: async () => '/nope/local.json',
        transfer: { importSession: async () => { calls.push('import'); } },
        stopServe: async () => undefined,
        resume: async (x) => { calls.push(`resumeWith ${x}`); return launched; },
        pruneTranscripts: () => undefined,
      }),
    }, id, false);
    expect(r).toBeInstanceOf(Promise);
    // 写しが無く手元に会話があるので、取り込まずに再開する。
    expect(await r).toBe(launched);
    expect(calls).toEqual([`prepare ${id}`, `resumeWith ${id}`]);
  });
});
