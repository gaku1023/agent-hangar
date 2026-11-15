import { describe, expect, it } from 'vitest';
import { speechText } from './speechText.ts';

describe('speechText', () => {
  it('コードの塊と URL を読まない', () => {
    expect(speechText('見て\n```ts\nconst a = 1;\n```\nhttps://example.com/x を開く')).toBe('見て\nを開く');
  });
  it('太字などの記号を外す', () => {
    expect(speechText('**太字** と *斜体* と `code`')).toBe('太字 と 斜体 と code');
  });
  it('見出し・箇条書き・リンクの記号を外し、リンクは文字だけ読む', () => {
    expect(speechText('# 題\n- 一つ\n- [二つ](https://a.b/c)')).toBe('題\n一つ\n二つ');
  });
});
