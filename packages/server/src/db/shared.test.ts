import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './open.ts';
import { softDeleteShared, upsertShared } from './shared.ts';

let db: Db;
beforeEach(() => { db = openDb(':memory:'); });

const at = (id: string) => (db.prepare('select updated_at u from projects where id = ?').get(id) as { u: number }).u;
const changeAt = (id: string) => (db.prepare('select updated_at u from changes where row_id = ? order by seq desc limit 1').get(id) as { u: number }).u;
const project = (id: string, name: string, when?: number) => upsertShared(db, 'projects', { id, name, status: 'active', is_scratch: 0 }, 'a', 'id', when);

describe('共有テーブルの書き込みの時刻（時計のずれ）', () => {
  it('手元の行の updated_at が今より先なら、その次の 1 ミリ秒で書く（時計の進んだ PC の行に負けない）', () => {
    const ahead = Date.now() + 10 * 60_000;
    project('p1', 'from-ahead', ahead);
    project('p1', 'later');
    expect(at('p1')).toBe(ahead + 1);
    expect(changeAt('p1')).toBe(ahead + 1);
  });

  it('手元の行が古ければ、今の時刻で書く', () => {
    project('p1', 'old', 1000);
    const before = Date.now();
    project('p1', 'new');
    expect(at('p1')).toBeGreaterThanOrEqual(before);
  });

  it('論理削除も、手元の行の updated_at より後の時刻で書く', () => {
    const ahead = Date.now() + 10 * 60_000;
    project('p1', 'from-ahead', ahead);
    softDeleteShared(db, 'projects', 'p1', 'a');
    expect(at('p1')).toBe(ahead + 1);
    expect(changeAt('p1')).toBe(ahead + 1);
  });
});
