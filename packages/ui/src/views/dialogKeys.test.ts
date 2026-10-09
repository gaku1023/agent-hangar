import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ダイアログ類の文は、辞書の鍵で書く。
 * 対象のソースに、日本語の直書きが残っていないことを見る（注釈は数えない）。
 */
const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'views/ConfirmDialog.tsx',
  'views/PauseDialog.tsx',
  'views/PromoteDialog.tsx',
  'views/NewProjectDialog.tsx',
  'views/RetentionDialog.tsx',
  'views/ShortcutsDialog.tsx',
  'views/AccountSwitcher.tsx',
  'presenters/confirm.ts',
  'presenters/pause.ts',
  'presenters/promote.ts',
  'presenters/newProject.ts',
  'presenters/retentionDialog.ts',
  'keys.ts',
];
const JAPANESE = /[぀-ヿ㐀-鿿＀-￯]/;

/** 注釈（ブロック、行末、JSX の中のブロック）を空にして、コードの文字列と JSX の文だけを残す。 */
const withoutComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');

describe('ダイアログ類の日本語の直書き', () => {
  for (const file of FILES) {
    it(`${file} に、日本語の直書きが残っていない`, () => {
      const lines = withoutComments(readFileSync(join(src, file), 'utf8')).split('\n').filter((l) => JAPANESE.test(l));
      expect(lines).toEqual([]);
    });
  }
});
