import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { ensureSession } from '../indexer/indexFile.ts';
import { FLUSH_AGAIN_MS, flushOnRunEnded } from './flushOnRunEnd.ts';

describe('run が終わったセッションの本文を上げる', () => {
  const UUID = '11111111-1111-4111-8111-111111111111';
  let db: Db;
  let sessionId: string;
  beforeEach(() => {
    db = openDb(':memory:');
    sessionId = ensureSession(db, UUID, '/w', 'd');
  });
  afterEach(() => { db.close(); });

  it('終了の直後に 1 回、少し置いてもう 1 回上げる', async () => {
    // Claude は終わる直前まで書き足すので、終了の直後の 1 回だけだと最後の数行が上がらない。
    const flushed: string[] = [];
    flushOnRunEnded({ db, uploader: { flushSession: async (u) => { flushed.push(u); } }, againMs: 20 })({ sessionId });
    expect(flushed).toEqual([UUID]);
    await new Promise((r) => setTimeout(r, 60));
    expect(flushed).toEqual([UUID, UUID]);
  });

  it('セッションの行が無ければ何もしない。同期を設定していない端末でも落ちない', async () => {
    const flushed: string[] = [];
    flushOnRunEnded({ db, uploader: { flushSession: async (u) => { flushed.push(u); } }, againMs: 5 })({ sessionId: 'nope' });
    flushOnRunEnded({ db, uploader: null, againMs: 5 })({ sessionId });
    await new Promise((r) => setTimeout(r, 30));
    expect(flushed).toEqual([]);
  });

  it('2 度目までの待ちは数秒に収める', () => {
    expect(FLUSH_AGAIN_MS).toBe(5_000);
  });
});
