import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeIn } from '@agent-hangar/shared';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { seedDbAt } from '../../test/oldDb.ts';
import { openDb, type Db } from '../db/open.ts';
import { getSession } from '../db/queries.ts';
import { upsertShared } from '../db/shared.ts';
import { getSessionNote, setSessionMemo } from '../sessions/notes.ts';
import { SyncEngine } from './engine.ts';

/**
 * 版 17（名前とメモを session_notes へ移す）へ上げる順序の罠。
 * 2 台の PC は同時には上がらない。先に上がった PC、後から上がった PC、クラウドに残る古い形の行が混ざる。
 */

let tmp: string;
let cloud: FakeCloudClient;
let timers: FakeTimers;
const opened: Db[] = [];
const engines: SyncEngine[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-notes-sync-'));
  cloud = new FakeCloudClient({ deviceId: 'pc1' });
  timers = new FakeTimers();
});
afterEach(() => {
  for (const e of engines.splice(0)) e.stop();
  for (const d of opened.splice(0)) d.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Old = { name?: string | null; memo?: string | null; updatedAt: number; origin?: string };

/** 版 16 の DB を作り、名前とメモを sessions の列に持つ行を 1 つ仕込む。まだ上げない。 */
function seedV16(device: string, row: Old | null): string {
  const file = path.join(tmp, `${device}.db`);
  seedDbAt(file, 16, (db) => {
    if (!row) return;
    db.prepare('insert into sessions (id, provider, provider_session_id, name, cwd, home_device, memo, updated_at, deleted_at, origin_device) values (?,?,?,?,?,?,?,?,?,?)')
      .run('s1', 'claude-code', 'u1', row.name ?? null, '/w', 'pc1', row.memo ?? null, row.updatedAt, null, row.origin ?? 'pc1');
  });
  return file;
}

/** その PC の DB を新しい版で開く。版 17 に上がる。同期はまだ動かない。 */
function upgrade(device: string, file: string): Db {
  const db = openDb(file, { backupDir: path.join(tmp, `backups-${device}`) });
  opened.push(db);
  return db;
}

/** その PC のアプリを新しい版で起こす。DB は版 17 に上がり、同期が動き出す（起動のときに 1 度 push と pull をする）。 */
async function boot(device: string, file: string, db: Db = upgrade(device, file)): Promise<{ db: Db; engine: SyncEngine }> {
  const engine = new SyncEngine({ db, deviceId: device, client: device === 'pc1' ? cloud : cloud.asDevice(device), now: () => timers.now, timers, url: 'https://h', home: homeOf(device) });
  engines.push(engine);
  await engine.start();
  return { db, engine };
}

/** まっさらな DB の PC が、後から参加する。クラウドの写しだけから組み上がる。 */
async function joinFresh(device: string): Promise<Db> {
  const { db, engine } = await boot(device, path.join(tmp, `${device}.db`));
  await engine.pullNow();
  return db;
}

/** 版 16 の端末がクラウドに上げていた、古い形の sessions の行。 */
const oldSessionChange = (o: Old): ChangeIn => ({
  tableName: 'sessions', rowId: 's1', op: 'upsert', updatedAt: o.updatedAt,
  payload: { id: 's1', provider: 'claude-code', provider_session_id: 'u1', project_id: null, name: o.name ?? null, cwd: '/w', first_prompt: null, ai_title: null, started_at: null, last_activity_at: null, home_device: 'pc1', memo: o.memo ?? null, updated_at: o.updatedAt, deleted_at: null, origin_device: o.origin ?? 'pc1' },
});

const noteOf = (db: Db) => getSessionNote(db, 's1');
/** その PC の控えの置き場。一時ディレクトリの下に置き、実物の home には書かない。 */
const homeOf = (device: string) => path.join(tmp, `home-${device}`);
/** その PC に残った、負けた名前とメモの控えの本文。 */
const backupsOf = (device: string): string[] => {
  const dir = path.join(homeOf(device), 'backups', 'memos');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort().map((f) => fs.readFileSync(path.join(dir, f), 'utf8')) : [];
};
const cloudNotes = () => cloud.changes.filter((c) => c.tableName === 'session_notes');
const sync = async (...es: SyncEngine[]) => { for (const e of es) { await e.pushNow(); await e.pullNow(); } };

describe('(a) 上げた直後の名前とメモが、クラウドへ上がる', () => {
  it('写した行は、クラウドにまだ無い状態から上がり、後から参加した PC に届く', async () => {
    await cloud.asDevice('old-pc1').pushChanges([oldSessionChange({ name: '名前', memo: 'メモ', updatedAt: 1000 })]);
    const file1 = seedV16('pc1', { name: '名前', memo: 'メモ', updatedAt: 1000 });
    const db1 = upgrade('pc1', file1);
    expect(noteOf(db1)).toEqual({ name: '名前', memo: 'メモ' });
    expect(cloudNotes()).toHaveLength(0);
    const pc1 = await boot('pc1', file1, db1);
    await pc1.engine.pushNow();
    expect(cloudNotes().map((c) => ({ rowId: c.rowId, updatedAt: c.updatedAt, payload: c.payload }))).toEqual([
      { rowId: 's1', updatedAt: 1000, payload: { session_id: 's1', name: '名前', memo: 'メモ', updated_at: 1000, deleted_at: null, origin_device: 'pc1' } },
    ]);
    expect((pc1.db.prepare("select count(*) c from changes where table_name = 'session_notes' and pushed_at is null").get() as { c: number }).c).toBe(0);

    const pc3 = await joinFresh('pc3');
    expect(noteOf(pc3)).toEqual({ name: '名前', memo: 'メモ' });
    expect(getSession(pc3, [], 's1', { deviceId: 'pc3' })).toMatchObject({ name: '名前', memo: 'メモ' });
  });
});

describe('(b) クラウドに残る古い形の sessions の行', () => {
  it('古い形の行が降りてきても、手元の名前とメモを壊さない', async () => {
    const pc1 = await boot('pc1', seedV16('pc1', { name: '手元の名前', memo: '手元のメモ', updatedAt: 1000 }));
    // まだ上げていない別の PC が、上げる前に sessions の行を書き直していた。名前とメモは古いか、空である。
    await cloud.asDevice('old-pc2').pushChanges([oldSessionChange({ name: null, memo: null, updatedAt: 5000, origin: 'old-pc2' })]);
    await pc1.engine.pullNow();
    expect((pc1.db.prepare('select updated_at u from sessions where id = ?').get('s1') as { u: number }).u).toBe(5000);
    expect(noteOf(pc1.db)).toEqual({ name: '手元の名前', memo: '手元のメモ' });
    await cloud.asDevice('old-pc2').pushChanges([oldSessionChange({ name: '向こうの古い名前', memo: '向こうの古いメモ', updatedAt: 6000, origin: 'old-pc2' })]);
    await pc1.engine.pullNow();
    expect(noteOf(pc1.db)).toEqual({ name: '手元の名前', memo: '手元のメモ' });
  });

  it('古い形の行しか無い PC には、名前とメモの行を作らない（空の行で他の PC に勝たないため）', async () => {
    await cloud.asDevice('old-pc1').pushChanges([oldSessionChange({ name: '古い名前', memo: '古いメモ', updatedAt: 1000 })]);
    const pc3 = await joinFresh('pc3');
    expect(pc3.prepare('select 1 from sessions where id = ?').get('s1')).toBeDefined();
    expect(pc3.prepare('select 1 from session_notes').get()).toBeUndefined();
  });
});

describe('(c) 2 台目が後から上がる', () => {
  it('同じ行から写した 2 台の名前とメモは、同じ時刻なのでぶつからない', async () => {
    const same = { name: '名前', memo: 'メモ', updatedAt: 1000 };
    const file2 = seedV16('pc2', same);
    const pc1 = await boot('pc1', seedV16('pc1', same));
    await sync(pc1.engine);
    const pc2 = await boot('pc2', file2);
    await sync(pc2.engine, pc1.engine);
    expect(noteOf(pc1.db)).toEqual({ name: '名前', memo: 'メモ' });
    expect(noteOf(pc2.db)).toEqual({ name: '名前', memo: 'メモ' });
    // 2 台目の写しは新しくないので、クラウドは採らない。
    expect(cloudNotes()).toHaveLength(1);
  });

  it('1 台目が上げた後に書いたメモは、後から上がった 2 台目の古い写しに負けない', async () => {
    const same = { name: '名前', memo: '古いメモ', updatedAt: 1000 };
    const file2 = seedV16('pc2', same);
    const pc1 = await boot('pc1', seedV16('pc1', same));
    setSessionMemo(pc1.db, 'pc1', 's1', '上げた後に書いたメモ');
    await sync(pc1.engine);
    // 2 台目は、1 台目の書き込みより後の時刻に上がる。写しの時刻は上げた時刻ではなく、元の行の時刻である。
    const db2 = upgrade('pc2', file2);
    expect(noteOf(db2)).toEqual({ name: '名前', memo: '古いメモ' });
    const pc2 = await boot('pc2', file2, db2);
    await sync(pc2.engine, pc1.engine);
    expect(noteOf(pc1.db)).toEqual({ name: '名前', memo: '上げた後に書いたメモ' });
    expect(noteOf(pc2.db)).toEqual({ name: '名前', memo: '上げた後に書いたメモ' });
  });

  it('2 台目に名前もメモも無ければ、空の行を作らないので、1 台目の名前とメモが残る', async () => {
    // 2 台目の sessions の行は 1 台目より新しい（本文を持つ PC の索引が書き直した）が、名前もメモも持たない。
    const file2 = seedV16('pc2', { name: null, memo: '', updatedAt: 9000, origin: 'pc2' });
    const pc1 = await boot('pc1', seedV16('pc1', { name: '名前', memo: 'メモ', updatedAt: 1000 }));
    await sync(pc1.engine);
    const db2 = upgrade('pc2', file2);
    expect(noteOf(db2)).toBeNull();
    const pc2 = await boot('pc2', file2, db2);
    await sync(pc2.engine, pc1.engine);
    expect(noteOf(pc1.db)).toEqual({ name: '名前', memo: 'メモ' });
    expect(noteOf(pc2.db)).toEqual({ name: '名前', memo: 'メモ' });
  });

  it('2 台の写しの中身が違えば、元の sessions の行が新しかった側が勝つ（上げる前の同期が採ったはずの側）', async () => {
    const file2 = seedV16('pc2', { name: '2 台目の名前', memo: '2 台目のメモ', updatedAt: 2000, origin: 'pc2' });
    const pc1 = await boot('pc1', seedV16('pc1', { name: '1 台目の名前', memo: '1 台目のメモ', updatedAt: 1000 }));
    await sync(pc1.engine);
    const pc2 = await boot('pc2', file2);
    await sync(pc2.engine, pc1.engine);
    expect(noteOf(pc1.db)).toEqual({ name: '2 台目の名前', memo: '2 台目のメモ' });
    expect(noteOf(pc2.db)).toEqual({ name: '2 台目の名前', memo: '2 台目のメモ' });
    // 負けた 1 台目の中身は、1 台目の控えに残る。勝った 2 台目は控えを作らない。
    expect(backupsOf('pc1')).toEqual(['名前：1 台目の名前\n\n1 台目のメモ']);
    expect(backupsOf('pc2')).toEqual([]);
  });

  it('同期が収束する前に 2 台が上がり、片方だけにメモがあるとき、負けた側のメモは控えに残る', async () => {
    // 1 台目でメモを書いた後、それが届く前に、2 台目の索引が sessions の行を書き直していた。
    // 2 台目の行の方が新しいが、メモを持たない。上げる前の同期でも、勝つのは 2 台目の行である。
    const file2 = seedV16('pc2', { name: '名前', memo: null, updatedAt: 2000, origin: 'pc2' });
    const pc1 = await boot('pc1', seedV16('pc1', { name: '名前', memo: '1 台目だけにあるメモ', updatedAt: 1000 }));
    await sync(pc1.engine);
    const pc2 = await boot('pc2', file2);
    await sync(pc2.engine, pc1.engine);
    expect(noteOf(pc1.db)).toEqual({ name: '名前', memo: null });
    expect(noteOf(pc2.db)).toEqual({ name: '名前', memo: null });
    // 消えたメモは、持っていた 1 台目の控えに残る。名前は同じなので、控えにはメモだけが入る。
    expect(backupsOf('pc1')).toEqual(['1 台目だけにあるメモ']);
    expect(backupsOf('pc2')).toEqual([]);
  });

  it('同じ中身の写し、手元が空の写しでは、控えを作らない', async () => {
    const same = { name: '名前', memo: 'メモ', updatedAt: 1000 };
    const file2 = seedV16('pc2', same);
    const file3 = seedV16('pc3', { name: null, memo: null, updatedAt: 500, origin: 'pc3' });
    const pc1 = await boot('pc1', seedV16('pc1', same));
    await sync(pc1.engine);
    const pc2 = await boot('pc2', file2);
    const pc3 = await boot('pc3', file3);
    await sync(pc2.engine, pc3.engine, pc1.engine);
    expect(noteOf(pc3.db)).toEqual({ name: '名前', memo: 'メモ' });
    for (const d of ['pc1', 'pc2', 'pc3']) expect(backupsOf(d), d).toEqual([]);
  });

  it('上げた後は、本文を持つ PC が sessions の行を書き直しても、別の PC の名前とメモに触らない', async () => {
    const same = { name: '名前', memo: 'メモ', updatedAt: 1000 };
    const file2 = seedV16('pc2', same);
    const pc1 = await boot('pc1', seedV16('pc1', same));
    const pc2 = await boot('pc2', file2);
    await sync(pc1.engine, pc2.engine);
    setSessionMemo(pc2.db, 'pc2', 's1', '2 台目で書き直したメモ');
    await pc2.engine.pushNow();
    // 1 台目は 2 台目のメモを受ける前に、索引が sessions の行を書き直す。
    const row = pc1.db.prepare('select * from sessions where id = ?').get('s1') as Record<string, unknown>;
    upsertShared(pc1.db, 'sessions', { ...row, last_activity_at: 42 }, 'pc1');
    await sync(pc1.engine, pc2.engine);
    expect(noteOf(pc1.db)).toEqual({ name: '名前', memo: '2 台目で書き直したメモ' });
    expect(noteOf(pc2.db)).toEqual({ name: '名前', memo: '2 台目で書き直したメモ' });
  });
});
