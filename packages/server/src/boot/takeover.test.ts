import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunDto } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { ensureSession } from '../indexer/indexFile.ts';
import { answerOf, writeAsk } from '../sync/takeoverRows.ts';
import { bootTakeover } from './takeover.ts';

const UUID = '22222222-2222-4222-8222-222222222222';
const SELF = 'pc-b';

describe('引き継ぎの頼みを受ける部品の組み立て', () => {
  let db: Db;
  let sessionId: string;
  let runs: Map<string, RunDto>;
  let calls: string[];
  let applied: Set<() => void>;
  let t: ReturnType<typeof bootTakeover>;

  beforeEach(() => {
    db = openDb(':memory:');
    sessionId = ensureSession(db, UUID, '/w', SELF);
    runs = new Map([['r1', { id: 'r1', sessionId, deviceId: SELF, kind: 'resume', tmuxName: 'hangar-r1', pid: 1, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 } as RunDto]]);
    calls = [];
    applied = new Set();
    t = bootTakeover({
      home: { db, device: { id: SELF, name: 'self' }, language: () => 'ja' },
      runs: { runs: { getRun: (id) => runs.get(id) ?? null, kill: (id, reason) => { calls.push(`kill:${id}:${reason}`); const r = { ...runs.get(id)!, endedAt: 2 } as RunDto; runs.set(id, r); return r; } } },
      sync: {
        flushSession: async () => {}, pushNow: async () => { calls.push('push'); },
        onTakeoversApplied: (cb) => { applied.add(cb); return () => { applied.delete(cb); }; },
      },
      againMs: 0,
    });
  });
  afterEach(() => { t.stop(); db.close(); });

  const ask = () => writeAsk(db, 'pc-a', { sessionId, runId: 'r1', targetDevice: SELF, mode: 'ask', now: 1000 });
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it('起動前に届いていた頼みは start の最初の scan で止める（tmux に残った claude）', async () => {
    const a = ask();
    t.start();
    await settle();
    expect(calls).toContain('kill:r1:taken_over');
    expect(answerOf(db, a.id)?.result).toBe('stopped');
  });

  it('start のあとに頼みの行が届いたら、その合図で止める。stop のあとは受けない', async () => {
    t.start();
    await settle();
    expect(applied.size).toBe(1);
    const a = ask();
    for (const cb of applied) cb();
    await settle();
    expect(answerOf(db, a.id)?.result).toBe('stopped');
    t.stop();
    expect(applied.size).toBe(0);
  });

  it('端末への 1 行は、setNotePane で渡された口へ、頼んだ PC の名前で送る', async () => {
    db.prepare("insert into devices (id, name, platform, updated_at, origin_device) values ('pc-a', 'ノート PC', 'darwin', 1, 'pc-a')").run();
    const notes: [string, string][] = [];
    t.setNotePane((n, text) => { notes.push([n, text]); });
    ask();
    await t.responder.scan();
    expect(notes).toEqual([['hangar-r1', '[hangar] ノート PC に引き継がれたため、この PC の claude を停止しました。']]);
  });
});
