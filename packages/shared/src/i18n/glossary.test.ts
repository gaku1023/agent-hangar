import { describe, expect, it } from 'vitest';
import { en } from './en.ts';
import { ja } from './ja.ts';

/**
 * 用語集（docs/superpowers/specs/2026-10-09-glossary.md の 13 章「使わない語」）のうち、機械で見張れるものを守らせる。
 * 辞書の文に、決めた語の代わりに古い語が残っていたら止める。
 */
const FORBIDDEN_JA: Array<{ pattern: RegExp; use: string }> = [
  { pattern: /会話の記録|生の記録/, use: 'トランスクリプト、詳細表示' },
  { pattern: /控え(?!る)|控えて/, use: 'バックアップ' },
];

/** 「本文」が HTTP やモデルの応答の本体（body）を指す鍵。トランスクリプトの意味では使わない。 */
const BODY_KEYS = /^(http\.request\.|todo\.error\.emptyText$|summary\.lmstudio\.)/;

const entries = (dict: Record<string, string>): Array<[string, string]> => Object.entries(dict);

describe('辞書は用語集の語に合っている', () => {
  it('日本語の文に、使わない語が残っていない', () => {
    const bad: string[] = [];
    for (const [key, text] of entries(ja as Record<string, string>)) {
      for (const f of FORBIDDEN_JA) if (f.pattern.test(text)) bad.push(`${key}: ${f.pattern} は ${f.use}`);
      if (text.includes('本文') && !BODY_KEYS.test(key)) bad.push(`${key}: 本文 は トランスクリプト`);
    }
    expect(bad).toEqual([]);
  });

  it('英語の文に、会話の記録の意味の conversation record が残っていない', () => {
    const bad = entries(en as Record<string, string>).filter(([, text]) => /conversation record/i.test(text)).map(([k]) => k);
    expect(bad).toEqual([]);
  });
});
