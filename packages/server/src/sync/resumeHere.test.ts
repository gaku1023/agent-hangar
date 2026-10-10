import type { LaunchResultDto } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { RunError } from '../runs/manager.ts';
import type { CopyResult } from './copy.ts';
import { resumeHere } from './resumeHere.ts';

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
});
