import { describe, expect, it } from 'vitest';
import { translatorOf } from '../../i18n/message.ts';
import { configAttentionText } from './attentionText.ts';

describe('configAttentionText', () => {
  const ja = translatorOf(() => 'ja');
  const en = translatorOf(() => 'en');

  it('新しく出た分だけを 1 行ずつ書く', () => {
    expect(configAttentionText(ja, { asks: 2, conflicts: 0, autoFailed: false })).toBe('確認が必要な設定が 2 件あります');
    expect(configAttentionText(ja, { asks: 0, conflicts: 1, autoFailed: true })).toBe('設定の競合が 1 件あります\n設定の自動適用に失敗しました');
  });

  it('英語でも組める', () => {
    expect(configAttentionText(en, { asks: 1, conflicts: 0, autoFailed: false })).toBe('1 settings need confirmation');
  });
});
