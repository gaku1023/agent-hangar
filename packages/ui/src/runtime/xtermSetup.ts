/**
 * xterm の設定と打鍵の扱いのうち、本物の xterm が無くても確かめられる部分。
 * xterm.ts はここから引いて組み立てる。
 */
import type { ITerminalOptions } from '@xterm/xterm';

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

/** xterm に渡す設定。色はテーマの CSS 変数から読んだものを受け取る。 */
export function terminalOptions(theme: { background: string; foreground: string }): ITerminalOptions {
  return {
    fontFamily: "'JetBrains Mono Variable', Menlo, monospace",
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    // unicode の切り替えは proposed API の扱いなので allowProposedApi が要る。
    allowProposedApi: true,
    theme,
    // tmux の mouse on や Claude Code がマウスを取っていると、ドラッグは中の側へ渡り、xterm の選択にならない。
    // Option を押している間だけ xterm の選択にする。選んだものは ⌘C で写せる。
    macOptionClickForcesSelection: true,
    // Option のクリックでカーソルを動かす機能は矢印キーを送る。
    // Claude Code の入力欄では ↑ ↓ が履歴の呼び出しになり、選ぶつもりの短いクリックで書きかけの指示が入れ替わるので切る。
    altClickMovesCursor: false,
    // Option は Meta にしない。JIS 配列のバックスラッシュ（Option+¥）や Option で打つ記号が入らなくなる。
    // Option+Enter はこの設定によらず ESC CR を送るので、改行はそのまま効く。
    macOptionIsMeta: false,
  };
}
