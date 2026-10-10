import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASELINE_DB_VERSION, dbVersionOf, LATEST_DB_VERSION, seedDbAt, withPendingMigration } from '../test/oldDb.ts';
import { BOOT_ERROR_FILE } from './boot/bootError.ts';
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
  await runMain({ start, home, exit: (c) => { codes.push(c); }, error: (e) => { errors.push(e); }, shutdown: { on: () => {}, exit: () => {}, log: () => {} } });
  return { codes, errors };
}
const bootError = () => JSON.parse(fs.readFileSync(path.join(home, BOOT_ERROR_FILE), 'utf8')) as { kind: string; params: Record<string, string | number>; detail: string };
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

  it('控えが取れなかったときは boot-error.json に db-backup-failed を書く', async () => {
    seedDbAt(path.join(home, 'hangar.db'), LATEST_DB_VERSION);
    fs.mkdirSync(path.join(home, 'backups'));
    fs.writeFileSync(path.join(home, 'backups', 'db'), 'x');
    await withPendingMigration(() => run(start));
    const e = bootError();
    expect(e.kind).toBe('db-backup-failed');
    expect(e.params.dir).toBe(path.join(home, 'backups', 'db'));
    expect(String(e.params.file)).toContain(path.join(home, 'backups', 'db'));
    expect(e.detail).toContain('マイグレーションを当てずに止めました');
  });

  it('起点より古い DB のときは boot-error.json に db-too-old を書く', async () => {
    seedDbAt(path.join(home, 'hangar.db'), BASELINE_DB_VERSION - 1);
    await run(start);
    const e = bootError();
    expect(e.kind).toBe('db-too-old');
    expect(e.params).toMatchObject({ found: BASELINE_DB_VERSION - 1, baseline: BASELINE_DB_VERSION });
  });

  it('ポートが塞がれているときは boot-error.json に port-in-use を書く', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      const r = await run(() => startServer({ port, home, claudeDir, registryIsGone: () => false, uiDist: path.join(home, 'no-dist') }));
      expect(r.codes).toEqual([1]);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
    expect(bootError()).toMatchObject({ kind: 'port-in-use', params: { port, host: '127.0.0.1' } });
  });

  it('それ以外の起動の失敗は server-exited を書く', async () => {
    await run(async () => { throw new Error('boom'); });
    expect(bootError()).toEqual({ kind: 'server-exited', params: {}, detail: 'boom' });
  });

  // 殻は子が死んだときにこのファイルを読む。古い失敗を拾わないよう、起こす前に消す（起動が成功するのを待たない）。
  it('起こす前に古い boot-error.json を消す。起動できたときは何も残さない', async () => {
    fs.writeFileSync(path.join(home, BOOT_ERROR_FILE), JSON.stringify({ kind: 'port-in-use', params: {}, detail: 'old' }));
    let closed = 0;
    const r = await run(async () => {
      expect(fs.existsSync(path.join(home, BOOT_ERROR_FILE))).toBe(false);
      return { close: async () => { closed++; } };
    });
    expect(r.codes).toEqual([]);
    expect(fs.existsSync(path.join(home, BOOT_ERROR_FILE))).toBe(false);
    expect(closed).toBe(0);
  });

  it('次の失敗が違う理由なら、古い理由は残らない', async () => {
    fs.writeFileSync(path.join(home, BOOT_ERROR_FILE), JSON.stringify({ kind: 'port-in-use', params: {}, detail: 'old' }));
    await run(async () => { throw new Error('new'); });
    expect(bootError()).toMatchObject({ kind: 'server-exited', detail: 'new' });
  });

  it('boot-error.json が書けなくても、起動の失敗の理由は出て終了コード 1 で終わる', async () => {
    fs.mkdirSync(path.join(home, BOOT_ERROR_FILE));
    fs.writeFileSync(path.join(home, BOOT_ERROR_FILE, 'x'), 'x');
    const r = await run(async () => { throw new Error('boom'); });
    expect(r.codes).toEqual([1]);
    expect(r.errors).toHaveLength(1);
    expect((r.errors[0] as Error).message).toBe('boom');
  });

  it('起動できたときは終わらせず、何も出さない', async () => {
    let closed = 0;
    const r = await run(async () => ({ close: async () => { closed++; } }));
    expect(r).toEqual({ codes: [], errors: [] });
    expect(closed).toBe(0);
  });
});
