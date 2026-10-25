import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectMode } from '../../test/platform.ts';
import { pruneSecretEnvs, removeSecretEnv, SECRET_ENV_DIR, secretEnvBody, secretEnvPath, writeSecretEnv } from './secretEnv.ts';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-secret-env-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('secretEnvBody', () => {
  it('1 行に 1 つ、名前=値 の形で書く', () => {
    expect(secretEnvBody({ OPENCODE_PASSWORD: 'p a=ss', B_2: '' })).toBe('OPENCODE_PASSWORD=p a=ss\nB_2=\n');
  });
  // 包みは 1 行ずつ読んで export するので、改行の入った値は割れて別の変数になる。名前に変な文字が入れば export が誤る。
  it('名前に使えない文字と、改行や NUL の入った値は断る', () => {
    expect(() => secretEnvBody({ 'A-B': 'x' })).toThrow();
    expect(() => secretEnvBody({ '1A': 'x' })).toThrow();
    expect(() => secretEnvBody({ A: 'x\ny' })).toThrow();
    expect(() => secretEnvBody({ A: 'x\ry' })).toThrow();
    expect(() => secretEnvBody({ A: 'x\0y' })).toThrow();
  });
});

describe('writeSecretEnv', () => {
  it('<home>/run-env/<runId>.env に 0600 で書き、置き場は 0700 にする', () => {
    const file = writeSecretEnv(home, 'run1', { OPENCODE_PASSWORD: 'secret' });
    expect(file).toBe(path.join(home, SECRET_ENV_DIR, 'run1.env'));
    expect(file).toBe(secretEnvPath(home, 'run1'));
    expect(fs.readFileSync(file, 'utf8')).toBe('OPENCODE_PASSWORD=secret\n');
    expectMode(file, 0o600);
    expectMode(path.dirname(file), 0o700);
  });
  it('既にあるファイルと置き場の権限も絞り直す', () => {
    const dir = path.join(home, SECRET_ENV_DIR);
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(path.join(dir, 'run1.env'), 'old', { mode: 0o644 });
    const file = writeSecretEnv(home, 'run1', { A: 'new' });
    expect(fs.readFileSync(file, 'utf8')).toBe('A=new\n');
    expectMode(file, 0o600);
    expectMode(dir, 0o700);
  });
  it('ファイル名に使えない run の ID は断る', () => {
    expect(() => secretEnvPath(home, '../x')).toThrow();
    expect(() => writeSecretEnv(home, 'a/b', { A: 'x' })).toThrow();
  });
});

describe('removeSecretEnv と pruneSecretEnvs', () => {
  it('その run のファイルを消す。無くても投げない', () => {
    const file = writeSecretEnv(home, 'run1', { A: 'x' });
    removeSecretEnv(home, 'run1');
    expect(fs.existsSync(file)).toBe(false);
    expect(() => removeSecretEnv(home, 'run1')).not.toThrow();
  });
  it('生きている run のもの以外を消し、関係の無いファイルには触らない。置き場が無くても投げない', () => {
    expect(pruneSecretEnvs(home, [])).toEqual([]);
    writeSecretEnv(home, 'alive', { A: 'x' });
    writeSecretEnv(home, 'gone', { A: 'x' });
    fs.writeFileSync(path.join(home, SECRET_ENV_DIR, 'note.txt'), 'x');
    expect(pruneSecretEnvs(home, ['alive'])).toEqual(['gone.env']);
    expect(fs.readdirSync(path.join(home, SECRET_ENV_DIR)).sort()).toEqual(['alive.env', 'note.txt']);
  });
});
