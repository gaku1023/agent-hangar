import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_GENERATIONS } from './claudeConfig.ts';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { setSessionMemo } from '../sessions/notes.ts';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { SyncEngine } from './engine.ts';
import { backupPruner, MEMO_BACKUP_KEEP_COUNT, MEMO_BACKUP_KEEP_DAYS, pruneBackupFiles, pruneBackupFilesByAge, pruneMemoBackups } from './pruneBackups.ts';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

/**
 * 控えの世代。
 * 刈っていたのは設定の取り込みの分だけで、本文（transcripts）は溜まり続けていた。
 * 設定の控えと同じ作法で、新しい方から数えて上限までを残す。
 */
describe('控えの世代を刈る', () => {
  const seed = (dir: string, n: number, ext: string): string[] => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const names: string[] = [];
    for (let i = 0; i < n; i++) {
      // 名前は辞書順と時刻の順が一致しない形にする（本文の控えは <uuid>-<時刻>、メモは session-<ID>-<時刻> である）。
      const name = `z${(n - i).toString().padStart(3, '0')}-20260101-00${i.toString().padStart(4, '0')}${ext}`;
      const f = path.join(dir, name);
      fs.writeFileSync(f, `${i}\n`, { mode: 0o600 });
      const t = new Date(1_700_000_000_000 + i * 1000);
      fs.utimesSync(f, t, t);
      names.push(name);
    }
    return names;
  };

  it('新しい方から数えて上限までを残し、古い控えを消す', () => {
    const dir = path.join(home, 'backups', 'transcripts');
    const names = seed(dir, BACKUP_GENERATIONS + 5, '.jsonl');
    expect(pruneBackupFiles(path.join(home, 'backups'), 'transcripts', BACKUP_GENERATIONS)).toBe(5);
    expect(fs.readdirSync(dir).sort()).toEqual(names.slice(5).sort());
    // もう一度刈っても、上限以下なら何も消さない。
    expect(pruneBackupFiles(path.join(home, 'backups'), 'transcripts', BACKUP_GENERATIONS)).toBe(0);
    expect(fs.readdirSync(dir).length).toBe(BACKUP_GENERATIONS);
  });

  it('入れ物が無くても、上限が 0 以下でも壊れない', () => {
    expect(pruneBackupFiles(path.join(home, 'backups'), 'nope', BACKUP_GENERATIONS)).toBe(0);
    const dir = path.join(home, 'backups', 'transcripts');
    seed(dir, 3, '.jsonl');
    // 上限は 1 未満にしない。控えを全部消す刈り込みは作らない。
    expect(pruneBackupFiles(path.join(home, 'backups'), 'transcripts', 0)).toBe(2);
    expect(fs.readdirSync(dir).length).toBe(1);
  });

  it('入れ物の中のディレクトリは消さない', () => {
    const dir = path.join(home, 'backups', 'transcripts');
    seed(dir, BACKUP_GENERATIONS + 3, '.jsonl');
    fs.mkdirSync(path.join(dir, 'keep-me'), { recursive: true });
    expect(pruneBackupFiles(path.join(home, 'backups'), 'transcripts', BACKUP_GENERATIONS)).toBe(3);
    expect(fs.existsSync(path.join(dir, 'keep-me'))).toBe(true);
  });

  it('入れ物がシンボリックリンクなら、リンクの先を消さずに断る', () => {
    // 書く側（copy.ts の resolveUnder）はリンクを 1 区切りも辿らない。消す側も揃える。
    const outside = path.join(home, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    const victims = seed(outside, 3, '.jsonl');
    fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
    fs.symlinkSync(outside, path.join(home, 'backups', 'transcripts'));
    expect(() => pruneBackupFiles(path.join(home, 'backups'), 'transcripts', 1)).toThrow(/シンボリックリンク/);
    // リンクの先は 1 件も消えていない。
    expect(fs.readdirSync(outside).sort()).toEqual(victims.sort());
  });

  it('控えの種類に区切りや上の階層を混ぜられない', () => {
    expect(() => pruneBackupFiles(path.join(home, 'backups'), '../..', 1)).toThrow(/形が不正/);
    expect(() => pruneBackupFiles(path.join(home, 'backups'), 'a/b', 1)).toThrow(/形が不正/);
  });

  it('刈る口は、刈れなくても投げずにログへ残す。掃除の失敗で呼び手の仕事を止めない', () => {
    const outside = path.join(home, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(path.join(home, 'backups'), { recursive: true });
    fs.symlinkSync(outside, path.join(home, 'backups', 'memos'));
    const logged: string[] = [];
    const prune = backupPruner(home, (...a) => { logged.push(a.map(String).join(' ')); });
    expect(() => prune('memos')).not.toThrow();
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain('[backups]');
    // 入れ物が無い種類は、何も言わずに済ませる。
    prune('transcripts');
    expect(logged.length).toBe(1);
  });

  it('刈る口は、設定の控えと同じ世代の数まで残す', () => {
    const dir = path.join(home, 'backups', 'transcripts');
    const names = seed(dir, BACKUP_GENERATIONS + 2, '.jsonl');
    backupPruner(home)('transcripts');
    expect(fs.readdirSync(dir).sort()).toEqual(names.slice(2).sort());
  });
});

/** 更新時刻が at の控えを n 件置く。 */
function seedAged(dir: string, n: number, prefix: string, at: number): string[] {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    const name = `session-${prefix}${i}-20260101-000000.md`;
    fs.writeFileSync(path.join(dir, name), `${i}\n`, { mode: 0o600 });
    fs.utimesSync(path.join(dir, name), new Date(at), new Date(at));
    names.push(name);
  }
  return names;
}

/**
 * セッションの名前とメモの控えは、件数ではなく日数で刈る。
 * 件数で刈ると、1 回の pull で上限より多くぶつかったときに、いま取った控えがその場で消える。
 */
describe('メモの控えを日数で刈る', () => {
  const NOW = 1_800_000_000_000;
  const DAY = 86_400_000;

  it('新しい方から 200 件は日数に依らず残し、それを超えた分は 180 日より古いものだけ刈る', () => {
    expect(MEMO_BACKUP_KEEP_COUNT).toBe(200);
    expect(MEMO_BACKUP_KEEP_DAYS).toBe(180);
  });

  it('しばらく使わなかった PC でも、件数の内なら古い控えを消さない', () => {
    const dir = path.join(home, 'backups', 'memos');
    const old = seedAged(dir, MEMO_BACKUP_KEEP_COUNT, 'old', NOW - 400 * DAY);
    expect(pruneMemoBackups(home, NOW)).toBe(0);
    expect(fs.readdirSync(dir).sort()).toEqual(old.sort());
  });

  it('件数を超えた分のうち、日数より古いものだけを消す', () => {
    const dir = path.join(home, 'backups', 'memos');
    // 新しい 150 件、少し古い 100 件（日数の内）、とても古い 20 件。
    const fresh = seedAged(dir, 150, 'new', NOW - DAY);
    const mid = seedAged(dir, 100, 'mid', NOW - 100 * DAY);
    seedAged(dir, 20, 'old', NOW - 181 * DAY);
    expect(pruneMemoBackups(home, NOW)).toBe(20);
    expect(fs.readdirSync(dir).sort()).toEqual([...fresh, ...mid].sort());
    expect(pruneMemoBackups(home, NOW)).toBe(0);
  });

  it('件数は見ない刈り方（keepNewest なし）では、日数より古い控えだけを消す', () => {
    const dir = path.join(home, 'backups', 'memos');
    const fresh = seedAged(dir, 50, 'new', NOW - 29 * DAY);
    const edge = seedAged(dir, 1, 'edge', NOW - 30 * DAY);
    seedAged(dir, 4, 'old', NOW - 30 * DAY - 1);
    expect(pruneBackupFilesByAge(path.join(home, 'backups'), 'memos', 30 * DAY, NOW)).toBe(4);
    expect(fs.readdirSync(dir).sort()).toEqual([...fresh, ...edge].sort());
    expect(pruneBackupFilesByAge(path.join(home, 'backups'), 'memos', 30 * DAY, NOW)).toBe(0);
  });

  it('入れ物が無くても壊れず、中のディレクトリは消さず、リンクの入れ物と不正な種類は断る', () => {
    expect(pruneBackupFilesByAge(path.join(home, 'backups'), 'memos', DAY, NOW)).toBe(0);
    const dir = path.join(home, 'backups', 'memos');
    seedAged(dir, 2, 'old', NOW - 5 * DAY);
    fs.mkdirSync(path.join(dir, 'keep-me'));
    fs.utimesSync(path.join(dir, 'keep-me'), new Date(NOW - 5 * DAY), new Date(NOW - 5 * DAY));
    expect(pruneBackupFilesByAge(path.join(home, 'backups'), 'memos', DAY, NOW)).toBe(2);
    expect(fs.readdirSync(dir)).toEqual(['keep-me']);
    expect(() => pruneBackupFilesByAge(path.join(home, 'backups'), '../..', DAY, NOW)).toThrow(/形が不正/);
    const outside = path.join(home, 'outside');
    const victims = seedAged(outside, 2, 'old', NOW - 5 * DAY);
    fs.symlinkSync(outside, path.join(home, 'backups', 'linked'));
    expect(() => pruneBackupFilesByAge(path.join(home, 'backups'), 'linked', DAY, NOW)).toThrow(/シンボリックリンク/);
    expect(fs.readdirSync(outside).sort()).toEqual(victims.sort());
  });

  it('1 回の pull で 30 件ぶつかっても、取った控えは 30 件とも残る', async () => {
    const dbA = openDb(':memory:');
    const dbB = openDb(':memory:');
    const cloud = new FakeCloudClient({ deviceId: 'a' });
    const timers = new FakeTimers();
    const a = new SyncEngine({ db: dbA, deviceId: 'a', client: cloud, now: () => timers.now, timers, url: 'https://h', home: path.join(home, 'a') });
    // 2 台目は、サーバの結線と同じく、控えを取るたびに刈る。
    const b = new SyncEngine({ db: dbB, deviceId: 'b', client: cloud.asDevice('b'), now: () => timers.now, timers, url: 'https://h', home, onSessionMemoBackup: () => { backupPruner(home)('memos'); } });
    try {
      await a.start();
      await b.start();
      const ids = Array.from({ length: 30 }, (_, i) => `s${i}`);
      for (const id of ids) upsertShared(dbA, 'sessions', { id, provider: 'claude-code', provider_session_id: `u-${id}`, cwd: '/w', home_device: 'a' }, 'a');
      await a.pushNow();
      await b.pullNow();
      for (const id of ids) setSessionMemo(dbB, 'b', id, `2 台目のメモ ${id}`);
      await new Promise<void>((r) => { setTimeout(r, 5); });
      for (const id of ids) setSessionMemo(dbA, 'a', id, `1 台目のメモ ${id}`);
      await a.pushNow();
      await b.pullNow();
      const dir = path.join(home, 'backups', 'memos');
      const bodies = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).sort();
      expect(bodies).toEqual(ids.map((id) => `2 台目のメモ ${id}`).sort());
    } finally {
      a.stop(); b.stop(); dbA.close(); dbB.close();
    }
  });
});
