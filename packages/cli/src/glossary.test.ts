import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_JA } from '../../shared/src/i18n/forbiddenJa.ts';

/**
 * CLI がユーザーに出す文（console の出力、エラー文、コマンドの説明）に、用語集で使わない語が残っていないかを見張る。
 * 辞書の文の試験（packages/shared/src/i18n/glossary.test.ts）と同じ一覧を、CLI のソースの文字列とテンプレートに当てる。
 * 見るのは、かなか漢字を含む文字列だけである（コメントと試験のファイルは見ない）。
 * 用語集 18 章のとおり、CLI では「端末トークン」も使わない（「端末」は解除の確認の文の中だけ可で、CLI の解除の確認には出さない）。
 */

const SRC = path.dirname(fileURLToPath(import.meta.url));
const JAPANESE = /[぀-ヿ一-鿿]/;

const CLI_ONLY: ReadonlyArray<{ pattern: RegExp; use: string }> = [{ pattern: /端末/, use: 'この PC 用のトークン、この PC の ID' }];

/** 古い語に見えても、用語集が別の意味で認める文。ファイルと文の一部で指し、理由を添える。 */
const ALLOWED: ReadonlyArray<{ file: string; text: string; why: string }> = [
  { file: 'setup.ts', text: 'hangar statusline install', why: 'コマンドの名前で、語ではない' },
  { file: 'membership.ts', text: '参加トークンは廃止されました', why: '0.8.x までの hangar join を打った人に、廃止した語そのものを示して案内する' },
  { file: 'recovery.ts', text: 'リカバリーキーの公開鍵', why: '暗号の用語の「公開鍵」で、キー（リカバリーキー）の言い換えの対象ではない' },
];

function sources(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => f.split(path.sep).join('/'))
    .sort();
}

/** ファイルの中の、かなか漢字を含む文字列とテンプレートの断片。 */
function japaneseTexts(file: string): Array<{ line: number; text: string }> {
  const code = fs.readFileSync(path.join(SRC, file), 'utf8');
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const out: Array<{ line: number; text: string }> = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      if (JAPANESE.test(n.text)) out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: n.text });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('CLI の文は用語集の語に合っている', () => {
  it('ソースの文字列に、使わない語が残っていない', () => {
    const bad: string[] = [];
    const used = new Set<string>();
    for (const file of sources(SRC)) {
      for (const { line, text } of japaneseTexts(file)) {
        const allowed = ALLOWED.find((a) => a.file === file && text.includes(a.text));
        if (allowed) { used.add(`${allowed.file}:${allowed.text}`); continue; }
        for (const f of [...FORBIDDEN_JA, ...CLI_ONLY]) if (f.pattern.test(text)) bad.push(`${file}:${line}: ${f.pattern} は ${f.use}（${text.slice(0, 60)}）`);
      }
    }
    expect(bad).toEqual([]);
    // 許可の一覧に、もう使っていない行を置いたままにしない。
    expect(ALLOWED.filter((a) => !used.has(`${a.file}:${a.text}`)).map((a) => `${a.file}:${a.text}`)).toEqual([]);
  });
});
