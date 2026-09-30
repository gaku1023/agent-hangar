/**
 * xterm の設定と打鍵の扱いのうち、本物の xterm が無くても確かめられる部分。
 * xterm.ts はここから引いて組み立てる。
 */

/**
 * Shift+Enter で送る列。
 * Claude Code は ESC CR（Option+Enter と同じ列）を改行として読み、送信しない。
 * /terminal-setup が VS Code に入れる Shift+Enter の割り当ても同じ列である。
 * tmux は extended-keys の設定によらずこの列をそのまま中の claude へ渡す。
 * CSI u の形（ESC [13;2u）は tmux が素の CR に潰すので使わない。
 */
export const NEWLINE_SEQ = '\x1b\r';

type KeyEventLike = Pick<KeyboardEvent, 'type' | 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey' | 'isComposing' | 'keyCode' | 'preventDefault'>;

/**
 * xterm の attachCustomKeyEventHandler に渡す関数を作る。
 * false を返した打鍵は xterm が処理しない。
 * xterm 6 は Shift+Enter でも CR を送り、Claude Code では送信になってしまうので、改行の列に差し替える。
 */
export function createKeyHandler(input: (data: string) => void): (e: KeyEventLike) => boolean {
  return (e) => {
    if (e.key !== 'Enter' || !e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return true;
    // 変換中の Enter は IME の確定である。keyCode 229 は IME が打鍵を受け取っている印。
    if (e.isComposing || e.keyCode === 229) return true;
    // keyup は何も送らない。止めると xterm がフォーカスの戻しとカーソルの形の更新を飛ばす。
    if (e.type === 'keyup') return true;
    if (e.type === 'keydown') {
      e.preventDefault();
      input(NEWLINE_SEQ);
    }
    // keypress も止める。通すと xterm が keypress の側で CR を送る。
    return false;
  };
}
