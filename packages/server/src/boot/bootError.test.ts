import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbBackupError } from '../db/backup.ts';
import { DbTooOldError } from '../db/open.ts';
import { BOOT_ERROR_FILE, bootErrorPath, classifyBootError, clearBootError, writeBootError } from './bootError.ts';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-booterr-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const read = (home: string) => JSON.parse(fs.readFileSync(path.join(home, BOOT_ERROR_FILE), 'utf8')) as unknown;
/** boot-error.json の場所に、中身のあるディレクトリを置く。消すことも、置き換えることもできなくなる。 */
const blockFile = (home: string) => {
  fs.mkdirSync(path.join(home, BOOT_ERROR_FILE));
  fs.writeFileSync(path.join(home, BOOT_ERROR_FILE, 'x'), 'x');
};

describe('起動の失敗の種類（classifyBootError）', () => {
  it('DB の控えが取れなかった失敗は db-backup-failed で、控えのファイルと置き場を params に持つ', () => {
    const file = path.join(root, 'backups', 'db', 'hangar-v16-20261009T000000000Z.db');
    const e = classifyBootError(new DbBackupError(file, new Error('ENOSPC')));
    expect(e.kind).toBe('db-backup-failed');
    expect(e.params).toEqual({ file, dir: path.dirname(file) });
    expect(e.detail).toContain('ENOSPC');
  });

  it('起点より古い DB は db-too-old で、ファイルと版を params に持つ', () => {
    const e = classifyBootError(new DbTooOldError('/x/hangar.db', 3, 16));
    expect(e.kind).toBe('db-too-old');
    expect(e.params).toEqual({ file: '/x/hangar.db', found: 3, baseline: 16 });
    expect(e.detail).toContain('版 3');
  });

  it('listen の EADDRINUSE は port-in-use で、ポートと宛先を params に持つ', () => {
    const err = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:4177'), { code: 'EADDRINUSE', port: 4177, address: '127.0.0.1' });
    expect(classifyBootError(err)).toEqual({ kind: 'port-in-use', params: { port: 4177, host: '127.0.0.1' }, detail: err.message });
  });

  it('EADDRINUSE でもポートが読めなければ、読めた分だけを params に入れる', () => {
    const e = classifyBootError(Object.assign(new Error('x'), { code: 'EADDRINUSE' }));
    expect(e.kind).toBe('port-in-use');
    expect(e.params).toEqual({});
  });

  it('それ以外の失敗は server-exited で、例外の文を detail に持つ（Error でない値も文字にする）', () => {
    expect(classifyBootError(new Error('boom'))).toEqual({ kind: 'server-exited', params: {}, detail: 'boom' });
    expect(classifyBootError('plain')).toEqual({ kind: 'server-exited', params: {}, detail: 'plain' });
  });

  it('文は書かない。持つのは kind、params、detail だけである', () => {
    expect(Object.keys(classifyBootError(new Error('boom'))).sort()).toEqual(['detail', 'kind', 'params']);
  });
});

describe('boot-error.json を書く（writeBootError）', () => {
  it('置き場に { kind, params, detail } だけを書く。置き場がまだ無くても作る', () => {
    const home = path.join(root, 'new', 'home');
    expect(writeBootError(home, new DbTooOldError('/x/hangar.db', 3, 16))).toBe(true);
    expect(bootErrorPath(home)).toBe(path.join(home, 'boot-error.json'));
    expect(read(home)).toEqual({ kind: 'db-too-old', params: { file: '/x/hangar.db', found: 3, baseline: 16 }, detail: expect.stringContaining('版 3') });
  });

  it('置き場の設定の言語で detail を書く。設定が無い、壊れている、知らない言語なら日本語', () => {
    const e = new DbTooOldError('/x/hangar.db', 3, 16);
    const detailIn = (home: string): unknown => { writeBootError(home, e); return (read(home) as { detail: string }).detail; };
    const withSettings = (name: string, text: string): string => {
      const home = path.join(root, name);
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, 'settings.json'), text);
      return home;
    };
    expect(detailIn(withSettings('en', '{"language":"en"}'))).toContain('is at version 3');
    expect(detailIn(withSettings('ja', '{"language":"ja"}'))).toContain('版 3');
    expect(detailIn(withSettings('broken', '{ not json'))).toContain('版 3');
    expect(detailIn(withSettings('unknown', '{"language":"fr"}'))).toContain('版 3');
    expect(detailIn(path.join(root, 'none'))).toContain('版 3');
  });

  it('前の失敗は新しい失敗で置き換わり、書きかけの一時ファイルは残らない', () => {
    writeBootError(root, new Error('first'));
    writeBootError(root, new Error('second'));
    expect(read(root)).toMatchObject({ kind: 'server-exited', detail: 'second' });
    expect(fs.readdirSync(root)).toEqual([BOOT_ERROR_FILE]);
  });

  it('書けなくても投げない（起動の失敗を隠さないため）。false を返し、一時ファイルを残さない', () => {
    blockFile(root);
    expect(writeBootError(root, new Error('boom'))).toBe(false);
    expect(fs.readdirSync(root)).toEqual([BOOT_ERROR_FILE]);
  });
});

describe('古い boot-error.json を消す（clearBootError）', () => {
  it('あれば消す。無くても、置き場が無くても、消せなくても投げない', () => {
    writeBootError(root, new Error('boom'));
    clearBootError(root);
    expect(fs.existsSync(bootErrorPath(root))).toBe(false);
    expect(() => clearBootError(root)).not.toThrow();
    expect(() => clearBootError(path.join(root, 'no', 'such', 'home'))).not.toThrow();
    blockFile(root);
    expect(() => clearBootError(root)).not.toThrow();
  });
});
