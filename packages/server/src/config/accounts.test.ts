import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectMode } from '../../test/platform.ts';
import { AccountError, AccountStore, PRIMARY_ACCOUNT_ID } from './accounts.ts';

let home: string;
let homeDir: string;
let primaryDir: string;
const make = () => new AccountStore({ home, primaryDir, homeDir });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-acct-home-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-acct-user-'));
  primaryDir = path.join(homeDir, '.claude');
  fs.mkdirSync(primaryDir);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('AccountStore', () => {
  it('ファイルが無ければ、最初のアカウントだけがあり、それがいまのアカウント', () => {
    const s = make();
    expect(s.list().map((a) => [a.id, a.dir])).toEqual([[PRIMARY_ACCOUNT_ID, primaryDir]]);
    expect(s.current().id).toBe(PRIMARY_ACCOUNT_ID);
    expect(fs.existsSync(path.join(home, 'accounts.json'))).toBe(false);
  });

  it('追加すると ~/.claude-2 から空いている連番の置き場を割り当て、色は使っていないものを選び、0600 で保存する', () => {
    fs.mkdirSync(path.join(homeDir, '.claude-2'));
    const s = make();
    const a = s.add({ name: '大学' });
    expect(a.dir).toBe(path.join(homeDir, '.claude-3'));
    expect(a.color).not.toBe(s.primary().color);
    expectMode(path.join(home, 'accounts.json'), 0o600);
    expect(make().list().map((x) => x.name)).toEqual([s.primary().name, '大学']);
  });

  it('既にある置き場を名指しで登録できる。相対パス、最初の置き場、登録済みの置き場は断る', () => {
    const s = make();
    const dir = path.join(homeDir, '.claude-univ');
    expect(s.add({ name: '大学', dir }).dir).toBe(dir);
    expect(() => s.add({ name: 'x', dir: 'relative' })).toThrow(AccountError);
    expect(() => s.add({ name: 'y', dir: primaryDir })).toThrow(AccountError);
    expect(() => s.add({ name: 'z', dir: dir + '/' })).toThrow(AccountError);
  });

  it('名前は前後の空白を落とし、空・41 字以上・重複を断る', () => {
    const s = make();
    expect(s.add({ name: '  大学  ' }).name).toBe('大学');
    expect(() => s.add({ name: '   ' })).toThrow(AccountError);
    expect(() => s.add({ name: 'あ'.repeat(41) })).toThrow(AccountError);
    expect(() => s.add({ name: '大学' })).toThrow(AccountError);
  });

  it('いまのアカウントを変えて覚える。知らない id は 404', () => {
    const s = make();
    const a = s.add({ name: '大学' });
    s.setCurrent(a.id);
    expect(make().current().id).toBe(a.id);
    expect(() => s.setCurrent('nope')).toThrow(AccountError);
  });

  it('消すと、いまのアカウントだったときは最初のアカウントに戻る。置き場は消さない。最初のアカウントは消せない', () => {
    const s = make();
    const a = s.add({ name: '大学' });
    fs.mkdirSync(a.dir);
    s.setCurrent(a.id);
    s.remove(a.id);
    expect(s.current().id).toBe(PRIMARY_ACCOUNT_ID);
    expect(fs.existsSync(a.dir)).toBe(true);
    expect(() => s.remove(PRIMARY_ACCOUNT_ID)).toThrow(AccountError);
  });

  it('壊れたファイルと、消えた id を指す currentId は、最初のアカウントに落とす', () => {
    fs.writeFileSync(path.join(home, 'accounts.json'), '{ not json');
    expect(make().current().id).toBe(PRIMARY_ACCOUNT_ID);
    fs.writeFileSync(path.join(home, 'accounts.json'), JSON.stringify({ currentId: 'gone', accounts: [{ id: 'a1', name: '大学', dir: path.join(homeDir, '.claude-2'), color: '#7a4a9e' }, { id: 5 }] }));
    const s = make();
    expect(s.current().id).toBe(PRIMARY_ACCOUNT_ID);
    expect(s.list().map((a) => a.id)).toEqual([PRIMARY_ACCOUNT_ID, 'a1']);
  });

  it('置き場からアカウントを引く。末尾の / と . は無視する', () => {
    const s = make();
    const a = s.add({ name: '大学' });
    expect(s.byDir(a.dir + '/')?.id).toBe(a.id);
    expect(s.byDir(path.join(primaryDir, '.'))?.id).toBe(PRIMARY_ACCOUNT_ID);
    expect(s.byDir('/nowhere')).toBeNull();
  });

  it('名前と色を変えられる。最初のアカウントの名前も変えられる', () => {
    const s = make();
    expect(s.update(PRIMARY_ACCOUNT_ID, { name: '会社' }).name).toBe('会社');
    expect(make().primary().name).toBe('会社');
    expect(() => s.update(PRIMARY_ACCOUNT_ID, { color: 'red' })).toThrow(AccountError);
  });
});
