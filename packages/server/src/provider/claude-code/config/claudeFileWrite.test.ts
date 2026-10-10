import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireFileLock, LOCK_BUSY_MESSAGE, resolveRealFile, writeFileAtomically } from './claudeFileWrite.ts';
import { expectMode } from '../../../../test/platform.ts';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cfw-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('claudeFileWrite', () => {
  it('リンクを実体まで解く', () => {
    const real = path.join(root, 'real.json');
    fs.writeFileSync(real, '{}');
    const link = path.join(root, 'link.json');
    fs.symlinkSync(real, link);
    expect(resolveRealFile(link)).toBe(fs.realpathSync(real));
  });
  it('一時ファイルから rename し、渡した権限で置く。一時ファイルは残さない', () => {
    const f = path.join(root, 's.json');
    writeFileAtomically(f, '{"a":1}\n', 0o640);
    expect(fs.readFileSync(f, 'utf8')).toBe('{"a":1}\n');
    expectMode(f, 0o640);
    expect(fs.readdirSync(root)).toEqual(['s.json']);
  });
  it('ロックは同時に 1 つだけ取れ、放すとまた取れる', () => {
    const f = path.join(root, 's.json');
    const release = acquireFileLock(f, 50, 10_000);
    expect(() => acquireFileLock(f, 50, 10_000)).toThrow(LOCK_BUSY_MESSAGE);
    release();
    acquireFileLock(f, 50, 10_000)();
  });
});
