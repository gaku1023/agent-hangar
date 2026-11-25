import { describe, expect, it } from 'vitest';
import { parseTrustDialog, trustMoves } from './trustDialog.ts';

const NEW_FORM = `
 Accessing workspace:

 D:\\workspace\\ops

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`;

const OLD_FORM = `
 Accessing workspace:

 /Users/x/work

 Quick safety check: Is this a project you created or one you trust?

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
`;

describe('parseTrustDialog', () => {
  it('番号の無い形を読む。カーソルは No にある', () => {
    const d = parseTrustDialog(NEW_FORM)!;
    expect(d.path).toBe('D:\\workspace\\ops');
    expect(d.options.map((o) => [o.key, o.label])).toEqual([['2', 'No, exit'], ['1', 'Yes, I trust this folder']]);
    expect(d.cursor).toBe(0);
  });
  it('番号付きの形を読む。カーソルは Yes にある', () => {
    const d = parseTrustDialog(OLD_FORM)!;
    expect(d.path).toBe('/Users/x/work');
    expect(d.options.map((o) => [o.key, o.label])).toEqual([['1', 'Yes, I trust this folder'], ['2', 'No, exit']]);
    expect(d.cursor).toBe(0);
  });
  it('カーソルが Yes にある新しい形', () => {
    const d = parseTrustDialog(NEW_FORM.replace('❯ No, exit', '  No, exit').replace('  Yes, I trust', '❯ Yes, I trust'))!;
    expect(d.cursor).toBe(1);
  });
  it('折り返したパスはつなぐ', () => {
    const d = parseTrustDialog(NEW_FORM.replace('D:\\workspace\\ops', 'D:\\workspace\\very\nlong\\ops'))!;
    expect(d.path).toBe('D:\\workspace\\verylong\\ops');
  });
  it('確認でない画面は null。入力欄の ❯ や本文の Yes だけの画面も取り違えない', () => {
    expect(parseTrustDialog('❯ Try "fix the bug"\n  ? for shortcuts')).toBeNull();
    expect(parseTrustDialog('Yes, I trust this folder is what the doc says')).toBeNull();
    expect(parseTrustDialog('')).toBeNull();
  });
});

describe('trustMoves', () => {
  it('No にカーソルがあって Yes を選ぶなら down を 1 回', () => {
    expect(trustMoves(parseTrustDialog(NEW_FORM)!, '1')).toEqual({ key: 'down', count: 1 });
  });
  it('すでにその行にカーソルがあれば 0 回', () => {
    expect(trustMoves(parseTrustDialog(NEW_FORM)!, '2')).toEqual({ key: 'down', count: 0 });
    expect(trustMoves(parseTrustDialog(OLD_FORM)!, '1')).toEqual({ key: 'down', count: 0 });
  });
  it('上の行へは up', () => {
    expect(trustMoves(parseTrustDialog(OLD_FORM.replace('❯ 1.', '  1.').replace('  2.', '❯ 2.'))!, '1')).toEqual({ key: 'up', count: 1 });
  });
  it('カーソルが読めない、行が無いときは null', () => {
    expect(trustMoves(parseTrustDialog(NEW_FORM.replace('❯ ', '  '))!, '1')).toBeNull();
    expect(trustMoves(parseTrustDialog(NEW_FORM)!, '9')).toBeNull();
  });
});
