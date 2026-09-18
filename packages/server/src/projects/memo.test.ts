import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { MemoStore } from './memo.ts';

let home: string;
let db: Db;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-memo-')); db = openDb(':memory:'); upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd'); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** p1 のメモのディレクトリにある控えの名前。 */
const backups = (m: MemoStore) => fs.readdirSync(path.dirname(m.memoPath('p1'))).filter((n) => n.startsWith('memo.md.bak-')).sort();
/** ファイルに本文を書き、mtime を DB より古くする。 */
function stale(m: MemoStore, updatedAt: number, markdown: string): void {
  fs.writeFileSync(m.memoPath('p1'), markdown);
  const past = new Date(updatedAt - 5000);
  fs.utimesSync(m.memoPath('p1'), past, past);
}

describe('MemoStore', () => {
  it('write は DB とファイルの両方に書き、read はそれを返す', () => {
    const m = new MemoStore({ db, deviceId: 'd', home });
    expect(m.read('p1')).toBeNull();
    const w = m.write('p1', '# alpha\n\n進め方');
    expect(w).toMatchObject({ projectId: 'p1', markdown: '# alpha\n\n進め方' });
    expect(fs.readFileSync(m.memoPath('p1'), 'utf8')).toBe('# alpha\n\n進め方');
    expect(m.read('p1')).toEqual(w);
    expect(Math.round(fs.statSync(m.memoPath('p1')).mtimeMs)).toBe(w.updatedAt);
    expect((db.prepare("select count(*) c from changes where table_name = 'project_memos'").get() as { c: number }).c).toBe(1);
  });
  it('ファイルが新しければファイルが勝つ。ファイルが無ければ DB から書き戻す', () => {
    const m = new MemoStore({ db, deviceId: 'd', home });
    const w = m.write('p1', 'v1');
    fs.writeFileSync(m.memoPath('p1'), 'v2 from editor');
    const future = new Date(w.updatedAt + 5000);
    fs.utimesSync(m.memoPath('p1'), future, future);
    const r = m.reconcile('p1');
    expect(r).toEqual({ changed: true, memo: { projectId: 'p1', markdown: 'v2 from editor', updatedAt: w.updatedAt + 5000 } });
    expect(m.reconcile('p1').changed).toBe(false);
    expect(m.read('p1')!.markdown).toBe('v2 from editor');
    fs.rmSync(m.memoPath('p1'));
    expect(m.reconcile('p1')).toMatchObject({ changed: false });
    expect(fs.readFileSync(m.memoPath('p1'), 'utf8')).toBe('v2 from editor');
  });
  it('古いファイルは DB を上書きしない', () => {
    const m = new MemoStore({ db, deviceId: 'd', home });
    const w = m.write('p1', 'db wins');
    fs.writeFileSync(m.memoPath('p1'), 'stale');
    const past = new Date(w.updatedAt - 5000);
    fs.utimesSync(m.memoPath('p1'), past, past);
    expect(m.reconcile('p1').changed).toBe(false);
    expect(m.read('p1')!.markdown).toBe('db wins');
    expect(fs.readFileSync(m.memoPath('p1'), 'utf8')).toBe('db wins');
  });
  it('書き戻しで消える本文は控えに残す', () => {
    const m = new MemoStore({ db, deviceId: 'd', home });
    const w = m.write('p1', 'db wins');
    // 利用者がファイルに書いたが、mtime が DB より古い。DB が勝つので、この本文は書き戻しで消える。
    stale(m, w.updatedAt, '利用者が書いた本文');
    expect(m.reconcile('p1').changed).toBe(false);
    expect(fs.readFileSync(m.memoPath('p1'), 'utf8')).toBe('db wins');
    const baks = backups(m);
    expect(baks).toHaveLength(1);
    expect(baks[0]).toMatch(/^memo\.md\.bak-\d{14}(-\d+)?$/);
    expect(fs.readFileSync(path.join(path.dirname(m.memoPath('p1')), baks[0]!), 'utf8')).toBe('利用者が書いた本文');
  });
  it('中身が DB と同じときと、ファイルが無いときは控えを作らない', () => {
    const m = new MemoStore({ db, deviceId: 'd', home });
    const w = m.write('p1', 'same');
    // 中身は同じで mtime だけ古い。消えるものが無いので控えは要らない。
    const past = new Date(w.updatedAt - 5000);
    fs.utimesSync(m.memoPath('p1'), past, past);
    expect(m.reconcile('p1').changed).toBe(false);
    expect(backups(m)).toEqual([]);
    fs.rmSync(m.memoPath('p1'));
    expect(m.reconcile('p1').changed).toBe(false);
    expect(backups(m)).toEqual([]);
  });
  it('控えは上書きせず積み上がる', () => {
    const m = new MemoStore({ db, deviceId: 'd', home });
    const w = m.write('p1', 'db wins');
    stale(m, w.updatedAt, '一度目');
    m.reconcile('p1');
    stale(m, w.updatedAt, '二度目');
    m.reconcile('p1');
    const dir = path.dirname(m.memoPath('p1'));
    const baks = backups(m);
    expect(baks).toHaveLength(2);
    expect(baks.map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).sort()).toEqual(['一度目', '二度目']);
  });
  it('watch は外部の編集を取り込んで知らせる', async () => {
    const m = new MemoStore({ db, deviceId: 'd', home, debounceMs: 50 });
    m.write('p1', 'v1');
    const seen: string[] = [];
    const stop = m.watch((memo) => seen.push(memo.markdown));
    await wait(50);
    fs.writeFileSync(m.memoPath('p1'), 'edited outside');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(m.memoPath('p1'), future, future);
    await wait(400);
    stop();
    expect(seen).toEqual(['edited outside']);
    expect(m.reconcileAll()).toEqual([]);
  });
  it('DB に無いプロジェクトのディレクトリがあっても落ちず、他のプロジェクトの照合は続く', () => {
    const m = new MemoStore({ db, deviceId: 'd', home });
    const ghost = path.join(home, 'projects', 'ghost', 'memo.md');
    fs.mkdirSync(path.dirname(ghost), { recursive: true });
    fs.writeFileSync(ghost, '知らないプロジェクトのメモ');
    const w = m.write('p1', 'v1');
    fs.writeFileSync(m.memoPath('p1'), 'edited outside');
    const future = new Date(w.updatedAt + 5000);
    fs.utimesSync(m.memoPath('p1'), future, future);

    expect(m.reconcile('ghost')).toEqual({ changed: false, memo: null });
    expect(m.read('ghost')).toBeNull();
    expect(m.reconcileAll()).toEqual([{ projectId: 'p1', markdown: 'edited outside', updatedAt: w.updatedAt + 5000 }]);
    // 知らないディレクトリのファイルは消さないし切り詰めない。
    expect(fs.readFileSync(ghost, 'utf8')).toBe('知らないプロジェクトのメモ');
  });
  it('memoHead を db/queries.ts から再エクスポートする', async () => {
    const memo = await import('./memo.ts');
    const queries = await import('../db/queries.ts');
    expect(memo.memoHead).toBe(queries.memoHead);
    expect(memo.memoHead('\n\n# 見出し\n本文')).toBe('# 見出し');
  });
});
