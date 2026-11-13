import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { recordSpawn } from '../sessions/spawns.ts';
import { forgetSend, involvedWith, noteSessionSend } from './involved.ts';

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
