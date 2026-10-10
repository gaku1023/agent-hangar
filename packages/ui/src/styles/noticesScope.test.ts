import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('./', import.meta.url);
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
/** 選択子の先頭の class（部品の名前）。`.prow .p-t` なら prow。後ろの class は共通の部品（.icon、.btn など）を指すので数えない。 */
const classesOf = (css: string) => new Set([...strip(css).replace(/\{[^{}]*\}/g, '{}').split(/[{},]/).map((sel) => /^\s*\.([A-Za-z_][\w-]*)/.exec(sel)?.[1]).filter((c): c is string => c !== undefined)]);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.css'));

// ベルの一覧の行に .prow を使い、プロジェクトの一覧の行（rows.css の .prow、高さ 40px の格子）と規則が重なって、行が潰れた（PR 29 の実画面で見つけた）。
// 画面に付けると別の画面の部品と同じ頁に載るので、notices.css が決めた名前は、ほかの css が使わない名前にする。
describe('notices.css の名前', () => {
  const mine = classesOf(fs.readFileSync(new URL('notices.css', dir), 'utf8'));
  it('ベルの一覧の部品が使う名前は、ほかの css に現れない', () => {
    expect(mine.size).toBeGreaterThan(0);
    for (const f of files.filter((f) => f !== 'notices.css')) {
      const theirs = classesOf(fs.readFileSync(new URL(f, dir), 'utf8'));
      const clash = [...mine].filter((c) => theirs.has(c));
      expect(clash, f).toEqual([]);
    }
  });
});
