import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { errorText, MessageError } from '../i18n/message.ts';
import { classifyBootError } from '../boot/bootError.ts';
import { backupDb, DbBackupError } from './backup.ts';
import { DbTooOldError } from './open.ts';

/** DB の起動の失敗の文が、辞書の鍵と引数を持ち、いまの言語で出ること。日本語の文は今までと同じである。 */

describe('DB の起動の失敗の文', () => {
  it('古すぎる DB は、見つけた版と開ける版を日本語と英語で言う', () => {
    const e = new DbTooOldError('/x/hangar.db', 3, 16);
    expect(e).toBeInstanceOf(MessageError);
    expect(e.message).toContain('DB（/x/hangar.db）はバージョン 3 で、このアプリが開けるのはバージョン 16 以降です');
    expect(errorText('en', e)).toBe('The database (/x/hangar.db) is at version 3, but this app can only open version 16 or later. There is no longer an upgrade path from older versions, so the database was left untouched and no migrations were applied. Launch an earlier Hangar that can upgrade it to version 16 once, then start this app again');
  });

  it('控えが取れなかった失敗は、控えの置き場と理由を言語ごとに言い、理由も同じ言語で出す', () => {
    const e = new DbBackupError('/x/backups/db/a.db', new Error('ENOSPC'));
    expect(e.message).toBe('DB のバックアップを /x/backups/db/a.db に作成できなかったので、マイグレーションを適用せずに停止しました（ENOSPC）。フォルダに書き込めるか、空き容量があるかを確認してください');
    expect(errorText('en', e)).toBe('Could not save a database backup to /x/backups/db/a.db, so startup stopped without applying migrations (ENOSPC). Check that the folder is writable and has free space');
  });

  describe('保存先がシンボリックリンクのとき', () => {
    let root: string;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-dberr-')); });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    it('理由に辞書の文を持ち、外側の文と同じ言語で出る', () => {
      const real = path.join(root, 'real');
      fs.mkdirSync(real);
      const dir = path.join(root, 'link');
      fs.symlinkSync(real, dir);
      const db = { prepare: () => ({ run: () => undefined }) } as never;
      const e = (() => { try { backupDb(db, dir, 16, new Date()); } catch (x) { return x; } return null; })();
      expect(e).toBeInstanceOf(DbBackupError);
      expect(errorText('ja', e)).toContain('backups/db がシンボリックリンクなので、バックアップを作成しません');
      expect(errorText('en', e)).toContain('backups/db is a symbolic link, so no backup was made');
      expect(errorText('en', e)).not.toContain('シンボリックリンク');
    });
  });

  it('起動の失敗の札に添える詳細は、渡された言語の文である', () => {
    expect(classifyBootError(new DbTooOldError('/x/hangar.db', 3, 16), 'ja').detail).toContain('バージョン 3');
    expect(classifyBootError(new DbTooOldError('/x/hangar.db', 3, 16), 'en').detail).toContain('is at version 3');
    // 言語を渡さなければ、今までどおり日本語である。
    expect(classifyBootError(new DbBackupError('/f', new Error('x'))).detail).toContain('DB のバックアップを');
    expect(classifyBootError(new Error('boom'), 'en').detail).toBe('boom');
  });
});
