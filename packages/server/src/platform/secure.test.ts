import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { posixIt } from '../../test/platform.ts';
import { ensureMode, hasMode, isLoose, modeOf } from './secure.ts';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-secure-'));
  file = path.join(dir, 'token');
  fs.writeFileSync(file, 'x', { mode: 0o644 });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('Windows の扱い', () => {
  // Node は Windows でモードを 0666 か 0444 としか返さない。比べると常に「緩い」になるので、比べない。
  it('モードを読まず、緩いとも言わず、直しもしない', () => {
    expect(modeOf(file, 'win32')).toBeNull();
    expect(isLoose(file, 'win32')).toBe(false);
    expect(hasMode(file, 0o600, 'win32')).toBe(true);
    const before = fs.statSync(file).mode;
    ensureMode(file, 0o600, 'win32');
    expect(fs.statSync(file).mode).toBe(before);
  });
  it('無いファイルは、モードが合っているとは言わない', () => {
    expect(hasMode(path.join(dir, 'nope'), 0o600, 'win32')).toBe(false);
    expect(modeOf(path.join(dir, 'nope'), 'win32')).toBeNull();
  });
});

describe('macOS と Linux の扱い', () => {
  posixIt('モードを読み、緩ければ直す', () => {
    expect(modeOf(file)).toBe(0o644);
    expect(isLoose(file)).toBe(true);
    expect(hasMode(file, 0o600)).toBe(false);
    ensureMode(file, 0o600);
    expect(modeOf(file)).toBe(0o600);
    expect(isLoose(file)).toBe(false);
    expect(hasMode(file, 0o600)).toBe(true);
  });
  posixIt('無いファイルは null と false を返し、投げない', () => {
    const nope = path.join(dir, 'nope');
    expect(modeOf(nope)).toBeNull();
    expect(isLoose(nope)).toBe(false);
    expect(hasMode(nope, 0o600)).toBe(false);
    expect(() => ensureMode(nope, 0o600)).not.toThrow();
  });
});
