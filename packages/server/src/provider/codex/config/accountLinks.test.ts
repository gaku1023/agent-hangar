import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectMode, posixIt } from '../../../../test/platform.ts';
import { CODEX_ACCOUNT_LINK_GROUPS } from '@agent-hangar/shared';
import { CODEX_LINKED_ENTRIES, ensureCodexAccountLinks, inspectCodexAccountLinks } from './accountLinks.ts';

let root: string;
let primary: string;
let dir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-codex-links-'));
  primary = path.join(root, '.codex');
  dir = path.join(root, '.codex-work');
  fs.mkdirSync(path.join(primary, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(primary, 'skills'));
  fs.writeFileSync(path.join(primary, 'config.toml'), 'model = "x"');
  fs.writeFileSync(path.join(primary, 'auth.json'), '{}');
  fs.writeFileSync(path.join(primary, 'installation_id'), 'id');
  fs.mkdirSync(path.join(primary, 'logs'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('ensureCodexAccountLinks', () => {
  it('画面に見せる組（CODEX_ACCOUNT_LINK_GROUPS）は、リンクにする 10 個をちょうど 1 回ずつ持つ', () => {
    const all = CODEX_ACCOUNT_LINK_GROUPS.flatMap((g) => g.entries);
    expect([...all].sort()).toEqual([...CODEX_LINKED_ENTRIES].sort());
    expect(new Set(all).size).toBe(all.length);
    expect(CODEX_LINKED_ENTRIES).toHaveLength(10);
    for (const n of ['auth.json', 'installation_id', 'logs', 'tmp', 'version.json']) expect(CODEX_LINKED_ENTRIES).not.toContain(n);
  });

  // A1
  posixIt('置き場を 0700 で作り、共有の項目だけをリンクにする。分ける項目は作らない', () => {
    const r = ensureCodexAccountLinks(primary, dir);
    expect(r).toEqual({ created: ['config.toml', 'skills', 'sessions'], conflicts: [], unlinked: [] });
    expectMode(dir, 0o700);
    expect(fs.readlinkSync(path.join(dir, 'sessions'))).toBe(path.join(primary, 'sessions'));
    for (const n of ['auth.json', 'installation_id', 'logs']) expect(fs.existsSync(path.join(dir, n))).toBe(false);
  });

  posixIt('二度目は何も作らない。あとから増えた項目は足す', () => {
    ensureCodexAccountLinks(primary, dir);
    expect(ensureCodexAccountLinks(primary, dir)).toEqual({ created: [], conflicts: [], unlinked: [] });
    fs.writeFileSync(path.join(primary, 'AGENTS.md'), '# x');
    expect(ensureCodexAccountLinks(primary, dir).created).toEqual(['AGENTS.md']);
  });

  posixIt('実ファイル、実ディレクトリ、別の先を指すリンクは、消さずに conflicts に挙げる', () => {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'config.toml'), 'mine');
    fs.mkdirSync(path.join(dir, 'skills'));
    fs.symlinkSync('/somewhere/else', path.join(dir, 'sessions'));
    const r = ensureCodexAccountLinks(primary, dir);
    expect(r).toEqual({ created: [], conflicts: ['config.toml', 'skills', 'sessions'], unlinked: [] });
    expect(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')).toBe('mine');
    expect(fs.readlinkSync(path.join(dir, 'sessions'))).toBe('/somewhere/else');
  });

  posixIt('Windows で張れない項目があっても投げず、残りを張って unlinked に挙げる', () => {
    const eperm = (): never => { throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' }); };
    const r = ensureCodexAccountLinks(primary, dir, {
      platform: 'win32',
      fs: { existsSync: fs.existsSync, lstatSync: fs.lstatSync, statSync: fs.statSync, readlinkSync: (p) => fs.readlinkSync(p),
        symlinkSync: (t, l, type) => (type === 'junction' ? fs.symlinkSync(t, l) : eperm()) },
    });
    expect(r).toEqual({ created: ['skills', 'sessions'], conflicts: [], unlinked: ['config.toml'] });
  });

  it('最初の置き場そのものを渡したら何もしない', () => {
    expect(ensureCodexAccountLinks(primary, path.join(primary, '.'))).toEqual({ created: [], conflicts: [], unlinked: [] });
    expect(fs.lstatSync(path.join(primary, 'sessions')).isSymbolicLink()).toBe(false);
  });
});

describe('inspectCodexAccountLinks', () => {
  it('まだ無い場所は、無いと答え、何も作らない', () => {
    expect(inspectCodexAccountLinks(primary, dir)).toEqual({ exists: false, conflicts: [] });
    expect(fs.existsSync(dir)).toBe(false);
  });
  it('同じ名前の実ファイルや実フォルダがあれば挙げる。触らない', () => {
    fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.toml'), '');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'x');
    expect(inspectCodexAccountLinks(primary, dir)).toEqual({ exists: true, conflicts: ['config.toml', 'skills'] });
    expect(fs.existsSync(path.join(dir, 'sessions'))).toBe(false);
  });
  posixIt('正しい先を指すリンクは挙げない', () => {
    ensureCodexAccountLinks(primary, dir);
    expect(inspectCodexAccountLinks(primary, dir)).toEqual({ exists: true, conflicts: [] });
  });
  it('最初の置き場そのものは、問題なしとする', () => {
    expect(inspectCodexAccountLinks(primary, primary)).toEqual({ exists: true, conflicts: [] });
  });
});
