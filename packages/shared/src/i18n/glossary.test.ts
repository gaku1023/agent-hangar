import { describe, expect, it } from 'vitest';
import { en } from './en.ts';
import { ja } from './ja.ts';
import { FORBIDDEN_JA } from './forbiddenJa.ts';

/*
 * 用語集（docs/superpowers/specs/2026-10-09-glossary.md の 13 章「使わない語」）のうち、機械で見張れるものを守らせる。
 * 辞書の文に、決めた語の代わりに古い語が残っていたら止める。
 * 見張る語の一覧は forbiddenJa.ts にあり、CLI の文の試験（packages/cli/src/glossary.test.ts）も同じ一覧を使う。
 */

/** 古い語に見えても、用語集が別の意味で認める場所。鍵ごとに理由を添えて、ここだけ外す。 */
const ALLOWED: Record<string, string> = {
  // サーバのポートの話で、セッションの状態ではない。
  'settings.integrations.statusline.port': '動いている（サーバのプロセス）',
  // Claude に頼む指示の文で、検索の操作ではなく「誤りを見つける」の意味。
  'prompt.builtin.codeReview': '探す（誤りを見つける）',
  // Claude に渡す指示の文で、画面には出ない。起動の指示は別の作業が直すため、ここでは外す（2026-10-17）。
  'launch.injection.handover': 'らしい（Claude 向けの指示）',
  // 分割の「外す」は、アプリの操作（分割から外す）の語で、用語集の 20 章に行がある（13 章の「外す」の例外）。この試験は用語集を読まないので、鍵ごとにここで外す。
  'mediator.pane.lastPane': '外す（分割から外す）',
  // 同じ理由（20 章の「分割から外す」）で、ペインの見出しの ✕ の名前。
  'pane.header.remove': '外す（分割から外す）',
  // 同じ理由（20 章の「分割から外す」「ほかのペインを外す」）で、ショートカット一覧とペインの右クリックの項目。「ほかの」は「ほかのペイン」という語の並びで、他の PC を指す語ではない。
  'shortcuts.key.paneRemove': '外す（分割から外す）',
  'pane.menu.closeOthers': '外す、ほかの（ほかのペインを外す）',
};

/** 「本文」が HTTP やモデルの応答の本体（body）を指す鍵。トランスクリプトの意味では使わない。 */
const BODY_KEYS = /^(http\.request\.|todo\.error\.emptyText$|summary\.lmstudio\.)/;

const entries = (dict: Record<string, string>): Array<[string, string]> => Object.entries(dict);

describe('辞書は用語集の語に合っている', () => {
  it('日本語の文に、使わない語が残っていない', () => {
    const bad: string[] = [];
    for (const [key, text] of entries(ja as Record<string, string>)) {
      if (key in ALLOWED) continue;
      for (const f of FORBIDDEN_JA) if (f.pattern.test(text)) bad.push(`${key}: ${f.pattern} は ${f.use}`);
      if (text.includes('本文') && !BODY_KEYS.test(key)) bad.push(`${key}: 本文 は トランスクリプト`);
    }
    expect(bad).toEqual([]);
  });

  it('英語の文に、会話の記録の意味の conversation record が残っていない', () => {
    const bad = entries(en as Record<string, string>).filter(([, text]) => /conversation record/i.test(text)).map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it('英語の文に、使わない語が残っていない', () => {
    const FORBIDDEN_EN: Array<{ pattern: RegExp; use: string }> = [
      { pattern: /take over|taking over|taken over/i, use: 'Move to Hangar' },
      { pattern: /\bdifferences?\b/i, use: 'change' },
      { pattern: /outside terminal/i, use: 'external terminal' },
      { pattern: /Under 1 min/, use: '<1 min' },
      { pattern: /join token/i, use: 'join code' },
      { pattern: /last IP|approximate location/i, use: '(not shown)' },
    ];
    const bad: string[] = [];
    for (const [key, text] of entries(en as Record<string, string>)) {
      for (const f of FORBIDDEN_EN) if (f.pattern.test(text)) bad.push(`${key}: ${f.pattern} は ${f.use}`);
    }
    expect(bad).toEqual([]);
  });
});
