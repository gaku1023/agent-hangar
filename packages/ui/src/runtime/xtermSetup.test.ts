import { describe, expect, it, vi } from 'vitest';
import { NEWLINE_SEQ, createKeyHandler } from './xtermSetup.ts';

type KeyInit = { type?: string; key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean; keyCode?: number };
function key(init: KeyInit) {
  const e = { type: 'keydown', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 0, preventDefault: vi.fn(), ...init };
  return e as typeof e & KeyboardEvent;
}

describe('createKeyHandler', () => {
  it('Shift+Enter は送信せず、Claude Code が改行として読む ESC CR を送る', () => {
    const input = vi.fn();
    const handle = createKeyHandler(input);
    const e = key({ key: 'Enter', shiftKey: true, keyCode: 13 });
    // false を返すと xterm はこの打鍵で CR を送らない。
    expect(handle(e)).toBe(false);
    expect(input).toHaveBeenCalledWith('\x1b\r');
    expect(NEWLINE_SEQ).toBe('\x1b\r');
    // 入力欄に改行が入らないよう、既定の動きも止める。
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('Shift+Enter の keypress も xterm に渡さず、二重に送らない。keyup は xterm に任せる', () => {
    const input = vi.fn();
    const handle = createKeyHandler(input);
    expect(handle(key({ type: 'keypress', key: 'Enter', shiftKey: true, keyCode: 13 }))).toBe(false);
    expect(handle(key({ type: 'keyup', key: 'Enter', shiftKey: true, keyCode: 13 }))).toBe(true);
    expect(input).not.toHaveBeenCalled();
  });

  it('素の Enter と、ほかの修飾の付いた Enter は xterm に任せる', () => {
    const input = vi.fn();
    const handle = createKeyHandler(input);
    expect(handle(key({ key: 'Enter', keyCode: 13 }))).toBe(true);
    // Option+Enter は xterm が自分で ESC CR を送る。
    expect(handle(key({ key: 'Enter', altKey: true, keyCode: 13 }))).toBe(true);
    expect(handle(key({ key: 'Enter', shiftKey: true, ctrlKey: true, keyCode: 13 }))).toBe(true);
    expect(handle(key({ key: 'Enter', shiftKey: true, metaKey: true, keyCode: 13 }))).toBe(true);
    expect(handle(key({ key: 'A', shiftKey: true, keyCode: 65 }))).toBe(true);
    expect(input).not.toHaveBeenCalled();
  });

  it('変換中の Shift+Enter は IME の確定なので横取りしない', () => {
    const input = vi.fn();
    const handle = createKeyHandler(input);
    expect(handle(key({ key: 'Enter', shiftKey: true, isComposing: true, keyCode: 13 }))).toBe(true);
    expect(handle(key({ key: 'Process', shiftKey: true, keyCode: 229 }))).toBe(true);
    expect(handle(key({ key: 'Enter', shiftKey: true, keyCode: 229 }))).toBe(true);
    expect(input).not.toHaveBeenCalled();
  });
});
