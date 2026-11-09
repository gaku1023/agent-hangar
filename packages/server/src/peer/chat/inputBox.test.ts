import { describe, expect, it } from 'vitest';
import { inputEmptyFromCapture } from './inputBox.ts';
import { MAC_DRAFT, MAC_GHOST, SYNTHETIC_FAINT_CHIP, WIN_CHIP_IMAGE, WIN_CHIP_PASTE, WIN_BUSY_WITH_DRAFT, WIN_DRAFT, WIN_EMPTY_AFTER_TURN, WIN_GHOST_FRESH, WIN_MULTILINE, WIN_NAMED_DRAFT, WIN_NAMED_EMPTY } from './inputBox.fixtures.ts';

const RULE = '─'.repeat(40);

describe('inputEmptyFromCapture（実機の capture-pane -pe の見本）', () => {
  it('何も打っていない箱は空', () => {
    expect(inputEmptyFromCapture(WIN_EMPTY_AFTER_TURN)).toBe(true);
  });

  it('薄字の提案（ghost）だけがある箱は空。Windows（psmux）と Mac（tmux）の両方の書き方で', () => {
    expect(inputEmptyFromCapture(WIN_GHOST_FRESH)).toBe(true);
    expect(inputEmptyFromCapture(MAC_GHOST)).toBe(true);
  });

  it('打ちかけがあれば空でない（1 語でも複数行でも）', () => {
    expect(inputEmptyFromCapture(WIN_DRAFT)).toBe(false);
    expect(inputEmptyFromCapture(MAC_DRAFT)).toBe(false);
    expect(inputEmptyFromCapture(WIN_BUSY_WITH_DRAFT)).toBe(false);
    expect(inputEmptyFromCapture(WIN_MULTILINE)).toBe(false);
  });

  it('貼り付けの札と画像の札（実機では普通の字）は打ちかけ。薄字で描かれる版でも、[ で始まる薄字は空でない', () => {
    expect(inputEmptyFromCapture(WIN_CHIP_PASTE)).toBe(false);
    expect(inputEmptyFromCapture(WIN_CHIP_IMAGE)).toBe(false);
    expect(inputEmptyFromCapture(SYNTHETIC_FAINT_CHIP)).toBe(false);
  });

  it('箱の上に残る直前の指示の行（❯ で始まる）は数えない', () => {
    const lines = WIN_EMPTY_AFTER_TURN.split('\n');
    expect(lines[0]).toContain('reply with exactly');
    expect(inputEmptyFromCapture(WIN_EMPTY_AFTER_TURN)).toBe(true);
  });
});

describe('inputEmptyFromCapture（作り込んだ場面）', () => {
  it('色なしの画面でも、薄字を見分けられないので打ちかけと同じに扱う（安全側）', () => {
    expect(inputEmptyFromCapture(`${RULE}\n❯ Try "fix lint errors"\n${RULE}\n  ⏸ manual mode on`)).toBe(false);
  });

  it('色なしでも、何も無い箱なら空', () => {
    expect(inputEmptyFromCapture(`${RULE}\n❯\n${RULE}\n  ⏸ manual mode on`)).toBe(true);
    expect(inputEmptyFromCapture(`${RULE}\n❯ \n${RULE}`)).toBe(true);
  });

  it('薄字のあとに打った字が続けば空でない。薄字の解除（22）も読む', () => {
    expect(inputEmptyFromCapture(`${RULE}\n❯ \x1b[2mTry\x1b[0m hi\n${RULE}`)).toBe(false);
    expect(inputEmptyFromCapture(`${RULE}\n❯ \x1b[2mTry\x1b[22m hi\n${RULE}`)).toBe(false);
    expect(inputEmptyFromCapture(`${RULE}\n❯ \x1b[2mTry again\x1b[22m\n${RULE}`)).toBe(true);
  });

  it('38;2;r;g;b の 2 を薄字と読まない。色の付いた打ちかけは空でない', () => {
    expect(inputEmptyFromCapture(`${RULE}\n❯ \x1b[38;2;2;2;2mhi\x1b[0m\n${RULE}`)).toBe(false);
    expect(inputEmptyFromCapture(`${RULE}\n❯ \x1b[0;38;5;2mhi\x1b[0m\n${RULE}`)).toBe(false);
  });

  it('bash モードの ! だけでも空でない', () => {
    expect(inputEmptyFromCapture(`${RULE}\n\x1b[0m!\x1b[0m\n${RULE}`)).toBe(false);
  });

  it('箱が見つからない画面（許可の札など）は空と言わない', () => {
    expect(inputEmptyFromCapture('')).toBe(false);
    expect(inputEmptyFromCapture('Do you want to proceed?\n ❯ 1. Yes\n   2. No')).toBe(false);
    expect(inputEmptyFromCapture(`${RULE}\n❯ 1. Red\n  2. Green\n${RULE}\n  Enter to select`)).toBe(false);
  });

  it('箱の中が空行だけで ❯ が無ければ空と言わない', () => {
    expect(inputEmptyFromCapture(`${RULE}\n\n${RULE}`)).toBe(false);
  });

  it('名前の付いた会話（上の区切り線に名前が入る）でも箱を見つける', () => {
    expect(inputEmptyFromCapture(WIN_NAMED_EMPTY)).toBe(true);
    expect(inputEmptyFromCapture(WIN_NAMED_DRAFT)).toBe(false);
  });

  it('箱より上に区切り線があっても、最後の 2 本を箱とする', () => {
    expect(inputEmptyFromCapture(`${RULE}\nsome text\n${RULE}\n❯ typed\n${RULE}\nfooter`)).toBe(false);
    expect(inputEmptyFromCapture(`${RULE}\nsome text\n${RULE}\n❯\n${RULE}\nfooter`)).toBe(true);
  });
});
