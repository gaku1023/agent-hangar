import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectMode, posixIt } from '../../../../test/platform.ts';
import { ACCOUNT_LINK_GROUPS } from '@agent-hangar/shared';
import { LINKED_ENTRIES, ensureAccountLinks, inspectAccountLinks, linkProblem } from './accountLinks.ts';

let root: string;
let primary: string;
let dir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-links-'));
  primary = path.join(root, '.claude');
  dir = path.join(root, '.claude-2');
  fs.mkdirSync(path.join(primary, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(primary, 'skills'));
  fs.writeFileSync(path.join(primary, 'settings.json'), '{"theme":"dark"}');
  fs.writeFileSync(path.join(primary, '.claude.json'), '{}');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('ensureAccountLinks', () => {
  it('17 個を決まった順で持つ', () => {
    expect(LINKED_ENTRIES).toHaveLength(17);
    expect(LINKED_ENTRIES.slice(0, 4)).toEqual(['CLAUDE.md', 'settings.json', 'statusline-command.sh', 'history.jsonl']);
    expect(LINKED_ENTRIES).not.toContain('.claude.json');
  });

  // Windows の symlink は管理者権限か開発者モードが要るので、Unix だけで確かめる（リンクを張る道は、アカウントを足したときだけ通る）。
  posixIt('置き場を 0700 で作り、最初の置き場にある項目だけをリンクにする', () => {
    const r = ensureAccountLinks(primary, dir);
    expect(r).toEqual({ created: ['settings.json', 'skills', 'projects'], conflicts: [], unlinked: [] });
    expectMode(dir, 0o700);
    expect(fs.readlinkSync(path.join(dir, 'projects'))).toBe(path.join(primary, 'projects'));
    expect(fs.existsSync(path.join(dir, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.claude.json'))).toBe(false);
  });

  posixIt('二度目は何も作らない。あとから最初の置き場に増えた項目は足す', () => {
    ensureAccountLinks(primary, dir);
    expect(ensureAccountLinks(primary, dir)).toEqual({ created: [], conflicts: [], unlinked: [] });
    fs.writeFileSync(path.join(primary, 'CLAUDE.md'), '# x');
    expect(ensureAccountLinks(primary, dir).created).toEqual(['CLAUDE.md']);
  });

  posixIt('実ファイル、実ディレクトリ、別の先を指すリンクは、消さずに conflicts に挙げる', () => {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"mine":1}');
    fs.mkdirSync(path.join(dir, 'skills'));
    fs.symlinkSync('/somewhere/else', path.join(dir, 'projects'));
    const r = ensureAccountLinks(primary, dir);
    expect(r).toEqual({ created: [], conflicts: ['settings.json', 'skills', 'projects'], unlinked: [] });
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).toBe('{"mine":1}');
    expect(fs.readlinkSync(path.join(dir, 'projects'))).toBe('/somewhere/else');
  });

  posixIt('Windows で張れない項目があっても投げず、残りを張って unlinked に挙げる', () => {
    const eperm = (): never => { throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' }); };
    const r = ensureAccountLinks(primary, dir, {
      platform: 'win32',
      fs: { existsSync: fs.existsSync, lstatSync: fs.lstatSync, statSync: fs.statSync, readlinkSync: (p) => fs.readlinkSync(p),
        symlinkSync: (t, l, type) => (type === 'junction' ? fs.symlinkSync(t, l) : eperm()) },
    });
    expect(r).toEqual({ created: ['skills', 'projects'], conflicts: [], unlinked: ['settings.json'] });
  });

  it('最初の置き場そのものを渡したら何もしない', () => {
    expect(ensureAccountLinks(primary, path.join(primary, '.'))).toEqual({ created: [], conflicts: [], unlinked: [] });
    expect(fs.lstatSync(path.join(primary, 'projects')).isSymbolicLink()).toBe(false);
  });

  it('conflicts を文にする', () => {
    expect(linkProblem([])).toBeNull();
    expect(linkProblem(['settings.json', 'skills'])).toBe('設定ディレクトリの settings.json、skills が共有のリンクではありません。中身を確認して、不要なら削除してください');
  });
});

describe('inspectAccountLinks', () => {
  it('画面に見せる組（ACCOUNT_LINK_GROUPS）は、リンクにする 17 個をちょうど 1 回ずつ持つ', () => {
    const all = ACCOUNT_LINK_GROUPS.flatMap((g) => g.entries);
    expect([...all].sort()).toEqual([...LINKED_ENTRIES].sort());
    expect(new Set(all).size).toBe(all.length);
  });
  it('まだ無い場所は、無いと答え、何も作らない', () => {
    expect(inspectAccountLinks(primary, dir)).toEqual({ exists: false, conflicts: [] });
    expect(fs.existsSync(dir)).toBe(false);
  });
  it('既にある場所に、同じ名前の実ファイルや実フォルダがあれば挙げる。触らない', () => {
    fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
    // 最初の場所に無い項目は、リンクを張らないので挙げない。
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'x');
    expect(inspectAccountLinks(primary, dir)).toEqual({ exists: true, conflicts: ['settings.json', 'skills'] });
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).toBe('{}');
    expect(fs.existsSync(path.join(dir, 'projects'))).toBe(false);
  });
  posixIt('正しい先を指すリンクは挙げない', () => {
    ensureAccountLinks(primary, dir);
    expect(inspectAccountLinks(primary, dir)).toEqual({ exists: true, conflicts: [] });
  });
  it('最初の場所そのものは、問題なしとする', () => {
    expect(inspectAccountLinks(primary, primary)).toEqual({ exists: true, conflicts: [] });
  });
});
