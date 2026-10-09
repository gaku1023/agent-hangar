import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * UI のソースに、辞書の鍵へ移っていない日本語の直書きがどれだけ残っているかを、ファイルごとに数える。
 * 数えるのは、文字列、テンプレート、JSX の文のうち、かなか漢字を含むものが始まる行である（コメントと試験は数えない）。
 * 許可の一覧と数が食い違えば落ちる。増やしたときは、辞書へ移すか、理由を添えて一覧に足す。
 * 減らしたときは、一覧から外す。残りを黙って増やさないための歯止めである（サーバ側の `hardcoded.test.ts` と同じ形）。
 * 画面に出る文は、画面の部品（`views`）も、データから作る文（`presenters`）も、辞書から引く。
 */

const SRC = path.dirname(fileURLToPath(import.meta.url));
const JAPANESE = /[぀-ヿ一-鿿]/;

/** ファイル（ui/src からの相対）ごとの、直書きの日本語の行の数と、残す理由。 */
const ALLOWED: Record<string, { lines: number; why: string }> = {};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'test' || e.name === 'node_modules' ? [] : sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

function japaneseLines(file: string): number {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = new Set<number>();
  const visit = (n: ts.Node): void => {
    const literal = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n);
    if (literal && JAPANESE.test(n.text)) lines.add(sf.getLineAndCharacterOfPosition(n.getStart()).line);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines.size;
}

describe('UI に残る日本語の直書き', () => {
  const actual: Record<string, number> = {};
  for (const file of sourceFiles(SRC)) {
    const n = japaneseLines(file);
    if (n > 0) actual[path.relative(SRC, file)] = n;
  }

  it('ファイルごとの行数が、許可の一覧と同じである', () => {
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([f, a]) => [f, a.lines]));
    expect(actual).toEqual(expected);
  });

  it('許可の一覧の理由は、どれも書いてある', () => {
    for (const [file, a] of Object.entries(ALLOWED)) expect([file, a.why.trim() !== '']).toEqual([file, true]);
  });

  it('走査は、文字列、テンプレート、JSX の文を見つけ、コメントは数えない', () => {
    // 走査が何も見つけなくなっても、上の試験は黙って通ってしまう。見つけることを、自分で確かめる。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hardcoded-'));
    try {
      const file = path.join(dir, 'sample.tsx');
      fs.writeFileSync(file, ['// 注釈の日本語は数えない', 'const a = "文字列";', 'const b = `テンプレート ${a}`;', 'export const c = () => <b>JSX の文</b>;', "const d = 'english';"].join('\n'));
      expect(japaneseLines(file)).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
