import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { getSessionNote, sessionTitleOf, setSessionMemo, setSessionName } from './notes.ts';

function seed() {
  const db = openDb(':memory:');
  // session_notes.session_id は sessions(id) への外部キーなので、紐付ける先を実際に作っておく。
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/w', home_device: 'd' }, 'd');
  return db;
}
type Db = ReturnType<typeof seed>;
/** 最後に積んだ変更の連番。書いたかどうかはこれで見る（未送信の差分は行ごとに 1 つへまとまるので、件数では見られない）。 */
const lastSeq = (db: Db) => (db.prepare("select max(seq) s from changes where table_name = 'session_notes'").get() as { s: number | null }).s;
const sessionsSeq = (db: Db) => (db.prepare("select max(seq) s from changes where table_name = 'sessions'").get() as { s: number | null }).s;

describe('セッションの名前とメモ', () => {
  it('行が無ければ null', () => {
    expect(getSessionNote(seed(), 's1')).toBeNull();
  });

  it('名前を書いてもメモは変わらず、メモを書いても名前は変わらない', () => {
    const db = seed();
    setSessionName(db, 'd', 's1', '名前');
    expect(getSessionNote(db, 's1')).toEqual({ name: '名前', memo: null });
    setSessionMemo(db, 'd', 's1', 'メモ');
    expect(getSessionNote(db, 's1')).toEqual({ name: '名前', memo: 'メモ' });
    setSessionName(db, 'd', 's1', null);
    expect(getSessionNote(db, 's1')).toEqual({ name: null, memo: 'メモ' });
  });

  it('書くのは session_notes だけで、sessions の行には触らない', () => {
    const db = seed();
    const before = sessionsSeq(db);
    const row = db.prepare('select * from sessions where id = ?').get('s1');
    setSessionName(db, 'd', 's1', '名前');
    setSessionMemo(db, 'd', 's1', 'メモ');
    expect(sessionsSeq(db)).toBe(before);
    expect(db.prepare('select * from sessions where id = ?').get('s1')).toEqual(row);
  });

  it('書き込みは changes に載り、payload は行の全列である', () => {
    const db = seed();
    setSessionMemo(db, 'dev-x', 's1', 'メモ');
    const c = db.prepare("select row_id, op, payload from changes where table_name = 'session_notes'").get() as { row_id: string; op: string; payload: string };
    expect(c.row_id).toBe('s1');
    expect(c.op).toBe('upsert');
    expect(JSON.parse(c.payload)).toMatchObject({ session_id: 's1', name: null, memo: 'メモ', deleted_at: null, origin_device: 'dev-x' });
  });

  it('行が無いところへ null を書いても、空の行を作らない', () => {
    const db = seed();
    setSessionName(db, 'd', 's1', null);
    setSessionMemo(db, 'd', 's1', null);
    expect(getSessionNote(db, 's1')).toBeNull();
    expect(lastSeq(db)).toBeNull();
  });

  it('中身が同じなら書かない', () => {
    const db = seed();
    setSessionMemo(db, 'd', 's1', 'メモ');
    const before = lastSeq(db);
    setSessionMemo(db, 'd', 's1', 'メモ');
    expect(lastSeq(db)).toBe(before);
  });

  it('論理削除された行へ書くと生き返り、消える前の中身は引き継がない', () => {
    const db = seed();
    setSessionName(db, 'd', 's1', '古い名前');
    db.prepare('update session_notes set deleted_at = 1 where session_id = ?').run('s1');
    expect(getSessionNote(db, 's1')).toBeNull();
    setSessionMemo(db, 'd', 's1', 'メモ');
    expect(getSessionNote(db, 's1')).toEqual({ name: null, memo: 'メモ' });
  });

  it('題名の手がかりは、本文から拾った題名、付けた名前の順に採る', () => {
    const db = seed();
    expect(sessionTitleOf(db, 's1')).toBeNull();
    setSessionName(db, 'd', 's1', '付けた名前');
    expect(sessionTitleOf(db, 's1')).toBe('付けた名前');
    db.prepare('update sessions set custom_title = ? where id = ?').run('本文の題名', 's1');
    expect(sessionTitleOf(db, 's1')).toBe('本文の題名');
  });
});
