import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { ensureScratchProject, isUnderScratch, newScratchDir, SCRATCH_PROJECT_NAME, scratchRoot } from './scratch.ts';

describe('scratch', () => {
  it('擬似プロジェクトは 1 つだけ作られる', () => {
    const db = openDb(':memory:');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-scr-'));
    const id = ensureScratchProject(db, 'd', home);
    expect(ensureScratchProject(db, 'd', home)).toBe(id);
    const p = db.prepare('select name, is_scratch, status from projects where id = ?').get(id);
    expect(p).toEqual({ name: SCRATCH_PROJECT_NAME, is_scratch: 1, status: 'active' });
    expect(db.prepare('select path, resolved from project_roots where project_id = ? and device_id = ?').get(id, 'd')).toEqual({ path: scratchRoot(home), resolved: 1 });
    expect(fs.existsSync(scratchRoot(home))).toBe(true);
    // 端末が違えば別の行を作る。ルートは端末ごとに 1 つである。
    expect(db.prepare('select count(*) c from projects where is_scratch = 1').get()).toEqual({ c: 1 });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('ディレクトリ名は時刻で、同じ秒は -2 を付ける', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-scr-'));
    const t = new Date(2026, 8, 17, 9, 5, 7);
    const a = newScratchDir(home, t);
    expect(a).toBe(path.join(scratchRoot(home), '20260917-090507'));
    expect(fs.statSync(a).isDirectory()).toBe(true);
    expect(newScratchDir(home, t)).toBe(path.join(scratchRoot(home), '20260917-090507-2'));
    expect(newScratchDir(home, t)).toBe(path.join(scratchRoot(home), '20260917-090507-3'));
    expect(isUnderScratch(home, a)).toBe(true);
    expect(isUnderScratch(home, path.join(a, 'sub'))).toBe(true);
    expect(isUnderScratch(home, scratchRoot(home))).toBe(false);
    expect(isUnderScratch(home, '/elsewhere')).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
