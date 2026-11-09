import { describe, expect, it } from 'vitest';
import { en } from './en.ts';
import { ja } from './ja.ts';

/*
 * 報告の下書きの道具の説明を、外への通信の実際に合わせる（issue #615）。
 * 下書きの段で、重なる issue を探すために題名の語を GitHub の検索に送っている。
 * 「何も送らない」とは書かず、issue を作らないことだけを書く。
 */
describe('報告の下書きの道具の説明', () => {
  it('日本語は GitHub の検索に送ることを書き、何も送らないとは書かない', () => {
    const s = ja['report.tool.draft'];
    expect(s).not.toContain('これだけでは送らない');
    expect(s).toContain('GitHub の検索');
    expect(s).toContain('issue は作らない');
  });
  it('英語は GitHub search に送ることを書き、sends nothing とは書かない', () => {
    const s = en['report.tool.draft'];
    expect(s).not.toMatch(/sends nothing/i);
    expect(s).toMatch(/GitHub search/);
    expect(s).toMatch(/does not create an issue/i);
  });
});
