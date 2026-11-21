import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { onRowChange } from '../db/notify.ts';
import { upsertShared } from '../db/shared.ts';
import { isViewing, noteViewing, resetViewing } from './viewing.ts';
import { remoteViewing, REMOTE_VIEWING_TTL_MS, ViewingShare, VIEWING_SHARE_REFRESH_MS } from './viewingShare.ts';

let db: Db;
let clock: number;
let urgent: boolean[];
let off: () => void;
const me = { id: 'mac', name: 'Mac', platform: 'darwin' };
const row = (id: string) => db.prepare('select viewing, viewing_at from devices where id = ?').get(id) as { viewing: string | null; viewing_at: number | null } | undefined;
const share = () => new ViewingShare({ db, device: me, now: () => clock });

beforeEach(() => {
  db = openDb(':memory:');
  clock = 1_000_000;
  resetViewing();
  urgent = [];
  off = onRowChange((c) => { if (c.table === 'devices' && c.origin === 'write') urgent.push(c.urgent === true); });
});
afterEach(() => { off(); resetViewing(); db.close(); });

describe('ViewingShare', () => {
  it('この PC で開いている会話が変わったら devices の行に急ぎで書き、変わらなければ書かない', () => {
    const s = share();
    s.check();
    expect(row('mac')).toBeUndefined();
    noteViewing('win', 's1', clock);
    s.check();
    expect(row('mac')).toEqual({ viewing: '["s1"]', viewing_at: clock });
    expect(urgent).toEqual([true]);
    s.check();
    expect(urgent).toHaveLength(1);
    noteViewing('win', null, clock);
    s.check();
    expect(row('mac')!.viewing).toBe('[]');
    expect(urgent).toEqual([true, true]);
  });

  it('開いている間は間を置いて刻み直す（急がない）。閉じた後は刻み直さない', () => {
    const s = share();
    noteViewing('win', 's1', clock);
    s.check();
    clock += VIEWING_SHARE_REFRESH_MS - 1;
    noteViewing('win', 's1', clock);
    s.check();
    expect(urgent).toHaveLength(1);
    clock += 2;
    noteViewing('win', 's1', clock);
    s.check();
    expect(row('mac')!.viewing_at).toBe(clock);
    expect(urgent).toEqual([true, false]);
  });

  it('前の書き込みの値を行から読み戻す（起こし直した後も、同じなら書かない）', () => {
    noteViewing('win', 's1', clock);
    share().check();
    share().check();
    expect(urgent).toHaveLength(1);
  });

  it('devices の行のほかの列（名前、最終確認）は保つ', () => {
    upsertShared(db, 'devices', { id: 'mac', name: 'Mac', platform: 'darwin', last_seen_at: 5, shell_hook: 'on', deleted_at: null }, 'mac');
    noteViewing('win', 's1', clock);
    share().check();
    expect(db.prepare('select last_seen_at, shell_hook from devices where id = ?').get('mac')).toEqual({ last_seen_at: 5, shell_hook: 'on' });
  });
});

describe('remoteViewing', () => {
  const peer = (viewing: string | null, at: number | null, over: Record<string, unknown> = {}) =>
    upsertShared(db, 'devices', { id: 'win', name: 'Win', platform: 'win32', viewing, viewing_at: at, deleted_at: null, ...over }, 'win');

  it('ほかの PC の行が新しいうちは、その PC で開いている会話を見ているとみなす。自分の行と古い行と消した行は見ない', () => {
    peer('["s1","s2"]', clock);
    expect(remoteViewing(db, 'mac', 's1', clock)).toBe(true);
    expect(remoteViewing(db, 'mac', 's2', clock)).toBe(true);
    expect(remoteViewing(db, 'mac', 's3', clock)).toBe(false);
    expect(remoteViewing(db, 'win', 's1', clock)).toBe(false);
    expect(remoteViewing(db, 'mac', 's1', clock + REMOTE_VIEWING_TTL_MS + 1)).toBe(false);
    peer('["s1"]', clock, { deleted_at: clock });
    expect(remoteViewing(db, 'mac', 's1', clock)).toBe(false);
  });

  it('読めない値と空は見ていないとみなす', () => {
    peer('not json', clock);
    expect(remoteViewing(db, 'mac', 's1', clock)).toBe(false);
    peer(null, null);
    expect(remoteViewing(db, 'mac', 's1', clock)).toBe(false);
  });

  it('isViewing は、つないだ判定でほかの PC の分も見る', () => {
    const s = share();
    s.start();
    peer('["s9"]', clock);
    expect(isViewing('s9', clock)).toBe(true);
    expect(isViewing('s1', clock)).toBe(false);
  });
});
