import { describe, expect, it } from 'vitest';
import { createTrustAnswerer, screenClues, trustKey } from './trust.ts';

// 2.1.295 の信頼の画面。カーソルの初期位置は No である。
const screen = (cursor: 'no' | 'yes'): string => [
  ' Accessing workspace:',
  ' /tmp/hangar-fixture/work',
  '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what\'s in this',
  ' folder first.',
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' Security guide',
  '',
  `${cursor === 'no' ? ' ❯' : '  '} No, exit`,
  `${cursor === 'yes' ? ' ❯' : '  '} Yes, I trust this folder`,
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

describe('trustKey', () => {
  it('No を選んでいる信頼の画面では Down', () => {
    expect(trustKey(screen('no'))).toBe('Down');
  });
  it('Yes を選んでいる信頼の画面では Enter', () => {
    expect(trustKey(screen('yes'))).toBe('Enter');
  });
  it('番号つきの選択肢でも、行頭が > でも同じに読む', () => {
    expect(trustKey('Do you trust this folder?\n > 1. Yes, I trust this folder\n   2. No, exit')).toBe('Enter');
    expect(trustKey('Do you trust this folder?\n   1. Yes, I trust this folder\n > 2. No, exit')).toBe('Down');
  });
  it('信頼の画面でない入力の欄は、❯ の行に Try があっても null', () => {
    expect(trustKey('╭──────╮\n│ ❯ Try "write a test for <filepath>" │\n╰──────╯\n  ? for shortcuts')).toBeNull();
    expect(trustKey('❯ Try "write a test for <filepath>"\n')).toBeNull();
    // 本文に trust という語があるだけの画面も、選択肢でなければ null
    expect(trustKey('❯ do you trust this?')).toBeNull();
  });
  it('空の画面と、選んでいる行が見つからない画面は null', () => {
    expect(trustKey('')).toBeNull();
    expect(trustKey('  No, exit\n  Yes, I trust this folder\n')).toBeNull();
  });
});

describe('screenClues', () => {
  it('❯、trust、Enter to confirm を含む行だけを残し、長い行は切る', () => {
    const lines = screenClues(`${screen('no')}\nunrelated line\n${'x trust '.repeat(100)}`);
    expect(lines.some((l) => l.includes('❯ No, exit'))).toBe(true);
    expect(lines.some((l) => l.includes('Enter to confirm'))).toBe(true);
    expect(lines.some((l) => l.includes('unrelated'))).toBe(false);
    expect(lines.every((l) => l.length <= 200)).toBe(true);
  });
});

describe('createTrustAnswerer', () => {
  it('信頼の画面を初めて見てから 1 秒は送らない。キーの間は 800 ミリ秒あける', () => {
    const a = createTrustAnswerer();
    expect(a(screen('no'), 1000)).toBeNull();
    expect(a(screen('no'), 1999)).toBeNull();
    expect(a(screen('no'), 2000)).toBe('Down');
    expect(a(screen('no'), 2500)).toBeNull();
    expect(a(screen('yes'), 2800)).toBe('Enter');
  });
  it('画面が No のあいだは、Enter を決して返さない。Down は合わせて 4 回までで、越えたら投げる', () => {
    const a = createTrustAnswerer();
    const keys: (string | null)[] = [];
    let t = 0;
    for (let i = 0; i < 4; i++) { t += 1000; keys.push(a(screen('no'), t)); }
    expect(keys).toEqual([null, 'Down', 'Down', 'Down']);
    t += 1000; expect(a(screen('no'), t)).toBe('Down');
    t += 1000; expect(() => a(screen('no'), t)).toThrow(/Down 4 回/);
  });
  it('Enter は合わせて 3 回までで、越えたら投げる。信頼の画面でなければ何もしない', () => {
    const a = createTrustAnswerer();
    expect(a('', 0)).toBeNull();
    expect(a(screen('yes'), 100)).toBeNull();
    expect(a(screen('yes'), 1100)).toBe('Enter');
    expect(a(screen('yes'), 2000)).toBe('Enter');
    expect(a(screen('yes'), 3000)).toBe('Enter');
    expect(() => a(screen('yes'), 4000)).toThrow(/Enter 3 回/);
    expect(createTrustAnswerer()('❯ Try "x"', 5000)).toBeNull();
  });
});
