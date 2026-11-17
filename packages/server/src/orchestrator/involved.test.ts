import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { recordSpawn } from '../sessions/spawns.ts';
import { forgetSend, forgetSendAny, involvedWith, involvedWithAny, lineageInvolvement, noteSessionSend } from './involved.ts';

let db: Db;
beforeEach(() => { db = openDb(':memory:'); });

describe('involvedWith', () => {
  it('統括が起こした会話と、統括が送った会話だけが関わった会話になる', () => {
    expect(involvedWith(db, 'd', 'orch', 's1')).toBe(false);
    recordSpawn(db, 'd', 's1', 'orch', 1);
    expect(involvedWith(db, 'd', 'orch', 's1')).toBe(true);
    noteSessionSend(db, 'orch', 's2', 1);
    noteSessionSend(db, 'other', 's3', 1);
    expect(involvedWith(db, 'd', 'orch', 's2')).toBe(true);
    expect(involvedWith(db, 'd', 'orch', 's3')).toBe(false);
  });

  it('送った印は、終わりを伝えたら使い切る', () => {
    noteSessionSend(db, 'orch', 's2', 1);
    forgetSend(db, 'orch', 's2');
    expect(involvedWith(db, 'd', 'orch', 's2')).toBe(false);
  });
});

describe('involvedWithAny（統括の系譜）', () => {
  it('前の統括が起こした会話と送った会話も、今の統括の関わった会話になる', () => {
    recordSpawn(db, 'd', 's1', 'old', 1);
    noteSessionSend(db, 'older', 's2', 1);
    expect(involvedWithAny(db, 'd', ['now', 'old', 'older'], 's1')).toBe(true);
    expect(involvedWithAny(db, 'd', ['now', 'old', 'older'], 's2')).toBe(true);
    expect(involvedWithAny(db, 'd', ['now'], 's1')).toBe(false);
    expect(involvedWithAny(db, 'd', [], 's1')).toBe(false);
  });
  it('使い切るときは、系譜の全部の印を消す', () => {
    noteSessionSend(db, 'old', 's2', 1);
    noteSessionSend(db, 'now', 's2', 1);
    forgetSendAny(db, ['now', 'old'], 's2');
    expect(involvedWithAny(db, 'd', ['now', 'old'], 's2')).toBe(false);
  });
});

describe('lineageInvolvement', () => {
  it('設定の系譜にある前の統括が起こした会話を、今の統括の関わりとして引く', () => {
    recordSpawn(db, 'd', 's1', 'old', 1);
    let setting = { sessionId: 'old' as string | null, history: [] as { sessionId: string; startedAt: number | null; endedAt: number; reason: 'fresh' }[] };
    const l = lineageInvolvement(db, 'd', () => setting);
    expect(l.involved('old', 's1')).toBe(true);
    setting = { sessionId: 'now', history: [{ sessionId: 'old', startedAt: null, endedAt: 2, reason: 'fresh' }] };
    expect(l.involved('now', 's1')).toBe(true);
    noteSessionSend(db, 'old', 's2', 1);
    l.reported('now', 's2');
    expect(l.involved('now', 's2')).toBe(false);
  });
});
