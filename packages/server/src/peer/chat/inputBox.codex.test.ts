import { describe, expect, it } from 'vitest';
import { codexInputEmptyFromCapture, inputEmptyFor } from './inputBox.ts';
import { CODEX_APPROVAL, CODEX_EMPTY_AFTER_TURNS, CODEX_MULTILINE, CODEX_PASTED, CODEX_TYPED, CODEX_WORKING } from './inputBox.codex.fixtures.ts';
import { WIN_EMPTY_AFTER_TURN, WIN_DRAFT } from './inputBox.fixtures.ts';

describe('codexInputEmptyFromCapture（実機の codex の capture-pane -pe の見本）', () => {
  it('薄字の案内だけの入力欄は空。上に残る直前の入力（› の行）は数えない', () => {
    expect(CODEX_EMPTY_AFTER_TURNS.split('\n').filter((l) => l.includes('›')).length).toBeGreaterThan(1);
    expect(codexInputEmptyFromCapture(CODEX_EMPTY_AFTER_TURNS)).toBe(true);
  });

  it('作業中でも、入力欄が空なら空', () => {
    expect(codexInputEmptyFromCapture(CODEX_WORKING)).toBe(true);
  });

  it('打ちかけ（1 行、複数行）と貼り付けの札は空でない', () => {
    expect(codexInputEmptyFromCapture(CODEX_TYPED)).toBe(false);
    expect(codexInputEmptyFromCapture(CODEX_MULTILINE)).toBe(false);
    expect(codexInputEmptyFromCapture(CODEX_PASTED)).toBe(false);
  });

  it('承認の札が出ている画面は空と言わない', () => {
    expect(codexInputEmptyFromCapture(CODEX_APPROVAL)).toBe(false);
  });

  it('色なしの画面、入力欄の無い画面は空と言わない（安全側）', () => {
    expect(codexInputEmptyFromCapture('› Ask Codex to do anything\n\n  model · 0% used')).toBe(false);
    expect(codexInputEmptyFromCapture('')).toBe(false);
    expect(codexInputEmptyFromCapture('starting codex...')).toBe(false);
  });

  it('薄字でも [ で始まる語は札かもしれないので空でない', () => {
    expect(codexInputEmptyFromCapture('\x1b[1m›\x1b[0m \x1b[2m[Image #1]\x1b[0m\n\n  footer')).toBe(false);
  });
});

describe('inputEmptyFor（エージェントで判定を選ぶ）', () => {
  it('Codex は Codex の判定、Claude Code は ❯ の箱の判定を使う', () => {
    expect(inputEmptyFor('codex', CODEX_EMPTY_AFTER_TURNS)).toBe(true);
    expect(inputEmptyFor('codex', CODEX_TYPED)).toBe(false);
    expect(inputEmptyFor('claude-code', WIN_EMPTY_AFTER_TURN)).toBe(true);
    expect(inputEmptyFor('claude-code', WIN_DRAFT)).toBe(false);
    expect(inputEmptyFor('claude-code', CODEX_EMPTY_AFTER_TURNS)).toBe(false);
  });

  it('判定を持たないエージェントは空と言わない', () => {
    expect(inputEmptyFor('opencode', CODEX_EMPTY_AFTER_TURNS)).toBe(false);
  });
});
