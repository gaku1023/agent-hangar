import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASELINE_DB_VERSION, dbVersionOf, LATEST_DB_VERSION, seedDbAt, withPendingMigration } from '../test/oldDb.ts';
import { DbBackupError } from './db/backup.ts';
import { DbTooOldError } from './db/open.ts';
import { runMain } from './entry.ts';
import { startServer } from './server.ts';

let root: string;
let home: string;
let claudeDir: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-entry-'));
  home = path.join(root, 'home');
  claudeDir = path.join(root, 'claude');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** 入口を、偽の exit と偽の出力で走らせる。信号の受け口は process に付けない。 */
async function run(start: () => Promise<{ close(): Promise<void> }>): Promise<{ codes: number[]; errors: unknown[] }> {
  const codes: number[] = [];
  const errors: unknown[] = [];
  await runMain({ start, exit: (c) => { codes.push(c); }, error: (e) => { errors.push(e); }, shutdown: { on: () => {}, exit: () => {}, log: () => {} } });
  return { codes, errors };
}
const start = () => startServer({ port: 0, home, claudeDir, registryIsGone: () => false, uiDist: path.join(home, 'no-dist') });

// 子プロセスには仮の次の版を渡せないので、プロセスの入口の本体（entry.ts の runMain）を直に呼ぶ。
// startServer も openDb も本物で、差し替えるのは exit と出力だけである。
describe('サーバの入口（runMain）', () => {
  it('DB の控えが取れなければ、理由を出して終了コード 1 で終わり、マイグレーションを当てない', async () => {
    const file = path.join(home, 'hangar.db');
    seedDbAt(file, LATEST_DB_VERSION);
    // 控えの置き場（backups/db）を通常のファイルにして作れなくする。
    fs.mkdirSync(path.join(home, 'backups'));
    fs.writeFileSync(path.join(home, 'backups', 'db'), 'x');
    const r = await withPendingMigration(() => run(start));
    expect(r.codes).toEqual([1]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toBeInstanceOf(DbBackupError);
    expect((r.errors[0] as Error).message).toContain('マイグレーションを当てずに止めました');
    expect(dbVersionOf(file)).toBe(LATEST_DB_VERSION);
  });

  it('起点より古い版の DB なら、理由を出して終了コード 1 で終わる', async () => {
    const file = path.join(home, 'hangar.db');
    seedDbAt(file, BASELINE_DB_VERSION - 1);
    const r = await run(start);
    expect(r.codes).toEqual([1]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toBeInstanceOf(DbTooOldError);
    expect(dbVersionOf(file)).toBe(BASELINE_DB_VERSION - 1);
  });

  it('起動できたときは終わらせず、何も出さない', async () => {
    let closed = 0;
    const r = await run(async () => ({ close: async () => { closed++; } }));
    expect(r).toEqual({ codes: [], errors: [] });
    expect(closed).toBe(0);
  });
});
