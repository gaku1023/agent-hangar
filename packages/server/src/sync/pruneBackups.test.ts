import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_GENERATIONS } from './claudeConfig.ts';
import { backupPruner, pruneBackupFiles } from './pruneBackups.ts';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

/**
 * 控えの世代。
 * 刈っていたのは設定の取り込みの分だけで、本文（transcripts）とメモ（memos）は溜まり続けていた。
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
    const dir = path.join(home, 'backups', 'memos');
    seed(dir, 3, '.md');
    // 上限は 1 未満にしない。控えを全部消す刈り込みは作らない。
    expect(pruneBackupFiles(path.join(home, 'backups'), 'memos', 0)).toBe(2);
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
