import { describe, expect, it } from 'vitest';
import { createEscState, groundCut } from './escState.ts';

describe('createEscState', () => {
  it('普通の文字と閉じたエスケープのあとは地の状態', () => {
    const s = createEscState();
    s.feed('hello \x1b[1;31mred\x1b[0m \x1b]0;title\x07 \x1b7\x1b8');
    expect(s.ground()).toBe(true);
  });

  it('CSI の途中で切れたら地の状態でない。続きが来たら戻る', () => {
    const s = createEscState();
    s.feed('abc\x1b[12;');
    expect(s.ground()).toBe(false);
    s.feed('3H');
    expect(s.ground()).toBe(true);
  });

  it('ESC だけで切れたら地の状態でない', () => {
    const s = createEscState();
    s.feed('x\x1b');
    expect(s.ground()).toBe(false);
    s.feed('M');
    expect(s.ground()).toBe(true);
  });

  it('OSC は BEL か ST で閉じる。ST の ESC の後で切れても途中とみなす', () => {
    const s = createEscState();
    s.feed('\x1b]52;;aGVsbG8=');
    expect(s.ground()).toBe(false);
    s.feed('\x1b');
    expect(s.ground()).toBe(false);
    s.feed('\\');
    expect(s.ground()).toBe(true);
  });

  it('DCS も ST まで途中とみなす', () => {
    const s = createEscState();
    s.feed('\x1bPtmux;payload');
    expect(s.ground()).toBe(false);
    s.feed('\x1b\\done');
    expect(s.ground()).toBe(true);
  });

  it('ESC ( B のような中間の文字の付いた列も閉じる', () => {
    const s = createEscState();
    s.feed('\x1b(');
    expect(s.ground()).toBe(false);
    s.feed('B');
    expect(s.ground()).toBe(true);
  });
});

describe('groundCut', () => {
  it('列の外で終われば全部、列の途中で終われば列の始まりの位置を返す', () => {
    expect(groundCut('abc\x1b[1mdef')).toBe(10);
    expect(groundCut('abc\x1b[1')).toBe(3);
    expect(groundCut('ab\x1b]52;c;aGk=')).toBe(2);
    expect(groundCut('ab\x1b')).toBe(2);
    expect(groundCut('')).toBe(0);
  });

  it('途中の閉じた列は切らず、最後に開いた列の始まりで切る', () => {
    expect(groundCut('\x1b[2Jx\x1b[3;4')).toBe(5);
  });
});
