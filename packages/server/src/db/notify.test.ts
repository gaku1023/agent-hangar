import { describe, expect, it } from 'vitest';
import { noteApplied, onRowChange, settleRowChanges, touchRow, type RowChange } from './notify.ts';
import { openDb } from './open.ts';
import { softDeleteShared, upsertShared } from './shared.ts';

const PROJECT = (id: string) => ({ id, name: 'a', status: 'active' });
/** その DB の知らせだけを、読みやすい形で貯める。 */
function watch(db: ReturnType<typeof openDb>) {
  const seen: string[] = [];
  const off = onRowChange((c: RowChange) => { if (c.db === db) seen.push(`${c.origin}:${c.op}:${c.table}:${c.rowId}`); });
  return { seen, off };
}

describe('行の変化の購読', () => {
  it('共有の表の書き込みは write で届き、消した行は delete で届く', () => {
    const db = openDb(':memory:');
    const other = openDb(':memory:');
    const w = watch(db);
    upsertShared(other, 'projects', PROJECT('px'), 'd');
    upsertShared(db, 'projects', PROJECT('p1'), 'd');
    softDeleteShared(db, 'projects', 'p1', 'd');
    expect(w.seen).toEqual(['write:upsert:projects:p1', 'write:delete:projects:p1']);
    w.off();
  });

  it('主キーが id でない表は、その主キーの値で届く', () => {
    const db = openDb(':memory:');
    upsertShared(db, 'projects', PROJECT('p1'), 'd');
    const w = watch(db);
    upsertShared(db, 'project_memos', { project_id: 'p1', markdown: 'm', deleted_at: null }, 'd', 'project_id');
    expect(w.seen).toEqual(['write:upsert:project_memos:p1']);
    w.off();
  });

  it('解除したら届かない', () => {
    const db = openDb(':memory:');
    const w = watch(db);
    upsertShared(db, 'projects', PROJECT('p1'), 'd');
    w.off();
    upsertShared(db, 'projects', PROJECT('p2'), 'd');
    touchRow(db, 'projects', 'p1');
    expect(w.seen).toEqual(['write:upsert:projects:p1']);
  });

  it('同期の apply と、書き込みを伴わない touch は、別の出どころで届く', () => {
    const db = openDb(':memory:');
    const w = watch(db);
    noteApplied(db, 'sessions', 's1', 'upsert');
    noteApplied(db, 'sessions', 's2', 'delete');
    touchRow(db, 'sessions', 's1');
    expect(w.seen).toEqual(['apply:upsert:sessions:s1', 'apply:delete:sessions:s2', 'touch:upsert:sessions:s1']);
    w.off();
  });

  it('購読が投げても、呼び手にも他の購読にも波及しない', () => {
    const db = openDb(':memory:');
    const offBad = onRowChange(() => { throw new Error('購読の中で失敗'); });
    const w = watch(db);
    expect(() => touchRow(db, 'sessions', 's1')).not.toThrow();
    expect(() => noteApplied(db, 'sessions', 's1', 'upsert')).not.toThrow();
    expect(w.seen).toEqual(['touch:upsert:sessions:s1', 'apply:upsert:sessions:s1']);
    offBad();
    w.off();
  });
});

describe('トランザクションの中の知らせ', () => {
  it('確定してから、書いた順に 1 行 1 回で届く', async () => {
    const db = openDb(':memory:');
    const w = watch(db);
    db.transaction(() => {
      upsertShared(db, 'projects', PROJECT('p1'), 'd');
      upsertShared(db, 'projects', { ...PROJECT('p1'), name: 'b' }, 'd');
      touchRow(db, 'sessions', 's1');
      touchRow(db, 'sessions', 's1');
      noteApplied(db, 'devices', 'd2', 'upsert');
      expect(w.seen).toEqual([]);
    })();
    await Promise.resolve();
    expect(w.seen).toEqual(['write:upsert:projects:p1', 'touch:upsert:sessions:s1', 'apply:upsert:devices:d2']);
    w.off();
  });

  it('同じ行を書いてから消したら、最後の操作で届く', async () => {
    const db = openDb(':memory:');
    const w = watch(db);
    db.transaction(() => {
      upsertShared(db, 'projects', PROJECT('p1'), 'd');
      softDeleteShared(db, 'projects', 'p1', 'd');
    })();
    await Promise.resolve();
    expect(w.seen).toEqual(['write:delete:projects:p1']);
    w.off();
  });

  it('巻き戻った書き込みは届かない', async () => {
    const db = openDb(':memory:');
    const w = watch(db);
    expect(() => db.transaction(() => {
      upsertShared(db, 'projects', PROJECT('p1'), 'd');
      throw new Error('外側で失敗');
    })()).toThrow('外側で失敗');
    await Promise.resolve();
    expect(w.seen).toEqual([]);
    w.off();
  });

  it('settleRowChanges は、確定済みの溜まった知らせをその場で配る', async () => {
    const db = openDb(':memory:');
    const w = watch(db);
    db.transaction(() => { upsertShared(db, 'projects', PROJECT('p1'), 'd'); })();
    expect(w.seen).toEqual([]);
    settleRowChanges(db);
    expect(w.seen).toEqual(['write:upsert:projects:p1']);
    // 後から来るマイクロタスクで二重に配らない。
    await Promise.resolve();
    expect(w.seen).toEqual(['write:upsert:projects:p1']);
    w.off();
  });

  it('settleRowChanges は、トランザクションの最中には何もしない', async () => {
    const db = openDb(':memory:');
    const w = watch(db);
    db.transaction(() => {
      upsertShared(db, 'projects', PROJECT('p1'), 'd');
      settleRowChanges(db);
      expect(w.seen).toEqual([]);
    })();
    await Promise.resolve();
    expect(w.seen).toEqual(['write:upsert:projects:p1']);
    w.off();
  });
});
