// @vitest-environment jsdom
// addon-clipboard の束は読み込みのときに self を参照するので、DOM のある環境で読む。
import { ClipboardAddon } from '@xterm/addon-clipboard';
import type { Terminal } from '@xterm/xterm';
import { describe, expect, it, vi } from 'vitest';
import { NEWLINE_SEQ, clipboardProvider, createKeyHandler, terminalOptions } from './xtermSetup.ts';

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

describe('terminalOptions', () => {
  const theme = { background: '#111111', foreground: '#eeeeee' };

  it('Option を押したドラッグは、tmux や Claude Code がマウスを取っていても xterm の選択にする', () => {
    expect(terminalOptions(theme).macOptionClickForcesSelection).toBe(true);
  });

  it('Option のクリックで矢印キーを送らない', () => {
    // 送ると Claude Code の入力欄では ↑ ↓ が履歴の呼び出しになり、書きかけの指示が入れ替わる。
    expect(terminalOptions(theme).altClickMovesCursor).toBe(false);
  });

  it('Option は Meta にしない', () => {
    // Meta にすると JIS 配列の Option+¥ で打つバックスラッシュや、Option で打つ記号が入らなくなる。
    expect(terminalOptions(theme).macOptionIsMeta).toBe(false);
  });

  it('今までの見た目の設定を保つ', () => {
    const o = terminalOptions(theme);
    expect(o).toMatchObject({ fontSize: 13, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, allowProposedApi: true, theme });
    expect(o.fontFamily).toContain('JetBrains Mono');
  });
});

describe('clipboardProvider', () => {
  /** addon を偽の端末に付け、OSC 52 の本体を流し込む口と、端末へ返した入力を返す。 */
  function withAddon(write: (text: string) => Promise<void>) {
    let osc52: ((data: string) => boolean | Promise<boolean>) | null = null;
    const replies: string[] = [];
    const term = {
      parser: { registerOscHandler: (id: number, cb: (data: string) => boolean | Promise<boolean>) => { if (id === 52) osc52 = cb; return { dispose() {} }; } },
      input: (d: string) => { replies.push(d); },
    };
    new ClipboardAddon(undefined, clipboardProvider(write)).activate(term as unknown as Terminal);
    return { send: async (data: string) => { await osc52!(data); }, replies };
  }

  it('アプリが写したものをクリップボードに書く', async () => {
    const write = vi.fn(async () => {});
    const { send } = withAddon(write);
    await send('c;aGVsbG8=');
    expect(write).toHaveBeenCalledWith('hello');
  });

  it('tmux のコピーモードが送る、選択先の空いた OSC 52 も書く', async () => {
    // tmux は `ESC ] 52 ; ; <base64>` の形で送る。addon の既定の提供者は c 以外を捨てるので、これが届かない。
    const write = vi.fn(async () => {});
    const { send } = withAddon(write);
    await send(';aGVsbG8td29ybGQ=');
    expect(write).toHaveBeenCalledWith('hello-world');
  });

  it('日本語もそのまま書く', async () => {
    const write = vi.fn(async () => {});
    const { send } = withAddon(write);
    await send(`c;${Buffer.from('こんにちは', 'utf8').toString('base64')}`);
    expect(write).toHaveBeenCalledWith('こんにちは');
  });

  it('クリップボードの中身はアプリに渡さない', async () => {
    // 読み出しを許すと、端末の中で動くどのプログラムでも利用者のクリップボードを盗み見られる。
    const write = vi.fn(async () => {});
    const { send, replies } = withAddon(write);
    await send('c;?');
    expect(write).not.toHaveBeenCalled();
    expect(replies).toEqual(['\x1b]52;c;\x07']);
  });

  it('空の中身や壊れた base64 では、利用者のクリップボードを消さない', async () => {
    const write = vi.fn(async () => {});
    const { send } = withAddon(write);
    await send('c;');
    await send('c;%%%not-base64');
    expect(write).not.toHaveBeenCalled();
  });

  it('書けなくても端末の処理は止めない', async () => {
    // WKWebView は利用者の操作の外での書き込みを断る。断られても投げずに済ませる。
    const { send } = withAddon(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
    await expect(send('c;aGVsbG8=')).resolves.toBeUndefined();
    const sync = withAddon(() => { throw new TypeError('navigator.clipboard is undefined'); });
    await expect(sync.send('c;aGVsbG8=')).resolves.toBeUndefined();
  });
});
