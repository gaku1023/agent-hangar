import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { posixDescribe } from '../../test/platform.ts';
import { fixableConflicts, linkConflictDetail, linkEntries, normalizeLinkTarget, resolveLinkConflict, type LinkFs } from './links.ts';

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
    readFileSync: (p) => fs.readFileSync(p), renameSync: fs.renameSync, unlinkSync: fs.unlinkSync, copyFileSync: (a, b) => fs.copyFileSync(a, b), writeFileSync: (p, d) => fs.writeFileSync(p, d),
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

posixDescribe('linkEntries: 中身が同じ実ファイル', () => {
  const put = (base: string, name: string, text: string) => fs.writeFileSync(path.join(base, name), text);

  it('実ファイルが共有側と同じ中身なら、make で張り直して created に入れ、何も残さない', () => {
    put(dir, 'config.toml', 'x');
    const r = linkEntries(primary, dir, ['config.toml'], true);
    expect(r).toEqual({ created: ['config.toml'], conflicts: [], unlinked: [] });
    expect(fs.lstatSync(path.join(dir, 'config.toml')).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['config.toml']);
  });

  it('別の先を指すリンクでも、先がファイルで中身が同じなら張り直す', () => {
    put(root, 'other.toml', 'x');
    fs.symlinkSync(path.join(root, 'other.toml'), path.join(dir, 'config.toml'));
    const r = linkEntries(primary, dir, ['config.toml'], true);
    expect(r.created).toEqual(['config.toml']);
    expect(fs.readlinkSync(path.join(dir, 'config.toml'))).toBe(path.join(primary, 'config.toml'));
    expect(fs.readFileSync(path.join(root, 'other.toml'), 'utf8')).toBe('x');
  });

  it('make でないときは、同じ中身なら conflicts に入れず、何も変えない', () => {
    put(dir, 'config.toml', 'x');
    expect(linkEntries(primary, dir, ['config.toml'], false)).toEqual({ created: [], conflicts: [], unlinked: [] });
    expect(fs.lstatSync(path.join(dir, 'config.toml')).isSymbolicLink()).toBe(false);
  });

  it('中身が違えば conflicts のままで、触らない', () => {
    put(dir, 'config.toml', 'y');
    expect(linkEntries(primary, dir, ['config.toml'], true)).toEqual({ created: [], conflicts: ['config.toml'], unlinked: [] });
    expect(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')).toBe('y');
  });

  it('ディレクトリ同士は、中身が同じでも conflicts のまま', () => {
    fs.mkdirSync(path.join(dir, 'skills'));
    expect(linkEntries(primary, dir, ['skills'], true).conflicts).toEqual(['skills']);
  });

  it('リンクが張れなかったら（EPERM）元の実ファイルに戻し、unlinked に挙げる', () => {
    put(dir, 'config.toml', 'x');
    const f = fakeFs({ symlinkSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } });
    const r = linkEntries(primary, dir, ['config.toml'], true, { fs: f.fs });
    expect(r).toEqual({ created: [], conflicts: [], unlinked: ['config.toml'] });
    expect(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')).toBe('x');
    expect(fs.readdirSync(dir)).toEqual(['config.toml']);
  });
});

posixDescribe('fixableConflicts', () => {
  it('両側がファイルの名前だけを挙げる', () => {
    fs.writeFileSync(path.join(dir, 'config.toml'), 'y');
    fs.mkdirSync(path.join(dir, 'skills'));
    expect(fixableConflicts(primary, dir, ['config.toml', 'skills', 'sessions'])).toEqual(['config.toml']);
  });
});

posixDescribe('linkConflictDetail', () => {
  it('両側の中身と時刻と大きさを返す', () => {
    fs.writeFileSync(path.join(dir, 'config.toml'), 'mine!');
    const d = linkConflictDetail(primary, dir, 'config.toml');
    expect(d.name).toBe('config.toml');
    expect(d.kind).toBe('file');
    expect(d.mine).toMatchObject({ text: 'mine!', size: 5 });
    expect(d.shared).toMatchObject({ text: 'x', size: 1 });
    expect(d.mine.mtimeMs).toBeGreaterThan(0);
  });

  it('256KB を超えるか NUL を含むと text は null', () => {
    fs.writeFileSync(path.join(dir, 'config.toml'), Buffer.alloc(256 * 1024 + 1, 97));
    fs.writeFileSync(path.join(primary, 'config.toml'), Buffer.from([97, 0, 98]));
    const d = linkConflictDetail(primary, dir, 'config.toml');
    expect(d.mine.text).toBeNull();
    expect(d.mine.size).toBe(256 * 1024 + 1);
    expect(d.shared.text).toBeNull();
  });

  it('ディレクトリは kind が dir で text が null', () => {
    fs.mkdirSync(path.join(dir, 'skills'));
    expect(linkConflictDetail(primary, dir, 'skills').kind).toBe('dir');
  });

  it('パスの細工の名前は断る', () => {
    expect(() => linkConflictDetail(primary, dir, '../x')).toThrow();
    expect(() => linkConflictDetail(primary, dir, 'a/b')).toThrow();
  });
});

posixDescribe('resolveLinkConflict', () => {
  const now = new Date(2026, 9, 29, 13, 5, 9);
  const stamp = '20261029-130509';

  beforeEach(() => fs.writeFileSync(path.join(dir, 'config.toml'), 'mine'));

  it('shared を残す：手元を .bak-hangar-日時 へ退避してリンクを張る', () => {
    const r = resolveLinkConflict(primary, dir, 'config.toml', 'shared', now);
    const bak = path.join(dir, `config.toml.bak-hangar-${stamp}`);
    expect(r.backup).toBe(bak);
    expect(fs.readFileSync(bak, 'utf8')).toBe('mine');
    expect(fs.readlinkSync(path.join(dir, 'config.toml'))).toBe(path.join(primary, 'config.toml'));
    expect(fs.readFileSync(path.join(primary, 'config.toml'), 'utf8')).toBe('x');
  });

  it('mine を残す：共有側を退避し、手元の中身を共有側に書いてリンクを張る', () => {
    const r = resolveLinkConflict(primary, dir, 'config.toml', 'mine', now);
    const bak = path.join(primary, `config.toml.bak-hangar-${stamp}`);
    expect(r.backup).toBe(bak);
    expect(fs.readFileSync(bak, 'utf8')).toBe('x');
    expect(fs.readFileSync(path.join(primary, 'config.toml'), 'utf8')).toBe('mine');
    expect(fs.lstatSync(path.join(dir, 'config.toml')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')).toBe('mine');
    expect(fs.readdirSync(dir)).toEqual(['config.toml']);
  });

  it('mine を残すとき、共有側がさらに別へのリンクなら、リンクをたどって書く', () => {
    fs.writeFileSync(path.join(root, 'dotfiles.toml'), 'x');
    fs.rmSync(path.join(primary, 'config.toml'));
    fs.symlinkSync(path.join(root, 'dotfiles.toml'), path.join(primary, 'config.toml'));
    resolveLinkConflict(primary, dir, 'config.toml', 'mine', now);
    expect(fs.lstatSync(path.join(primary, 'config.toml')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(root, 'dotfiles.toml'), 'utf8')).toBe('mine');
  });

  it('退避名が既にあれば -2 を付けて重ねない', () => {
    const first = path.join(dir, `config.toml.bak-hangar-${stamp}`);
    fs.writeFileSync(first, 'older');
    const r = resolveLinkConflict(primary, dir, 'config.toml', 'shared', now);
    expect(r.backup).toBe(`${first}-2`);
    expect(fs.readFileSync(first, 'utf8')).toBe('older');
  });

  it('リンクが張れなかったら、手元のファイルを戻して投げる', () => {
    const f = fakeFs({ symlinkSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } });
    expect(() => resolveLinkConflict(primary, dir, 'config.toml', 'shared', now, { fs: f.fs })).toThrow('EPERM');
    expect(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')).toBe('mine');
    expect(fs.readdirSync(dir)).toEqual(['config.toml']);
  });

  it('ディレクトリは断る', () => {
    fs.mkdirSync(path.join(dir, 'skills'));
    expect(() => resolveLinkConflict(primary, dir, 'skills', 'shared', now)).toThrow();
    expect(fs.readdirSync(dir).sort()).toEqual(['config.toml', 'skills']);
  });

  it('パスの細工の名前は断る', () => {
    expect(() => resolveLinkConflict(primary, dir, '../x', 'shared', now)).toThrow();
  });

  it('既に共有へのリンクなら何もしない', () => {
    fs.rmSync(path.join(dir, 'config.toml'));
    fs.symlinkSync(path.join(primary, 'config.toml'), path.join(dir, 'config.toml'));
    expect(resolveLinkConflict(primary, dir, 'config.toml', 'shared', now).backup).toBeNull();
    expect(fs.readdirSync(dir)).toEqual(['config.toml']);
  });
});
