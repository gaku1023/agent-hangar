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

/**
 * invalid のうち、いまの読み手が通してしまう入力（日付の範囲、制御文字、16 進などの数の末尾の _ など）。
 * 設定ファイルの同期は読めるものを読めば足りるので、断らなくてよいものとして控える。
 * 断るように直したら、この表から外す（下の試験が、まだ通る入力だけがここに残るよう見張る）。
 * 1.1 で許される書き方（インライン表の改行と末尾のカンマ、秒の省略）もここに入る。
 */
const LENIENT = new Set([
  'control/bare-cr.toml',
  'control/comment-cr.toml',
  'control/comment-del.toml',
  'control/comment-ff.toml',
  'control/comment-lf.toml',
  'control/comment-null.toml',
  'control/comment-us.toml',
  'control/multi-del.toml',
  'control/multi-lf.toml',
  'control/multi-null.toml',
  'control/multi-us.toml',
  'control/rawmulti-del.toml',
  'control/rawmulti-lf.toml',
  'control/rawmulti-null.toml',
  'control/rawmulti-us.toml',
  'control/rawstring-cr.toml',
  'control/rawstring-del.toml',
  'control/rawstring-lf.toml',
  'control/rawstring-null.toml',
  'control/rawstring-us.toml',
  'control/string-bs.toml',
  'control/string-cr.toml',
  'control/string-del.toml',
  'control/string-lf.toml',
  'control/string-null.toml',
  'control/string-us.toml',
  'datetime/day-zero.toml',
  'datetime/feb-29.toml',
  'datetime/feb-30.toml',
  'datetime/hour-over.toml',
  'datetime/mday-over.toml',
  'datetime/mday-under.toml',
  'datetime/minute-over.toml',
  'datetime/month-over.toml',
  'datetime/month-under.toml',
  'datetime/no-secs.toml',
  'datetime/offset-overflow-hour.toml',
  'datetime/offset-overflow-minute.toml',
  'datetime/second-over.toml',
  'encoding/bad-codepoint.toml',
  'encoding/bad-utf8-in-comment.toml',
  'encoding/bad-utf8-in-multiline.toml',
  'encoding/bad-utf8-in-multiline-literal.toml',
  'encoding/bad-utf8-in-string.toml',
  'encoding/bad-utf8-in-string-literal.toml',
  'inline-table/linebreak-01.toml',
  'inline-table/linebreak-02.toml',
  'inline-table/linebreak-03.toml',
  'inline-table/linebreak-04.toml',
  'inline-table/trailing-comma.toml',
  'integer/trailing-us-bin.toml',
  'integer/trailing-us-hex.toml',
  'integer/trailing-us-oct.toml',
  'integer/us-after-bin.toml',
  'integer/us-after-hex.toml',
  'integer/us-after-oct.toml',
  'local-date/feb-29.toml',
  'local-date/feb-30.toml',
  'local-date/mday-over.toml',
  'local-date/mday-under.toml',
  'local-date/month-over.toml',
  'local-date/month-under.toml',
  'local-datetime/feb-29.toml',
  'local-datetime/feb-30.toml',
  'local-datetime/hour-over.toml',
  'local-datetime/mday-over.toml',
  'local-datetime/mday-under.toml',
  'local-datetime/minute-over.toml',
  'local-datetime/month-over.toml',
  'local-datetime/month-under.toml',
  'local-datetime/no-secs.toml',
  'local-datetime/second-over.toml',
  'local-time/hour-over.toml',
  'local-time/minute-over.toml',
  'local-time/no-secs.toml',
  'local-time/second-over.toml',
]);

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
      if (LENIENT.has(name)) expect(() => parseToml(text(src))).not.toThrow();
      else expect(() => parseToml(text(src))).toThrow();
    });
  }
});

describe('1.1 の書き方は断る', () => {
  it('\\e と \\xHH', () => {
    expect(() => parseToml('a = "\\e"\n')).toThrow();
    expect(() => parseToml('a = "\\x41"\n')).toThrow();
  });
});
