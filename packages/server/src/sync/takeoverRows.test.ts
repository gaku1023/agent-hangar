import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { answerOf, askOf, asksForMe, cancelAsk, pruneTakeoverRows, setAskForce, TAKEOVER_ROW_TTL_MS, writeAnswer, writeAsk } from './takeoverRows.ts';

const pendingChanges = (db: Db, table: string): number =>
  (db.prepare('select count(*) c from changes where table_name = ? and pushed_at is null').get(table) as { c: number }).c;

describe('引き継ぎの頼みと応答の行', () => {
  let db: Db;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db.close(); });

  const ask = (o: Partial<Parameters<typeof writeAsk>[2]> = {}) =>
    writeAsk(db, 'pc-a', { sessionId: 's1', runId: 'r1', targetDevice: 'pc-b', mode: 'ask', now: 1000, ...o });

  it('writeAsk は自分の行を書いて changes に積み、asksForMe は宛先の PC からだけ見える', () => {
    const a = ask();
    expect(a).toMatchObject({ sessionId: 's1', runId: 'r1', targetDevice: 'pc-b', fromDevice: 'pc-a', requestedAt: 1000, mode: 'ask', cancelledAt: null });
    expect(asksForMe(db, 'pc-b').map((x) => x.id)).toEqual([a.id]);
    expect(asksForMe(db, 'pc-a')).toEqual([]);
    expect(pendingChanges(db, 'takeovers')).toBe(1);
    expect(askOf(db, a.id)).toEqual(a);
    expect(askOf(db, 'none')).toBeNull();
  });

  it('asksForMe は古い順に返す', () => {
    const late = ask({ now: 3000 });
    const early = ask({ now: 2000, runId: 'r2' });
    expect(asksForMe(db, 'pc-b').map((x) => x.id)).toEqual([early.id, late.id]);
  });

  it('取り下げた頼みと、答えた頼みは asksForMe に出ない', () => {
    const a = ask();
    const b = ask({ runId: 'r2', now: 1100 });
    const c = ask({ runId: 'r3', now: 1200 });
    cancelAsk(db, 'pc-a', a.id, 1500);
    expect(askOf(db, a.id)?.cancelledAt).toBe(1500);
    writeAnswer(db, 'pc-b', { askId: b.id, runId: 'r2', result: 'not_running', answeredAt: 2000, transcriptSha256: null, transcriptSize: null });
    expect(asksForMe(db, 'pc-b').map((x) => x.id)).toEqual([c.id]);
  });

  it('setAskForce は同じ行の mode を force にする', () => {
    const a = ask();
    setAskForce(db, 'pc-a', a.id, 1600);
    expect(askOf(db, a.id)?.mode).toBe('force');
    expect(askOf(db, a.id)?.requestedAt).toBe(1000);
    // 送る前の差分は 1 つにまとまる。
    expect(pendingChanges(db, 'takeovers')).toBe(1);
  });

  it('answerOf は sha256 と大きさを返す', () => {
    const a = ask();
    expect(answerOf(db, a.id)).toBeNull();
    writeAnswer(db, 'pc-b', { askId: a.id, runId: 'r1', result: 'stopped', answeredAt: 2000, transcriptSha256: 'abc', transcriptSize: 42 });
    expect(answerOf(db, a.id)).toEqual({ askId: a.id, runId: 'r1', result: 'stopped', answeredAt: 2000, transcriptSha256: 'abc', transcriptSize: 42 });
    expect(pendingChanges(db, 'takeover_answers')).toBe(1);
  });

  it('pruneTakeoverRows は自分の行のうち 30 日より古いものだけを消す', () => {
    const now = 100 * 86_400_000;
    const oldMine = ask({ now: 1 });
    const freshMine = ask({ runId: 'r2', now });
    const theirs = writeAsk(db, 'pc-c', { sessionId: 's9', runId: 'r9', targetDevice: 'pc-b', mode: 'ask', now: 1 });
    const stamp = (id: string, at: number) => db.prepare('update takeovers set updated_at = ? where id = ?').run(at, id);
    stamp(oldMine.id, now - TAKEOVER_ROW_TTL_MS - 1);
    stamp(freshMine.id, now - TAKEOVER_ROW_TTL_MS + 1000);
    stamp(theirs.id, now - TAKEOVER_ROW_TTL_MS - 1);
    expect(pruneTakeoverRows(db, 'pc-a', now)).toBe(1);
    const alive = (id: string) => (db.prepare('select deleted_at from takeovers where id = ?').get(id) as { deleted_at: number | null }).deleted_at === null;
    expect(alive(oldMine.id)).toBe(false);
    expect(alive(freshMine.id)).toBe(true);
    expect(alive(theirs.id)).toBe(true);
    // 消した行は asksForMe にも出ない。
    expect(asksForMe(db, 'pc-b').map((x) => x.id).sort()).toEqual([freshMine.id, theirs.id].sort());
    // 2 回目は消すものが無い。
    expect(pruneTakeoverRows(db, 'pc-a', now)).toBe(0);
  });
});
