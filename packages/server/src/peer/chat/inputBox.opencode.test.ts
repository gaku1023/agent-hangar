import { describe, expect, it } from 'vitest';
import { inputEmptyFor, opencodeInputEmptyFromCapture } from './inputBox.ts';
import { OPENCODE_EMPTY_AFTER_TURN, OPENCODE_EMPTY_FRESH, OPENCODE_MULTILINE, OPENCODE_TYPED, OPENCODE_WORKING } from './inputBox.opencode.fixtures.ts';

describe('opencodeInputEmptyFromCapture（実機の opencode の capture-pane -pe の見本）', () => {
  it('新しい会話の空の入力欄は空', () => {
    expect(opencodeInputEmptyFromCapture(OPENCODE_EMPTY_FRESH)).toBe(true);
  });

  it('ターンの後の空の入力欄は空', () => {
    expect(opencodeInputEmptyFromCapture(OPENCODE_EMPTY_AFTER_TURN)).toBe(true);
  });

  it('作業中でも、入力欄が空なら空。上に残る利用者の入力（同じ ┃ の囲み）は数えない', () => {
    expect(OPENCODE_WORKING).toContain('esc');
    expect(OPENCODE_WORKING.split('\n').filter((l) => l.includes('┃')).length).toBeGreaterThan(5);
    expect(opencodeInputEmptyFromCapture(OPENCODE_WORKING)).toBe(true);
  });

  it('打ちかけ（1 行、複数行）は空でない', () => {
    expect(opencodeInputEmptyFromCapture(OPENCODE_TYPED)).toBe(false);
    expect(opencodeInputEmptyFromCapture(OPENCODE_MULTILINE)).toBe(false);
  });

  it('色なしの画面、入力欄の無い画面、状態の行の無い囲みは空と言わない（安全側）', () => {
    expect(opencodeInputEmptyFromCapture('  ┃\n  ┃  Build · m\n  ╹▀▀▀▀\n  footer')).toBe(false);
    expect(opencodeInputEmptyFromCapture('')).toBe(false);
    expect(opencodeInputEmptyFromCapture('starting opencode...')).toBe(false);
    expect(opencodeInputEmptyFromCapture('  \x1b[38;2;1;2;3m┃\x1b[0m\n  \x1b[38;2;1;2;3m┃\x1b[0m\n  \x1b[38;2;1;2;3m╹▀▀▀▀\x1b[0m')).toBe(false);
  });

  it('inputEmptyFor は opencode にこの判定を使う', () => {
    expect(inputEmptyFor('opencode', OPENCODE_EMPTY_FRESH)).toBe(true);
    expect(inputEmptyFor('opencode', OPENCODE_TYPED)).toBe(false);
  });
});
