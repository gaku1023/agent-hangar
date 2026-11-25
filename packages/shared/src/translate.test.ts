import { describe, expect, it } from 'vitest';
import { isEnglishText, translateEnglishOf, TRANSLATE_MAX_CHARS } from './translate.ts';

describe('isEnglishText', () => {
  it('英語の文を英語とみなす', () => {
    expect(isEnglishText('I delayed the removal until the next sync, so the row no longer jumps.')).toBe(true);
  });

  it('日本語の文は英語とみなさない', () => {
    expect(isEnglishText('削除を次の同期まで遅らせたので、行がジャンプしなくなりました。')).toBe(false);
  });

  it('コードやパスが英字でも、地の文が日本語なら英語とみなさない', () => {
    expect(isEnglishText('`packages/ui/src/views/Sidebar.tsx` の `usePresence` を直しました。\n```ts\nconst removeRowAfterSync = (row: Row) => row;\n```')).toBe(false);
  });

  it('地の文が英語なら、コードの部分を除いても英語とみなす', () => {
    expect(isEnglishText('I moved the rekey into `applyPeerAsk()` so it runs before the dedupe check.\n```ts\nconst x = 1;\n```')).toBe(true);
  });

  it('短すぎる文（コマンド名だけ、OK だけ）は訳さない', () => {
    expect(isEnglishText('OK')).toBe(false);
    expect(isEnglishText('Done.')).toBe(false);
    expect(isEnglishText('`npm test`')).toBe(false);
  });

  it('英語の中に日本語の語が少し混じっても英語とみなす', () => {
    expect(isEnglishText('The user asked to fix the 「入力待ち」 label overflowing in the sidebar when the window is narrow.')).toBe(true);
  });

  it('上限を超える長さは訳さない', () => {
    expect(isEnglishText('word '.repeat(TRANSLATE_MAX_CHARS / 5 + 10))).toBe(false);
  });
});

describe('translateEnglishOf', () => {
  it('項目が無ければ切として読む', () => {
    expect(translateEnglishOf({})).toBe(false);
    expect(translateEnglishOf({ translateEnglish: true })).toBe(true);
  });
});
