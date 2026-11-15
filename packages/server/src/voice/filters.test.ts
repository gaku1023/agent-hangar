import { describe, expect, it } from 'vitest';
import { dropReason } from './filters.ts';

const ctx = { hints: ['hangar', 'vitest', 'Sonnet'], inWindow: false };

describe('dropReason', () => {
  it('-46 dBFS は quiet、-44 は通る', () => {
    expect(dropReason({ text: 'テストを回して', dbfs: -46 }, ctx)).toBe('quiet');
    expect(dropReason({ text: 'テストを回して', dbfs: -44 }, ctx)).toBeNull();
  });
  it('定番の作り話は hallucination', () => {
    expect(dropReason({ text: 'ご視聴ありがとうございました。', dbfs: -20 }, ctx)).toBe('hallucination');
    expect(dropReason({ text: 'チャンネル登録 よろしくお願いします', dbfs: -20 }, ctx)).toBe('hallucination');
    expect(dropReason({ text: 'おやすみなさい', dbfs: -20 }, ctx)).toBe('hallucination');
  });
  it('定番の文を含むだけの長い文は通る', () => {
    expect(dropReason({ text: 'おやすみなさいの通知を直して', dbfs: -20 }, ctx)).toBeNull();
  });
  it('窓の中の はい だけは ack、窓の外は通る', () => {
    expect(dropReason({ text: 'はい。', dbfs: -20 }, { ...ctx, inWindow: true })).toBe('ack');
    expect(dropReason({ text: 'はい', dbfs: -20 }, ctx)).toBeNull();
    expect(dropReason({ text: 'はい、お願いします', dbfs: -20 }, { ...ctx, inWindow: true })).toBeNull();
  });
  it('ヒントの語が 3 つ以上並んで 6 割以上を占めたら hintEcho', () => {
    expect(dropReason({ text: 'hangar, vitest, Sonnet', dbfs: -20 }, ctx)).toBe('hintEcho');
    expect(dropReason({ text: 'hangar、vitest、Sonnet、', dbfs: -20 }, ctx)).toBe('hintEcho');
    expect(dropReason({ text: 'hangar, vitest', dbfs: -20 }, ctx)).toBeNull();
    expect(dropReason({ text: 'hangar と vitest と Sonnet でテストを全部回して結果を教えて', dbfs: -20 }, ctx)).toBeNull();
  });
});
