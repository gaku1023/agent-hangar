import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { ensureScratchProject, isUnderScratch, newScratchDir, SCRATCH_PROJECT_NAME, scratchRoot } from './scratch.ts';

let db: Db;
let home: string;

beforeEach(() => {
  db = openDb(':memory:');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-scr-'));
});
// 途中で落ちても一時ディレクトリを置き去りにしない。
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('scratch', () => {
  it('擬似プロジェクトは 1 つだけ作られる', () => {
    const id = ensureScratchProject(db, 'd', home);
    expect(ensureScratchProject(db, 'd', home)).toBe(id);
    const p = db.prepare('select name, is_scratch, status from projects where id = ?').get(id);
    expect(p).toEqual({ name: SCRATCH_PROJECT_NAME, is_scratch: 1, status: 'active' });
    expect(db.prepare('select path, resolved from project_roots where project_id = ? and device_id = ?').get(id, 'd')).toEqual({ path: scratchRoot(home), resolved: 1 });
    expect(fs.existsSync(scratchRoot(home))).toBe(true);
    expect(db.prepare('select count(*) c from projects where is_scratch = 1').get()).toEqual({ c: 1 });
  });

  it('ディレクトリ名は時刻で、同じ秒は -2 を付ける', () => {
    const t = new Date(2026, 8, 17, 9, 5, 7);
    const a = newScratchDir(home, t);
    expect(a).toBe(path.join(scratchRoot(home), '20260917-090507'));
    expect(fs.statSync(a).isDirectory()).toBe(true);
    expect(newScratchDir(home, t)).toBe(path.join(scratchRoot(home), '20260917-090507-2'));
    expect(newScratchDir(home, t)).toBe(path.join(scratchRoot(home), '20260917-090507-3'));
  });

  it('isUnderScratch はルートの下だけを真とし、パスを正規化してから比べる', () => {
    const a = newScratchDir(home, new Date(2026, 8, 17, 9, 5, 7));
    expect(isUnderScratch(home, a)).toBe(true);
    expect(isUnderScratch(home, path.join(a, 'sub'))).toBe(true);
    expect(isUnderScratch(home, scratchRoot(home))).toBe(false);
    expect(isUnderScratch(home, '/elsewhere')).toBe(false);
    // 末尾の区切り、`.`、`..` が混じっても判定は変わらない。
    expect(isUnderScratch(home, a + path.sep)).toBe(true);
    expect(isUnderScratch(home, path.join(a, '.', 'sub', '..'))).toBe(true);
    expect(isUnderScratch(home, path.join(a, '..'))).toBe(false);
    expect(isUnderScratch(home + path.sep, a)).toBe(true);
    // 名前がルートで始まるだけの隣のディレクトリは下ではない。
    expect(isUnderScratch(home, `${scratchRoot(home)}-old`)).toBe(false);
    // 区切りを足しただけのルートはルートのままである。
    expect(isUnderScratch(home, scratchRoot(home) + path.sep)).toBe(false);
    // 正規化していない綴りでも下は下である。
    expect(isUnderScratch(home, `${scratchRoot(home)}${path.sep}${path.sep}sub`)).toBe(true);
  });
});
