import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseToml } from './tomlParse.ts';

/**
 * toml-test（TOML 1.0 の valid と invalid）を自前の読み手に当てる。
 * 試験集は test/fixtures/toml-test-1.0.0.json に束ねてある（scripts/vendor-toml-test.mjs、MIT）。
 * 値として壊れているものは断る。1.0 では不正でも 1.1 で正しくなった書き方は受ける（下の ACCEPTED_1_1）。
 * 利用者が Codex の config.toml に手で書いた設定を、hangar が読めなくなるほうが害が大きいため。
 */
interface Suite { valid: Record<string, string>; invalid: Record<string, string> }
const suite = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/toml-test-1.0.0.json', import.meta.url), 'utf8')) as Suite;
// ファイルの中身は latin1 で束ねてあるので、元のバイト列から UTF-8 に戻す。
const text = (s: string): string => Buffer.from(s, 'latin1').toString('utf8');

describe('toml-test 1.0（valid は読める）', () => {
  for (const [name, src] of Object.entries(suite.valid)) {
    it(name, () => {
      expect(() => parseToml(text(src))).not.toThrow();
    });
  }
});

/** invalid のうち、TOML 1.1 では正しくなった書き方。受ける。 */
const ACCEPTED_1_1 = new Set<string>([
  'inline-table/linebreak-01.toml',
  'inline-table/linebreak-02.toml',
  'inline-table/linebreak-03.toml',
  'inline-table/linebreak-04.toml',
  'inline-table/trailing-comma.toml',
  'string/basic-byte-escapes.toml',
]);

describe('toml-test 1.0（invalid は断る。1.1 で正しいものは受ける）', () => {
  for (const [name, src] of Object.entries(suite.invalid)) {
    it(name, () => {
      if (ACCEPTED_1_1.has(name)) expect(() => parseToml(text(src))).not.toThrow();
      else expect(() => parseToml(text(src))).toThrow();
    });
  }
});

describe('1.1 の書き方は受ける', () => {
  it('\\e と \\xHH', () => {
    expect(parseToml('a = "\\e"\n').tree.a).toBe('\u001b');
    expect(parseToml('a = "\\x41"\n').tree.a).toBe('A');
    expect(() => parseToml('a = "\\xZZ"\n')).toThrow();
  });
  it('インライン表の改行と末尾のカンマ', () => {
    expect(parseToml('a = {\n  b = 1, # c\n  d = 2,\n}\n').tree.a).toEqual({ b: 1, d: 2 });
  });
});
