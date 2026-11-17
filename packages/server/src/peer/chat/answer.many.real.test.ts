import { describe, expect, it } from 'vitest';
import { parseDialog } from './answer.ts';
import { REAL_MANY_SUBMIT, REAL_MANY_TAB1, REAL_MANY_TAB2 } from './questionDialogs.real.fixtures.ts';

/** 実機の写しで、問いが複数ある札の読み取りを確かめる（見出しの空白や案内の行が作った見本と違う）。 */
describe('parseDialog: 実機の問いが複数ある札', () => {
  it('1 タブ目', () => {
    const d = parseDialog(REAL_MANY_TAB1)!;
    expect(d.step).toEqual({ index: 1, total: 2, submit: false });
    expect(d.question).toBe('果物はどれ？');
    expect(d.options.map((o) => o.first)).toEqual(['りんご', 'みかん', 'Type something.', 'Chat about this']);
  });
  it('2 タブ目', () => {
    const d = parseDialog(REAL_MANY_TAB2)!;
    expect(d.step).toEqual({ index: 2, total: 2, submit: false });
    expect(d.question).toBe('色はどれ？');
    expect(d.options.map((o) => o.first)).toEqual(['赤', '青', 'Type something.', 'Chat about this']);
  });
  it('確認のタブ（案内の行が無い）', () => {
    const d = parseDialog(REAL_MANY_SUBMIT)!;
    expect(d.step).toEqual({ index: null, total: 2, submit: true });
    expect(d.options.map((o) => o.first)).toEqual(['Submit answers', 'Cancel']);
  });
});
