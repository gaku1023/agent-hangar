import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeIn } from '@agent-hangar/shared';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { seedDbAt } from '../../test/oldDb.ts';
import { MIGRATED_NOTE_AT } from '../db/migrations.ts';
import { openDb, type Db } from '../db/open.ts';
import { getSession } from '../db/queries.ts';
import { upsertShared } from '../db/shared.ts';
import { getSessionNote, setSessionName } from '../sessions/notes.ts';
import { SyncEngine } from './engine.ts';

/**
 * 版 17（名前とメモを session_notes へ移す）へ上げる順序の罠。
 * 2 台の PC は同時には上がらない。先に上がった PC、後から上がった PC、クラウドに残る古い形の行が混ざる。
 * 版 16 の DB はいまの版まで一度に上がるので、メモ（ノート）は版 21 で落ちる。ここで見るのは名前の行方である。
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
  const engine = new SyncEngine({ db, deviceId: device, client: cloud.asDevice(device), now: () => timers.now, timers, url: 'https://h', home: homeOf(device) });
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
const cloudNotes = async () => (await cloud.opened()).filter((c) => c.tableName === 'session_notes');
const sync = async (...es: SyncEngine[]) => { for (const e of es) { await e.pushNow(); await e.pullNow(); } };

describe('(a) 上げた直後の名前が、クラウドへ上がる', () => {
  it('写した行は、クラウドにまだ無い状態から上がり、後から参加した PC に届く。メモは手元の表から落ちる', async () => {
    await cloud.asDevice('old-pc1').pushChanges([oldSessionChange({ name: '名前', memo: 'メモ', updatedAt: 1000 })]);
    const file1 = seedV16('pc1', { name: '名前', memo: 'メモ', updatedAt: 1000 });
    const db1 = upgrade('pc1', file1);
    expect(noteOf(db1)).toEqual({ name: '名前' });
    expect(await cloudNotes()).toHaveLength(0);
    const pc1 = await boot('pc1', file1, db1);
    await pc1.engine.pushNow();
    // 版 17 が積んだ差分は、版 21 が列を落とす前に組んだ payload なので、メモを持ったまま上がる。受けた側は知らない列として捨てる。
    expect((await cloudNotes()).map((c) => ({ rowId: c.rowId, updatedAt: c.updatedAt, payload: c.payload }))).toEqual([
      { rowId: 's1', updatedAt: MIGRATED_NOTE_AT, payload: { session_id: 's1', name: '名前', memo: 'メモ', updated_at: MIGRATED_NOTE_AT, deleted_at: null, origin_device: 'pc1' } },
    ]);
    expect((pc1.db.prepare("select count(*) c from changes where table_name = 'session_notes' and pushed_at is null").get() as { c: number }).c).toBe(0);

    const pc3 = await joinFresh('pc3');
    expect(noteOf(pc3)).toEqual({ name: '名前' });
    expect(getSession(pc3, [], 's1', { deviceId: 'pc3' })).toMatchObject({ name: '名前' });
    expect(getSession(pc3, [], 's1', { deviceId: 'pc3' })).not.toHaveProperty('memo');
  });
});

describe('(b) クラウドに残る古い形の sessions の行', () => {
  it('古い形の行が降りてきても、手元の名前を壊さない', async () => {
    const pc1 = await boot('pc1', seedV16('pc1', { name: '手元の名前', memo: '手元のメモ', updatedAt: 1000 }));
    // まだ上げていない別の PC が、上げる前に sessions の行を書き直していた。名前とメモは古いか、空である。
    await cloud.asDevice('old-pc2').pushChanges([oldSessionChange({ name: null, memo: null, updatedAt: 5000, origin: 'old-pc2' })]);
    await pc1.engine.pullNow();
    expect((pc1.db.prepare('select updated_at u from sessions where id = ?').get('s1') as { u: number }).u).toBe(5000);
    expect(noteOf(pc1.db)).toEqual({ name: '手元の名前' });
    await cloud.asDevice('old-pc2').pushChanges([oldSessionChange({ name: '向こうの古い名前', memo: '向こうの古いメモ', updatedAt: 6000, origin: 'old-pc2' })]);
    await pc1.engine.pullNow();
    expect(noteOf(pc1.db)).toEqual({ name: '手元の名前' });
  });

  it('古い形の行だけがクラウドにあるとき、その名前が新しい PC に届く。メモは拾わない', async () => {
    // 書いた PC はまだ上げていない。クラウドにあるのは、名前とメモを含む古い形の sessions の行だけである。
    await cloud.asDevice('old-pc1').pushChanges([oldSessionChange({ name: '古い形の名前', memo: '古い形のメモ', updatedAt: 1000, origin: 'old-pc1' })]);
    const pc3 = await joinFresh('pc3');
    expect(noteOf(pc3)).toEqual({ name: '古い形の名前' });
    expect(getSession(pc3, [], 's1', { deviceId: 'pc3' })).toMatchObject({ name: '古い形の名前' });
    // 時刻は写しの定数、書き手は payload の書き手である。こちらからは上げ直さない。
    expect(pc3.prepare('select updated_at, origin_device from session_notes where session_id = ?').get('s1')).toEqual({ updated_at: MIGRATED_NOTE_AT, origin_device: 'old-pc1' });
    expect(pc3.prepare("select count(*) c from changes where table_name = 'session_notes'").get()).toEqual({ c: 0 });
    expect(await cloudNotes()).toHaveLength(0);
  });

  it('クラウドに本物の名前があれば、古い形の行の中身は拾わない。控えも作らない', async () => {
    // 書いた PC は上がっていて、上げた後に名前を付け直した。クラウドの sessions の行は、古い形のまま古い名前を持っている。
    await cloud.asDevice('old-pc1').pushChanges([oldSessionChange({ name: '古い名前', memo: '古い形のメモ', updatedAt: 1000 })]);
    const pc1 = await boot('pc1', seedV16('pc1', { name: '古い名前', memo: '古い形のメモ', updatedAt: 1000 }));
    setSessionName(pc1.db, 'pc1', 's1', '上げた後に付け直した名前');
    await sync(pc1.engine);
    const pc3 = await joinFresh('pc3');
    expect(noteOf(pc3)).toEqual({ name: '上げた後に付け直した名前' });
    expect(backupsOf('pc3')).toEqual([]);
  });

  it('古い形の行に名前が無ければ、メモがあっても行を作らない', async () => {
    await cloud.asDevice('old-pc1').pushChanges([oldSessionChange({ name: null, memo: 'メモだけ', updatedAt: 1000 })]);
    const pc3 = await joinFresh('pc3');
    expect(pc3.prepare('select 1 from sessions where id = ?').get('s1')).toBeDefined();
    expect(pc3.prepare('select 1 from session_notes').get()).toBeUndefined();
  });

  it('古い形の行から作った名前は、書いた PC が上がって届いた本物に置き換わる', async () => {
    await cloud.asDevice('old-pc1').pushChanges([oldSessionChange({ name: '古い名前', memo: '古い形のメモ', updatedAt: 1000 })]);
    const pc3 = await joinFresh('pc3');
    expect(noteOf(pc3)).toEqual({ name: '古い名前' });
    // 書いた PC は、クラウドへ上げていなかった新しい名前を持ったまま上がる。
    const pc1 = await boot('pc1', seedV16('pc1', { name: '上げていなかった新しい名前', updatedAt: 3000 }));
    await sync(pc1.engine);
    await engines[0]!.pullNow();
    expect(noteOf(pc3)).toEqual({ name: '上げていなかった新しい名前' });
    expect(noteOf(pc1.db)).toEqual({ name: '上げていなかった新しい名前' });
    // 書いた PC の中身は、新しい PC が古い形の行から作った中身に負けない。書いた PC に控えは出ない。
    await sync(pc1.engine, engines[0]!, pc1.engine);
    expect(noteOf(pc1.db)).toEqual({ name: '上げていなかった新しい名前' });
    expect(noteOf(pc3)).toEqual({ name: '上げていなかった新しい名前' });
    expect(backupsOf('pc1')).toEqual([]);
    expect((await cloudNotes()).map((c) => c.payload.name)).toEqual(['上げていなかった新しい名前']);
  });
});

describe('(c) 2 台目が後から上がる', () => {
  it('同じ行から写した 2 台の名前は、同じ中身なのでぶつからない', async () => {
    const same = { name: '名前', memo: 'メモ', updatedAt: 1000 };
    const file2 = seedV16('pc2', { ...same, updatedAt: 7000 });
    const pc1 = await boot('pc1', seedV16('pc1', same));
    await sync(pc1.engine);
    const pc2 = await boot('pc2', file2);
    await sync(pc2.engine, pc1.engine);
    expect(noteOf(pc1.db)).toEqual({ name: '名前' });
    expect(noteOf(pc2.db)).toEqual({ name: '名前' });
    // 2 台目の写しは同じ時刻（写しの定数）なので、クラウドは採らない。
    expect(await cloudNotes()).toHaveLength(1);
    for (const d of ['pc1', 'pc2']) expect(backupsOf(d), d).toEqual([]);
  });

  it('写しの時刻は、元の行の時刻に依らず、どの PC でも同じ定数である', async () => {
    const db1 = upgrade('pc1', seedV16('pc1', { name: '名前', updatedAt: 1000 }));
    const db2 = upgrade('pc2', seedV16('pc2', { name: '名前', updatedAt: Date.now() + 600_000 }));
    for (const d of [db1, db2]) expect(d.prepare('select updated_at u from session_notes').get()).toEqual({ u: MIGRATED_NOTE_AT });
    // 本物の書き込みの時刻より必ず古い。
    expect(MIGRATED_NOTE_AT).toBeGreaterThan(0);
    expect(MIGRATED_NOTE_AT).toBeLessThan(Date.UTC(2000, 0, 1));
  });

  it('先に上げた PC で付け直した名前は、後から別の PC が古い名前を持って上がっても、両方の PC に残る', async () => {
    // 2 台目はまだ上げておらず、索引が sessions の行の時刻を進め続けている。1 台目の付け直しより後の時刻になる。
    const file2 = seedV16('pc2', { name: '古い名前', updatedAt: Date.now() + 600_000, origin: 'pc2' });
    const pc1 = await boot('pc1', seedV16('pc1', { name: '古い名前', updatedAt: 1000 }));
    setSessionName(pc1.db, 'pc1', 's1', '上げた後に付け直した名前');
    await sync(pc1.engine);
    const db2 = upgrade('pc2', file2);
    expect(noteOf(db2)).toEqual({ name: '古い名前' });
    const pc2 = await boot('pc2', file2, db2);
    await sync(pc2.engine, pc1.engine, pc2.engine);
    expect(noteOf(pc1.db)).toEqual({ name: '上げた後に付け直した名前' });
    expect(noteOf(pc2.db)).toEqual({ name: '上げた後に付け直した名前' });
    // 負けた 2 台目の古い名前は、2 台目の控えに残る。
    expect(backupsOf('pc2')).toEqual(['名前：古い名前\n']);
    expect(backupsOf('pc1')).toEqual([]);
  });

  it('2 台目に名前もメモも無ければ、空の行を作らないので、1 台目の名前が残る', async () => {
    // 2 台目の sessions の行は 1 台目より新しい（本文を持つ PC の索引が書き直した）が、名前もメモも持たない。
    const file2 = seedV16('pc2', { name: null, memo: '', updatedAt: 9000, origin: 'pc2' });
    const pc1 = await boot('pc1', seedV16('pc1', { name: '名前', updatedAt: 1000 }));
    await sync(pc1.engine);
    const db2 = upgrade('pc2', file2);
    expect(noteOf(db2)).toBeNull();
    const pc2 = await boot('pc2', file2, db2);
    await sync(pc2.engine, pc1.engine);
    expect(noteOf(pc1.db)).toEqual({ name: '名前' });
    expect(noteOf(pc2.db)).toEqual({ name: '名前' });
  });

  it.each([
    { first: 'pc1', second: 'pc2' },
    { first: 'pc2', second: 'pc1' },
  ])('写し同士の名前が違えば、先にクラウドへ上がった側（$first）に 2 台とも収束し、負けた側は控えに残る', async ({ first, second }) => {
    const rows = {
      pc1: { name: '1 台目の名前', memo: '1 台目のメモ', updatedAt: 1000, origin: 'pc1' },
      pc2: { name: '2 台目の名前', memo: '2 台目のメモ', updatedAt: 2000, origin: 'pc2' },
    };
    const files = { pc1: seedV16('pc1', rows.pc1), pc2: seedV16('pc2', rows.pc2) };
    const a = await boot(first, files[first as 'pc1']);
    await sync(a.engine);
    const b = await boot(second, files[second as 'pc1']);
    // 何巡しても、どちらの PC から先に同期しても、同じ結果である。
    await sync(b.engine, a.engine, b.engine, a.engine);
    const winner = rows[first as 'pc1'];
    const loser = rows[second as 'pc1'];
    expect(noteOf(a.db)).toEqual({ name: winner.name });
    expect(noteOf(b.db)).toEqual({ name: winner.name });
    expect(backupsOf(second)).toEqual([`名前：${loser.name}\n`]);
    expect(backupsOf(first)).toEqual([]);
    expect(await cloudNotes()).toHaveLength(1);
  });

  it.each([
    { order: ['pc1', 'pc2', 'pc3'] },
    { order: ['pc3', 'pc1', 'pc2'] },
  ])('3 台が $order の順に上がっても、全部の PC が同じ名前になり、負けた名前は控えに残る', async ({ order }) => {
    const rows: Record<string, Old> = {
      pc1: { name: '1 台目の名前', updatedAt: 1000, origin: 'pc1' },
      pc2: { name: '2 台目の名前', updatedAt: 3000, origin: 'pc2' },
      pc3: { name: '3 台目の名前', updatedAt: 2000, origin: 'pc3' },
    };
    const files: Record<string, string> = {};
    for (const d of order) files[d] = seedV16(d, rows[d]!);
    const booted: { db: Db; engine: SyncEngine }[] = [];
    for (const d of order) {
      const pc = await boot(d, files[d]!);
      booted.push(pc);
      await sync(pc.engine);
    }
    // 何巡しても、どの順に同期しても変わらない。
    await sync(...booted.map((x) => x.engine), ...[...booted].reverse().map((x) => x.engine));
    const winner = rows[order[0]!]!;
    for (const pc of booted) expect(noteOf(pc.db)).toEqual({ name: winner.name });
    expect(backupsOf(order[0]!)).toEqual([]);
    for (const d of order.slice(1)) expect(backupsOf(d), d).toEqual([`名前：${rows[d]!.name}\n`]);
    expect(await cloudNotes()).toHaveLength(1);
  });

  it('メモだけの写し（名前が空）が先に上がると、後から上がった PC の名前はそれに負け、控えに残る', async () => {
    // 2 台目はメモだけを持っていた。版 17 は名前の空の行を写し、版 21 はメモを落としても行を残す。
    // その写しが先に上がると、後から上がった 1 台目の名前は、写し同士の決着で負ける（版 17 の決まりのまま）。
    const file1 = seedV16('pc1', { name: '1 台目だけにある名前', updatedAt: 1000 });
    const pc2 = await boot('pc2', seedV16('pc2', { name: null, memo: '2 台目のメモ', updatedAt: 2000, origin: 'pc2' }));
    await sync(pc2.engine);
    const pc1 = await boot('pc1', file1);
    await sync(pc1.engine, pc2.engine);
    expect(noteOf(pc1.db)).toEqual({ name: null });
    expect(noteOf(pc2.db)).toEqual({ name: null });
    // 消えた名前は、持っていた 1 台目の控えに残る。
    expect(backupsOf('pc1')).toEqual(['名前：1 台目だけにある名前\n']);
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
    expect(noteOf(pc3.db)).toEqual({ name: '名前' });
    for (const d of ['pc1', 'pc2', 'pc3']) expect(backupsOf(d), d).toEqual([]);
  });

  it('上げた後は、本文を持つ PC が sessions の行を書き直しても、別の PC の名前に触らない', async () => {
    const same = { name: '名前', updatedAt: 1000 };
    const file2 = seedV16('pc2', same);
    const pc1 = await boot('pc1', seedV16('pc1', same));
    const pc2 = await boot('pc2', file2);
    await sync(pc1.engine, pc2.engine);
    setSessionName(pc2.db, 'pc2', 's1', '2 台目で付け直した名前');
    await pc2.engine.pushNow();
    // 1 台目は 2 台目の名前を受ける前に、索引が sessions の行を書き直す。
    const row = pc1.db.prepare('select * from sessions where id = ?').get('s1') as Record<string, unknown>;
    upsertShared(pc1.db, 'sessions', { ...row, last_activity_at: 42 }, 'pc1');
    await sync(pc1.engine, pc2.engine);
    expect(noteOf(pc1.db)).toEqual({ name: '2 台目で付け直した名前' });
    expect(noteOf(pc2.db)).toEqual({ name: '2 台目で付け直した名前' });
  });
});
