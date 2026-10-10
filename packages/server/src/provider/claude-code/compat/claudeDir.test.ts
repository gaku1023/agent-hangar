import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { posixIt } from '../../../../test/platform.ts';
import { ClaudeDirWatch, claudeDirDrifts } from './claudeDir.ts';
import type { Drift } from './types.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cdir-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const entry = (name: string): Drift => ({ contract: 'claude-dir', value: `entry=${name}`, version: null });

describe('claudeDirDrifts', () => {
  // 共有のリンクは symlink で張る。Windows は権限が要るので、リンクを含む試験は飛ばす。
  posixIt('リンクでも、アカウントごとに持つと知っている項目でもないものだけを、名前の順に返す', () => {
    const primary = path.join(tmp, 'primary');
    const dir = path.join(tmp, 'second');
    fs.mkdirSync(primary);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(primary, 'settings.json'), '{}');
    fs.symlinkSync(path.join(primary, 'settings.json'), path.join(dir, 'settings.json'));
    fs.writeFileSync(path.join(dir, '.claude.json'), '{}');
    fs.mkdirSync(path.join(dir, 'cache'));
    fs.writeFileSync(path.join(dir, '.DS_Store'), '');
    // 共有のはずの名前が実体なのは、リンクの問題として別に出す（provider/claude-code/config/accountLinks.ts の linkProblem）。ここでは数えない。
    fs.mkdirSync(path.join(dir, 'skills'));
    fs.mkdirSync(path.join(dir, 'zeta-new'));
    fs.writeFileSync(path.join(dir, 'alpha-new.json'), '{}');
    expect(claudeDirDrifts(dir)).toEqual([entry('alpha-new.json'), entry('zeta-new')]);
  });
  it('読めない置き場は空', () => {
    expect(claudeDirDrifts(path.join(tmp, 'none'))).toEqual([]);
  });
});

describe('ClaudeDirWatch', () => {
  it('同じ名前はサーバの寿命で 1 度だけ知らせる', () => {
    const dir = path.join(tmp, 'second');
    fs.mkdirSync(path.join(dir, 'brand-new'), { recursive: true });
    const seen: Drift[] = [];
    const w = new ClaudeDirWatch({ dirs: () => [dir], sink: { note: (d) => seen.push(d) } });
    w.check();
    w.check();
    expect(seen).toEqual([entry('brand-new')]);
  });
  it('reset() の後は、見た名前を忘れてもう一度知らせる', () => {
    // ずれの記録が手元の版の変化で空になったとき、まだある項目を数え直すために使う。
    const dir = path.join(tmp, 'second');
    fs.mkdirSync(path.join(dir, 'brand-new'), { recursive: true });
    const seen: Drift[] = [];
    const w = new ClaudeDirWatch({ dirs: () => [dir], sink: { note: (d) => seen.push(d) } });
    w.check();
    w.reset();
    w.check();
    w.check();
    expect(seen).toEqual([entry('brand-new'), entry('brand-new')]);
  });
});
