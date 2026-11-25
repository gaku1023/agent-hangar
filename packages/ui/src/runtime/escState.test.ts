import { describe, expect, it } from 'vitest';
import { createEscState } from './escState.ts';

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
