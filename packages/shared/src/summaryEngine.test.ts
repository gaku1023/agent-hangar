import { describe, expect, it } from 'vitest';
import { DEFAULT_SUMMARY_CLAUDE_MODEL, isModelName, isSummaryEngine, MODEL_CHOICES, SUMMARY_ENGINES } from './summaryEngine.ts';

describe('要約エンジンの選択', () => {
  it('使わない、Claude、OpenAI 互換の 3 つだけを受ける', () => {
    expect(SUMMARY_ENGINES).toEqual(['off', 'claude', 'openai']);
    for (const v of SUMMARY_ENGINES) expect(isSummaryEngine(v)).toBe(true);
    for (const v of ['lmstudio', 'OFF', '', null, undefined, 1]) expect(isSummaryEngine(v)).toBe(false);
  });
  it('要約に使う Claude のモデルの既定は haiku', () => {
    expect(DEFAULT_SUMMARY_CLAUDE_MODEL).toBe('haiku');
    expect(MODEL_CHOICES).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
  });
});

describe('isModelName', () => {
  it('別名と、版や文脈の長さの付いた名前を受ける', () => {
    for (const v of ['haiku', 'opus', 'claude-sonnet-4-5', 'opus[1m]', 'us.anthropic.claude-haiku-4-5:0']) expect(isModelName(v)).toBe(true);
  });
  it('空、空白入り、先頭のハイフン（引数として読まれる）、長すぎる名前は断る', () => {
    for (const v of ['', ' ', 'haiku sonnet', '-p', '--tools', 'a'.repeat(101), 'opus;rm', 3, null]) expect(isModelName(v)).toBe(false);
  });
});
