import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { posixDescribe } from '../../test/platform.ts';
import { linkEntries, normalizeLinkTarget, type LinkFs } from './links.ts';

let root: string;
let primary: string;
let dir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-plinks-'));
  primary = path.join(root, 'primary');
  dir = path.join(root, 'second');
  fs.mkdirSync(path.join(primary, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(primary, 'skills'));
  fs.writeFileSync(path.join(primary, 'config.toml'), 'x');
  fs.mkdirSync(dir);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const NAMES = ['config.toml', 'sessions', 'skills'];

/** 本物の fs に、symlinkSync の型の記録と、差し替えた振る舞いを重ねる。 */
function fakeFs(over: Partial<LinkFs> = {}): { fs: LinkFs; types: Record<string, string | undefined> } {
  const types: Record<string, string | undefined> = {};
  const base: LinkFs = {
    existsSync: fs.existsSync, lstatSync: fs.lstatSync, statSync: fs.statSync, readlinkSync: (p) => fs.readlinkSync(p),
    symlinkSync: (target, link, type) => { types[path.basename(link)] = type ?? undefined; fs.symlinkSync(target, link); },
  };
  return { fs: { ...base, ...over, symlinkSync: over.symlinkSync ?? base.symlinkSync }, types };
}

describe('normalizeLinkTarget', () => {
  it('Windows の長いパスの頭（\\\\?\\ と \\??\\）を外す', () => {
    expect(normalizeLinkTarget('\\\\?\\C:\\Users\\u\\.codex\\sessions')).toBe('C:\\Users\\u\\.codex\\sessions');
    expect(normalizeLinkTarget('\\??\\C:\\Users\\u\\.codex\\sessions')).toBe('C:\\Users\\u\\.codex\\sessions');
    expect(normalizeLinkTarget('/a/b')).toBe('/a/b');
  });
});

// 本物の symlink を張るので Unix だけで確かめる。Windows の型は差し替えた fs が記録する。
posixDescribe('linkEntries', () => {
  it('win32 では、ディレクトリをジャンクション、ファイルを file のリンクにする', () => {
    const f = fakeFs();
    const r = linkEntries(primary, dir, NAMES, true, { platform: 'win32', fs: f.fs });
    expect(r).toEqual({ created: NAMES, conflicts: [], unlinked: [] });
    expect(f.types).toEqual({ 'config.toml': 'file', sessions: 'junction', skills: 'junction' });
  });

  it('win32 以外では、型を渡さない（今と同じ）', () => {
    const f = fakeFs();
    linkEntries(primary, dir, NAMES, true, { platform: 'darwin', fs: f.fs });
    expect(f.types).toEqual({ 'config.toml': undefined, sessions: undefined, skills: undefined });
  });

  it('1 つが EPERM で張れなくても投げず、残りを張り、張れない項目を unlinked に挙げる', () => {
    const f = fakeFs();
    const real = f.fs.symlinkSync;
    const fs2: LinkFs = {
      ...f.fs,
      symlinkSync: (target, link, type) => {
        if (type === 'file') throw Object.assign(new Error(`EPERM: operation not permitted, symlink '${target}' -> '${link}'`), { code: 'EPERM' });
        real(target, link, type);
      },
    };
    const r = linkEntries(primary, dir, NAMES, true, { platform: 'win32', fs: fs2 });
    expect(r).toEqual({ created: ['sessions', 'skills'], conflicts: [], unlinked: ['config.toml'] });
    expect(fs.lstatSync(path.join(dir, 'sessions')).isSymbolicLink()).toBe(true);
  });

  it('ジャンクションの readlink が \\\\?\\ 付きで返っても、張ってあると判定する', () => {
    linkEntries(primary, dir, NAMES, true, {});
    const f = fakeFs({ readlinkSync: (p) => `\\\\?\\${fs.readlinkSync(p)}` });
    expect(linkEntries(primary, dir, NAMES, true, { platform: 'win32', fs: f.fs })).toEqual({ created: [], conflicts: [], unlinked: [] });
    expect(linkEntries(primary, dir, NAMES, false, { platform: 'win32', fs: f.fs })).toEqual({ created: [], conflicts: [], unlinked: [] });
  });

  it('make が false なら何も作らない。無い項目は unlinked にも挙げない', () => {
    const f = fakeFs();
    expect(linkEntries(primary, dir, NAMES, false, { platform: 'win32', fs: f.fs })).toEqual({ created: [], conflicts: [], unlinked: [] });
    expect(f.types).toEqual({});
  });

  it('最初の置き場に無い項目は飛ばす', () => {
    expect(linkEntries(primary, dir, ['nothing', 'skills'], true, {})).toEqual({ created: ['skills'], conflicts: [], unlinked: [] });
  });
});
