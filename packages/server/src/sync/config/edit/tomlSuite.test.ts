import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseToml } from './tomlParse.ts';

/**
 * toml-test（TOML 1.0 の valid と invalid）を自前の読み手に当てる。
 * 試験集は test/fixtures/toml-test-1.0.0.json に束ねてある（scripts/vendor-toml-test.mjs、MIT）。
 * 対応は 1.0 まで。1.1 の \e と \xHH は断る（valid に入れていない）。
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

describe('toml-test 1.0（invalid は断る）', () => {
  for (const [name, src] of Object.entries(suite.invalid)) {
    it(name, () => {
      expect(() => parseToml(text(src))).toThrow();
    });
  }
});

describe('1.1 の書き方は断る', () => {
  it('\\e と \\xHH', () => {
    expect(() => parseToml('a = "\\e"\n')).toThrow();
    expect(() => parseToml('a = "\\x41"\n')).toThrow();
  });
});
